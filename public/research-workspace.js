// Shared reference rules for the reader, editor, exports and persistence layer.
import { projectsOf, scopedState } from './project-scope.js';
import { recordSourceIds } from './knowledge-model.js';

export function mapCitations(content, replace) {
  return (content || '').replace(/\[@([^\]\s,]+)(?:,\s*p\.\s*([^\]]+))?\]/gu,
    (marker, id, page) => replace({marker, id, page:page || ''}));
}
export function mapExcerpts(content, replace) {
  return (content || '').replace(/\[\[摘錄:([a-zA-Z0-9-]{1,80})\]\]/gu,
    (marker, id) => replace({marker, id}));
}
export function usedExcerpts(note) {
  const ids = new Set();
  mapExcerpts(note.content, ({id, marker}) => { ids.add(id); return marker; });
  return (note.excerptRefs || []).filter(ref => ids.has(ref.id));
}
export function noteSourceIds(note) {
  const ids = new Set(note.sourceIds || []);
  if(note.sourceId)ids.add(note.sourceId);
  mapCitations(note.content, ({id, marker}) => { ids.add(id); return marker; });
  for (const ref of usedExcerpts(note)) ids.add(ref.sourceId);
  return [...ids];
}
export function excerptSnapshot(annotation, id, capturedAt = new Date().toISOString()) {
  return {
    id, annotationId:annotation.id, sourceId:annotation.sourceId,
    quote:annotation.quote, locator:annotation.locator,
    paraphrase:annotation.paraphrase || '', comment:annotation.comment || '',
    verified:annotation.verified === true, annotationRevision:annotation.revision,
    sourceRevision:annotation.sourceRevision || null, sourceHash:annotation.sourceHash || '', capturedAt
  };
}
export function excerptStatus(ref, state) {
  const annotation = state.find(r => r.id === ref.annotationId && r.kind === 'annotation');
  const source = state.find(r => r.id === ref.sourceId && r.kind === 'source');
  if (!source) return '來源已移除，保留引用快照';
  if (!annotation) return '摘錄已移除，保留引用快照';
  if (annotation.revision !== ref.annotationRevision) return '摘錄已更新，引用保留舊版';
  if (ref.sourceHash && source.fileHash && source.fileHash !== ref.sourceHash) return '原檔已更新，請重新核對';
  return ref.verified ? '引用時已人工核對' : '待人工核對';
}
export function connections(state, focus, {projectId = '', allProjects = false} = {}) {
  const selected = typeof focus === 'string' ? state.find(r => r.id === focus) : focus;
  if (!selected) return {sources:[], annotations:[], notes:[], terms:[], relations:[], projects:[], hidden:0};
  const sourceIds = new Set(['note','term'].includes(selected.kind) ? [...noteSourceIds(selected),...recordSourceIds(selected,state)] : recordSourceIds(selected,state));
  const scope = new Set(scopedState(state, projectId).map(r => r.id));
  const relevant = state.filter(r =>
    (r.kind === 'annotation' || r.kind === 'term') && r.id!==selected.id && recordSourceIds(r,state).some(id=>sourceIds.has(id)) ||
    r.kind === 'note' && r.id !== selected.id && noteSourceIds(r).some(id => sourceIds.has(id)) ||
    r.kind === 'discussion' && r.id !== selected.id && (r.sourceIds||[]).some(id=>sourceIds.has(id)) ||
    r.kind === 'relation' && (sourceIds.has(r.from) || sourceIds.has(r.to)));
  const visible = relevant.filter(r => allProjects || !projectId || scope.has(r.id));
  const projectIds = new Set(projectsOf(selected));
  return {
    sources:state.filter(r => r.kind === 'source' && sourceIds.has(r.id)),
    annotations:visible.filter(r => r.kind === 'annotation'),
    notes:visible.filter(r => r.kind === 'note'), terms:visible.filter(r => r.kind === 'term'),
    relations:visible.filter(r => r.kind === 'relation'),
    discussions:visible.filter(r=>r.kind==='discussion'),
    projects:state.filter(r => r.kind === 'project' && projectIds.has(r.id)),
    hidden:relevant.length - visible.length
  };
}
export function excerptMarkdown(ref, source, citation = '') {
  return `> ${ref.quote.replace(/\n/g, '\n> ')}\n\n` +
    `來源：${source?.title || '來源已移除'} · ${ref.locator}${citation ? ` ${citation}` : ''}\n\n` +
    `釋義：${ref.paraphrase || '尚未填寫'}${ref.comment ? `\n\n加註：${ref.comment}` : ''}\n\n` +
    `〔摘錄 ID：${ref.annotationId}；引用 ID：${ref.id}；摘錄版本：${ref.annotationRevision}；${ref.verified ? '引用時已人工核對' : '待人工核對'}〕`;
}
