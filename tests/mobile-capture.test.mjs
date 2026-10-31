import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,openSync,ftruncateSync,closeSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,verify } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Store } from '../lib/store.mjs';
import { importCapture,validateCapture } from '../lib/mobile-import.mjs';
import { externalPath,fileHash,inspectZip } from '../lib/mobile-files.mjs';
import { backupStream,restoreMobileFile } from '../lib/mobile-backup.mjs';
import { MediaJobs,resultExport } from '../lib/media-jobs.mjs';
import { makeServer } from '../server.mjs';
import { captureFixture } from './mobile-fixtures.mjs';
import { markdown } from '../lib/exports.mjs';
import { withoutMobileLocation } from '../public/mobile-model.js';

async function lab(run){const root=mkdtempSync(join(tmpdir(),'inkgraph-mobile-')),store=new Store(join(root,'vault.sqlite'));try{await run(store,root);}finally{store.close();rmSync(root,{recursive:true,force:true});}}
const pack=(root,bytes)=>{const file=join(root,randomUUID()+'.igc');writeFileSync(file,bytes);return file;};

test('Mobile mixed capture preserves source bytes, local timestamps, denied location, signed receipt and separate queued jobs',async()=>lab(async(s,root)=>{
  const f=await captureFixture({photo:true}),r=await importCapture(s,pack(root,f.bytes));assert.equal(r.duplicate,false);assert.equal(r.sourceIds.length,2);
  const n=s.get(r.noteId);assert.equal(n.noteType,'quick');assert.equal(n.mobileCapture.createdAt,f.manifest.capture.createdAt);assert.equal(n.mobileCapture.location.status,'denied');assert.equal(n.mobileCapture.timezone,'Asia/Taipei');
  for(let i=0;i<r.sourceIds.length;i++){const file=s.file(s.attachment(r.sourceIds[i]).id);assert.ok(file.path);assert.equal(await fileHash(externalPath(s,file)),f.manifest.capture.media[i].sha256);assert.equal(s.get(r.sourceIds[i]).cslType,'personal-communication');}
  assert.equal(s.db.prepare('SELECT count(*) n FROM media_jobs WHERE state=\'queued\'').get().n,2);
  const receipt=r.receipt;assert.ok(verify('sha256',Buffer.from(receipt.payload,'base64'),{key:Buffer.from(receipt.publicKey,'base64'),format:'der',type:'spki'},Buffer.from(receipt.signature,'base64')));const payload=JSON.parse(Buffer.from(receipt.payload,'base64'));assert.equal(payload.captureId,f.manifest.capture.id);assert.equal(payload.revision,1);assert.match(markdown(s.list()),/本地測試想法/);
  assert.match(markdown(s.list()),/記錄時間：2026-10-25T10:00:00.000Z/);assert.match(markdown(s.list()),/Asia\/Taipei/);assert.match(markdown(s.list()),/未授權/);
}));

test('Text/JSON sharing omits location metadata without mutating stored capture or removing time provenance',async()=>lab(async(s,root)=>{
  const f=await captureFixture();f.manifest.capture.location={status:'captured',lat:23.4567,lon:120.4567,accuracyMeters:20,measuredAt:'2026-10-25T10:00:00Z',label:'PRIVATE PLACE'};f.manifest.capture.media[0].location=structuredClone(f.manifest.capture.location);const packData=await captureFixture({manifest:f.manifest});await importCapture(s,pack(root,packData.bytes));const before=s.list(),shared=withoutMobileLocation(before);assert.ok(!JSON.stringify(shared).includes('PRIVATE PLACE'));assert.ok(!JSON.stringify(shared).includes('23.4567'));assert.match(markdown(shared),/已於此次輸出排除/);assert.match(markdown(shared),/Asia\/Taipei/);assert.deepEqual(s.list(),before);
}));

test('Repeat imports are idempotent; same-version conflict never overwrites notes or original media',async()=>lab(async(s,root)=>{
  const f=await captureFixture(),file=pack(root,f.bytes),r=await importCapture(s,file),before=s.list(),repeat=await importCapture(s,file);assert.equal(repeat.duplicate,true);assert.equal(repeat.noteId,r.noteId);assert.deepEqual(s.list(),before);
  const changed=structuredClone(f.manifest);changed.capture.text='Changed';const bad=await captureFixture({manifest:changed});await assert.rejects(importCapture(s,pack(root,bad.bytes)),e=>e.status===409);assert.deepEqual(s.list(),before);
}));

test('New and out-of-order phone versions preserve desktop edits and provenance',async()=>lab(async(s,root)=>{
  const f=await captureFixture(),first=await importCapture(s,pack(root,f.bytes)),original=s.get(first.noteId);s.save('note',{...original,content:'My later desktop interpretation'},original.id);
  const v3=structuredClone(f.manifest);v3.capture.revision=3;v3.capture.text='Phone revision 3';const third=await captureFixture({manifest:v3}),r3=await importCapture(s,pack(root,third.bytes));
  const v2=structuredClone(f.manifest);v2.capture.revision=2;const second=await captureFixture({manifest:v2}),r2=await importCapture(s,pack(root,second.bytes));
  assert.equal(s.get(first.noteId).content,'My later desktop interpretation');assert.notEqual(r3.noteId,first.noteId);assert.notEqual(r2.noteId,r3.noteId);assert.ok(s.list().some(r=>r.kind==='link'&&r.from===r3.noteId&&r.to===first.noteId));assert.equal(s.list().filter(r=>r.kind==='source').length,1);
}));

test('Invalid hashes, unexpected entries and fake media fail without any partial database rows',async()=>lab(async(s,root)=>{
  const f=await captureFixture({corrupt:true});await assert.rejects(importCapture(s,pack(root,f.bytes)));assert.equal(s.list().length,0);
  const extra=await captureFixture({extra:{name:'unknown.exe'}});await assert.rejects(importCapture(s,pack(root,extra.bytes)),/清單/);assert.equal(s.list().length,0);
  const invalid=await captureFixture();invalid.manifest.capture.location={status:'captured',lat:1000,lon:0,accuracyMeters:10,measuredAt:'2026-10-25T00:00:00Z'};assert.throws(()=>validateCapture(invalid.manifest),/定位/);
}));

test('Transaction failure removes newly installed originals and leaves no note, source or job',async()=>lab(async(s,root)=>{
  const f=await captureFixture(),save=s.save.bind(s);s.save=(kind,...args)=>{if(kind==='note')throw Error('simulated failure');return save(kind,...args);};await assert.rejects(importCapture(s,pack(root,f.bytes)),/simulated/);assert.equal(s.list().length,0);assert.equal(s.db.prepare('SELECT count(*) n FROM external_attachments').get().n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM media_jobs').get().n,0);
}));

test('ZIP64 streaming backup restores external originals, mobile receipts, jobs and old BLOB files together',async()=>lab(async(s,root)=>{
  const f=await captureFixture({photo:true}),imported=await importCapture(s,pack(root,f.bytes));const legacy=s.save('source',{title:'Old source',authors:[]});s.attach(legacy.id,'old.txt','text/plain',Buffer.from('Original legacy bytes'));
  const archive=backupStream(s),path=join(root,'full.zip'),write=pipeline(archive,createWriteStream(path));await archive.finalize();await write;
  const restored=new Store(join(root,'restored','vault.sqlite'));try{const r=await restoreMobileFile(restored,path);assert.equal(r.version,5);assert.deepEqual(restored.list(),s.list());for(const m of f.manifest.capture.media){const file=restored.files().find(r=>r.sha===m.sha256);assert.equal(await fileHash(externalPath(restored,file)),m.sha256);}assert.equal(Buffer.from(restored.file(restored.attachment(legacy.id).id).bytes).toString(),'Original legacy bytes');assert.equal(restored.db.prepare('SELECT count(*) n FROM media_jobs').get().n,2);assert.equal(restored.db.prepare('SELECT receipt FROM mobile_captures').get().receipt,JSON.stringify(imported.receipt));}finally{restored.close();}
}));

test('Failed v5 restore does not overwrite existing notes or files',async()=>lab(async(s,root)=>{
  const f=await captureFixture(),r=await importCapture(s,pack(root,f.bytes)),archive=backupStream(s),path=join(root,'full.zip'),write=pipeline(archive,createWriteStream(path));await archive.finalize();await write;
  s.save('note',{...s.get(r.noteId),content:'Later'},r.noteId);const before=s.list();await assert.rejects(restoreMobileFile(s,path),e=>e.status===409);assert.deepEqual(s.list(),before);
}));

test('Persistent recognition queue recovers interrupted jobs and exports timestamped results without replacing edits',async()=>lab(async(s,root)=>{
  const f=await captureFixture(),r=await importCapture(s,pack(root,f.bytes)),job=s.db.prepare('SELECT * FROM media_jobs').get();s.db.prepare("UPDATE media_jobs SET state='running'").run();const jobs=new MediaJobs(s,{autoStart:false});assert.equal(jobs.list()[0].state,'queued');jobs.pause(true);assert.equal(jobs.status().paused,true);
  const result={text:'Machine words',segments:[{start:1.5,end:2.6,text:'Machine words'}],verified:false};s.db.prepare("UPDATE media_jobs SET state='done',result=? WHERE id=?").run(JSON.stringify(result),job.id);assert.match(resultExport(s,r.sourceIds[0],'srt')[2],/00:00:01,500 --> 00:00:02,600/);assert.match(resultExport(s,r.sourceIds[0],'vtt')[2],/^WEBVTT/);jobs.close();
}));

test('Mobile API enforces authorization, accepts a raw package, serves range audio and streams complete v5 backup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-mobile-api-')),app=makeServer({dataPath:root,port:0,mobileOptions:{autoStart:false}});
  try{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`,headers={'x-inkgraph-token':app.token};assert.equal((await fetch(base+'/api/mobile/status')).status,403);
    const f=await captureFixture(),response=await fetch(base+'/api/mobile/import',{method:'POST',headers,body:f.bytes});assert.equal(response.status,200);const r=await response.json();const file=app.store.attachment(r.sourceIds[0]);const audio=await fetch(base+'/files/'+file.id,{headers:{cookie:`inkgraph_session=${app.token}`,range:'bytes=0-43'}});assert.equal(audio.status,206);assert.equal((await audio.arrayBuffer()).byteLength,44);assert.equal(audio.headers.get('content-type'),'audio/wav');
    app.store.db.prepare("UPDATE media_jobs SET state='done',result=?").run(JSON.stringify({text:'Synthetic transcript',segments:[],verified:false}));const exported=await(await fetch(base+'/api/mobile/result?id='+r.sourceIds[0]+'&format=json',{headers})).json();assert.equal(typeof exported,'object');assert.equal(exported.text,'Synthetic transcript');
    const status=await(await fetch(base+'/api/mobile/status',{headers})).json();assert.deepEqual(status.captures[0].sourceIds,r.sourceIds);assert.equal(status.captures[0].noteMissing,false);
    const backup=await fetch(base+'/api/backup',{headers});assert.equal(backup.status,200);assert.ok((await backup.arrayBuffer()).byteLength>0);assert.equal((await fetch(base+'/mobile-capture.js')).status,200);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});

test('Streaming backup and restore exceed the previous 250MiB expanded limit without loading all originals together',async()=>lab(async(s,root)=>{
  const size=24*1024*1024,temp=join(root,'large-source.bin'),fd=openSync(temp,'w');ftruncateSync(fd,size);closeSync(fd);const sha=await fileHash(temp),relative=`${sha.slice(0,2)}/${sha}.wav`;mkdirSync(join(s.originalsRoot,sha.slice(0,2)),{recursive:true});const {renameSync}=await import('node:fs');renameSync(temp,join(s.originalsRoot,relative));
  for(let i=0;i<11;i++){const source=s.save('source',{title:'Synthetic streaming original '+i,authors:[]});s.db.prepare('INSERT INTO external_attachments VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),source.id,`sample-${i}.wav`,'audio/wav',sha,size,relative,new Date().toISOString());}
  const archive=backupStream(s),path=join(root,'large.zip'),write=pipeline(archive,createWriteStream(path));await archive.finalize();await write;const inspected=await inspectZip(path);assert.ok(inspected.expanded>250*1024*1024);inspected.zip.close();
  const restored=new Store(join(root,'restored','vault.sqlite'));try{await restoreMobileFile(restored,path);assert.equal(restored.files().length,11);assert.equal(await fileHash(join(restored.originalsRoot,relative)),sha);}finally{restored.close();}
}));
