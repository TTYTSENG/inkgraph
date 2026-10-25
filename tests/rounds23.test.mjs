import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Store } from '../lib/store.mjs';
import { LightImport } from '../lib/light-import.mjs';
import { backup,restore,projectState,markdown } from '../lib/exports.mjs';
import { LiteratureSearch,mergeCandidates } from '../lib/literature-search.mjs';
const pack=()=>({format:'light-inkgraph',version:1,sources:[{key:'a',title:'共用來源',authors:[],doi:'10.1234/shared'}],notes:[{title:'專案筆記',content:'引用 [@a]',sourceKeys:['a']}]});
const importInto=(l,b,id)=>l.commit(b,id,l.preview(b,id).fingerprint);
const fixture=async fn=>{const s=new Store(':memory:');try{await fn(s,new LightImport(s));}finally{s.close();}};

test('Cross-project import shares source and attachment, keeps notes scoped, repeat and undo are safe',()=>fixture(async(s,l)=>{
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'});
  importInto(l,pack(),a.id);const source=s.list().find(r=>r.kind==='source'),file=s.attach(source.id,'evidence.txt','text/plain',Buffer.from('evidence'));
  const result=importInto(l,pack(),b.id);
  assert.equal(result.added,2);assert.equal(s.list().filter(r=>r.kind==='source').length,1);assert.equal(s.files().length,1);
  assert.deepEqual(new Set(s.get(source.id).projectIds),new Set([a.id,b.id]));
  for(const project of [a,b]){const state=projectState(s.list(),project.id);assert.equal(state.filter(r=>r.kind==='source').length,1);assert.equal(state.filter(r=>r.kind==='note').length,1);assert.ok(!markdown(state).includes('來源遺失'));}
  assert.equal(l.preview(pack(),b.id).added,0);
  assert.equal(l.undo(result.batch).removed,2);assert.deepEqual(s.get(source.id).projectIds,[a.id]);assert.ok(s.file(file));
}));

test('Shared links protect dependents, source deletion reports all projects, deleting a project preserves shared source',()=>fixture(async(s,l)=>{
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'});
  importInto(l,pack(),a.id);const source=s.list().find(r=>r.kind==='source');
  const batch=importInto(l,{...pack(),notes:[]},b.id);
  s.save('note',{title:'B 後續筆記',projectId:b.id,sourceIds:[source.id],content:'保留'});
  assert.throws(()=>l.undo(batch.batch),/其他資料/);
  assert.throws(()=>s.unlinkSource(source.id,b.id,source.revision),/仍有筆記/);
  assert.equal(s.sourceDeletionPreview(source.id).projects.length,2);
  s.deleteEntity(a.id,s.entityDeletionPreview(a.id).fingerprint);
  assert.deepEqual(s.get(source.id).projectIds,[b.id]);assert.equal(s.list().filter(r=>r.kind==='source').length,1);
  assert.equal(projectState(s.list(),b.id).filter(r=>r.kind==='note').length,1);
}));

test('Unlink only removes membership; unchanged shared source revision and attachment remain',()=>fixture(async(s)=>{
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'}),source=s.save('source',{title:'Paper',authors:[],projectId:a.id});
  s.linkSource(source.id,b.id);assert.equal(s.linkSource(source.id,b.id).linked,false);
  assert.throws(()=>s.unlinkSource(source.id,b.id,99),e=>e.status===409);
  s.unlinkSource(source.id,b.id,source.revision);assert.deepEqual(s.get(source.id).projectIds,[a.id]);assert.equal(s.get(source.id).revision,1);
}));

test('Narrow import fingerprints reject related source edits, attachments and competing imports but accept unrelated edits',()=>fixture(async(s,l)=>{
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'});importInto(l,pack(),a.id);
  const p=l.preview(pack(),a.id),unrelated=s.save('note',{title:'無關筆記',projectId:b.id,sourceIds:[]});
  s.save('note',{...unrelated,content:'changed'},unrelated.id);assert.equal(l.commit(pack(),a.id,p.fingerprint).added,0);
  const before=l.preview(pack(),a.id),source=s.list().find(r=>r.kind==='source');s.attach(source.id,'file','text/plain',Buffer.from('x'));
  assert.throws(()=>l.commit(pack(),a.id,before.fingerprint),e=>e.status===409);
  const again=l.preview(pack(),a.id);s.save('source',{...source,summary:'new evidence'},source.id);assert.throws(()=>l.commit(pack(),a.id,again.fingerprint),e=>e.status===409);
  const fresh={...pack(),sources:[{key:'a',title:'新來源',authors:[],doi:'10.1234/race'}]},initial=l.preview(fresh,a.id);importInto(l,fresh,a.id);assert.throws(()=>l.commit(fresh,a.id,initial.fingerprint),e=>e.status===409);
}));

test('Version 2 backups retain shared memberships and search history; legacy version 1 still restores',()=>fixture(async(s)=>{
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'}),source=s.save('source',{title:'Paper',authors:[],projectId:a.id});s.linkSource(source.id,b.id);
  s.attach(source.id,'file.txt','text/plain',Buffer.from('bytes'));s.save('search-run',{title:'query',query:'query',candidates:[],logs:[]});
  const bytes=await backup(s),target=new Store(':memory:');
  try{await restore(target,bytes);assert.deepEqual(target.list(),s.list());assert.deepEqual(Buffer.from(target.files()[0].bytes),Buffer.from(s.files()[0].bytes));assert.equal((await restore(target,bytes)).added,0);}finally{target.close();}
  const legacy=new JSZip();legacy.file('manifest.json',JSON.stringify({format:'inkgraph',version:1,entities:[a,source],attachments:[]}));const old=new Store(':memory:');
  try{await restore(old,await legacy.generateAsync({type:'nodebuffer'}));assert.equal(old.get(source.id).title,'Paper');}finally{old.close();}
}));

test('Summary defers source body without losing edits; server-side search includes full text and paginates',()=>fixture(async(s)=>{
  const p=s.save('project',{title:'A'}),q=s.save('project',{title:'B'});
  const source=s.save('source',{title:'Paper',authors:[],projectId:p.id,text:'needle full text',pages:[{number:1,text:'page data'}]});s.linkSource(source.id,q.id);
  const summary=s.state({summary:true}).find(r=>r.id===source.id);assert.equal(summary.text,undefined);assert.equal(summary.pages,undefined);assert.equal(summary.bodyDeferred,true);
  s.save('source',{...summary,title:'Renamed'},source.id);assert.equal(s.get(source.id).text,'needle full text');
  for(let i=0;i<55;i++)s.save('note',{title:`needle ${i}`,sourceIds:[],projectId:q.id,content:'search'});
  assert.equal(s.search('needle',{projectId:q.id}).total,56);assert.equal(s.search('needle',{projectId:q.id,offset:50}).entities.length,6);
  assert.equal(s.search('needle',{projectId:p.id}).total,1);
}));

test('Candidate merge keeps distinct Chinese titles and incomplete metadata, merges DOI discovery paths',()=>{
  const r={title:'中文研究一',year:'2024',authors:[{literal:'作者'}],foundVia:['crossref']};
  const result=mergeCandidates([r,{...r,title:'中文研究二'},{...r,doi:'10.1234/SAME'},{...r,doi:'https://doi.org/10.1234/same',foundVia:['openalex']}]);
  assert.equal(result.length,3);assert.deepEqual(result[2].foundVia,['crossref','openalex']);assert.equal(mergeCandidates([{...r,authors:[]},{...r,authors:[]}]).length,2);
});

const crossrefPage={message:{items:[{DOI:'10.1234/a',title:['synthetic test'],author:[{family:'Name'}],published:{'date-parts':[[2025]]},URL:'https://example.org/a'}],'next-cursor':'next'}};
test('Offline-labelled packages never import synthetic scholarly data',()=>fixture(async(s,l)=>{
  for(const flags of [{offline:true},{production_eligible:false}])assert.throws(()=>l.preview({...pack(),...flags}),/離線合成/);
  assert.equal(s.list().length,0);
}));
test('Scholarly search records pagination limits, partial failures, key stops and selection without importing sources',()=>fixture(async(s)=>{
  const service=new LiteratureSearch(s,{retrieve:async u=>{if(u.hostname==='api.crossref.org')return crossrefPage;if(u.hostname==='api.openalex.org')return {results:[{id:'https://openalex.org/W1',title:'Open synthetic test',publication_year:2025}],meta:{next_cursor:'second'}};throw Object.assign(Error('rate'),{status:429});},wait:async()=>{}});
  const r=await service.run({query:'synthetic',providers:['crossref','openalex','europepmc'],pages:2,pageSize:1});
  assert.equal(r.logs.find(l=>l.provider==='openalex').stop,'key_required');assert.equal(r.logs.find(l=>l.provider==='europepmc').stop,'unavailable');assert.equal(r.logs.find(l=>l.provider==='crossref').pages,2);
  assert.equal(s.list().filter(r=>r.kind==='source').length,0);assert.equal(service.history().length,1);
  const b=service.bundle(r.id,[r.candidates[0].key]);assert.equal(b.sources[0].verification,'UNRESOLVED');assert.match(b.sources[0].evidence.note,/檢索：synthetic/);
  assert.throws(()=>service.bundle(r.id,['invalid']),/有效/);
  await assert.rejects(service.run({query:'x',providers:['invalid']}),/有效/);
}));

test('Search can be cancelled and never substitutes synthetic candidates for failed providers',()=>fixture(async(s)=>{
  const service=new LiteratureSearch(s,{retrieve:async(_u,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancel'),{name:'AbortError'})),{once:true}))});
  const pending=service.run({id:'cancel-test',query:'query',providers:['crossref']});service.cancel('cancel-test');const r=await pending;
  assert.equal(r.cancelled,true);assert.equal(r.candidates.length,0);assert.equal(r.logs[0].stop,'cancelled');assert.equal(service.jobs.size,0);
}));
