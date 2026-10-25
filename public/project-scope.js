export const projectsOf = source => [...new Set([source.projectId,...(source.projectIds||[])].filter(Boolean))];
export const inProject = (source,id) => projectsOf(source).includes(id);
export function scopedState(state, projectId) {
  if(!projectId)return state;
  if(projectId==='inbox')return state.filter(r=>!['project','membership','search-run','link','category','conversion-history'].includes(r.kind)&&!r.projectId&&!(r.projectIds||[]).length);
  const shared=new Set(['source','note','term','discussion','concept']);
  const ids=new Set(state.filter(r=>shared.has(r.kind)&&inProject(r,projectId)).map(r=>r.id));
  for(const row of state)if(row.kind==='message'&&ids.has(row.discussionId)||['annotation','term'].includes(row.kind)&&(row.projectId===projectId||!Object.hasOwn(row,'projectId')&&ids.has(row.sourceId)))ids.add(row.id);
  return state.filter(r=>r.id===projectId||
    (r.kind==='link'?!r.projectId&&(ids.has(r.from)||ids.has(r.to))||r.projectId===projectId:r.kind==='message'?ids.has(r.discussionId):shared.has(r.kind)?ids.has(r.id):
      r.projectId===projectId||(!Object.hasOwn(r,'projectId')&&(r.sourceId?ids.has(r.sourceId):r.kind==='relation'&&ids.has(r.from)&&ids.has(r.to)))));
}
