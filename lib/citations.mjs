import CSL from 'citeproc';
import { readFileSync } from 'node:fs';
const style = readFileSync(new URL('../vendor/apa.csl', import.meta.url), 'utf8');
const locale = readFileSync(new URL('../vendor/locales-en-US.xml', import.meta.url), 'utf8');
export function cslItem(s) {
  const item = { id: s.id, type: s.cslType || 'article-journal', title: s.title, author: s.authors || [] };
  const map = { publisher: 'publisher', url: 'URL', ...(item.type==='article-journal'?{journal:'container-title',volume:'volume',issue:'issue',pageRange:'page'}:{}) };
  for (const [field, key] of Object.entries(map)) if (s[field]) item[key] = s[field];
  if (s.doi) item.DOI = s.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (s.year) item.issued = { 'date-parts': [[Number(s.year)]] };
  return item;
}
export function citationEngine(sources, output = 'html') {
  sources = sources.filter(s => s.cslType !== 'personal-communication');
  const items = Object.fromEntries(sources.map(s => [s.id, cslItem(s)]));
  const engine = new CSL.Engine({ retrieveLocale: () => locale, retrieveItem: id => items[id] }, style, 'en-US');
  engine.setOutputFormat(output); engine.updateItems(Object.keys(items));
  return engine;
}
export function bibliography(sources, output = 'html') {
  sources = sources.filter(s => s.cslType !== 'personal-communication');
  if (!sources.length) return [];
  return citationEngine(sources, output).makeBibliography()?.[1] || [];
}
export function inText(sources, id, page = '') {
  if (sources.find(s => s.id === id)?.cslType === 'personal-communication') return '〔AI 對話／筆記：請配對原始文獻〕';
  const engine = citationEngine(sources, 'text');
  return engine.makeCitationCluster([{ id, ...(page ? { locator: page, label: 'page' } : {}) }]);
}
export function missingFields(s) {
  const missing = [];
  if (!s.authors?.length) missing.push('作者');
  if (!s.year) missing.push('年份');
  if ((s.cslType || 'article-journal') === 'article-journal' && !s.journal) missing.push('期刊名稱');
  if (s.cslType === 'book' && !s.publisher) missing.push('出版社');
  return missing;
}
export function ris(sources) {
  sources = sources.filter(s => s.cslType !== 'personal-communication');
  const lines = [];
  const clean = v => String(v || '').replace(/[\r\n]+/g, ' ');
  for (const s of sources) {
    lines.push(`TY  - ${s.cslType === 'book' ? 'BOOK' : s.cslType === 'webpage' ? 'ELEC' : s.cslType === 'report' ? 'RPRT' : 'JOUR'}`, `TI  - ${clean(s.title)}`);
    for (const a of s.authors || []) lines.push(`AU  - ${clean(a.literal || `${a.family}, ${a.given || ''}`)}`);
    for (const [field, tag] of Object.entries({ year:'PY', journal:'JO', publisher:'PB', volume:'VL', issue:'IS', doi:'DO', url:'UR' })) if (s[field]) lines.push(`${tag}  - ${clean(s[field])}`);
    if (s.pageRange) { const [start,end] = s.pageRange.split(/[-–]/); lines.push(`SP  - ${clean(start)}`); if (end) lines.push(`EP  - ${clean(end)}`); }
    lines.push('ER  - ', '');
  }
  return lines.join('\r\n');
}
