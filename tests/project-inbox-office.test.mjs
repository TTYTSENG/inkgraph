import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { parseFile,MAX_FILE } from '../lib/imports.mjs';
import { backup,restore,markdown } from '../lib/exports.mjs';
import { makeServer } from '../server.mjs';
import { xlsxFixture,pptxFixture,docxFixture,legacyFixture } from './office-fixtures.mjs';

test('Batch project linking is atomic, preserves source IDs, skips existing membership and survives project rename',()=>{
  const store=new Store(':memory:');try{
    const p=store.save('project',{title:'A'}),sources=[1,2].map(n=>store.save('source',{title:'S'+n,authors:[],text:'Original '+n}));
    const result=store.batchLinkSources({sources:sources.map(r=>({id:r.id,revision:r.revision})),projectId:p.id});assert.equal(result.linked,2);assert.equal(store.list().filter(r=>r.kind==='source').length,2);
    assert.equal(store.batchLinkSources({sources:sources.map(r=>({id:r.id,revision:r.revision})),projectId:p.id}).alreadyLinked,2);
    const changed=store.save('project',{...p,title:'New name'},p.id);assert.equal(changed.id,p.id);assert.ok(store.state().filter(r=>r.kind==='source').every(r=>r.projectIds.includes(p.id)));
    assert.throws(()=>store.save('project',{...p,title:'Stale'},p.id),e=>e.status===409);
    const before=store.list();assert.throws(()=>store.batchLinkSources({sources:[{id:sources[0].id,revision:0},{id:sources[1].id,revision:1}],newProject:{title:'Must not remain'}}),e=>e.status===409);assert.deepEqual(store.list(),before);
    assert.throws(()=>store.batchLinkSources({sources:[{id:sources[0].id,revision:1},{id:'missing',revision:1}],newProject:{title:'No orphan'}}));assert.deepEqual(store.list(),before);
    assert.throws(()=>store.batchLinkSources({sources:[{id:sources[0].id,revision:1}],newProject:{title:''}}));assert.deepEqual(store.list(),before);
  }finally{store.close();}
});
test('New-project batch operation rolls back even if a later membership write fails',()=>{
  const store=new Store(':memory:');try{
    const rows=[1,2].map(n=>store.save('source',{title:'S'+n,authors:[]})),before=store.list(),original=store.linkSource.bind(store);let calls=0;
    store.linkSource=(...args)=>{if(++calls===2)throw new Error('injected failure');return original(...args);};
    assert.throws(()=>store.batchLinkSources({sources:rows.map(r=>({id:r.id,revision:r.revision})),newProject:{title:'Atomic'}}),/injected failure/);assert.deepEqual(store.list(),before);
  }finally{store.close();}
});
test('Office extraction retains worksheet/cell and slide order without executing formulas',async()=>{
  const xlsx=await parseFile('data.XLSX',await xlsxFixture());assert.match(xlsx.text,/工作表：合成研究表/);assert.match(xlsx.text,/A1：合成標題/);assert.match(xlsx.text,/第 3 列｜A3：3｜B3：TRUE/);assert.match(xlsx.text,/公式沒有快取結果/);assert.equal(xlsx.pages[0].label,'工作表：合成研究表');assert.ok(xlsx.warnings.some(w=>w.includes('不重新計算')));
  const ppt=await parseFile('slides.pptx',await pptxFixture());assert.match(ppt.pages[0].text,/第一張合成頁/);assert.match(ppt.pages[1].text,/第二張合成頁/);assert.equal(ppt.pages[0].label,'投影片第 1 張');assert.match(ppt.text,/第一張合成頁\n可引用/);
  assert.match((await parseFile('paper.docx',await docxFixture())).text,/Word 合成研究文字/);
});
test('Legacy Office files are download-only; malformed/oversized or external-reference packages are rejected',async()=>{
  for(const ext of ['doc','xls','ppt']){const result=await parseFile('old.'+ext,legacyFixture());assert.equal(result.text,'');assert.match(result.parseStatus,/僅保存原檔/);}
  await assert.rejects(()=>parseFile('fake.xls',Buffer.from('not an Office file')),/副檔名不符/);
  await assert.rejects(()=>parseFile('bad.xlsx',Buffer.from('bad zip')),/無效|有效/);
  await assert.rejects(async()=>parseFile('xxe.xlsx',await xlsxFixture({unsafeXML:true})),/XML/);
  await assert.rejects(async()=>parseFile('external.xlsx',await xlsxFixture({external:true})),/參照無效/);
  await assert.rejects(()=>parseFile('large.pptx',Buffer.alloc(MAX_FILE+1)),/25 MB/);
});
test('Office originals and extracted locations survive export/backup restoration byte-for-byte',async()=>{
  const store=new Store(':memory:'),target=new Store(':memory:');try{
    for(const [name,bytes] of [['data.xlsx',await xlsxFixture()],['slides.pptx',await pptxFixture()],['old.doc',legacyFixture()]]){const parsed=await parseFile(name,bytes),source=store.save('source',{title:name,authors:[],...parsed});store.attach(source.id,name,parsed.mime,bytes);}
    const md=markdown(store.list());assert.ok(store.list().find(r=>r.title==='data.xlsx').pages[0].label.includes('工作表'));
    await restore(target,await backup(store));for(const file of store.files()){assert.deepEqual(Buffer.from(target.file(file.id).bytes),Buffer.from(file.bytes));assert.equal(target.file(file.id).mime,file.mime);}
    assert.equal(target.list().find(r=>r.title==='slides.pptx').pages[0].label,'投影片第 1 張');
  }finally{store.close();target.close();}
});
test('Batch and Office HTTP endpoints keep authentication and return full attachment metadata on direct open',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-office-http-')),app=makeServer({dataPath:root,port:0});try{
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`,headers={'x-inkgraph-token':app.token,origin:base,'content-type':'application/json'};
    const source=app.store.save('source',{title:'Inbox',authors:[]});
    assert.equal((await fetch(base+'/api/sources/batch-project',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    const result=await fetch(base+'/api/sources/batch-project',{method:'POST',headers,body:JSON.stringify({sources:[{id:source.id,revision:1}],newProject:{title:'New project'}})});assert.equal(result.status,200);assert.equal((await result.json()).linked,1);
    const bytes=await xlsxFixture(),uploaded=await fetch(base+'/api/import',{method:'POST',headers,body:JSON.stringify({name:'data.xlsx',base64:bytes.toString('base64')})});assert.equal(uploaded.status,200);const id=(await uploaded.json()).sourceId;
    const details=await(await fetch(base+'/api/entity?id='+id,{headers})).json();assert.equal(details.attachment.name,'data.xlsx');assert.match(details.text,/合成標題/);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});
