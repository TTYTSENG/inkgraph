import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const KINDS = ['project', 'source', 'annotation', 'term', 'note', 'relation'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateEntity(kind, d, lookup) {
  if (!KINDS.includes(kind) || !d || typeof d !== 'object' || Array.isArray(d)) throw new AppError('無效的資料類型');
  if (JSON.stringify(d).length > 2_000_000) throw new AppError('文字資料超過 2 MB');
  const stringFields=['title','description','purpose','projectId','sourceId','from','to','relation','quote','locator','paraphrase','comment','term','aliases','definition','example','tags','content','noteType','text','summary','method','findings','limitations','journal','publisher','volume','issue','pageRange','doi','url','origin','cslType','reason'];
  for (const key of stringFields) if (d[key]!=null && typeof d[key]!=='string') throw new AppError(`${key} 必須為文字`);
  if (kind !== 'relation' && kind !== 'annotation' && (!d.title || typeof d.title !== 'string' || d.title.length > 500)) throw new AppError('請填寫標題（最多 500 字）');
  const ref = (id, expected) => {
    if (!id) return;
    const entity = lookup(id);
    if (!entity || entity.kind !== expected) throw new AppError(`找不到相關 ${expected} 資料`);
  };
  if (kind !== 'project') ref(d.projectId, 'project');
  if (['annotation', 'term'].includes(kind)) ref(d.sourceId, 'source');
  if (kind === 'annotation') {
    if (!d.sourceId || typeof d.quote !== 'string' || !d.quote.trim()) throw new AppError('摘錄需要原文與來源');
    if (typeof d.locator !== 'string' || !d.locator.trim()) throw new AppError('請填寫頁碼、段落或圖片位置');
  }
  if (kind === 'note') {
    if (!Array.isArray(d.sourceIds) || d.sourceIds.length > 500) throw new AppError('筆記來源格式錯誤');
    d.sourceIds.forEach(id => ref(id, 'source'));
  }
  if (kind === 'relation') {
    ref(d.from, 'source'); ref(d.to, 'source');
    if (!d.from || !d.to || d.from === d.to) throw new AppError('請選擇兩個不同來源');
    if (!['supports', 'contradicts', 'extends', 'compares'].includes(d.relation)) throw new AppError('無效的關係');
  }
  if (kind === 'source') {
    if (!Array.isArray(d.authors)) throw new AppError('作者格式錯誤');
    if (d.authors.length > 200 || d.authors.some(a => !a || typeof a !== 'object' || (!a.literal && !a.family))) throw new AppError('作者資料錯誤');
    if (d.authors.some(a=>['literal','family','given'].some(k=>a[k]!=null && typeof a[k]!=='string'))) throw new AppError('作者姓名必須為文字');
    if (d.cslType && !['article-journal','book','report','webpage','manuscript','personal-communication'].includes(d.cslType)) throw new AppError('不支援的書目類型');
    if (d.pages && (!Array.isArray(d.pages) || d.pages.length>1000 || d.pages.some(p=>!p || !Number.isInteger(p.number) || p.number<1 || typeof p.text!=='string'))) throw new AppError('PDF 頁面資料錯誤');
    if (d.year && !/^\d{4}$/.test(String(d.year))) throw new AppError('年份須為四位數');
    if (d.url && !/^https?:\/\//i.test(d.url)) throw new AppError('網址須以 http 或 https 開頭');
    if (d.doi && !/^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(d.doi)) throw new AppError('DOI 格式錯誤');
  }
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES entities(id), name TEXT NOT NULL, mime TEXT NOT NULL, sha TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS attachment_source ON attachments(source_id);`);
  }
  row(row) { return row ? { id: row.id, kind: row.kind, ...JSON.parse(row.data), created: row.created, updated: row.updated, revision: row.revision } : null; }
  get(id) { return this.row(this.db.prepare('SELECT * FROM entities WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM entities ORDER BY created DESC, id').all().map(r => this.row(r)); }
  save(kind, input, id = randomUUID()) {
    const old = this.get(id);
    if (old && old.kind !== kind) throw new AppError('資料類型不可變更');
    if (old && Number(input.revision) !== old.revision) throw new AppError('資料已由其他頁籤修改，請重新載入後再編輯。', 409);
    const data = { ...input };
    for (const key of ['id', 'kind', 'created', 'updated', 'revision', 'attachment']) delete data[key];
    validateEntity(kind, data, key => this.get(key));
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO entities(id,kind,data,created,updated,revision) VALUES (?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated, revision=entities.revision+1`).run(id, kind, JSON.stringify(data), old?.created || now, now);
    return this.get(id);
  }
  attachment(sourceId) {
    const row = this.db.prepare('SELECT id,source_id,name,mime,sha,length(bytes) as size FROM attachments WHERE source_id=?').get(sourceId);
    return row || null;
  }
  attach(sourceId, name, mime, bytes) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(id, sourceId, name, mime, hash(bytes), bytes);
    return id;
  }
  file(id) { return this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id); }
  files() { return this.db.prepare('SELECT * FROM attachments').all(); }
  state() { return this.list().map(e => ({ ...e, ...(e.kind === 'source' ? { attachment: this.attachment(e.id) } : {}) })); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
