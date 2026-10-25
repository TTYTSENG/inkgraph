import { randomUUID } from 'node:crypto';
import { AppError, hash, validateEntity } from './store.mjs';
import { mapReferences } from './note-references.mjs';
import { evidenceText } from '../public/research-evidence.js';
import { projectsOf, inProject } from '../public/project-scope.js';

const digest = value => hash(Buffer.from(JSON.stringify(value)));
const text = (v, name, max=200000) => {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > max) throw new AppError(`${name} 必須為文字，且不得超過 ${max} 字`);
  return v.trim();
};
const doi = v => String(v || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').toLowerCase();
const url = v => {
  if (!v) return '';
  try { const u = new URL(v); if (!['http:','https:'].includes(u.protocol)) throw Error(); u.hash=''; return u.href; }
  catch { throw new AppError('來源網址須為有效的 http 或 https 網址'); }
};
const fields = (r, names) => Object.fromEntries(names.map(k => [k,text(r[k],k)]));
const normalizeAuthors = input => {
  if(input==null)return [];
  if(!Array.isArray(input)||input.length>200)throw new AppError('作者必須為陣列，最多 200 位');
  return input.map((author,index)=>{
    if(typeof author==='string'){
      if(!author.trim())throw new AppError(`第 ${index+1} 位作者姓名不可為空白`);
      return {literal:author.trim()};
    }
    if(!author||typeof author!=='object'||Array.isArray(author)||
      ![author.literal,author.family].some(v=>typeof v==='string'&&v.trim())||
      ['literal','family','given'].some(k=>author[k]!=null&&typeof author[k]!=='string'))
      throw new AppError(`第 ${index+1} 位作者須為姓名文字或含 literal／family 的作者物件`);
    return {...author};
  });
};
const sourceFields = ['title','summary','method','findings','limitations','journal','publisher','volume','issue','pageRange','tags'];
const fileRows = store => store.db.prepare('SELECT id,source_id,sha FROM attachments ORDER BY id').all();
const stateHash = store => digest({entities:store.list(),files:fileRows(store)});
const detailRows = (kind,r) => {
  const labels={doi:'DOI',url:'來源網址',summary:'摘要',method:'研究方法',findings:'主要發現',limitations:'研究限制',quote:'原文摘錄',locator:'來源位置',paraphrase:'釋義',comment:'加註',content:'完整內容',definition:'詞彙釋義',aliases:'原語／別名',scopeNote:'辨義提醒',noteType:'筆記用途',relation:'關係',reason:'理由與證據'};
  const details=Object.entries(labels).filter(([k])=>r[k]).map(([k,label])=>[label,r[k]]);
  if(kind==='source')details.unshift(['作者',(r.authors||[]).map(a=>a.literal||`${a.family}, ${a.given||''}`).join('；')||'待補'],['年份',String(r.year||'待補')],['查證資訊',evidenceText(r)]);
  return details;
};

export const lightExample = {
  format:'light-inkgraph', version:1,
  sources:[{key:'paper1',title:'格式示例：請替換成已查證的真實文獻',authors:[],verification:'UNRESOLVED',summary:'這是格式示例，不是研究證據。'}],
  annotations:[{sourceKey:'paper1',quote:'請替換成已取得全文的原文摘錄',locator:'請填寫真實頁碼或段落',comment:'待人工對照'}],
  notes:[{title:'研究問題',content:'請填寫研究問題與證據限制',sourceKeys:['paper1']}],relations:[]
};

const groupKinds={sources:'source',annotations:'annotation',notes:'note',relations:'relation'};
function selectItems(input,excludedIds) {
  const ids=new Set(Object.entries(input).flatMap(([group,records])=>records.map((_,i)=>`${group}:${i}`)));
  if(!Array.isArray(excludedIds)||excludedIds.length>2000||excludedIds.some(id=>typeof id!=='string'||!ids.has(id)))
    throw new AppError('移除清單包含無效的項目，請重新預覽');
  const excluded=new Set(excludedIds),removedSources=new Set(input.sources.filter((_,i)=>excluded.has(`sources:${i}`)).map(r=>typeof r?.key==='string'?r.key.trim():null));
  const items=Object.entries(input).flatMap(([group,records])=>records.map((raw,index)=>{
    const rowId=`${group}:${index}`,manualExcluded=excluded.has(rowId);
    const automaticExcluded=group==='annotations'?removedSources.has(raw?.sourceKey):group==='relations'&&(removedSources.has(raw?.fromKey)||removedSources.has(raw?.toKey));
    const removedKeys=group==='notes'&&Array.isArray(raw?.sourceKeys)?raw.sourceKeys.filter(k=>removedSources.has(k)):[];
    return {group,index,rowId,raw,manualExcluded,automaticExcluded:Boolean(automaticExcluded),removedKeys,excluded:manualExcluded||Boolean(automaticExcluded)};
  }));
  return {items,excludedIds:[...excluded].sort(),removedSources};
}

export class LightImport {
  constructor(store) { this.store=store; }
  prepare(bundle, projectId=null, excludedIds=[]) {
    const store=this.store;
    if(bundle?.offline===true||bundle?.production_eligible===false)throw new AppError('離線合成樣本不可匯入正式文獻');
    if (!bundle || bundle.format!=='light-inkgraph' || bundle.version!==1) throw new AppError('請使用 light-inkgraph 第 1 版成果包；可下載格式範例');
    if (JSON.stringify(bundle).length>5_000_000) throw new AppError('成果包上限 5 MB');
    if (projectId && store.get(projectId)?.kind!=='project') throw new AppError('找不到所屬專案');
    const groups=['sources','annotations','notes','relations'];
    for(const g of groups) if(bundle[g]!=null && (!Array.isArray(bundle[g]) || bundle[g].length>500)) throw new AppError(`${g} 必須為陣列，最多 500 筆`);
    const input=Object.fromEntries(groups.map(g=>[g,bundle[g]||[]]));
    if(!groups.some(g=>input[g].length))throw new AppError('成果包沒有可匯入的資料');
    const selection=selectItems(input,excludedIds);
    const kept=group=>selection.items.filter(item=>item.group===group&&!item.excluded);
    const existing=store.list(), virtual=new Map(existing.map(r=>[r.id,r])), refs=new Map(), operations=[], rows=[],usedRecords=new Map();
    let currentItem;
    for(const item of selection.items.filter(item=>item.excluded))rows.push({
      rowId:item.rowId,kind:groupKinds[item.group],title:typeof (item.raw?.title||item.raw?.quote||item.raw?.reason)==='string'?(item.raw.title||item.raw.quote||item.raw.reason):'文獻關係',
      status:'excluded',manualExcluded:item.manualExcluded,automaticExcluded:item.automaticExcluded,
      warnings:[item.automaticExcluded?'來源文獻已移除，此筆相依資料不會匯入。':'已從本次匯入移除；既有資料不受影響。'],details:[]
    });
    const add=(kind,data,key='')=>{
      const rowMeta={rowId:currentItem.rowId,warnings:currentItem.removedKeys.length?[`已解除 ${currentItem.removedKeys.length} 個文獻連結（${currentItem.removedKeys.join('、')}）。筆記文字保持原樣，請檢查文字引用。`]:[]};
      const identity=id=>{const s=virtual.get(id);return s?.doi?`doi:${doi(s.doi)}`:s?.url?`url:${url(s.url)}`:s?.lightItemHash||id;};
      const stable={...data};
      if(['note','term'].includes(kind))stable.content=mapReferences(stable.content,({marker,id,page})=>virtual.has(id)?`[@${identity(id)}${page?`, p. ${page}`:''}]`:marker);
      if(stable.sourceId)stable.sourceId=identity(stable.sourceId);
      if(stable.sourceIds)stable.sourceIds=stable.sourceIds.map(identity);
      if(stable.from)stable.from=identity(stable.from);
      if(stable.to)stable.to=identity(stable.to);
      const itemHash=currentItem.group==='notes'?digest({kind:'note',projectId,data:{title:stable.title,content:stable.content,tags:stable.tags,sourceIds:stable.sourceIds,noteType:'research'}}):digest({kind,projectId,data:stable});
      let matches=existing.filter(r=>r.kind===kind && (r.projectId||null)===(projectId||null) && r.lightItemHash===itemHash);
      if(kind==='source') {
        const same=r=>r.kind==='source' && ((data.doi && doi(r.doi)===data.doi) || (data.url && r.url && url(r.url)===data.url));
        const candidates=[...virtual.values()].filter(same);
        matches=[...new Map([...matches,...candidates].map(r=>[r.id,r])).values()];
        if(matches.length>1)throw new AppError(`「${data.title}」的 DOI／網址對應多筆資料，請先整理重複文獻`);
      } else {
        matches=[...virtual.values()].filter(r=>(currentItem.group==='notes'?['note','term'].includes(r.kind):r.kind===kind) && r.lightItemHash===itemHash && (r.projectId||null)===(projectId||null));
      }
      const duplicate=matches[0];
      if(duplicate){
        if(store.get(duplicate.id))usedRecords.set(duplicate.id,store.get(duplicate.id));
        const link=kind==='source'&&projectId&&!inProject(duplicate,projectId);
        if(link){
          const id=`light-preview-${randomUUID()}`,linkData={title:'專案來源連結',sourceId:duplicate.id,projectId,lightItemHash:digest({kind:'membership',projectId,source:identity(duplicate.id)})};
          virtual.set(id,{id,kind:'membership',...linkData});operations.push({id,kind:'membership',data:linkData});
          virtual.set(duplicate.id,{...duplicate,projectIds:[...projectsOf(duplicate),projectId]});
        }
        rows.push({...rowMeta,kind:duplicate.kind,title:duplicate.title||duplicate.quote||duplicate.reason||'文獻關係',status:link?'link':'duplicate',key,verification:duplicate.verification||'UNRESOLVED',details:detailRows(duplicate.kind,duplicate),warnings:[...rowMeta.warnings,...(link?['沿用共用來源，只新增專案連結，不覆寫書目或附件。']:[]),...(currentItem.group==='notes'?['沿用既有項目；保留你後來確認的類型、分類與釋義，不覆寫。']:[])]});return duplicate.id;
      }
      const id=`light-preview-${randomUUID()}`;
      const full={...data,projectId,lightItemHash:itemHash};
      validateEntity(kind,full,id=>virtual.get(id));
      virtual.set(id,{id,kind,...full}); operations.push({id,kind,data:full});
      rows.push({...rowMeta,kind,title:data.title||data.quote||data.reason||'文獻關係',status:'new',key,verification:data.verification||'UNRESOLVED',details:detailRows(kind,data)});
      return id;
    };
    const record=r=>{if(!r||typeof r!=='object'||Array.isArray(r))throw new AppError('每筆資料必須為物件');return r;};
    for(const item of kept('sources')){
      currentItem=item;const {index:sourceIndex,raw}=item;
      try {
      const r=record(raw),key=text(r.key,'文獻代號',200);
      if(!key||refs.has(key))throw new AppError('每篇文獻需要唯一且非空的 key');
      const data={...fields(r,sourceFields),authors:normalizeAuthors(r.authors),year:r.year==null?'':String(r.year),doi:doi(text(r.doi,'DOI')),url:url(text(r.url,'網址')),origin:'light',cslType:r.cslType||'article-journal',verification:text(r.verification||'UNRESOLVED','查證狀態',100),text:'',pages:[],warnings:['Light 匯入；查證狀態為產生者聲明，尚須人工核查。']};
      if(!['CONFIRMED','CONFIRMED-MISSING','UNAVAILABLE','UNRESOLVED'].includes(data.verification))throw new AppError('查證狀態須為 CONFIRMED、CONFIRMED-MISSING、UNAVAILABLE 或 UNRESOLVED');
      if(r.evidence!=null && (typeof r.evidence!=='object'||Array.isArray(r.evidence)))throw new AppError('evidence 必須為物件');
      const evidence=r.evidence||{};
      if(r.evidence!=null){
        data.lightEvidence={verification:data.verification,readLevel:text(evidence.readLevel||'unknown','閱讀範圍',30),...fields(evidence,['provider','checkedAt','note']),url:url(text(evidence.url,'證據網址'))};
        if(!['metadata','abstract','fulltext','unknown'].includes(data.lightEvidence.readLevel))throw new AppError('閱讀範圍須為 metadata、abstract、fulltext 或 unknown');
      }
      refs.set(key,add('source',data,key));
      } catch(error) {
        if(error instanceof AppError){
          const title=typeof raw?.title==='string'?raw.title.slice(0,100):'未填標題';
          throw new AppError(`文獻第 ${sourceIndex+1} 筆「${title}」：${error.message}`,error.status);
        }
        throw error;
      }
    }
    const ref=k=>{if(typeof k!=='string'||!refs.has(k))throw new AppError('摘錄、筆記或關係引用了不存在的 sourceKey');return refs.get(k);};
    for(const item of kept('annotations')){currentItem=item;const r=record(item.raw);add('annotation',{...fields(r,['quote','locator','paraphrase','comment']),sourceId:ref(r.sourceKey),verified:false});}
    for(const item of kept('notes')){
      currentItem=item;const r=record(item.raw);
      if(!Array.isArray(r.sourceKeys||[]))throw new AppError('筆記 sourceKeys 必須為陣列');
      const sourceIds=new Set((r.sourceKeys||[]).filter(k=>!selection.removedSources.has(k)).map(ref)),warnings=[];
      const data=fields(r,['title','content','tags']);
      data.content=mapReferences(data.content,({marker,id,page})=>{
        const source=virtual.get(id);
        const resolved=refs.get(id)||(!selection.removedSources.has(id)&&source?.kind==='source'&&(projectId?inProject(source,projectId):!projectsOf(source).length)?id:null);
        if(resolved&&store.get(resolved))usedRecords.set(resolved,store.get(resolved));
        if(!resolved){warnings.push(`正文引用 ${marker} 的來源${selection.removedSources.has(id)?'已排除':'不存在'}，請核對。`);return marker;}
        sourceIds.add(resolved);return `[@${resolved}${page?`, p. ${page}`:''}]`;
      });
      const kind=r.kind||'note';if(!['note','term'].includes(kind))throw new AppError('筆記匯入類型僅接受 note 或 term');
      if(r.noteType!=null&&!['quick','research','draft','decision'].includes(r.noteType))throw new AppError('筆記用途無效');
      add(kind,{...data,sourceIds:[...sourceIds],...(kind==='note'?{noteType:r.noteType||'quick'}:fields(r,['aliases','definition','scopeNote','example']))});
      rows.at(-1).warnings.push(...new Set(warnings));
    }
    for(const item of kept('relations')){currentItem=item;const r=record(item.raw);add('relation',{...fields(r,['relation','reason']),from:ref(r.fromKey),to:ref(r.toKey)});}
    const order=new Map(selection.items.map((item,index)=>[item.rowId,index]));rows.sort((a,b)=>order.get(a.rowId)-order.get(b.rowId));
    const removed=rows.filter(r=>r.status==='excluded').length;
    const fingerprint=digest({bundle,projectId,excludedIds:selection.excludedIds,project:projectId?store.get(projectId):null,
      plan:operations.map(op=>[op.kind,op.data.lightItemHash]),used:[...usedRecords].sort(([a],[b])=>a.localeCompare(b)),files:fileRows(store).filter(f=>usedRecords.has(f.source_id))});
    return {fingerprint,operations,rows,added:operations.length,skipped:rows.filter(r=>r.status==='duplicate').length,removed,automaticRemoved:rows.filter(r=>r.automaticExcluded).length};
  }
  preview(bundle,projectId,excludedIds) {const {operations,...result}=this.prepare(bundle,projectId,excludedIds);return result;}
  commit(bundle,projectId,fingerprint,excludedIds) {
    return this.store.transaction(()=>{
      const p=this.prepare(bundle,projectId,excludedIds);
      if(!fingerprint||p.fingerprint!==fingerprint)throw new AppError('成果包或資料已變更，請重新預覽',409);
      const batch=randomUUID(),ids=new Map(p.operations.map(o=>[o.id,randomUUID()]));
      const remap=id=>ids.get(id)||id;
      for(const op of p.operations){
        const data={...op.data,lightImport:{batch,size:p.added,at:new Date().toISOString()}};
        // The duplicate identity uses stable source identities, not preview or database IDs.
        if(data.sourceId)data.sourceId=remap(data.sourceId);
        if(data.sourceIds)data.sourceIds=data.sourceIds.map(remap);
        if(['note','term'].includes(op.kind))data.content=mapReferences(data.content,({marker,id,page})=>ids.has(id)?`[@${remap(id)}${page?`, p. ${page}`:''}]`:marker);
        if(data.from)data.from=remap(data.from);
        if(data.to)data.to=remap(data.to);
        this.store.save(op.kind,data,ids.get(op.id));
      }
      return {batch:p.added?batch:null,added:p.added,skipped:p.skipped,removed:p.removed};
    });
  }
  batches() {
    const batches=new Map();
    for(const r of this.store.list())if(r.lightImport?.batch){const m=r.lightImport;const b=batches.get(m.batch)||{id:m.batch,at:m.at,count:0};b.count++;batches.set(m.batch,b);}
    return [...batches.values()].sort((a,b)=>b.at.localeCompare(a.at));
  }
  undo(batch) {
    return this.store.transaction(()=>{
      const all=this.store.list(),members=all.filter(r=>r.lightImport?.batch===batch);
      if(!members.length)throw new AppError('找不到匯入批次',404);
      const ids=new Set(members.map(r=>r.id));
      const links=members.filter(r=>r.kind==='membership');
      if(links.some(link=>all.some(r=>!ids.has(r.id)&&r.projectId===link.projectId&&r.kind!=='membership'&&(r.sourceId===link.sourceId||(r.sourceIds||[]).includes(link.sourceId)||r.from===link.sourceId||r.to===link.sourceId||(r.content||'').includes(`[@${link.sourceId}`)))))throw new AppError('此專案已有其他資料使用新增的共用連結，無法撤回',409);
      if(members.some(r=>r.revision!==1||r.lightImport.size!==members.length)||fileRows(this.store).some(f=>ids.has(f.source_id)))throw new AppError('此批資料已修改、刪除或新增附件，無法整批撤回；請個別整理',409);
      if(all.some(r=>!ids.has(r.id)&&([r.sourceId,r.from,r.to,...(r.sourceIds||[])].some(id=>ids.has(id))||members.some(m=>(r.content||'').includes(`[@${m.id}`)))))throw new AppError('其他資料已引用這批成果，請先解除關聯再撤回',409);
      for(const r of members)this.store.db.prepare('DELETE FROM entities WHERE id=?').run(r.id);
      return {removed:members.length};
    });
  }
}
