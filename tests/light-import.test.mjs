import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { LightImport } from '../lib/light-import.mjs';
import { makeServer } from '../server.mjs';
import { JSDOM } from 'jsdom';
import { createLightImport } from '../public/light-import.js';
import { markdown, reportHTML, resolveNote, exportContent } from '../lib/exports.mjs';

const bundle=()=>({format:'light-inkgraph',version:1,
  sources:[{key:'a',title:'測試文獻 A',authors:[{literal:'測試作者'}],year:2026,doi:'https://doi.org/10.1234/TEST',verification:'CONFIRMED'},
    {key:'b',title:'測試文獻 B',authors:[],url:'https://example.org/paper#abstract'}],
  annotations:[{sourceKey:'a',quote:'合成測試摘錄',locator:'p. 1',verified:true}],
  notes:[{title:'合成研究筆記',content:'僅供測試',sourceKeys:['a','b']}],
  relations:[{fromKey:'a',toKey:'b',relation:'compares',reason:'測試比較'}]});
const commit=(service,b,projectId=null)=>service.commit(b,projectId,service.preview(b,projectId).fingerprint);
function fixture(fn){const store=new Store(':memory:');try{return fn(store,new LightImport(store));}finally{store.close();}}

test('Inline package keys become stable source IDs with pages, unknown markers warn, repeat and undo work',()=>fixture((s,l)=>{
  const b=bundle();b.sources[0].key='中文_代號.1';b.annotations=[];b.relations=[];
  b.notes[0].sourceKeys=[];b.notes[0].content='證據 [@中文_代號.1, p. 12–13] 及 [@b]，未知 [@missing_key]';
  const p=l.preview(b);assert.match(p.rows.find(r=>r.kind==='note').warnings.join(''),/missing_key.*不存在/);
  const result=l.commit(b,null,p.fingerprint),note=s.list().find(r=>r.kind==='note'),a=s.list().find(r=>r.doi),sources=s.list().filter(r=>r.kind==='source');
  assert.ok(note.content.includes(`[@${a.id}, p. 12–13]`));assert.equal(note.sourceIds.length,2);
  assert.ok(!note.content.includes('light-preview-'));
  const output=resolveNote(note,sources);assert.match(output.content,/12–13/);assert.match(output.content,/\[@missing_key\]〔來源遺失〕/);
  assert.equal(l.preview(b).added,0);assert.equal(l.undo(result.batch).removed,3);
}));

test('Existing same-project source IDs resolve; excluded and cross-project citations remain visible warnings',()=>fixture((s,l)=>{
  const other=s.save('project',{title:'其他'}),source=s.save('source',{title:'既有',authors:[]}),foreign=s.save('source',{title:'其他來源',authors:[],projectId:other.id});
  const b=bundle();b.notes[0].content=`正文 [@a] [@${source.id}] [@${foreign.id}]`;
  const p=l.preview(b,null,['sources:0']);assert.match(p.rows.find(r=>r.kind==='note').warnings.join(''),/已排除/);
  l.commit(b,null,p.fingerprint,['sources:0']);const n=s.list().find(r=>r.kind==='note');
  assert.ok(n.sourceIds.includes(source.id));assert.ok(!n.sourceIds.includes(foreign.id));assert.ok(n.content.includes('[@a]'));
}));

test('Provider evidence survives JSON, Markdown and HTML without claiming local verification',()=>fixture((s,l)=>{
  const b=bundle();b.sources[0].evidence={provider:'<Provider>',readLevel:'abstract',checkedAt:'2026-10-20',url:'https://example.org/evidence',note:'只查摘要'};
  commit(l,b);const state=s.list(),a=state.find(r=>r.doi);
  assert.equal(a.lightEvidence.readLevel,'abstract');assert.equal(a.lightEvidence.provider,'<Provider>');
  const md=markdown(state),html=reportHTML(state),json=JSON.parse(exportContent(state,'json')[2]);
  for(const text of [md,html]){assert.match(text,/提供者聲明：CONFIRMED/);assert.match(text,/墨脈人工核查：未確認/);assert.match(text,/只查摘要/);}
  assert.ok(html.includes('&lt;Provider&gt;'));assert.ok(!html.includes('<Provider>'));
  assert.equal(json.entities.find(r=>r.id===a.id).lightEvidence.readLevel,'abstract');
  assert.equal(state.find(r=>r.kind==='annotation').verified,false);
  const bad=bundle();bad.sources[0].evidence={readLevel:'invented'};assert.throws(()=>l.preview(bad),/閱讀範圍/);
}));

test('Preview exclusions resume across page recreation only for identical content and project, then clear on commit',async()=>{
  const dom=new JSDOM('<main></main>',{url:'http://localhost'}),old=globalThis.document;globalThis.document=dom.window.document;
  const s=new Store(':memory:'),l=new LightImport(s),p=s.save('project',{title:'測試專案'}),b=bundle();
  const make=()=>createLightImport({api:async(path,opts)=>({json:async()=>path.endsWith('/preview')?l.preview(opts.body.bundle,opts.body.projectId,opts.body.excludedIds):l.commit(opts.body.bundle,opts.body.projectId,opts.body.fingerprint,opts.body.excludedIds)}),e:v=>String(v??''),heading:()=>'',toast:()=>{},refresh:async()=>{},project:()=>'',entities:()=>[p]});
  const ui=make();
  const mount=()=>{document.querySelector('main').innerHTML=ui.render();ui.bind();};
  const submit=async(value=b,projectId='')=>{
    const f=document.querySelector('#light-file');Object.defineProperty(f,'files',{configurable:true,value:[{size:100,text:async()=>JSON.stringify(value)}]});
    document.querySelector('#light-project').value=projectId;
    await document.querySelector('#light-form').onsubmit({preventDefault(){}});
  };
  try{
    mount();await submit();await document.querySelector('#light-preview').onclick({target:document.querySelector('[data-light-row="notes:0"]')});
    mount();await submit();assert.match(document.querySelector('#light-status').textContent,/新增 4 筆.*接續/);
    const stored=dom.window.localStorage.getItem('inkgraph-light-selections-v1');assert.ok(!stored.includes('測試文獻'));
    mount();await submit(b,p.id);assert.match(document.querySelector('#light-status').textContent,/新增 5 筆/);
    mount();await submit({...b,notes:[{...b.notes[0],content:'不同版本'}]});assert.match(document.querySelector('#light-status').textContent,/新增 5 筆/);
    mount();await submit();assert.match(document.querySelector('#light-status').textContent,/新增 4 筆/);
    await document.querySelector('#light-confirm').onclick();
    const saved=JSON.parse(dom.window.localStorage.getItem('inkgraph-light-selections-v1'));assert.ok(Object.values(saved).every(v=>v.ids.length===0));
  }finally{s.close();globalThis.document=old;dom.window.close();}
});

test('Excluding a source removes dependent items, detaches note links, and restores without changing the package',()=>fixture((s,l)=>{
  const b=bundle(),original=JSON.stringify(b),full=l.preview(b),excluded=['sources:0'];
  const p=l.preview(b,null,excluded);
  assert.equal(p.added,2);assert.equal(p.removed,3);assert.equal(p.automaticRemoved,2);assert.equal(p.rows.length,5);
  assert.equal(p.rows.find(r=>r.rowId==='annotations:0').automaticExcluded,true);
  assert.match(p.rows.find(r=>r.rowId==='notes:0').warnings[0],/解除 1 個文獻連結/);
  assert.equal(s.list().length,0);assert.equal(JSON.stringify(b),original);
  assert.equal(l.preview(b,null,[]).fingerprint,full.fingerprint);
  const r=l.commit(b,null,p.fingerprint,excluded);assert.equal(r.added,2);assert.equal(r.removed,3);
  const sources=s.list().filter(r=>r.kind==='source'),note=s.list().find(r=>r.kind==='note');
  assert.equal(sources.length,1);assert.equal(sources[0].title,'測試文獻 B');assert.deepEqual(note.sourceIds,[sources[0].id]);assert.equal(note.content,b.notes[0].content);
  assert.equal(l.undo(r.batch).removed,2);
}));

test('Individual exclusion and restore preserve other selections; all items can be excluded',()=>fixture((s,l)=>{
  const b=bundle();
  for(const id of ['annotations:0','notes:0','relations:0']){
    const p=l.preview(b,null,[id]);assert.equal(p.removed,1);assert.equal(p.added,4);assert.equal(p.automaticRemoved,0);
  }
  const p=l.preview(b,null,['sources:0','annotations:0']);assert.equal(p.removed,3);
  const restored=l.preview(b,null,['annotations:0']);assert.equal(restored.rows.find(r=>r.rowId==='sources:0').status,'new');assert.equal(restored.removed,1);
  const all=['sources:0','sources:1','notes:0'],none=l.preview(b,null,all);
  assert.equal(none.added,0);assert.equal(none.removed,5);assert.equal(none.skipped,0);
  assert.equal(l.commit(b,null,none.fingerprint,all).batch,null);assert.equal(s.list().length,0);
}));

test('Excluding an existing duplicate never deletes or edits existing data',()=>fixture((s,l)=>{
  const old=s.save('source',{title:'既有來源',authors:[],doi:'10.1234/test'});
  const b=bundle(),excluded=['sources:0'],p=l.preview(b,null,excluded);
  const batch=l.commit(b,null,p.fingerprint,excluded);assert.deepEqual(s.get(old.id),old);
  l.undo(batch.batch);assert.deepEqual(s.list(),[old]);
}));

test('Selection is validated and bound to the preview fingerprint',()=>fixture((s,l)=>{
  const b=bundle(),p=l.preview(b,null,['notes:0']);
  assert.throws(()=>l.commit(b,null,p.fingerprint,[]),e=>e.status===409);
  for(const excluded of ['sources:0',[null],['sources:99'],['source:0'],['notes:00']])assert.throws(()=>l.preview(b,null,excluded),/移除清單/);
  assert.equal(l.preview(b,null,['notes:0','annotations:0']).fingerprint,l.preview(b,null,['annotations:0','notes:0','notes:0']).fingerprint);
  assert.equal(s.list().length,0);
}));

test('Author strings and mixed structured names import without guessing name parts or changing the package',()=>fixture((s,l)=>{
  const b=bundle();b.sources[0].authors=[' Monica S. Perlmutter ',{family:'王',given:'小明'},{literal:'研究機構'}];
  const original=JSON.stringify(b),p=l.preview(b);
  assert.equal(s.list().length,0);l.commit(b,null,p.fingerprint);
  const source=s.list().find(r=>r.doi==='10.1234/test');
  assert.deepEqual(source.authors,[{literal:'Monica S. Perlmutter'},{family:'王',given:'小明'},{literal:'研究機構'}]);
  assert.equal(JSON.stringify(b),original);assert.equal(l.preview(b).added,0);
  const structured=structuredClone(b);structured.sources[0].authors[0]={literal:'Monica S. Perlmutter'};
  assert.equal(l.preview(structured).added,0);
}));

test('Invalid author formats identify the exact source and author position without writing',()=>fixture((s,l)=>{
  for(const bad of [[''],[null],[123],[{}],[{literal:' '}],['valid',false],'Name']){
    const b=bundle();b.sources[1].authors=bad;
    assert.throws(()=>l.preview(b),e=>e.status===400 && /文獻第 2 筆/.test(e.message) && /測試文獻 B/.test(e.message) && /作者/.test(e.message));
    assert.equal(s.list().length,0);
  }
}));

test('Preview is read-only; commit resolves all references; repeat import is idempotent and undo preserves existing data',()=>fixture((s,l)=>{
  const existing=s.save('source',{title:'既有原文',authors:[],doi:'10.1234/test',summary:'保留內容'});
  const before=s.list();const p=l.preview(bundle());assert.equal(p.added,4);assert.equal(p.skipped,1);assert.deepEqual(s.list(),before);
  const r=l.commit(bundle(),null,p.fingerprint);assert.equal(r.added,4);
  const annotation=s.list().find(r=>r.kind==='annotation');assert.equal(annotation.sourceId,existing.id);assert.equal(annotation.verified,false);
  const note=s.list().find(r=>r.kind==='note');assert.ok(note.sourceIds.every(id=>s.get(id)?.kind==='source'));
  assert.equal(s.get(existing.id).summary,'保留內容');
  const repeat=commit(l,bundle());assert.equal(repeat.added,0);assert.equal(repeat.skipped,5);assert.equal(repeat.batch,null);
  assert.equal(l.batches().length,1);assert.equal(l.undo(r.batch).removed,4);assert.deepEqual(s.list(),before);
}));

test('New-source references remain idempotent after insertion and service restart',()=>fixture((s,l)=>{
  const r=commit(l,bundle());assert.equal(r.added,5);assert.equal(new LightImport(s).preview(bundle()).added,0);
  assert.equal(new LightImport(s).undo(r.batch).removed,5);assert.equal(s.list().length,0);
}));

test('A write failure rolls back all new records in the batch',()=>fixture((s,l)=>{
  const b=bundle(),p=l.preview(b),save=s.save.bind(s);let n=0;
  s.save=(...args)=>{if(++n===4)throw Error('simulated failure');return save(...args);};
  assert.throws(()=>l.commit(b,null,p.fingerprint),/simulated failure/);assert.equal(s.list().length,0);
}));

test('Malformed packages, missing references and conflicting identities never write; cross-project preview reuses sources',()=>fixture((s,l)=>{
  const invalid=[{}, {...bundle(),version:2},{...bundle(),sources:'wrong'}, {...bundle(),annotations:[{sourceKey:'missing',quote:'x',locator:'p1'}]}, {...bundle(),relations:[{fromKey:'a',toKey:'a',relation:'compares'}]}, {...bundle(),sources:[{key:'a',title:'x',url:'javascript:alert(1)'}]}];
  for(const b of invalid){assert.throws(()=>l.preview(b));assert.equal(s.list().length,0);}
  const p=s.save('project',{title:'其他專案'});s.save('source',{title:'另一專案文獻',authors:[],doi:'10.1234/test',projectId:p.id});
  assert.equal(l.preview(bundle()).skipped,1);assert.equal(s.list().length,2);
  s.save('source',{title:'網址與 DOI 衝突',authors:[],url:'https://example.org/conflict'});
  const b=bundle();b.sources[0].url='https://example.org/conflict';assert.throws(()=>l.preview(b,p.id));
}));

test('Preview fingerprints reject edited package and changed project but accept unrelated records and attachments',()=>fixture((s,l)=>{
  const b=bundle(),p=l.preview(b),changed=bundle();changed.notes[0].content='changed';
  assert.throws(()=>l.commit(changed,null,p.fingerprint),/重新預覽/);assert.equal(s.list().length,0);
  const project=s.save('project',{title:'智慧光測試'});assert.throws(()=>l.commit(b,project.id,p.fingerprint),/重新預覽/);
  const before=l.preview(b);const source=s.save('source',{title:'附件來源',authors:[]});s.attach(source.id,'test.txt','text/plain',Buffer.from('test'));
  assert.equal(l.commit(b,null,before.fingerprint).added,5);assert.equal(s.list().length,7);
}));

test('Undo blocks edited, missing, attached and externally referenced batch members',()=>{
  for(const variant of ['edited','missing','attachment','note','annotation','relation','citation'])fixture((s,l)=>{
    const r=commit(l,bundle()),source=s.list().find(x=>x.kind==='source'),other=s.save('source',{title:'保留',authors:[]});
    if(variant==='edited')s.save('source',{...source,title:'人工修改'},source.id);
    if(variant==='missing')s.db.prepare('DELETE FROM entities WHERE id=?').run(s.list().find(x=>x.kind==='annotation').id);
    if(variant==='attachment')s.attach(source.id,'test.txt','text/plain',Buffer.from('test'));
    if(variant==='note')s.save('note',{title:'外部筆記',sourceIds:[source.id]});
    if(variant==='citation')s.save('note',{title:'引用',sourceIds:[],content:`證據 [@${source.id}]`});
    if(variant==='annotation')s.save('annotation',{sourceId:source.id,quote:'外部摘錄',locator:'p.2'});
    if(variant==='relation')s.save('relation',{from:source.id,to:other.id,relation:'supports'});
    const before=s.list();assert.throws(()=>l.undo(r.batch),e=>e.status===409);assert.deepEqual(s.list(),before);
  });
});

test('HTTP workflow enforces session auth and persists batches across service restarts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-light-'));let app=makeServer({dataPath:dir,port:0});
  const start=async()=>{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${app.server.address().port}`;};
  const stop=async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();};
  try{
    let base=await start();const send=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'x-inkgraph-token':app.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await fetch(base+'/api/light/batches')).status,403);
    const script=await fetch(base+'/light-import.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
    assert.equal((await fetch(base+'/research-evidence.js')).status,200);
    const p=await(await send('/api/light/preview',{bundle:bundle()})).json();assert.equal(app.store.list().length,0);
    const r=await(await send('/api/light/commit',{bundle:bundle(),fingerprint:p.fingerprint})).json();assert.equal(r.added,5);
    await stop();app=makeServer({dataPath:dir,port:0});base=await start();assert.equal((await(await send('/api/light/batches')).json()).length,1);
    assert.equal((await(await send('/api/light/undo',{batch:r.batch})).json()).removed,5);assert.equal(app.store.list().length,0);
    const excludedIds=['sources:0'],selected=await(await send('/api/light/preview',{bundle:bundle(),excludedIds})).json();
    assert.equal(selected.added,2);assert.equal(selected.removed,3);
    assert.equal((await send('/api/light/commit',{bundle:bundle(),fingerprint:selected.fingerprint,excludedIds:[]})).status,409);
    assert.equal(app.store.list().length,0);
    const imported=await(await send('/api/light/commit',{bundle:bundle(),fingerprint:selected.fingerprint,excludedIds})).json();
    assert.equal(imported.added,2);assert.equal(app.store.list().filter(r=>r.kind==='source').length,1);
    const source=app.store.list().find(r=>r.kind==='source'),project=app.store.save('project',{title:'API scope test'});
    assert.equal((await send('/api/entities',{kind:'source',id:source.id,data:{...source,projectId:project.id}})).status,400);
    assert.equal((await send('/api/sources/project',{id:source.id,projectId:project.id,operation:'link'})).status,200);
    assert.ok(app.store.get(source.id).projectIds.includes(project.id));
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});

test('Import UI escapes package titles, requires preview, invalidates changed project, and supports confirmation',async()=>{
  const dom=new JSDOM('<main></main>');const old=globalThis.document;globalThis.document=dom.window.document;
  let writes=0,refreshes=0;const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ui=createLightImport({api:async(path,opts)=>({json:async()=>path.endsWith('/preview')?{added:1,skipped:0,fingerprint:'x',rows:[{kind:'source',title:'<img src=x onerror=alert(1)>',status:'new',verification:'UNRESOLVED'}]}:(writes++,{added:1,skipped:0})}),e,heading:()=>'',toast:()=>{},refresh:async()=>{refreshes++;},project:()=>'',entities:()=>[{id:'project1',kind:'project',title:'測試專案'}]});
  try{
    document.querySelector('main').innerHTML=ui.render();ui.bind();assert.equal(document.querySelector('#light-confirm'),null);
    const file=document.querySelector('#light-file');Object.defineProperty(file,'files',{value:[{size:10,text:async()=>JSON.stringify(bundle())}]});
    await document.querySelector('#light-form').onsubmit({preventDefault(){}});assert.equal(writes,0);assert.equal(document.querySelector('#light-preview img'),null);
    document.querySelector('#light-project').value='project1';document.querySelector('#light-project').onchange();assert.equal(document.querySelector('#light-confirm'),null);
    await document.querySelector('#light-form').onsubmit({preventDefault(){}});await document.querySelector('#light-confirm').onclick();assert.equal(writes,1);assert.equal(refreshes,1);
  }finally{globalThis.document=old;dom.window.close();}
});

test('Preview controls remove, restore, detach note links and commit only the selected records',async()=>{
  const dom=new JSDOM('<main></main>'),old=globalThis.document;globalThis.document=dom.window.document;
  const s=new Store(':memory:'),l=new LightImport(s),b=bundle(),original=JSON.stringify(b);
  const ui=createLightImport({api:async(path,opts)=>({json:async()=>path.endsWith('/preview')?l.preview(opts.body.bundle,null,opts.body.excludedIds):l.commit(opts.body.bundle,null,opts.body.fingerprint,opts.body.excludedIds)}),e:v=>String(v??''),heading:()=>'',toast:()=>{},refresh:async()=>{},project:()=>'',entities:()=>[]});
  try{
    document.querySelector('main').innerHTML=ui.render();ui.bind();
    Object.defineProperty(document.querySelector('#light-file'),'files',{value:[{size:100,text:async()=>original}]});
    await document.querySelector('#light-form').onsubmit({preventDefault(){}});
    const out=document.querySelector('#light-preview'),row=id=>out.querySelector(`[data-light-row="${id}"]`),click=async target=>out.onclick({target});
    await click(row('sources:0'));assert.match(document.querySelector('#light-status').textContent,/新增 2 筆.*移除 3 筆/);
    assert.equal(row('annotations:0').disabled,true);assert.equal(row('relations:0').disabled,true);assert.match(out.textContent,/請檢查文字引用/);
    assert.equal(s.list().length,0);
    await click(row('sources:0'));assert.match(document.querySelector('#light-status').textContent,/新增 5 筆.*移除 0 筆/);
    await click(row('notes:0'));assert.match(document.querySelector('#light-status').textContent,/新增 4 筆/);
    await click(out.querySelector('[data-light-restore-all]'));assert.match(document.querySelector('#light-status').textContent,/新增 5 筆/);
    await click(row('sources:0'));await document.querySelector('#light-confirm').onclick();
    assert.equal(s.list().length,2);assert.equal(s.list().some(r=>r.kind==='annotation'||r.kind==='relation'),false);
    assert.equal(s.list().find(r=>r.kind==='note').sourceIds.length,1);assert.equal(JSON.stringify(b),original);
  }finally{s.close();globalThis.document=old;dom.window.close();}
});

test('Selection preview errors invalidate confirmation until a successful retry',async()=>{
  const dom=new JSDOM('<main></main>'),old=globalThis.document;globalThis.document=dom.window.document;
  const s=new Store(':memory:'),l=new LightImport(s);let fail=false;
  const ui=createLightImport({api:async(path,opts)=>{if(fail)throw Error('暫時無法更新');return {json:async()=>l.preview(opts.body.bundle,null,opts.body.excludedIds)};},e:v=>String(v??''),heading:()=>'',toast:()=>{},refresh:async()=>{},project:()=>'',entities:()=>[]});
  try{
    document.querySelector('main').innerHTML=ui.render();ui.bind();Object.defineProperty(document.querySelector('#light-file'),'files',{value:[{size:100,text:async()=>JSON.stringify(bundle())}]});
    const form=document.querySelector('#light-form');await form.onsubmit({preventDefault(){}});
    fail=true;await document.querySelector('#light-preview').onclick({target:document.querySelector('[data-light-row="notes:0"]')});
    assert.equal(document.querySelector('#light-confirm'),null);assert.match(document.querySelector('#light-status').textContent,/重試/);assert.equal(s.list().length,0);
    fail=false;await form.onsubmit({preventDefault(){}});assert.match(document.querySelector('#light-status').textContent,/新增 4 筆.*移除 1 筆/);
  }finally{s.close();globalThis.document=old;dom.window.close();}
});
