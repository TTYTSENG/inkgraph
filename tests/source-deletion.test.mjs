import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { makeServer } from '../server.mjs';

function fixture(store) {
  const source = store.save('source', {title:'Delete me', authors:[]});
  const keep = store.save('source', {title:'Keep me', authors:[]});
  store.save('annotation', {sourceId:source.id, quote:'Evidence', locator:'p. 1'});
  store.save('term', {title:'A term', sourceId:source.id});
  store.save('relation', {from:keep.id, to:source.id, relation:'compares'});
  const note = store.save('note', {title:'Keep this draft', sourceIds:[source.id,keep.id], content:`Original words [@${source.id}, p. 1]`});
  const file = store.attach(source.id, 'test.txt', 'text/plain', Buffer.from('original'));
  store.attach(source.id, 'version.txt', 'text/plain', Buffer.from('old version'));
  return {source,keep,note,file};
}

test('Deletion preview is read-only; deletion cleans dependent records and retains notes and unrelated sources', () => {
  const store = new Store(':memory:');
  try {
    const {source,keep,note,file} = fixture(store);
    const before = store.list();
    const p = store.sourceDeletionPreview(source.id);
    assert.deepEqual([p.attachments,p.annotations,p.terms,p.relations,p.notes],[2,1,1,1,1]);
    assert.deepEqual(store.list(),before);
    store.deleteSource(source.id,p.fingerprint);
    assert.equal(store.get(source.id),null);
    assert.equal(store.file(file),undefined);
    assert.equal(store.files().length,0);
    assert.deepEqual(store.list().map(e=>e.kind).sort(),['note','source']);
    assert.deepEqual(store.get(keep.id),keep);
    assert.equal(store.get(note.id).content,note.content);
    assert.deepEqual(store.get(note.id).sourceIds,[keep.id]);
    assert.equal(store.get(note.id).revision,note.revision+1);
  } finally { store.close(); }
});

test('Stale preview, new dependencies and attachments block deletion without partial changes', () => {
  const store = new Store(':memory:');
  try {
    const {source,note} = fixture(store);
    let p = store.sourceDeletionPreview(source.id);
    store.save('note',{...note,content:'Changed draft'},note.id);
    const before = store.list();
    assert.throws(()=>store.deleteSource(source.id,p.fingerprint),e=>e.status===409);
    assert.deepEqual(store.list(),before);
    p = store.sourceDeletionPreview(source.id);
    store.save('annotation',{sourceId:source.id,quote:'New evidence',locator:'p. 2'});
    assert.throws(()=>store.deleteSource(source.id,p.fingerprint),e=>e.status===409);
    p = store.sourceDeletionPreview(source.id);
    store.attach(source.id,'new.txt','text/plain',Buffer.from('new'));
    assert.throws(()=>store.deleteSource(source.id,p.fingerprint),e=>e.status===409);
    assert.throws(()=>store.deleteSource(source.id,''),e=>e.status===409);
    assert.ok(store.get(source.id));
  } finally { store.close(); }
});

test('Deletion rolls back if note cleanup fails', () => {
  const store = new Store(':memory:');
  try {
    const {source} = fixture(store);
    const p = store.sourceDeletionPreview(source.id), before=store.list();
    store.db.exec("CREATE TRIGGER fail_note BEFORE UPDATE ON entities WHEN OLD.kind='note' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(()=>store.deleteSource(source.id,p.fingerprint),/test rollback/);
    assert.deepEqual(store.list(),before);
    assert.equal(store.files().length,2);
  } finally { store.close(); }
});

test('Delete API requires authorization, explicit confirmation and a current preview', async () => {
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-delete-'));
  const app=makeServer({dataPath:dir,port:0});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const {source,keep}=fixture(app.store);
  const request=(path,method='GET',body,authorized=true)=>fetch(base+path,{
    method,headers:{'Content-Type':'application/json',...(authorized?{'x-inkgraph-token':app.token}:{})},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  try {
    assert.equal((await request('/api/sources','DELETE',{id:source.id},false)).status,403);
    assert.equal((await request('/api/sources','DELETE',{id:source.id})).status,400);
    const p=await(await request('/api/sources/delete-preview?id='+source.id)).json();
    assert.ok(app.store.get(source.id));
    assert.equal((await request('/api/sources','DELETE',{id:source.id,confirm:true,fingerprint:'stale'})).status,409);
    assert.equal((await request('/api/sources','DELETE',{id:source.id,confirm:true,fingerprint:p.fingerprint})).status,200);
    assert.equal((await request('/api/sources/delete-preview?id='+source.id)).status,404);
    const state=await(await request('/api/state')).json();
    assert.ok(state.entities.some(e=>e.id===keep.id));
    assert.ok(!state.entities.some(e=>e.id===source.id));
  } finally {
    await new Promise(resolve=>app.server.close(resolve));app.store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
