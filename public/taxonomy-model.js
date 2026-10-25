export const AXES={discipline:'學科',context:'思想脈絡',application:'應用領域'};
export function categoryPath(category,state) {
  const parts=[],seen=new Set();let row=category;
  while(row&&!seen.has(row.id)){seen.add(row.id);parts.unshift(row.title);row=state.find(r=>r.kind==='category'&&r.id===row.parentId);}
  return parts.join(' → ');
}
export function descendants(id,state) {
  const ids=new Set([id]);let changed=true;
  while(changed){changed=false;for(const row of state)if(row.kind==='category'&&ids.has(row.parentId)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
  return ids;
}
export function filterTerms(terms,state,{selected=[],includeChildren=true,query='',unclassified=false}={}) {
  const groups=new Map();for(const id of selected){const c=state.find(r=>r.kind==='category'&&r.id===id);if(!c)continue;const ids=groups.get(c.axis)||new Set();for(const child of includeChildren?descendants(id,state):[id])ids.add(child);groups.set(c.axis,ids);}
  const q=query.trim().toLocaleLowerCase();return terms.filter(t=>(!unclassified||!t.categoryIds?.length)&&(!q||`${t.title} ${t.aliases||''}`.toLocaleLowerCase().includes(q))&&[...groups.values()].every(ids=>(t.categoryIds||[]).some(id=>ids.has(id))));
}
