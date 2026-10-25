import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Store } from '../lib/store.mjs';
import { conversionPreview,convertEntity,conversionHistory,undoConversion } from '../lib/entity-conversion.mjs';
import { categoryImpact,deleteCategory } from '../lib/taxonomy.mjs';
import { categoryPath,filterTerms } from '../public/taxonomy-model.js';
import { excerptSnapshot } from '../public/research-workspace.js';
import { markdown,reportHTML,exportContent,projectState,backup,restore } from '../lib/exports.mjs';
import { recordState } from '../lib/knowledge-export.mjs';
import { scopedState } from '../public/project-scope.js';
import { LightImport } from '../lib/light-import.mjs';
import { makeServer } from '../server.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixture(s){
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'}),sources=[1,2].map(n=>s.save('source',{title:'Source '+n,authors:[{literal:'Author '+n}],year:'2024',projectId:a.id}));
  const annotation=s.save('annotation',{sourceId:sources[0].id,quote:'Original evidence',locator:'p. 7',verified:true});
  const snapshot=excerptSnapshot(annotation,'snapshot-test'),category=s.save('category',{title:'哲學',axis:'discipline'});
  const note=s.save('note',{title:'T31｜透明性',noteType:'research',projectId:a.id,sourceIds:sources.map(r=>r.id),content:`# 透明性\n原詞：transparency\n\n辨義提醒：特定語境\n[@${sources[1].id}, p. 8]\n[[摘錄:${snapshot.id}]]`,excerptRefs:[snapshot],tags:'待核對'});
  s.linkEntity(note.id,b.id);return {a,b,sources,annotation,snapshot,category,note};
}
const convert=(s,row,fields={})=>{const p=conversionPreview(s,{id:row.id,targetKind:row.kind==='note'?'term':'note'});return convertEntity(s,{...p,fields});};

test('Conversion preserves identity, complete prose, snapshots, source list, memberships and old citation output',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),r=convert(s,f.note,{definition:'自己的釋義',categoryIds:[f.category.id]});
    assert.equal(r.entity.id,f.note.id);assert.equal(r.entity.kind,'term');assert.equal(r.entity.content,f.note.content);assert.deepEqual(r.entity.excerptRefs,f.note.excerptRefs);assert.deepEqual(r.entity.sourceIds,f.note.sourceIds);assert.deepEqual(new Set(r.entity.projectIds),new Set([f.a.id,f.b.id]));
    const md=markdown(recordState(s.list(),f.note.id));for(const text of ['Original evidence','特定語境','自己的釋義','哲學','Author 2'])assert.ok(md.includes(text),text);
    assert.ok(!s.state({summary:true}).some(r=>r.kind==='conversion-history'));
    assert.equal(conversionHistory(s,f.note.id)[0].canUndo,true);
    const restored=undoConversion(s,{id:f.note.id,historyId:r.historyId,revision:r.entity.revision});assert.equal(restored.kind,'note');assert.equal(restored.content,f.note.content);assert.equal(restored.noteType,'research');assert.deepEqual(restored.excerptRefs,f.note.excerptRefs);
  }finally{s.close();}
});

test('Stale preview, invalid categories and changed graph reject conversion atomically',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),p=conversionPreview(s,{id:f.note.id,targetKind:'term'});
    s.save('link',{title:'Related',from:f.note.id,to:f.sources[0].id,relation:'related'});
    const before=s.list();assert.throws(()=>convertEntity(s,p),e=>e.status===409);assert.deepEqual(s.list(),before);
    const current=conversionPreview(s,{id:f.note.id,targetKind:'term'});assert.throws(()=>convertEntity(s,{...current,fields:{categoryIds:['missing']}}),/分類/);assert.deepEqual(s.list(),before);
    assert.throws(()=>convertEntity(s,{...current,fields:{sourceIds:[]}}),/欄位/);assert.deepEqual(s.list(),before);
  }finally{s.close();}
});

test('Argument edges block direct conversion; derived term preserves old snapshot even if annotation has changed',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),claim=s.save('note',{title:'Claim',sourceIds:[],content:'Argument'});
    const link=s.save('link',{title:'Support',from:claim.id,to:f.note.id,relation:'supports',reason:'Evidence'});
    s.save('annotation',{...f.annotation,quote:'New edition'},f.annotation.id);
    const p=conversionPreview(s,{id:f.note.id,targetKind:'term'}),before=s.list();assert.equal(p.conflicts.length,1);
    assert.throws(()=>convertEntity(s,p),/支持/);assert.deepEqual(s.list(),before);
    const r=convertEntity(s,{...p,mode:'derive'});assert.notEqual(r.entity.id,f.note.id);assert.deepEqual(r.entity.excerptRefs,f.note.excerptRefs);assert.equal(s.get(f.note.id).kind,'note');assert.equal(s.get(link.id).to,f.note.id);assert.ok(s.get(r.entity.id).projectIds.includes(f.b.id));assert.ok(s.list().some(l=>l.kind==='link'&&l.from===r.entity.id&&l.to===f.note.id&&l.relation==='derived'));
    assert.equal(conversionHistory(s,r.entity.id)[0].canUndo,false);
  }finally{s.close();}
});

test('Undo refuses to overwrite subsequent edits or new relationships; reverse conversion preserves glossary fields',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),r=convert(s,f.note,{definition:'Definition',aliases:'transparency'});
    const changed=s.save('term',{...r.entity,content:r.entity.content+'\nLater thought'},r.entity.id),before=s.list();
    assert.equal(conversionHistory(s,r.entity.id)[0].canUndo,false);assert.throws(()=>undoConversion(s,{id:changed.id,historyId:r.historyId,revision:changed.revision}),e=>e.status===409);assert.deepEqual(s.list(),before);
    const n=convert(s,changed).entity;assert.equal(n.kind,'note');assert.equal(n.definition,'Definition');assert.match(n.content,/Later thought/);
    const next=convert(s,n),edge=s.save('link',{title:'New relationship',from:next.entity.id,to:f.sources[0].id,relation:'related'});
    assert.equal(conversionHistory(s,next.entity.id)[0].canUndo,false);assert.throws(()=>undoConversion(s,{id:next.entity.id,historyId:next.historyId,revision:next.entity.revision}),e=>e.status===409);assert.ok(s.get(edge.id));
  }finally{s.close();}
});

test('Taxonomy filters use OR within axis, AND across axes, optional descendants and project-safe counts',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),child=s.save('category',{title:'政治哲學',axis:'discipline',parentId:f.category.id}),context=s.save('category',{title:'啟蒙思想',axis:'context'}),other=s.save('category',{title:'社會學',axis:'discipline'});
    const term=convert(s,f.note,{categoryIds:[child.id,context.id]}).entity;
    const second=s.save('term',{title:'Second',sourceIds:[],categoryIds:[other.id],projectId:f.a.id}),hidden=s.save('term',{title:'Private B',sourceIds:[],categoryIds:[child.id],projectId:f.b.id});
    const terms=scopedState(s.list(),f.a.id).filter(r=>r.kind==='term');
    assert.deepEqual(filterTerms(terms,s.list(),{selected:[f.category.id,context.id]}).map(r=>r.id),[term.id]);
    assert.equal(filterTerms(terms,s.list(),{selected:[f.category.id],includeChildren:false}).length,0);
    assert.equal(filterTerms(terms,s.list(),{selected:[f.category.id,other.id]}).length,2);
    assert.ok(!filterTerms(terms,s.list(),{selected:[child.id]}).some(r=>r.id===hidden.id));
    assert.equal(categoryPath(child,s.list()),'哲學 → 政治哲學');
    const renamed=s.save('category',{...f.category,title:'人文哲學'},f.category.id);assert.equal(categoryPath(child,s.list()),'人文哲學 → 政治哲學');
    assert.throws(()=>s.save('category',{...renamed,parentId:child.id},renamed.id),/子分類/);
    assert.throws(()=>s.save('category',{title:'錯誤跨軸',axis:'application',parentId:child.id}),/同一/);
    assert.equal(s.get(second.id).categoryIds[0],other.id);
  }finally{s.close();}
});

test('Category removal previews affected rows and moves children/assignments without deleting terms; stale removal is atomic',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),child=s.save('category',{title:'Child',axis:'discipline',parentId:f.category.id}),target=s.save('category',{title:'Target',axis:'discipline'}),term=convert(s,f.note,{categoryIds:[f.category.id]}).entity;
    const stale=categoryImpact(s,f.category.id);s.save('term',{...term,definition:'Later'},term.id);const before=s.list();assert.throws(()=>deleteCategory(s,{id:f.category.id,fingerprint:stale.fingerprint}),e=>e.status===409);assert.deepEqual(s.list(),before);
    const p=categoryImpact(s,f.category.id);assert.equal(p.affected.length,2);assert.throws(()=>deleteCategory(s,{id:f.category.id,fingerprint:p.fingerprint,replacementId:child.id}),/子分類/);assert.deepEqual(s.list(),before);
    deleteCategory(s,{id:f.category.id,fingerprint:p.fingerprint,replacementId:target.id});assert.equal(s.get(child.id).parentId,target.id);assert.deepEqual(s.get(term.id).categoryIds,[target.id]);assert.ok(s.get(term.id));
  }finally{s.close();}
});

test('Exports include taxonomy ancestors, all source dependencies and resolved links but no other project prose',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),child=s.save('category',{title:'Child',axis:'discipline',parentId:f.category.id}),secret=s.save('note',{title:'External title',content:'SECRET BODY',sourceIds:[],projectId:f.b.id});
    const updated=s.save('note',{...s.get(f.note.id),content:f.note.content+`\n[[連結:${secret.id}]]`},f.note.id),term=convert(s,updated,{categoryIds:[child.id],scopeNote:'Usage warning'}).entity;
    const rows=projectState(s.list(),f.a.id),md=markdown(rows);assert.ok(rows.some(r=>r.id===f.category.id));assert.ok(rows.some(r=>r.id===child.id));assert.ok(!md.includes('SECRET BODY'));assert.ok(md.includes('External title'));assert.ok(md.includes('Original evidence'));assert.ok(md.includes('哲學 → Child'));
    assert.ok(reportHTML(rows).includes('Usage warning'));assert.ok(exportContent(rows,'glossary')[2].includes('完整說明'));assert.ok(exportContent(rows,'taxonomy')[2].includes(child.id));
    assert.equal(recordState(s.list(),term.id).filter(r=>r.kind==='source').length,2);
  }finally{s.close();}
});

test('Backup v4 round-trips categories, conversion history, snapshots and undo; legacy backups 1–3 remain accepted',async()=>{
  const s=new Store(':memory:'),out=new Store(':memory:');try{
    const f=fixture(s),r=convert(s,f.note,{categoryIds:[f.category.id]});await restore(out,await backup(s));assert.deepEqual(out.list(),s.list());assert.equal(conversionHistory(out,r.entity.id)[0].canUndo,true);
    undoConversion(out,{id:r.entity.id,historyId:r.historyId,revision:r.entity.revision});assert.equal(out.get(r.entity.id).kind,'note');
    for(const version of [1,2,3]){const old=new Store(':memory:');try{const zip=new JSZip();zip.file('manifest.json',JSON.stringify({format:'inkgraph',version,entities:[f.a],attachments:[]}));await restore(old,await zip.generateAsync({type:'nodebuffer'}));assert.ok(old.get(f.a.id));}finally{old.close();}}
  }finally{s.close();out.close();}
});

test('Modern terms survive source/annotation deletion and retain immutable quotation snapshots',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),term=convert(s,f.note).entity,p=s.sourceDeletionPreview(f.sources[0].id);s.deleteSource(p.id,p.fingerprint);
    const kept=s.get(term.id);assert.equal(kept.kind,'term');assert.deepEqual(kept.sourceIds,[f.sources[1].id]);assert.deepEqual(kept.excerptRefs,f.note.excerptRefs);assert.match(markdown(recordState(s.list(),kept.id)),/Original evidence/);
    const d=s.entityDeletionPreview(term.id);s.deleteEntity(term.id,d.fingerprint);assert.equal(s.list().filter(r=>r.kind==='conversion-history'&&r.entityId===term.id).length,0);
  }finally{s.close();}
});

test('Light defaults to ordinary notes, explicit terms keep citations, and reimport preserves corrected classification',()=>{
  const s=new Store(':memory:');try{
    const importer=new LightImport(s),bundle={format:'light-inkgraph',version:1,sources:[{key:'s',title:'Source',authors:[],doi:'10.1234/example'}],notes:[{title:'Transparency',content:'Meaning [@s, p. 3]',sourceKeys:['s']}]};
    const p=importer.preview(bundle);importer.commit(bundle,null,p.fingerprint);const n=s.list().find(r=>r.kind==='note');assert.equal(n.noteType,'quick');
    const c=s.save('category',{title:'Theory',axis:'context'}),r=convert(s,n,{categoryIds:[c.id],definition:'My edited definition'});
    const again=importer.preview(bundle);assert.equal(again.added,0);assert.equal(again.rows.find(r=>r.rowId==='notes:0').kind,'term');assert.match(again.rows.find(r=>r.rowId==='notes:0').warnings.join(),/保留/);assert.equal(s.get(r.entity.id).definition,'My edited definition');
    const termBundle={...bundle,notes:[{...bundle.notes[0],title:'Explicit term',kind:'term',aliases:'transparency',definition:'Meaning'}]},preview=importer.preview(termBundle);importer.commit(termBundle,null,preview.fingerprint);
    const term=s.list().find(r=>r.title==='Explicit term');assert.equal(term.kind,'term');assert.ok(term.content.includes(term.sourceIds[0]));assert.equal(term.definition,'Meaning');
  }finally{s.close();}
});

test('Conversion transaction rolls back a failed history write, including kind, memberships and derived link',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),original=s.save.bind(s),before=s.list();s.save=(kind,...args)=>{if(kind==='conversion-history')throw Error('simulated disk failure');return original(kind,...args);};
    assert.throws(()=>convert(s,f.note),/simulated/);assert.deepEqual(s.list(),before);
    const p=conversionPreview(s,{id:f.note.id,targetKind:'term'});assert.throws(()=>convertEntity(s,{...p,mode:'derive'}),/simulated/);assert.deepEqual(s.list(),before);
  }finally{s.close();}
});

test('Deferred glossary summary retains reference indexes without sending body or snapshot quotation text',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),updated=s.save('note',{...f.note,content:f.note.content+`\n[[連結:${f.sources[1].id}]]`},f.note.id);convert(s,updated);
    const row=s.state({summary:true}).find(r=>r.id===f.note.id);assert.equal(row.content,undefined);assert.equal(row.excerptRefs,undefined);assert.equal(row.bodyDeferred,true);assert.deepEqual(row.excerptAnnotationIds,[f.annotation.id]);assert.deepEqual(row.navigationTargetIds,[f.sources[1].id]);assert.deepEqual(new Set(row.referencedSourceIds),new Set(f.sources.map(r=>r.id)));
  }finally{s.close();}
});

test('Conversion and taxonomy endpoints enforce session token, prevent raw history writes and expose complete details on demand',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-glossary-api-')),app=makeServer({dataPath:root,port:0});
  try{
    const f=fixture(app.store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    const post=async(path,body,auth=true)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-inkgraph-token':app.token}:{})},body:JSON.stringify(body)});
    assert.equal((await post('/api/conversion/preview',{id:f.note.id,targetKind:'term'},false)).status,403);
    assert.equal((await post('/api/entities',{kind:'conversion-history',data:{title:'forged'}})).status,400);
    const p=await(await post('/api/conversion/preview',{id:f.note.id,targetKind:'term'})).json(),r=await(await post('/api/conversion/commit',{...p,fields:{categoryIds:[f.category.id]}})).json();assert.equal(r.entity.kind,'term');
    const headers={'x-inkgraph-token':app.token};const state=await(await fetch(base+'/api/state?summary=1',{headers})).json();assert.equal(state.entities.find(x=>x.id===f.note.id).content,undefined);assert.ok(!state.entities.some(x=>x.kind==='conversion-history'));
    const full=await(await fetch(base+'/api/entity?id='+f.note.id,{headers})).json();assert.equal(full.content,f.note.content);assert.deepEqual(full.excerptRefs,[f.snapshot]);
    const h=await(await fetch(base+'/api/conversion/history?id='+f.note.id,{headers})).json();assert.equal(h[0].canUndo,true);assert.equal((await post('/api/conversion/undo',{id:f.note.id,historyId:h[0].id,revision:full.revision})).status,200);
    for(const path of ['/glossary-workspace.js','/taxonomy-model.js'])assert.equal((await fetch(base+path)).status,200);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});
