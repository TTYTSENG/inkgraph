import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { runInNewContext } from 'node:vm';
import { Store } from '../lib/store.mjs';
import { ExtensionBridge } from '../lib/extension-bridge.mjs';
import { makeServer } from '../server.mjs';

const extensionId='a'.repeat(32),target='https://notebooklm.google.com/notebook/test-book';
const makeSource=(store,id)=>store.save('source',{title:'Article '+id,authors:[],origin:'web',url:'https://example.com/'+id,text:'# Markdown\nResearch content',fileHash:'a'.repeat(64),notebookSync:{}},id);

test('Eleven-article upload accepts seed plus ten results, rejects oversized or duplicate batches, and allows a longer upload window',async()=>{
  const s=new Store(':memory:');let now=0;const bridge=new ExtensionBridge(s,{now:()=>now});bridge.pair(extensionId);bridge.poll([{url:target}]);
  try{
    const ids=Array.from({length:12},(_,i)=>makeSource(s,'batch-'+i).id);
    assert.throws(()=>bridge.sync(ids,target),/1 至 11/);
    assert.throws(()=>bridge.sync([...ids.slice(0,10),ids[0]],target),/不同/);
    const queued=bridge.sync(ids.slice(0,11),target);const {job}=bridge.poll([{url:target}]);assert.equal(job.payload.sources.length,11);
    const names=job.payload.sources.map(x=>x.name);assert.equal(new Set(names).size,11);
    now=20*60*1000;bridge.expire();assert.equal(bridge.jobStatus(queued.jobId).status,'running');
    bridge.complete(job.id,job.lease,{results:ids.slice(0,11).map(sourceId=>({sourceId,status:'uploaded'}))});
    assert.equal(bridge.jobStatus(queued.jobId).results.length,11);assert.ok(ids.slice(0,11).every(id=>s.get(id).notebookSync[target].status==='uploaded'));assert.deepEqual(s.get(ids[11]).notebookSync,{});
  }finally{await bridge.close();s.close();}
});
test('Extension capability is scoped, re-pairing revokes old connection, stale heartbeat does not appear connected',async()=>{
  const s=new Store(':memory:');let now=1000;const bridge=new ExtensionBridge(s,{now:()=>now});
  try{assert.throws(()=>bridge.create('retrieve',{}),/連接/);assert.throws(()=>bridge.pair('invalid'));
    const first=bridge.pair(extensionId);assert.doesNotThrow(()=>bridge.authenticate(extensionId,first.capability));assert.throws(()=>bridge.authenticate('b'.repeat(32),first.capability));assert.throws(()=>bridge.authenticate(extensionId,'字'.repeat(64)));
    const second=bridge.pair(extensionId);assert.throws(()=>bridge.authenticate(extensionId,first.capability));assert.doesNotThrow(()=>bridge.authenticate(extensionId,second.capability));now+=45001;assert.equal(bridge.status().connected,false);
  }finally{await bridge.close();s.close();}
});
test('Browser requests require matching URL, valid job lease and bounded reports; timeout rejects waiting capture',async()=>{
  const s=new Store(':memory:');let now=0;const bridge=new ExtensionBridge(s,{now:()=>now});bridge.pair(extensionId);
  try{
    const capture=bridge.retrieveArticle('https://example.com/article');const {job}=bridge.poll();
    assert.throws(()=>bridge.complete(job.id,'wrong',{url:'https://example.com/article',html:'x'}),/憑證/);
    assert.throws(()=>bridge.complete(job.id,job.lease,{url:'https://other.example/article',html:'x'}),/網站/);
    bridge.complete(job.id,job.lease,{url:'https://example.com/article',html:'<article>Original</article>'});assert.match((await capture).html,/Original/);
    assert.throws(()=>bridge.complete(job.id,job.lease,{}));
    const pending=bridge.searchArticles('site:example.com strategy');const rejected=assert.rejects(pending,/逾時/);now=100000;bridge.expire();await rejected;
  }finally{await bridge.close();s.close();}
});
test('Notebook registration filters wrong domains; sync snapshots selected content and only commits complete validated reports',async()=>{
  const s=new Store(':memory:'),bridge=new ExtensionBridge(s);bridge.pair(extensionId);const doc=makeSource(s,'doc-1');
  try{
    bridge.poll([{url:'https://evil.com/notebook/book',title:'Bad'},{url:target,title:'My notebook'}]);assert.equal(bridge.status().notebooks.length,1);
    const old=s.save('source',{...doc,notebookSync:{[target]:{title:'InkGraph-doc-1--bbbbbbbbbbbb.md',hash:'b'.repeat(64)}}},doc.id);
    const queued=bridge.sync([old.id],target,{replace:true});const {job}=bridge.poll([{url:target}]);assert.equal(job.payload.sources[0].text,doc.text);
    assert.throws(()=>bridge.complete(job.id,job.lease,{results:[]}),/不完整/);assert.equal(s.get(doc.id).notebookSync[target].hash,'b'.repeat(64));
    bridge.complete(job.id,job.lease,{results:[{sourceId:doc.id,status:'cleanup_required',pendingCleanupTitles:['InkGraph-doc-1--bbbbbbbbbbbb.md','unmanaged.md'],message:'New source visible; old needs cleanup'}]});
    const receipt=s.get(doc.id).notebookSync[target];assert.equal(receipt.status,'cleanup_required');assert.deepEqual(receipt.pendingCleanupTitles,['InkGraph-doc-1--bbbbbbbbbbbb.md']);assert.equal(bridge.jobStatus(queued.jobId).status,'done');assert.equal('payload' in bridge.jobStatus(queued.jobId),false);
  }finally{await bridge.close();s.close();}
});
test('Failed cloud results retain earlier receipt; invalid second result rolls back every source',async()=>{
  const s=new Store(':memory:'),bridge=new ExtensionBridge(s);bridge.pair(extensionId);bridge.poll([{url:target}]);const a=makeSource(s,'doc-a'),b=makeSource(s,'doc-b');
  try{
    const queued=bridge.sync([a.id,b.id],target);const {job}=bridge.poll([{url:target}]);
    assert.throws(()=>bridge.complete(job.id,job.lease,{results:[{sourceId:a.id,status:'uploaded'},{sourceId:'unknown',status:'uploaded'}]}));assert.deepEqual(s.get(a.id).notebookSync,{});
    bridge.complete(job.id,job.lease,{results:[{sourceId:a.id,status:'failed',message:'UI changed'},{sourceId:b.id,status:'skipped'}]});assert.deepEqual(s.get(a.id).notebookSync,{});assert.equal(bridge.jobStatus(queued.jobId).results[1].status,'skipped');
  }finally{await bridge.close();s.close();}
});
test('Extension HTTP handshake enforces app token, extension identity and Origin; capability cannot read app data',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-extension-'));const app=makeServer({dataPath:dir,port:0});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=(path,body={},headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-inkgraph-extension':extensionId,Origin:'chrome-extension://'+extensionId,...headers},body:JSON.stringify(body)});
  try{
    assert.equal((await post('/api/extension/pair')).status,403);
    assert.equal((await post('/api/extension/pair',{}, {'x-inkgraph-token':app.token,Origin:'https://evil.example'})).status,403);
    const response=await post('/api/extension/pair',{}, {'x-inkgraph-token':app.token});assert.equal(response.headers.get('access-control-allow-origin'),'chrome-extension://'+extensionId);const paired=await response.json();assert.ok(paired.capability);
    assert.equal((await post('/api/extension/poll',{notebooks:[{url:target}]},{'x-inkgraph-capability':paired.capability})).status,200);
    assert.equal((await post('/api/extension/poll',{}, {'x-inkgraph-capability':paired.capability,'x-inkgraph-extension':'b'.repeat(32)})).status,403);
    assert.equal((await fetch(base+'/api/state',{headers:{'x-inkgraph-token':paired.capability}})).status,403);
    assert.equal((await fetch(base+'/api/notebooks',{headers:{'x-inkgraph-token':app.token}})).status,200);
    const preflight=await fetch(base+'/api/extension/poll',{method:'OPTIONS',headers:{Origin:'chrome-extension://'+extensionId}});assert.equal(preflight.status,204);
  }finally{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});}
});

async function agentFixture({old=false,wrongTarget=false,canRemove=false}={}){
  const dom=new JSDOM('<body><button id="add">add Add sources</button><section id="sources"></section></body>',{url:target,runScripts:'outside-only'});let listener,complete;
  const w=dom.window;w.HTMLElement.prototype.getClientRects=()=>[{width:100,height:20}];w.setInterval=()=>0;
  w.chrome={runtime:{onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async m=>{if(m.type==='complete')complete=m;return {ok:true};}}};
  w.DataTransfer=class {constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};
  const current='InkGraph-doc--aaaaaaaaaaaa.md',previous='InkGraph-doc--bbbbbbbbbbbb.md';
  if(old){const row=w.document.createElement('div');const title=w.document.createElement('span');title.textContent=previous;row.append(title);w.document.getElementById('sources').append(row);
    if(canRemove){const menu=w.document.createElement('button');menu.setAttribute('aria-label','Source actions');menu.textContent='more_vert';row.append(menu);
      menu.onclick=()=>{assert.match(w.document.getElementById('sources').textContent,/aaaaaaaaaaaa/,'New version must exist before removing old');const item=w.document.createElement('button');item.setAttribute('role','menuitem');item.textContent='Remove source';w.document.body.append(item);
        item.onclick=()=>{item.remove();const dialog=w.document.createElement('div');dialog.setAttribute('role','dialog');const confirm=w.document.createElement('button');confirm.setAttribute('aria-label','Delete');confirm.textContent='Delete';dialog.append(confirm);w.document.body.append(dialog);confirm.onclick=()=>{row.remove();dialog.remove();};};};
    }
  }
  w.document.getElementById('add').onclick=()=>{
    const dialog=w.document.createElement('div');dialog.setAttribute('role','dialog');const input=w.document.createElement('input');input.type='file';Object.defineProperty(input,'files',{value:[],writable:true});dialog.append(input);w.document.body.append(dialog);
    input.onchange=()=>{const row=w.document.createElement('div');row.textContent=input.files[0].name;w.document.getElementById('sources').append(row);dialog.remove();};
  };
  w.eval(readFileSync(new URL('../chrome-extension/page-agent.js',import.meta.url),'utf8'));
  await new Promise(resolve=>listener({type:'inkgraph-register'},{},resolve));
  listener({type:'inkgraph-sync',job:{id:'job',lease:'lease',payload:{notebook:wrongTarget?target+'-other':target,replace:true,sources:[{id:'doc',name:current,text:'# Real Markdown fixture',outdated:old?[previous]:[]}]}}},{},()=>{});
  const until=Date.now()+2000;while(!complete&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.ok(complete,'The real content agent must report a result');return {dom,complete,current,previous};
}
test('Actual extension content agent uploads via file input and reports visible source, not a mocked success function',async()=>{
  const fixture=await agentFixture();try{assert.equal(fixture.complete.result.results[0].status,'uploaded');assert.match(fixture.dom.window.document.getElementById('sources').textContent,/InkGraph-doc--aaaaaaaaaaaa/);}finally{fixture.dom.window.close();}
});
test('Actual content agent preserves old source when its menu cannot be identified and rejects switched notebook',async()=>{
  const fixture=await agentFixture({old:true});try{assert.equal(fixture.complete.result.results[0].status,'cleanup_required');assert.equal(fixture.complete.result.results[0].pendingCleanupTitles[0],fixture.previous);assert.match(fixture.dom.window.document.getElementById('sources').textContent,/bbbbbbbbbbbb/);}finally{fixture.dom.window.close();}
  const wrong=await agentFixture({wrongTarget:true});try{assert.equal(wrong.complete.result.results[0].status,'failed');assert.equal(wrong.dom.window.document.getElementById('sources').textContent,'');}finally{wrong.dom.window.close();}
});
test('Actual content agent removes exactly the prior managed source after the new one appears, with accessible confirmation labels',async()=>{
  const fixture=await agentFixture({old:true,canRemove:true});try{assert.equal(fixture.complete.result.results[0].status,'uploaded');assert.doesNotMatch(fixture.dom.window.document.getElementById('sources').textContent,/bbbbbbbbbbbb/);assert.match(fixture.dom.window.document.getElementById('sources').textContent,/aaaaaaaaaaaa/);}finally{fixture.dom.window.close();}
});

test('Actual extension worker dispatches Google search and refuses article access without site permission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-worker-'));const app=makeServer({dataPath:dir,port:0});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  let messageListener;const data={},tabs=new Map();let nextTab=0;const created=[];
  const chrome={runtime:{id:extensionId,onMessage:{addListener:fn=>{messageListener=fn;}}},storage:{session:{get:async keys=>{const out={};for(const k of typeof keys==='string'?[keys]:keys)out[k]=data[k];return out;},set:async patch=>Object.assign(data,patch),clear:async()=>{for(const k of Object.keys(data))delete data[k];}}},alarms:{create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}},permissions:{contains:async({origins})=>origins.every(x=>x==='https://www.google.com/*')},tabs:{create:async({url})=>{const tab={id:++nextTab,url,status:'complete'};tabs.set(tab.id,tab);created.push(url);return tab;},get:async id=>tabs.get(id),remove:async id=>tabs.delete(id),update:async()=>{},onUpdated:{addListener:()=>{},removeListener:()=>{}},onRemoved:{addListener:()=>{},removeListener:()=>{}}},scripting:{executeScript:async({target})=>[{result:{url:tabs.get(target.tabId).url,html:'<article>Google results</article>',textLength:1000,title:'Google Search',links:[{url:'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fstrategy',title:'CEO strategy and resource allocation'}]}}]}};
  runInNewContext(readFileSync(new URL('../chrome-extension/background.js',import.meta.url),'utf8'),{chrome,URL,AbortSignal,setTimeout,clearTimeout,fetch:(url,options)=>fetch(base+new URL(url).pathname,{...options,headers:{...options.headers,Origin:'chrome-extension://'+extensionId}})});
  const message=(m,sender)=>new Promise(resolve=>messageListener(m,sender,resolve));
  try{
    assert.equal((await message({type:'pair',token:app.token},{id:extensionId})).ok,true);
    const search=app.extension.searchArticles('site:example.com CEO strategy');await message({type:'wake'},{tab:{id:1,url:'http://127.0.0.1:4317/#web'}});const links=await search;
    assert.equal(new URL(created[0]).hostname,'www.google.com');assert.equal(links[0].url,'https://example.com/strategy');assert.equal(data.connection.capability===app.token,false);
    const capture=app.extension.retrieveArticle('https://example.com/article');const failure=assert.rejects(capture,/尚未允許/);await message({type:'wake'},{tab:{id:1,url:'http://127.0.0.1:4317/#web'}});await failure;
    assert.equal(created.length,1,'Unauthorized site must not be opened or scraped');
  }finally{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});}
});
