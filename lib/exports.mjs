import JSZip from 'jszip';
import { AppError, KINDS, validateEntity, hash } from './store.mjs';
import { bibliography, cslItem, ris, inText } from './citations.mjs';
import { mapReferences } from './note-references.mjs';
import { evidenceText } from '../public/research-evidence.js';
import { scopedState } from '../public/project-scope.js';
import { noteSourceIds, usedExcerpts, mapExcerpts, excerptMarkdown } from '../public/research-workspace.js';
import { exportDependencies, knowledgeText } from './knowledge-export.mjs';
import { KIND_LABELS } from '../public/knowledge-model.js';
import { mapObjectLinks, objectLinkText } from '../public/object-navigation.js';
import { AXES, categoryPath } from '../public/taxonomy-model.js';
import { captureText } from '../public/mobile-model.js';

function termText(term,state){
  const resolved=resolveNote(term,state.filter(r=>r.kind==='source'),'text',state);
  const categories=(term.categoryIds||[]).map(id=>{const c=state.find(r=>r.id===id);return c?`${AXES[c.axis]}：${categoryPath(c,state)}`:`分類已移除：${id}`;});
  return `ID：${term.id}\n原語／別名：${term.aliases||''}\n簡明釋義（自己的整理）：${term.definition||''}\n辨義提醒：${term.scopeNote||''}\n例句／應用：${term.example||''}\n整理狀態：${term.reviewStatus||'待整理'}\n分類：${categories.join('；')||'未分類'}\n來源 ID：${[...new Set([...(term.sourceIds||[]),term.sourceId].filter(Boolean))].join('、')||'個人整理'}\n${captureText(term)}\n\n### 完整說明\n\n${resolved.content}\n\n### 本篇來源\n\n${resolved.bibliography.join('\n\n')}`;
}

export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const csv = rows => '\uFEFF' + rows.map(row => row.map(c => {
  const v = String(c ?? '');
  // Spreadsheet-safe values: don't execute formulas in a user's Excel session.
  return '"' + (/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"';
}).join(',')).join('\r\n');
const LABEL = { supports: '支持', contradicts: '反駁', extends: '延伸', compares: '比較' };
export function projectState(state, projectId) {
  const selected = scopedState(state,projectId);
  return exportDependencies(selected,state);
}
export function resolveNote(note, sources, mode = 'text', context = sources) {
  const cited = new Set(noteSourceIds(note));
  const refs = sources.filter(s => cited.has(s.id));
  const labels=[];
  // Keep generated link labels out of citation/excerpt parsing, including marker-like titles.
  const names=new Map();mapObjectLinks(note.content,({id,marker})=>{names.set(id,objectLinkText(id,context,note.objectLinkTargets||[]));return marker;});
  const material=JSON.stringify(note)+JSON.stringify([...names.values()]);
  let tokenPrefix='\uE000inkgraph-link';
  while(material.includes(tokenPrefix))tokenPrefix+='x';
  const navigationText=mapObjectLinks(note.content,({id})=>{const index=labels.push(names.get(id))-1;return `${tokenPrefix}:${index}\uE001`;});
  const citedText = mapReferences(navigationText, ({marker, id, page}) => {
    if (!sources.some(s => s.id === id)) return `${marker}〔來源遺失〕`;
    return inText(refs, id, page || '');
  });
  const result = mapExcerpts(citedText, ({marker,id}) => {
    const snapshot = usedExcerpts(note).find(ref => ref.id === id);
    if (!snapshot) return `${marker}〔摘錄引用遺失〕`;
    const source = sources.find(s => s.id === snapshot.sourceId);
    // Locator may describe a file page or paragraph; do not turn it into an APA print-page number.
    const citation = source ? inText(refs, source.id, '') : '〔原始來源已移除〕';
    return excerptMarkdown(snapshot, source, citation);
  });
  const content=labels.reduce((value,label,i)=>value.replaceAll(`${tokenPrefix}:${i}\uE001`,label),result);
  return { content, refs, bibliography: bibliography(refs, mode) };
}
export function markdown(state) {
  const sources = state.filter(e => e.kind === 'source');
  const title = state.find(e => e.kind === 'project')?.title || '墨脈研究匯出';
  const blocks = [`# ${title}`, '> InkGraph 匯出；摘錄核對狀態與來源定位一併保留。'];
  for(const s of sources)if(evidenceText(s))blocks.push(`## 查證資訊：${s.title}\n\n來源 ID：${s.id}\n\n${evidenceText(s)}`);
  for (const s of sources) blocks.push(`## 來源：${s.title}\n\nID: ${s.id}\n\n${bibliography([s], 'text').join('')}\n\n來源類別：${s.origin || 'local'}\n\n${s.summary || ''}\n\n方法：${s.method || ''}\n\n發現：${s.findings || ''}\n\n限制：${s.limitations || ''}`);
  for (const a of state.filter(e => e.kind === 'annotation')) blocks.push(`## 摘錄：${sources.find(s => s.id === a.sourceId)?.title || a.sourceId}\n\n定位：${a.locator}\n\n核對狀態：${a.verified ? '已人工核對' : '待核對'}\n\n> ${a.quote.replace(/\n/g, '\n> ')}\n\n釋義：${a.paraphrase || ''}\n\n我的加註：${a.comment || ''}\n\n相關術語：${a.term || ''}`);
  for (const t of state.filter(e => e.kind === 'term')) blocks.push(`## 術語：${t.title}\n\n${termText(t,state)}`);
  for (const n of state.filter(e => e.kind === 'note')) { const r = resolveNote(n,sources,'text',state); blocks.push(`## 筆記：${n.title}\n\nID：${n.id}\n\n${captureText(n)}\n\n${r.content}\n\n### 本篇來源\n\n${r.bibliography.join('\n\n')}`); }
  for (const r of state.filter(e => e.kind === 'relation')) blocks.push(`## 文獻關係\n\n${sources.find(s => s.id === r.from)?.title || r.from} → ${LABEL[r.relation]} → ${sources.find(s => s.id === r.to)?.title || r.to}\n\n理由與證據：${r.reason || ''}`);
  for(const row of state.filter(r=>['concept','discussion','message','link'].includes(r.kind)))blocks.push(`## ${KIND_LABELS[row.kind]||'物件連結'}：${row.title}\n\n${knowledgeText(row,state)}`);
  blocks.push(`## APA 參考文獻\n\n${bibliography(sources,'text').join('\n\n')}`);
  return blocks.join('\n\n---\n\n');
}
export function reportHTML(state) {
  const sources = state.filter(e => e.kind === 'source');
  const title = state.find(e => e.kind === 'project')?.title || '墨脈研究匯出';
  const body = state.filter(e => !['project','relation','membership','search-run','category','conversion-history'].includes(e.kind)).map(e => {
    let text = '';
    if (e.kind === 'source') text = `摘要：${e.summary || ''}\n方法：${e.method || ''}\n發現：${e.findings || ''}\n限制：${e.limitations || ''}`;
    if (e.kind === 'annotation') text = `來源：${sources.find(s => s.id === e.sourceId)?.title || e.sourceId}\n定位：${e.locator}\n核對：${e.verified ? '已人工核對' : '待核對'}\n\n原文：${e.quote}\n\n釋義：${e.paraphrase || ''}\n\n加註：${e.comment || ''}`;
    if (e.kind === 'term') text = termText(e,state);
    if (e.kind === 'note') { const n = resolveNote(e,sources,'text',state); text = captureText(e)+'\n\n'+n.content + '\n\n本篇來源：\n' + n.bibliography.join('\n'); }
    if(['concept','discussion','message','link'].includes(e.kind))text=knowledgeText(e,state);
    if(e.kind==='source'&&evidenceText(e))text+='\n\n'+evidenceText(e);
    return `<section><h2>${escapeHTML(e.title || '文段摘錄')}</h2><p>${escapeHTML(text).replace(/\n/g,'<br>')}</p></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>${escapeHTML(title)}</title><style>body{font-family:Arial,"Microsoft JhengHei",sans-serif;max-width:820px;margin:48px auto;color:#263832;line-height:1.8;padding:24px}h1{font-size:32px}h2{font-size:21px;border-bottom:1px solid #ccc}section{break-inside:avoid}.csl-entry{padding-left:2em;text-indent:-2em;margin:12px 0}@media print{body{margin:0;max-width:none}@page{size:A4;margin:22mm}}</style><body><h1>${escapeHTML(title)}</h1><p>墨脈 InkGraph · 研究匯出</p>${body}<h2>APA 參考文獻</h2>${bibliography(sources).join('')}<footer>APA formatting powered by citeproc-js © Frank Bennett (AGPL-3.0-or-later).</footer></body></html>`;
}
export function exportContent(state, format) {
  const sources = state.filter(e => e.kind === 'source');
  switch (format) {
    case 'markdown': return ['text/markdown; charset=utf-8', 'research.md', markdown(state)];
    case 'html': return ['text/html; charset=utf-8', 'research-report.html', reportHTML(state)];
    case 'apa': return ['text/plain; charset=utf-8','references-apa.txt',bibliography(sources,'text').join('\n\n')];
    case 'ris': return ['application/x-research-info-systems','references.ris',ris(sources)];
    case 'csl': return ['application/json; charset=utf-8','references.csl.json',JSON.stringify(sources.filter(s=>s.cslType!=='personal-communication').map(cslItem),null,2)];
    case 'matrix': return ['text/csv; charset=utf-8','literature-matrix.csv', csv([['ID','文獻','作者','年份','摘要','研究方法','主要發現','限制','DOI'],...sources.map(s=>[s.id,s.title,(s.authors||[]).map(a=>a.literal||`${a.family}, ${a.given||''}`).join('; '),s.year,s.summary,s.method,s.findings,s.limitations,s.doi])])];
    case 'glossary': return ['text/csv; charset=utf-8','glossary.csv',csv([['ID','術語','外文／別名','定義','例句','來源ID','辨義提醒','完整說明','分類ID(JSON)','整理狀態'],...state.filter(e=>e.kind==='term').map(t=>[t.id,t.title,t.aliases,t.definition,t.example,JSON.stringify([...new Set([...(t.sourceIds||[]),t.sourceId].filter(Boolean))]),t.scopeNote,resolveNote(t,sources,'text',state).content,JSON.stringify(t.categoryIds||[]),t.reviewStatus||'待整理'])])];
    case 'taxonomy': return ['text/csv; charset=utf-8','glossary-categories.csv',csv([['詞條ID','詞名','分類ID','分類軸','分類路徑'],...state.filter(r=>r.kind==='term').flatMap(t=>(t.categoryIds||[]).map(id=>{const c=state.find(r=>r.kind==='category'&&r.id===id);return [t.id,t.title,id,AXES[c?.axis]||'',c?categoryPath(c,state):'分類已移除'];}))])];
    case 'json': return ['application/json; charset=utf-8','inkgraph-records.json',JSON.stringify({version:1,entities:state},null,2)];
    default: throw new AppError('不支援的輸出格式');
  }
}
export async function backup(store) {
  if(store.db.prepare('SELECT id FROM external_attachments LIMIT 1').get()||store.db.prepare('SELECT capture_id FROM mobile_captures LIMIT 1').get())throw new AppError('此研究庫含手機原始媒體，請使用第5版串流完整備份');
  const zip = new JSZip();
  const files = store.files();
  const entities = store.list();
  zip.file('manifest.json', JSON.stringify({format:'inkgraph',version:4,exported:new Date().toISOString(),entities,attachments:files.map(({bytes,...f})=>f)},null,2));
  for (const f of files) zip.file(`attachments/${f.id}`,f.bytes);
  zip.file('research.md',markdown(entities));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function restore(store, bytes) {
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new AppError('不是有效的 ZIP 備份'); }
  const entries = Object.values(zip.files);
  if (entries.length > 5000 || entries.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0)>250*1024*1024) throw new AppError('備份解壓縮後超過 250 MB 或檔案太多');
  const mf = zip.file('manifest.json');
  if (!mf || mf._data?.uncompressedSize > 8*1024*1024) throw new AppError('缺少或無效的備份清單');
  let manifest;
  try { manifest=JSON.parse(await mf.async('string')); } catch { throw new AppError('備份清單格式錯誤'); }
  if (manifest.format !== 'inkgraph' || ![1,2,3,4].includes(manifest.version) || !Array.isArray(manifest.entities) || !Array.isArray(manifest.attachments)) throw new AppError('不相容的備份版本');
  const byId = new Map();
  for (const e of manifest.entities) {
    if (!e || !/^[a-zA-Z0-9-]{1,80}$/.test(e.id) || !KINDS.includes(e.kind) || byId.has(e.id)) throw new AppError('備份資料 ID 或類型錯誤');
    byId.set(e.id,e);
  }
  for (const e of byId.values()) {
    validateEntity(e.kind,e,id=>byId.get(id));
    const existing = store.get(e.id);
    const canonical=v=>JSON.stringify(Object.fromEntries(Object.entries(v).filter(([key])=>key!=='projectIds').sort(([a],[b])=>a.localeCompare(b))));
    if (existing && canonical(existing) !== canonical(e)) throw new AppError('備份與目前資料有不同版本；請還原至新的資料目錄，以免覆寫。',409);
  }
  const prepared = [], attachmentIds = new Set();
  for (const f of manifest.attachments) {
    if (!f || !/^[a-zA-Z0-9-]{1,80}$/.test(f.id) || attachmentIds.has(f.id) || byId.get(f.source_id)?.kind !== 'source' || typeof f.name !== 'string' || typeof f.mime !== 'string') throw new AppError('備份附件格式錯誤');
    attachmentIds.add(f.id);
    const entry = zip.file(`attachments/${f.id}`);
    if (!entry || entry._data?.uncompressedSize > 25*1024*1024) throw new AppError('備份附件遺失或過大');
    const buffer = await entry.async('nodebuffer');
    if (hash(buffer) !== f.sha) throw new AppError('備份附件校驗失敗');
    const existing = store.file(f.id);
    if (existing && existing.sha !== f.sha) throw new AppError('附件版本衝突',409);
    prepared.push({...f,bytes:buffer});
  }
  return store.transaction(()=>{
    let added=0;
    for (const e of manifest.entities) {
      if (store.get(e.id)) continue;
      const {id,kind,created,updated,revision,...data}=e;
      delete data.projectIds;
      store.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(id,kind,JSON.stringify(data),created||new Date().toISOString(),updated||new Date().toISOString(),Number.isInteger(revision)&&revision>0?revision:1); added++;
    }
    for (const f of prepared) if (!store.file(f.id)) store.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(f.id,f.source_id,f.name,f.mime,f.sha,f.bytes);
    return {added,skipped:manifest.entities.length-added};
  });
}
