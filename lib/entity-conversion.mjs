import { randomUUID } from 'node:crypto';
import { AppError, hash, validateEntity } from './store.mjs';
import { noteSourceIds } from '../public/research-workspace.js';
import { projectsOf } from '../public/project-scope.js';
const digest=value=>hash(Buffer.from(JSON.stringify(value)));
const dataOf=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!['id','kind','revision','created','updated','projectIds','attachment','bodyDeferred','excerptAnnotationIds','navigationTargetIds','referencedSourceIds'].includes(k)));
const related=(store,id)=>store.list().filter(r=>r.kind==='link'&&(r.from===id||r.to===id)||r.kind==='membership'&&r.entityId===id).sort((a,b)=>a.id.localeCompare(b.id));
export function conversionPreview(store,{id,targetKind}){
  const row=store.get(id);if(!['note','term'].includes(row?.kind)||!['note','term'].includes(targetKind)||row.kind===targetKind)throw new AppError('目前僅支援筆記與字彙雙向改列');
  const links=related(store,id),conflicts=targetKind==='term'?links.filter(r=>r.kind==='link'&&r.to===id&&['supports','contradicts'].includes(r.relation)):[];
  const proposal={...dataOf(row),sourceIds:[...new Set([...(row.sourceIds||[]),...(row.sourceId?[row.sourceId]:[]),...noteSourceIds(row)])].filter(id=>store.get(id)?.kind==='source')};
  if(targetKind==='term'){proposal.definition=row.definition||'';proposal.content=row.content||'';proposal.scopeNote=row.scopeNote||'';proposal.categoryIds=row.categoryIds||[];}
  else {proposal.noteType='quick';proposal.content=row.content||`# ${row.title}\n\n原語／別名：${row.aliases||''}\n\n定義：${row.definition||''}\n\n辨義提醒：${row.scopeNote||''}\n\n例句：${row.example||''}`;}
  return {id,revision:row.revision,targetKind,title:row.title,proposal,conflicts:conflicts.map(r=>({id:r.id,title:r.title,relation:r.relation,from:r.from})),projects:projectsOf(row),sourceCount:proposal.sourceIds.length,fingerprint:digest({row,links,targetKind})};
}
export function convertEntity(store,{id,targetKind,revision,fingerprint,mode='convert',fields={}}){
  return store.transaction(()=>{
    const preview=conversionPreview(store,{id,targetKind}),before=store.get(id);
    if(before.revision!==revision||preview.fingerprint!==fingerprint)throw new AppError('資料或連結已更新，請重新預覽',409);
    if(!['convert','derive'].includes(mode)||mode==='derive'&&targetKind!=='term')throw new AppError('不支援此改列方式');
    if(mode==='convert'&&preview.conflicts.length)throw new AppError('仍有支持／反駁關係指向這篇筆記，請選擇保留筆記另建詞條',409);
    const allowed=['title','aliases','definition','scopeNote','categoryIds'];
    if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(k=>!allowed.includes(k)))throw new AppError('改列欄位無效');
    const data={...preview.proposal,...fields};validateEntity(targetKind,data,key=>store.get(key));
    let result;
    if(mode==='derive'){
      const newId=randomUUID(),now=new Date().toISOString();
      store.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(newId,targetKind,JSON.stringify(data),now,now,1);
      result=store.get(newId);
      for(const projectId of projectsOf(before))store.linkEntity(result.id,projectId);
      store.save('link',{title:'詞條衍生自原筆記',from:result.id,to:id,relation:'derived',reason:'由筆記整理為字彙，原筆記及其論證保留',projectId:null});
    }else{
      store.db.prepare('UPDATE entities SET kind=? WHERE id=?').run(targetKind,id);
      result=store.save(targetKind,{...data,revision},id);
    }
    const history=store.save('conversion-history',{title:`${before.kind} → ${targetKind}`,entityId:result.id,before,mode,afterRevision:result.revision,afterFingerprint:digest({row:store.get(result.id),links:related(store,result.id)})},randomUUID());
    return {entity:store.get(result.id),historyId:history.id};
  });
}
export function conversionHistory(store,id){
  return store.list().filter(r=>r.kind==='conversion-history'&&r.entityId===id).map(r=>({id:r.id,title:r.title,created:r.created,mode:r.mode,canUndo:r.mode==='convert'&&r.afterFingerprint===digest({row:store.get(id),links:related(store,id)})}));
}
export function undoConversion(store,{id,historyId,revision}){
  return store.transaction(()=>{
    const event=store.get(historyId),row=store.get(id);
    if(event?.kind!=='conversion-history'||event.entityId!==id||event.mode!=='convert')throw new AppError('此項改列不能直接撤回');
    if(row?.revision!==revision||event.afterFingerprint!==digest({row,links:related(store,id)}))throw new AppError('改列後資料或連結已有修改，請保留目前內容，重新使用改列預覽；不能直接撤回',409);
    const before=event.before,data=dataOf(before);validateEntity(before.kind,data,key=>store.get(key));
    const now=new Date().toISOString();store.db.prepare('UPDATE entities SET kind=?,data=?,updated=?,revision=revision+1 WHERE id=?').run(before.kind,JSON.stringify(data),now,id);
    store.db.prepare('DELETE FROM entities WHERE id=?').run(historyId);return store.get(id);
  });
}
