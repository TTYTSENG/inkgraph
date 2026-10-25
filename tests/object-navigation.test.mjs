import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { Store } from '../lib/store.mjs';
import { makeServer } from '../server.mjs';
import { mapObjectLinks,usedObjectLinks,searchObjects,previewRecord,createObjectNavigation } from '../public/object-navigation.js';
import { markdown,reportHTML,projectState,resolveNote,backup,restore } from '../lib/exports.mjs';
import { recordState } from '../lib/knowledge-export.mjs';
import { noteSourceIds,excerptSnapshot } from '../public/research-workspace.js';

test('Navigation syntax preserves fenced/inline examples, stable IDs and ordinary citation semantics',()=>{
  const note={content:'[[連結:a]] [[連結:a]] `[[連結:b]]`\n```md\n[[連結:c]]\n```\n~~~\n[[連結:d]]\n~~~\n[@source, p. 4]'};
  assert.deepEqual(usedObjectLinks(note),['a']);assert.deepEqual(noteSourceIds(note),['source']);
  const value=mapObjectLinks(note.content,({id})=>`name:${id}`);assert.match(value,/name:a name:a/);assert.match(value,/`\[\[連結:b\]\]`/);assert.match(value,/\[\[連結:c\]\]/);
});
test('Name-only search disambiguates types/authors/projects, respects memberships and bounds visible results',()=>{
  const state=[{id:'p',kind:'project',title:'A'},{id:'q',kind:'project',title:'B'},{id:'s',kind:'source',title:'Trust',authors:[{family:'Lee'}],projectId:'p',projectIds:['q']},{id:'c',kind:'concept',title:'Trust',aliases:'信任',projectId:'q'},{id:'n',kind:'note',title:'Other',content:'Trust hidden body',projectId:'p'}];
  assert.equal(searchObjects(state,{projectId:'p',query:'Trust'}).total,1);
  assert.equal(searchObjects(state,{projectId:'q',query:'Trust'}).total,2);
  assert.equal(searchObjects(state,{query:'Lee'}).rows[0].row.id,'s');assert.equal(searchObjects(state,{query:'信任'}).rows[0].row.id,'c');
  assert.equal(searchObjects(state,{query:'Trust',kind:'concept'}).total,1);assert.equal(searchObjects(state,{query:'Trust',excludeId:'c',limit:1}).rows.length,1);
  assert.equal(searchObjects(state,{query:'hidden body'}).total,0);
});
test('Preview projection bounds text and omits full source, pages, attachments and unknown secrets',()=>{
  const row={id:'s',kind:'source',title:'Test',revision:2,text:'字'.repeat(10000),pages:[{text:'full pages'}],attachment:{bytes:'blob'},key:'secret',aliases:'alias'};
  const preview=previewRecord(row);assert.equal(preview.body.length,1200);assert.equal(preview.truncated,true);assert.equal(preview.revision,2);
  assert.ok(!('text' in preview));assert.ok(!('pages' in preview));assert.ok(!('attachment' in preview));assert.ok(!('key' in preview));
});
test('Navigation export retains ID/title mapping across rename/deletion without leaking external note bodies or changing APA',async()=>{
  const store=new Store(':memory:'),targetStore=new Store(':memory:');
  try{
    const p=store.save('project',{title:'A'}),q=store.save('project',{title:'B'}),target=store.save('note',{title:'外部判斷',content:'PRIVATE OTHER PROJECT BODY',sourceIds:[],projectId:q.id});
    const note=store.save('note',{title:'My writing',content:`導覽 [[連結:${target.id}]]`,sourceIds:[],projectId:p.id});
    const state=projectState(store.list(),p.id),md=markdown(state),html=reportHTML(state);
    assert.match(md,/外部判斷/);assert.ok(md.includes(target.id));assert.ok(md.includes('內容未納入'));assert.ok(!md.includes('PRIVATE OTHER PROJECT BODY'));assert.ok(!html.includes('PRIVATE OTHER PROJECT BODY'));
    assert.equal(resolveNote(state.find(r=>r.id===note.id),[]).refs.length,0);assert.equal(store.list().filter(r=>r.kind==='link').length,0);
    store.save('note',{...target,title:'Renamed <unsafe> [@fake]'},target.id);
    const current=recordState(store.list(),note.id);assert.match(markdown(current),/Renamed <unsafe> \[@fake\]/);assert.match(reportHTML(current),/&lt;unsafe&gt;/);
    const bytes=await backup(store);await restore(targetStore,bytes);assert.equal(targetStore.get(note.id).content,note.content);
    const preview=store.entityDeletionPreview(target.id);store.deleteEntity(target.id,preview.fingerprint);
    assert.match(markdown(projectState(store.list(),p.id)),/目標已移除或未提供/);assert.ok(store.get(note.id).content.includes(target.id));
  }finally{store.close();targetStore.close();}
});
test('Link resolution never parses marker-looking labels or transforms marker text inside immutable quotations',()=>{
  const store=new Store(':memory:');try{
    const source=store.save('source',{title:'Original',authors:[],text:'raw'});
    const annotation=store.save('annotation',{sourceId:source.id,quote:'Original [[連結:literal]]',locator:'p1'}),ref=excerptSnapshot(annotation,'snap');
    const note={content:'[[連結:label]]\n[[摘錄:snap]]',sourceIds:[],excerptRefs:[ref]};
    const result=resolveNote(note,[source],'text',[{id:'label',kind:'concept',title:'Title [[摘錄:missing]] [@fake]'}]).content;
    assert.match(result,/Title \[\[摘錄:missing\]\] \[@fake\]/);assert.match(result,/Original \[\[連結:literal\]\]/);assert.ok(!result.includes('引用遺失'));
  }finally{store.close();}
});
test('Preview HTTP endpoint uses existing authentication, returns bounded content, handles deletion and serves the shared module',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-navigation-http-')),app=makeServer({dataPath:root,port:0});
  try{
    const source=app.store.save('source',{title:'Source',authors:[],text:'x'.repeat(20000)});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base+'/api/entity?id='+source.id+'&preview=1')).status,403);
    const response=await fetch(base+'/api/entity?id='+source.id+'&preview=1',{headers:{'x-inkgraph-token':app.token}});assert.equal(response.status,200);const preview=await response.json();assert.equal(preview.body.length,1200);assert.ok(!('text' in preview));
    assert.equal((await fetch(base+'/api/entity?id=deleted&preview=1',{headers:{'x-inkgraph-token':app.token}})).status,404);
    assert.equal((await fetch(base+'/object-navigation.js')).status,200);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});
test('Late preview responses cannot replace a newer preview or reopen a closed navigation dialog',async()=>{
  const dom=new JSDOM('<dialog id="dialog"></dialog>'),document=dom.window.document;document.querySelector('dialog').close=function(){this.removeAttribute('open');};const pending=[];
  const ui=createObjectNavigation({entities:()=>[],project:()=>'',dom:document,capture:()=>null,restore:()=>{},toast:()=>{},api:()=>new Promise(resolve=>pending.push(resolve)),dialog:(title,body,footer)=>{const d=document.querySelector('dialog');d.setAttribute('open','');d.innerHTML='<div class="dialog-body">'+body+'</div>'+footer;}});
  try{
    const first=ui.handle('nav-preview','a'),second=ui.handle('nav-preview','b');pending[1]({json:async()=>({id:'b',title:'Newer',kind:'note',body:'new',revision:1})});await second;
    pending[0]({json:async()=>({id:'a',title:'Older',kind:'note',body:'old',revision:1})});await first;assert.match(document.body.textContent,/Newer/);assert.ok(!document.body.textContent.includes('Older'));
    const third=ui.handle('nav-preview','c');await ui.handle('nav-cancel');pending[2]({json:async()=>({id:'c',title:'Late',kind:'note',revision:1})});await third;assert.ok(!document.querySelector('dialog').open);assert.ok(!document.body.textContent.includes('Late'));
  }finally{dom.window.close();}
});
