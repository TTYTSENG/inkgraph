export const OBJECT_KINDS = ['source','annotation','term','note','discussion','message','concept'];
export const SHARED_KINDS = ['source','note','term','discussion','concept'];
export const KIND_LABELS = {source:'來源',annotation:'摘錄',term:'辭典條目',note:'筆記',discussion:'討論',message:'討論訊息',concept:'概念'};
export const LINK_LABELS = {cites:'引用',discusses:'討論',about:'關於',defines:'定義',derived:'衍生自',supports:'支持',contradicts:'反駁',related:'相關'};
export const ROLE_LABELS = {user:'提問者',assistant:'AI 回覆',researcher:'我的整理',unknown:'未標示角色'};
export function objectTitle(row) {return row?.title || row?.quote?.slice(0,80) || row?.content?.slice(0,80) || '已移除的項目';}
export function objectView(row) {return ({source:'source',note:'note',annotation:'annotation',term:'term',discussion:'discussion',message:'message',concept:'concept'})[row?.kind] || 'source';}
export function relatedLinks(state, focusId, {projectId='',allProjects=false}={}) {
  const focus=state.find(r=>r.id===focusId);
  const ids=new Set([focusId]);
  if(focus?.kind==='discussion')for(const r of state.filter(r=>r.kind==='message'&&r.discussionId===focusId))ids.add(r.id);
  const all=state.filter(r=>r.kind==='link'&&(ids.has(r.from)||ids.has(r.to)));
  return {links:all.filter(r=>allProjects||!projectId||!r.projectId||r.projectId===projectId),hidden:allProjects?0:all.filter(r=>projectId&&r.projectId&&r.projectId!==projectId).length};
}
export function recordSourceIds(row,state=[]) {
  const ids=new Set(row?.sourceIds||[]);
  if(row?.bodyDeferred)for(const id of row.referencedSourceIds||[])ids.add(id);
  if(row?.kind==='source')ids.add(row.id);
  if(row?.sourceId)ids.add(row.sourceId);
  if(row?.kind==='message')for(const id of state.find(r=>r.id===row.discussionId)?.sourceIds||[])ids.add(id);
  return [...ids];
}
