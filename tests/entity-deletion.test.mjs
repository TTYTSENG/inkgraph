import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { makeServer } from '../server.mjs';

function fixture(store) {
  const project=store.save('project',{title:'Project to remove'});
  const source=store.save('source',{title:'Preserved paper',authors:[],projectId:project.id});
  const other=store.save('source',{title:'Other paper',authors:[]});
  const annotation=store.save('annotation',{sourceId:source.id,projectId:project.id,quote:'Evidence',locator:'p. 1'});
  const term=store.save('term',{title:'Term',sourceId:source.id,projectId:project.id});
  const relation=store.save('relation',{from:source.id,to:other.id,relation:'compares',projectId:project.id});
  const note=store.save('note',{title:'Draft',sourceIds:[source.id],content:`Keep this text [@${source.id}]`,projectId:project.id});
  const file=store.attach(source.id,'original.txt','text/plain',Buffer.from('Original attachment'));
  return {project,source,other,annotation,term,relation,note,file};
}

for(const kind of ['annotation','term','relation','note'])test(`Deleting ${kind} preserves its source, attachment and other entities`,()=>{
  const store=new Store(':memory:');
  try {
    const f=fixture(store), id=f[kind].id, before=store.list();
    const preview=store.entityDeletionPreview(id);
    assert.deepEqual(store.list(),before);
    store.deleteEntity(id,preview.fingerprint);
    assert.equal(store.get(id),null);
    assert.deepEqual(store.list().sort((a,b)=>a.id.localeCompare(b.id)),before.filter(e=>e.id!==id).sort((a,b)=>a.id.localeCompare(b.id)));
    assert.equal(Buffer.from(store.file(f.file).bytes).toString(),'Original attachment');
  }finally{store.close();}
});

test('Deleting a project moves only its members to the inbox and preserves contents, references and attachments',()=>{
  const store=new Store(':memory:');
  try {
    const f=fixture(store),before=store.list();
    const p=store.entityDeletionPreview(f.project.id);
    assert.equal(p.moved,5);
    store.deleteEntity(f.project.id,p.fingerprint);
    assert.equal(store.get(f.project.id),null);
    assert.equal(store.list().length,before.length-1);
    for(const old of before.filter(e=>e.projectId===f.project.id)){
      const actual=store.get(old.id);
      assert.equal(actual.projectId,null);
      if(old.kind==='source')assert.deepEqual(actual.projectIds,[]);
      assert.deepEqual({...actual,...(old.kind==='source'?{projectIds:old.projectIds}:{}),projectId:old.projectId,revision:old.revision,updated:old.updated},old);
    }
    assert.deepEqual(store.get(f.other.id),f.other);
    assert.equal(store.get(f.note.id).content,f.note.content);
    assert.deepEqual(store.get(f.note.id).sourceIds,[f.source.id]);
    assert.equal(store.get(f.annotation.id).sourceId,f.source.id);
    assert.equal(store.get(f.relation.id).to,f.other.id);
    assert.ok(store.file(f.file));
  }finally{store.close();}
});

test('Concurrent entity edits or added project members invalidate the confirmation',()=>{
  const store=new Store(':memory:');
  try {
    const f=fixture(store);
    let p=store.entityDeletionPreview(f.note.id);
    store.save('note',{...f.note,content:'New draft'},f.note.id);
    assert.throws(()=>store.deleteEntity(f.note.id,p.fingerprint),e=>e.status===409);
    p=store.entityDeletionPreview(f.project.id);
    store.save('source',{title:'New member',authors:[],projectId:f.project.id});
    const before=store.list();
    assert.throws(()=>store.deleteEntity(f.project.id,p.fingerprint),e=>e.status===409);
    assert.deepEqual(store.list(),before);
    assert.throws(()=>store.entityDeletionPreview(f.source.id),/刪除文獻/);
    assert.throws(()=>store.entityDeletionPreview('missing'),e=>e.status===404);
  }finally{store.close();}
});

test('Project deletion rolls back all moves on failure',()=>{
  const store=new Store(':memory:');
  try {
    const f=fixture(store),p=store.entityDeletionPreview(f.project.id),before=store.list();
    store.db.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON entities WHEN OLD.kind='project' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(()=>store.deleteEntity(f.project.id,p.fingerprint),/test rollback/);
    assert.deepEqual(store.list(),before);
  }finally{store.close();}
});

test('Generic deletion API checks authorization and explicit confirmation before removing data',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-entity-delete-'));
  const app=makeServer({dataPath:dir,port:0});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`,f=fixture(app.store);
  const request=(path,body,authorized=true)=>fetch(base+path,{method:body?'DELETE':'GET',headers:{'Content-Type':'application/json',...(authorized?{'x-inkgraph-token':app.token}:{})},body:body?JSON.stringify(body):undefined});
  try {
    assert.equal((await request('/api/entities',{id:f.note.id},false)).status,403);
    assert.equal((await request('/api/entities',{id:f.note.id})).status,400);
    const p=await(await request('/api/entities/delete-preview?id='+f.project.id)).json();
    assert.equal(p.kind,'project');assert.equal(p.moved,5);
    assert.equal((await request('/api/entities',{id:f.project.id,confirm:true,fingerprint:'wrong'})).status,409);
    assert.equal((await request('/api/entities',{id:f.project.id,confirm:true,fingerprint:p.fingerprint})).status,200);
    const state=await(await request('/api/state')).json();
    assert.ok(state.entities.some(e=>e.id===f.source.id&&e.projectId===null));
    assert.ok(!state.entities.some(e=>e.id===f.project.id));
  }finally{
    await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(dir,{recursive:true,force:true});
  }
});
