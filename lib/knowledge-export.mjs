import { noteSourceIds } from '../public/research-workspace.js';
import { recordSourceIds,objectTitle,LINK_LABELS,ROLE_LABELS } from '../public/knowledge-model.js';
import { usedObjectLinks } from '../public/object-navigation.js';

export function exportDependencies(selected,universe) {
  const ids=new Set(selected.map(r=>r.id));
  const sources=new Set(selected.flatMap(r=>['note','term'].includes(r.kind)?[...noteSourceIds(r),...recordSourceIds(r,universe)]:recordSourceIds(r,universe)));
  for(const link of selected.filter(r=>r.kind==='link'&&r.relation==='cites')){
    const target=universe.find(r=>r.id===link.to);
    for(const id of recordSourceIds(target,universe))sources.add(id);
  }
  const state=[...selected,...universe.filter(r=>r.kind==='source'&&sources.has(r.id)&&!ids.has(r.id))];
  const categoryIds=new Set(state.flatMap(r=>r.categoryIds||[]));
  for(const id of categoryIds){const row=universe.find(r=>r.id===id&&r.kind==='category');if(row?.parentId)categoryIds.add(row.parentId);if(row&&!state.some(r=>r.id===id))state.push(row);}
  for(let i=0;i<state.length;i++)if(['note','term'].includes(state[i].kind))state[i]={...state[i],objectLinkTargets:usedObjectLinks(state[i]).map(id=>{const target=universe.find(r=>r.id===id);return target?{id,kind:target.kind,title:objectTitle(target),external:!state.some(r=>r.id===id)}:{id,status:'missing'};})};
  return state.map(r=>r.kind==='link'?{...r,fromTitle:objectTitle(universe.find(n=>n.id===r.from)),toTitle:objectTitle(universe.find(n=>n.id===r.to)),targetCurrentRevision:universe.find(n=>n.id===r.to)?.revision||null,externalFrom:!state.some(n=>n.id===r.from),externalTo:!state.some(n=>n.id===r.to)}:r);
}
export function recordState(universe,id) {
  const selected=universe.find(r=>r.id===id);if(!selected)return [];
  const rows=[selected];
  if(selected.kind==='discussion')rows.push(...universe.filter(r=>r.kind==='message'&&r.discussionId===id));
  const ids=new Set(rows.map(r=>r.id));
  rows.push(...universe.filter(r=>r.kind==='link'&&(ids.has(r.from)||ids.has(r.to))));
  return exportDependencies(rows,universe);
}
export function knowledgeText(row,state) {
  if(row.kind==='concept')return `ID：${row.id}\n別名：${row.aliases||''}\n\n概念說明：${row.definition||''}`;
  if(row.kind==='discussion')return `ID：${row.id}\n討論來源：${row.origin}\n原始來源：${(row.sourceIds||[]).join('、')||'未指定'}\n\n背景／摘要：${row.content||''}`;
  if(row.kind==='message')return `ID：${row.id}\n所屬討論：${state.find(r=>r.id===row.discussionId)?.title||row.discussionId}\n角色：${ROLE_LABELS[row.role]||row.role}\n本機保存時間：${row.created}\n\n${row.content}\n\n原始來源：${(row.sourceIds||[]).join('、')||'沿用討論來源'}${row.importedSourceId?`\n匯入原文來源：${row.importedSourceId}；來源版本：${row.importedSourceRevision}（來源若已移除，僅保留此對照）`:''}`;
  if(row.kind==='link')return `關係 ID：${row.id}\n${row.fromTitle||objectTitle(state.find(r=>r.id===row.from))}（${row.from}） → ${LINK_LABELS[row.relation]} → ${row.toTitle||objectTitle(state.find(r=>r.id===row.to))}（${row.to}）\n起點位置：${row.fromLocator||'未標示'}\n目標位置：${row.toLocator||'未標示'}\n理由／證據：${row.reason||'未填寫'}${row.targetRevision&&row.targetCurrentRevision&&row.targetRevision!==row.targetCurrentRevision?'\n素材已更新，筆記保留引用時的整理內容，請重新核對。':''}${row.externalFrom||row.externalTo?'\n外部項目只保留標題與 ID，未輸出其他專案全文。':''}`;
  return '';
}
