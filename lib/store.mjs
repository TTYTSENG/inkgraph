import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { projectsOf, scopedState } from '../public/project-scope.js';
import { noteSourceIds, usedExcerpts, excerptSnapshot } from '../public/research-workspace.js';
import { OBJECT_KINDS, SHARED_KINDS, LINK_LABELS, ROLE_LABELS, recordSourceIds } from '../public/knowledge-model.js';
import { validateTaxonomy } from './taxonomy.mjs';
import { usedObjectLinks } from '../public/object-navigation.js';

export const KINDS = ['project', 'source', 'annotation', 'term', 'note', 'relation', 'membership', 'search-run', 'discussion','message','concept','link','category','conversion-history'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function validateEntity(kind, d, lookup) {
  if (!KINDS.includes(kind) || !d || typeof d !== 'object' || Array.isArray(d)) throw new AppError('無效的資料類型');
  if (JSON.stringify(d).length > 2_000_000) throw new AppError('文字資料超過 2 MB');
  validateTaxonomy(kind,d,lookup);
  if(kind==='conversion-history'&&(!['convert','derive'].includes(d.mode)||typeof d.entityId!=='string'||!['note','term'].includes(d.before?.kind)||typeof d.afterFingerprint!=='string'||!Number.isInteger(d.afterRevision)))throw new AppError('改列歷程格式錯誤');
  if(d.scopeNote!=null&&typeof d.scopeNote!=='string')throw new AppError('辨義提醒必須為文字');
  if(kind==='category'){
    const seen=new Set(d.id?[d.id]:[]);let parent=d.parentId;
    while(parent){if(seen.has(parent))throw new AppError('分類不能形成循環');seen.add(parent);parent=lookup(parent)?.parentId;}
  }
  const stringFields=['title','description','purpose','projectId','sourceId','entityId','discussionId','role','from','to','fromLocator','toLocator','relation','quote','locator','paraphrase','comment','term','aliases','definition','example','tags','content','noteType','text','summary','method','findings','limitations','journal','publisher','volume','issue','pageRange','doi','url','origin','cslType','reason'];
  for (const key of stringFields) if (d[key]!=null && typeof d[key]!=='string') throw new AppError(`${key} 必須為文字`);
  if (kind !== 'relation' && kind !== 'annotation' && (!d.title || typeof d.title !== 'string' || d.title.length > 500)) throw new AppError('請填寫標題（最多 500 字）');
  const ref = (id, expected) => {
    if (!id) return;
    const entity = lookup(id);
    if (!entity || entity.kind !== expected) throw new AppError(`找不到相關 ${expected} 資料`);
  };
  if (kind !== 'project') ref(d.projectId, 'project');
  if(kind==='membership'){
    if((!d.sourceId&&!d.entityId)||(d.sourceId&&d.entityId)||!d.projectId)throw new AppError('專案連結需要單一項目與專案');
    if(d.sourceId)ref(d.sourceId,'source');
    if(d.entityId&&!SHARED_KINDS.includes(lookup(d.entityId)?.kind))throw new AppError('此資料不能加入多個專案');
  }
  if (d.projectIds!=null&&(!Array.isArray(d.projectIds)||d.projectIds.some(id=>typeof id!=='string')))throw new AppError('專案連結格式錯誤');
  if (kind === 'discussion' || kind === 'message') {
    if(!Array.isArray(d.sourceIds)||d.sourceIds.length>500)throw new AppError('討論來源格式錯誤');
    d.sourceIds.forEach(id=>ref(id,'source'));
    if(kind==='discussion'&&!['manual','gemini','notebooklm'].includes(d.origin))throw new AppError('請選擇討論來源');
    if(kind==='message'){
      ref(d.discussionId,'discussion');
      if(!d.discussionId||!Object.hasOwn(ROLE_LABELS,d.role)||typeof d.content!=='string'||!d.content.trim())throw new AppError('討論訊息需要角色、內容與所屬討論');
    }
  }
  if(kind==='link'){
    const from=lookup(d.from),to=lookup(d.to);
    if(!OBJECT_KINDS.includes(from?.kind)||!OBJECT_KINDS.includes(to?.kind)||d.from===d.to)throw new AppError('請選擇兩個不同的研究項目');
    if(!Object.hasOwn(LINK_LABELS,d.relation))throw new AppError('不支援的物件關係');
    if(['supports','contradicts'].includes(d.relation)&&(!d.reason?.trim()||!['note','message'].includes(to.kind)))throw new AppError('支持／反駁必須指向筆記或訊息，並填寫理由與證據位置');
    if(d.relation==='defines'&&to.kind!=='concept')throw new AppError('定義關係必須指向概念');
    if(d.relation==='about'&&to.kind!=='concept')throw new AppError('關於關係必須指向概念');
    if(d.targetRevision!=null&&(!Number.isInteger(d.targetRevision)||d.targetRevision<1))throw new AppError('素材版本格式錯誤');
  }
  if (['annotation', 'term'].includes(kind)) ref(d.sourceId, 'source');
  if (kind === 'annotation') {
    if (!d.sourceId || typeof d.quote !== 'string' || !d.quote.trim()) throw new AppError('摘錄需要原文與來源');
    if (typeof d.locator !== 'string' || !d.locator.trim()) throw new AppError('請填寫頁碼、段落或圖片位置');
  }
  if (kind === 'note' || kind === 'term') {
    if (kind==='note'||d.sourceIds!=null){
      if (!Array.isArray(d.sourceIds) || d.sourceIds.length > 500) throw new AppError('來源格式錯誤');
      d.sourceIds.forEach(id => ref(id, 'source'));
    }
    if (d.excerptRefs != null) {
      if (!Array.isArray(d.excerptRefs) || d.excerptRefs.length > 500) throw new AppError('摘錄引用格式錯誤');
      const ids = new Set();
      for (const snapshot of d.excerptRefs) {
        if (!snapshot || typeof snapshot !== 'object' ||
            ['id','annotationId','sourceId'].some(k => typeof snapshot[k] !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(snapshot[k])) || ids.has(snapshot.id))
          throw new AppError('摘錄引用 ID 無效或重複');
        ids.add(snapshot.id);
        if (typeof snapshot.quote !== 'string' || !snapshot.quote.trim() || typeof snapshot.locator !== 'string' || !snapshot.locator.trim() ||
            ['paraphrase','comment','sourceHash','capturedAt'].some(k => typeof snapshot[k] !== 'string') ||
            typeof snapshot.verified !== 'boolean' || !Number.isInteger(snapshot.annotationRevision) || snapshot.annotationRevision < 1 ||
            (snapshot.sourceRevision != null && (!Number.isInteger(snapshot.sourceRevision) || snapshot.sourceRevision < 1)))
          throw new AppError('摘錄引用內容不完整');
      }
    }
  }
  if (kind === 'relation') {
    ref(d.from, 'source'); ref(d.to, 'source');
    if (!d.from || !d.to || d.from === d.to) throw new AppError('請選擇兩個不同來源');
    if (!['supports', 'contradicts', 'extends', 'compares'].includes(d.relation)) throw new AppError('無效的關係');
  }
  if (kind === 'source') {
    if(d.projectIds!=null&&(!Array.isArray(d.projectIds)||d.projectIds.some(id=>typeof id!=='string')))throw new AppError('專案連結格式錯誤');
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
    this.originalsRoot=resolve(path===':memory:'?'.':dirname(path),'originals');
    this.mobileTempRoot=resolve(path===':memory:'?'.':dirname(path),'mobile-staging');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES entities(id), name TEXT NOT NULL, mime TEXT NOT NULL, sha TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS attachment_source ON attachments(source_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS external_attachments(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,sha TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mobile_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mobile_captures(device_id TEXT NOT NULL,capture_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,note_id TEXT NOT NULL,manifest TEXT NOT NULL,receipt TEXT NOT NULL,received TEXT NOT NULL,PRIMARY KEY(device_id,capture_id,revision));
      CREATE TABLE IF NOT EXISTS media_jobs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,kind TEXT NOT NULL,state TEXT NOT NULL,settings TEXT NOT NULL,result TEXT,error TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,attempts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS media_job_state ON media_jobs(state,created);`);
  }
  row(row) { return row ? { id: row.id, kind: row.kind, ...JSON.parse(row.data), created: row.created, updated: row.updated, revision: row.revision } : null; }
  decorate(rows) {
    const links=this.db.prepare("SELECT data FROM entities WHERE kind='membership'").all().map(r=>JSON.parse(r.data));
    const map=new Map();for(const link of links){const id=link.sourceId||link.entityId,ids=map.get(id)||[];ids.push(link.projectId);map.set(id,ids);}
    const discussions=new Map(this.db.prepare("SELECT id,data FROM entities WHERE kind='discussion'").all().map(r=>[r.id,JSON.parse(r.data)]));
    return rows.map(r=>(r.kind==='source'||SHARED_KINDS.includes(r.kind)&&map.has(r.id))?{...r,projectIds:[...new Set([r.projectId,...(map.get(r.id)||[])].filter(Boolean))]}:
      r.kind==='message'?{...r,projectId:discussions.get(r.discussionId)?.projectId||null,projectIds:[...new Set([discussions.get(r.discussionId)?.projectId,...(map.get(r.discussionId)||[])].filter(Boolean))]}:r);
  }
  get(id) { const row=this.row(this.db.prepare('SELECT * FROM entities WHERE id=?').get(id));return row&&(SHARED_KINDS.includes(row.kind)||row.kind==='message')?this.decorate([row])[0]:row; }
  list() { return this.decorate(this.db.prepare('SELECT * FROM entities ORDER BY created DESC, id').all().map(r => this.row(r))); }
  save(kind, input, id = randomUUID()) {
    const old = this.get(id);
    if (old && old.kind !== kind) throw new AppError('資料類型不可變更');
    if (old && Number(input.revision) !== old.revision) throw new AppError('資料已由其他頁籤修改，請重新載入後再編輯。', 409);
    const data = { ...(old||{}), ...input };
    for (const key of ['id', 'kind', 'created', 'updated', 'revision', 'attachment']) delete data[key];
    delete data.bodyDeferred;
    delete data.excerptAnnotationIds;delete data.navigationTargetIds;delete data.referencedSourceIds;
    delete data.projectIds;
    if(kind==='category'){
      if(old&&old.axis!==data.axis&&this.list().some(r=>r.kind==='category'&&r.parentId===id))throw new AppError('有子分類時不能更換分類軸，請先移動子分類');
      const seen=new Set([id]);let parent=data.parentId;
      while(parent){if(seen.has(parent))throw new AppError('分類不能移入本身或子分類');seen.add(parent);parent=this.get(parent)?.parentId;}
      if(this.list().some(r=>r.kind==='category'&&r.id!==id&&r.axis===data.axis&&(r.parentId||null)===(data.parentId||null)&&r.title.trim()===data.title?.trim()))throw new AppError('同一層已有同名分類');
    }
    if(kind==='membership'&&this.db.prepare("SELECT id FROM entities WHERE kind='membership' AND coalesce(json_extract(data,'$.sourceId'),json_extract(data,'$.entityId'))=? AND json_extract(data,'$.projectId')=? AND id<>?").get(data.sourceId||data.entityId,data.projectId,id))throw new AppError('專案已連結此項目');
    validateEntity(kind, data, key => this.get(key));
    if (kind === 'note' || kind === 'term') for (const snapshot of data.excerptRefs || []) {
      const previous = old?.excerptRefs?.find(ref => ref.id === snapshot.id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(snapshot)) throw new AppError('既有摘錄引用為固定快照，請重新加入新版摘錄');
      } else {
        const annotation = this.get(snapshot.annotationId);
        if (annotation?.kind !== 'annotation' || !this.get(annotation.sourceId)) throw new AppError('找不到要引用的摘錄');
        const expected = excerptSnapshot(annotation, snapshot.id, snapshot.capturedAt);
        if (Object.keys(expected).some(key => expected[key] !== snapshot[key])) throw new AppError('摘錄已變更，請重新選取後加入',409);
      }
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO entities(id,kind,data,created,updated,revision) VALUES (?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated, revision=entities.revision+1`).run(id, kind, JSON.stringify(data), old?.created || now, now);
    return this.get(id);
  }
  attachment(sourceId) {
    const row = this.db.prepare('SELECT id,source_id,name,mime,sha,length(bytes) as size FROM attachments WHERE source_id=? ORDER BY rowid DESC LIMIT 1').get(sourceId);
    return row || this.db.prepare('SELECT id,source_id,name,mime,sha,size FROM external_attachments WHERE source_id=? ORDER BY created DESC LIMIT 1').get(sourceId) || null;
  }
  attach(sourceId, name, mime, bytes) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(id, sourceId, name, mime, hash(bytes), bytes);
    return id;
  }
  file(id) { return this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id)||this.db.prepare('SELECT * FROM external_attachments WHERE id=?').get(id); }
  files() { return [...this.db.prepare('SELECT * FROM attachments').all(),...this.db.prepare('SELECT * FROM external_attachments').all()]; }
  state({summary=false}={}) {
    const rows=summary?this.decorate(this.db.prepare("SELECT id,kind,CASE WHEN kind='source' THEN json_remove(data,'$.text','$.pages') WHEN kind='term' THEN json_remove(data,'$.content','$.excerptRefs') ELSE data END AS data,created,updated,revision FROM entities WHERE kind NOT IN ('membership','search-run','conversion-history') ORDER BY created DESC,id").all().map(r=>this.row(r))):this.list().filter(r=>r.kind!=='conversion-history');
    const files=new Map(this.db.prepare('SELECT id,source_id,name,mime,sha,length(bytes) as size FROM attachments ORDER BY rowid').all().map(f=>[f.source_id,f]));
    for(const file of this.db.prepare('SELECT id,source_id,name,mime,sha,size FROM external_attachments').all())files.set(file.source_id,file);
    const hints=new Map(summary?this.db.prepare("SELECT id,data FROM entities WHERE kind='term'").all().map(r=>{const data=JSON.parse(r.data);return [r.id,{excerptAnnotationIds:[...new Set(usedExcerpts(data).map(ref=>ref.annotationId))],navigationTargetIds:usedObjectLinks(data),referencedSourceIds:noteSourceIds(data)}];}):[]);
    return rows.map(e=>({...e,...(e.kind==='source'?{attachment:files.get(e.id)||null,...(summary?{bodyDeferred:true}:{})}:e.kind==='term'&&summary?{bodyDeferred:true,...hints.get(e.id)}:{})}));
  }
  search(query,{projectId='',offset=0,limit=50}={}) {
    if(typeof query!=='string'||!query.trim()||query.length>300)throw new AppError('請輸入 1 至 300 字搜尋文字');
    offset=Math.max(0,Math.min(100000,Number(offset)||0));limit=Math.max(1,Math.min(100,Number(limit)||50));
    const hits=this.decorate(this.db.prepare("SELECT id,kind,json_remove(data,'$.text','$.pages') AS data,created,updated,revision FROM entities WHERE kind IN ('source','note','annotation','term','discussion','message','concept') AND instr(lower(data),lower(?))>0 ORDER BY updated DESC,id").all(query.trim()).map(r=>this.row(r)));
    const hitIds=new Set(hits.map(r=>r.id));
    const sources=projectId?this.decorate(this.db.prepare("SELECT id,kind,json_remove(data,'$.text','$.pages') AS data,created,updated,revision FROM entities WHERE kind IN ('source','note','discussion','concept','term')").all().map(r=>this.row(r))):[];
    const scoped=scopedState([...sources.filter(r=>!hitIds.has(r.id)),...hits],projectId).filter(r=>hitIds.has(r.id));return {total:scoped.length,offset,limit,entities:scoped.slice(offset,offset+limit)};
  }
  linkSource(sourceId,projectId) {
    const source=this.get(sourceId);if(source?.kind!=='source'||this.get(projectId)?.kind!=='project')throw new AppError('找不到來源或專案');
    if(projectsOf(source).includes(projectId))return {linked:false};
    return {linked:true,link:this.save('membership',{title:'專案來源連結',sourceId,projectId})};
  }
  batchLinkSources({sources,projectId,newProject}) {
    if(!Array.isArray(sources)||!sources.length||sources.length>500||sources.some(s=>!s||typeof s.id!=='string'||!Number.isInteger(s.revision)))throw new AppError('請勾選 1 至 500 份來源，並提供目前版本');
    if(new Set(sources.map(s=>s.id)).size!==sources.length)throw new AppError('批量來源不可重複');
    if(Boolean(projectId)===Boolean(newProject))throw new AppError('請選擇既有專案或建立新專案');
    return this.transaction(()=>{
      for(const selected of sources){const row=this.get(selected.id);if(row?.kind!=='source')throw new AppError('部分來源已移除，未進行任何批量修改',409);if(row.revision!==selected.revision)throw new AppError('部分來源已更新，請重新載入後再勾選',409);}
      const project=newProject?this.save('project',{title:typeof newProject.title==='string'?newProject.title.trim():'',description:'',purpose:'academic'}):this.get(projectId);
      if(project?.kind!=='project')throw new AppError('找不到所選專案');
      let linked=0;for(const selected of sources)if(this.linkSource(selected.id,project.id).linked)linked++;
      return {project,total:sources.length,linked,alreadyLinked:sources.length-linked};
    });
  }
  linkEntity(id,projectId) {
    const entity=this.get(id);
    if(entity?.kind==='source')return this.linkSource(id,projectId);
    if(!SHARED_KINDS.includes(entity?.kind)||this.get(projectId)?.kind!=='project')throw new AppError('找不到項目或專案');
    if(projectsOf(entity).includes(projectId))return {linked:false};
    return {linked:true,link:this.save('membership',{title:'專案項目連結',entityId:id,projectId})};
  }
  discussionFromSource({sourceId,title,origin,content='',projectId=null}) {
    const source=this.get(sourceId);
    if(source?.kind!=='source'||!source.text?.trim())throw new AppError('此來源沒有可匯入的對話文字，請改為手動新增訊息');
    return this.transaction(()=>{
      const discussion=this.save('discussion',{title,origin,content,sourceIds:[sourceId],projectId});
      this.save('message',{title:'匯入的對話原文',role:'unknown',content:source.text,discussionId:discussion.id,sourceIds:[sourceId],projectId,importedSourceId:source.id,importedSourceRevision:source.revision});
      return discussion;
    });
  }
  noteFromDiscussion({id,title,content,projectId=null}) {
    const target=this.get(id);
    if(!['discussion','message'].includes(target?.kind)||typeof content!=='string'||!content.trim())throw new AppError('請選擇討論或訊息，並填寫自己的理解');
    return this.transaction(()=>{
      const sourceIds=recordSourceIds(target,this.list()).filter(id=>this.get(id)?.kind==='source');
      const note=this.save('note',{title,content:`${content.trim()}\n\n## 討論素材（待核對，不等於原始文獻）\n\n> ${(target.content||'').replace(/\n/g,'\n> ')}`,sourceIds,noteType:'research',projectId});
      this.save('link',{title:'衍生自',from:note.id,to:target.id,relation:'derived',reason:'由此討論素材整理，自己的理解與討論原文分開保存。',toLocator:`${target.kind==='message'?'訊息':'討論'}版本 ${target.revision}`,targetRevision:target.revision,projectId});
      return note;
    });
  }
  unlinkEntity(id,projectId,revision) {
    if(this.get(id)?.kind==='source')return this.unlinkSource(id,projectId,revision);
    return this.transaction(()=>{
      const entity=this.get(id);
      if(!SHARED_KINDS.includes(entity?.kind))throw new AppError('此資料不能管理專案連結');
      if(entity.revision!==revision)throw new AppError('項目已變更，請重新開啟',409);
      const state=this.list(),ids=new Set([id,...state.filter(r=>r.kind==='message'&&r.discussionId===id).map(r=>r.id)]);
      const dependent=scopedState(state,projectId).some(r=>r.kind==='link'&&(ids.has(r.from)||ids.has(r.to)));
      if(dependent)throw new AppError('此專案仍有物件連結使用此項目，請先整理後再解除連結',409);
      this.db.prepare("DELETE FROM entities WHERE kind='membership' AND json_extract(data,'$.entityId')=? AND json_extract(data,'$.projectId')=?").run(id,projectId);
      if(entity.projectId===projectId)this.save(entity.kind,{...entity,projectId:null},id);
      return {unlinked:true};
    });
  }
  unlinkSource(sourceId,projectId,revision) {
    return this.transaction(()=>{
      const source=this.get(sourceId);if(source?.kind!=='source')throw new AppError('找不到來源');
      if(source.revision!==revision)throw new AppError('來源已變更，請重新開啟',409);
      const dependents=scopedState(this.list(),projectId).filter(r=>r.kind!=='membership'&&r.id!==sourceId&&(r.sourceId===sourceId||(['note','term'].includes(r.kind)&&noteSourceIds(r).includes(sourceId))||(['discussion','message'].includes(r.kind)&&(r.sourceIds||[]).includes(sourceId))||r.from===sourceId||r.to===sourceId));
      if(dependents.length)throw new AppError('此專案仍有筆記、摘錄或關係使用此來源，請先整理後再解除連結',409);
      this.db.prepare("DELETE FROM entities WHERE kind='membership' AND json_extract(data,'$.sourceId')=? AND json_extract(data,'$.projectId')=?").run(sourceId,projectId);
      if(source.projectId===projectId)this.save('source',{...source,projectId:null},source.id);
      return {unlinked:true};
    });
  }
  sourceDeletion(id) {
    const source = this.get(id);
    if (!source || source.kind !== 'source') throw new AppError('找不到來源文獻', 404);
    const state=this.list();
    const related = state.filter(e =>
      (['annotation', 'term','membership'].includes(e.kind) && e.sourceId === id && !(e.kind==='term'&&Array.isArray(e.sourceIds))) ||
      (e.kind === 'relation' && (e.from === id || e.to === id)));
    const removedIds=new Set([id,...related.map(e=>e.id)]);
    related.push(...state.filter(e=>e.kind==='link'&&(removedIds.has(e.from)||removedIds.has(e.to))));
    const notes = state.filter(e => (e.kind==='note'||e.kind==='term'&&Array.isArray(e.sourceIds)) && noteSourceIds(e).includes(id));
    const discussions=state.filter(e=>['discussion','message'].includes(e.kind)&&(e.sourceIds||[]).includes(id));
    const files = [...this.db.prepare('SELECT id FROM attachments WHERE source_id=? ORDER BY id').all(id),...this.db.prepare('SELECT id FROM external_attachments WHERE source_id=? ORDER BY id').all(id)];
    const fingerprint = hash(Buffer.from(JSON.stringify({
      source: [source.id, source.revision],
      related: related.map(e => [e.id, e.revision]),
      notes: notes.map(e => [e.id, e.revision]), discussions:discussions.map(e=>[e.id,e.revision]), files: files.map(f => f.id)
    })));
    return {source, related, notes, discussions, files, fingerprint};
  }
  sourceDeletionPreview(id) {
    const p = this.sourceDeletion(id);
    return {id, title: p.source.title, projects:projectsOf(p.source),fingerprint: p.fingerprint,
      attachments: p.files.length,
      annotations: p.related.filter(e => e.kind === 'annotation').length,
      terms: p.related.filter(e => e.kind === 'term').length,
      relations: p.related.filter(e => e.kind === 'relation').length,
      notes: p.notes.length,discussions:p.discussions.length,objectLinks:p.related.filter(e=>e.kind==='link').length};
  }
  deleteSource(id, fingerprint) {
    return this.transaction(() => {
      const p = this.sourceDeletion(id);
      if (!fingerprint || fingerprint !== p.fingerprint)
        throw new AppError('文獻或關聯資料已變更，請取消後重新開啟刪除確認。', 409);
      for (const note of p.notes) this.save(note.kind, {
        ...note, sourceId:note.sourceId===id?null:note.sourceId, sourceIds: (note.sourceIds || []).filter(sourceId => sourceId !== id)
      }, note.id);
      for(const row of p.discussions)this.save(row.kind,{...row,sourceIds:row.sourceIds.filter(sourceId=>sourceId!==id)},row.id);
      this.db.prepare('DELETE FROM attachments WHERE source_id=?').run(id);
      const remove = this.db.prepare('DELETE FROM entities WHERE id=?');
      for (const entity of p.related) remove.run(entity.id);
      remove.run(id);
      return {deleted: id, title: p.source.title};
    });
  }
  entityDeletion(id) {
    const entity = this.get(id);
    if (!entity) throw new AppError('找不到要刪除的資料', 404);
    if (!['project','annotation','term','note','relation','discussion','message','concept','link'].includes(entity.kind))
      throw new AppError('文獻請使用刪除文獻功能');
    const members = entity.kind === 'project' ? this.list().filter(e => e.projectId === id) : [];
    const children=entity.kind==='discussion'?this.list().filter(e=>e.kind==='message'&&e.discussionId===id):[];
    const ids=new Set([id,...children.map(e=>e.id)]);
    const connected=entity.kind==='project'?[]:this.list().filter(e=>(e.kind==='link'&&(ids.has(e.from)||ids.has(e.to)))||(e.kind==='membership'&&e.entityId===id));
    const references = entity.kind === 'annotation' ? this.list().filter(e=>['note','term'].includes(e.kind)&&usedExcerpts(e).some(ref=>ref.annotationId===id)) : [];
    const fingerprint = hash(Buffer.from(JSON.stringify({
      entity: [entity.id,entity.revision], members: members.map(e => [e.id,e.revision]), references: references.map(e=>[e.id,e.revision]),children:children.map(e=>[e.id,e.revision]),connected:connected.map(e=>[e.id,e.revision])
    })));
    return {entity,members,references,children,connected,fingerprint};
  }
  entityDeletionPreview(id) {
    const p = this.entityDeletion(id);
    return {id,kind:p.entity.kind,title:p.entity.title || p.entity.quote || '文獻關係',
      fingerprint:p.fingerprint,moved:p.members.length,linkedNotes:p.references.length,removedMessages:p.children.length,removedLinks:p.connected.filter(e=>e.kind==='link').length};
  }
  deleteEntity(id, fingerprint) {
    return this.transaction(() => {
      const p = this.entityDeletion(id);
      if (!fingerprint || fingerprint !== p.fingerprint)
        throw new AppError('資料已變更，請取消後重新開啟刪除確認。',409);
      for (const member of p.members) {
        if(member.kind==='membership')this.db.prepare('DELETE FROM entities WHERE id=?').run(member.id);
        else this.save(member.kind,{...member,projectId:null},member.id);
      }
      for(const row of [...p.children,...p.connected])this.db.prepare('DELETE FROM entities WHERE id=?').run(row.id);
      this.db.prepare("DELETE FROM entities WHERE kind='conversion-history' AND json_extract(data,'$.entityId')=?").run(id);
      this.db.prepare('DELETE FROM entities WHERE id=?').run(id);
      return {deleted:id,kind:p.entity.kind,moved:p.members.length};
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
