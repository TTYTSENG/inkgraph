import { AppError, hash } from './store.mjs';
import { AXES, descendants } from '../public/taxonomy-model.js';
export function validateTaxonomy(kind,data,lookup) {
  if(kind==='category'){
    if(!Object.hasOwn(AXES,data.axis))throw new AppError('請選擇分類軸');
    if(data.projectId)throw new AppError('分類在全庫共用，不隸屬專案');
    if(data.parentId){const p=lookup(data.parentId);if(p?.kind!=='category'||p.axis!==data.axis)throw new AppError('父分類必須位於同一分類軸');}
  }
  if(['term','note'].includes(kind)&&data.categoryIds!=null){
    if(!Array.isArray(data.categoryIds)||data.categoryIds.length>100||new Set(data.categoryIds).size!==data.categoryIds.length||data.categoryIds.some(id=>lookup(id)?.kind!=='category'))throw new AppError('分類指派無效（最多 100 個且不可重複）');
  }
}
export function categoryImpact(store,id){
  const row=store.get(id);if(row?.kind!=='category')throw new AppError('找不到分類',404);
  const affected=store.list().filter(r=>r.parentId===id||(r.categoryIds||[]).includes(id));
  return {row,affected,fingerprint:hash(Buffer.from(JSON.stringify([row,affected])))};
}
export function deleteCategory(store,{id,fingerprint,replacementId=''}){
  return store.transaction(()=>{
    const p=categoryImpact(store,id);if(p.fingerprint!==fingerprint)throw new AppError('分類或詞條已更新，請重新預覽',409);
    const target=replacementId&&store.get(replacementId);
    if(replacementId&&(target?.kind!=='category'||target.axis!==p.row.axis||descendants(id,store.list()).has(replacementId)))throw new AppError('替代分類須在同一軸，且不能是本身或子分類');
    for(const r of p.affected){if(r.kind==='category')store.save('category',{...r,parentId:replacementId||p.row.parentId||null},r.id);
      else store.save(r.kind,{...r,categoryIds:[...new Set(r.categoryIds.flatMap(c=>c===id?(replacementId?[replacementId]:[]):[c]))]},r.id);}
    store.db.prepare('DELETE FROM entities WHERE id=?').run(id);return {deleted:id,affected:p.affected.length};
  });
}
