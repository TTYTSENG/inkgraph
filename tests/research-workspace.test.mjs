import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { Store } from '../lib/store.mjs';
import { backup, restore, markdown, projectState, resolveNote, reportHTML } from '../lib/exports.mjs';
import { connections, excerptSnapshot, excerptStatus, noteSourceIds, usedExcerpts } from '../public/research-workspace.js';
import { renderConnections, renderNoteEditor } from '../public/workspace-view.js';
import { makeServer } from '../server.mjs';

function fixture(store) {
  const a=store.save('project',{title:'文獻回顧'}),b=store.save('project',{title:'跨領域研究'});
  const source=store.save('source',{title:'共同文獻',authors:[{family:'Lee',given:'A.'}],year:'2024',cslType:'book',publisher:'Research Press',text:'Original evidence',projectId:a.id});
  store.linkSource(source.id,b.id);
  const annotation=store.save('annotation',{sourceId:source.id,projectId:a.id,quote:'Original evidence [@literal]',locator:'檔案第 3 頁；印刷頁碼待核對',paraphrase:'我的釋義',comment:'需比較其他證據',verified:true,sourceRevision:source.revision});
  const other=store.save('annotation',{sourceId:source.id,projectId:b.id,quote:'Other project evidence',locator:'paragraph 2',comment:'Private project context'});
  const legacy=store.save('note',{title:'原專案筆記',projectId:a.id,content:`Existing citation [@${source.id}]`,sourceIds:[]});
  const ref=excerptSnapshot(annotation,randomUUID());
  const note=store.save('note',{title:'跨專案引用筆記',projectId:b.id,content:`我的論點\n\n[[摘錄:${ref.id}]]`,sourceIds:[],excerptRefs:[ref]});
  return {a,b,source,annotation,other,legacy,ref,note};
}

test('Workspace backlinks combine explicit citations and excerpt references, respecting project scope',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),state=s.list(),linked=connections(state,f.source.id,{projectId:f.a.id});
    assert.deepEqual(linked.notes.map(n=>n.id),[f.legacy.id]);
    assert.deepEqual(linked.annotations.map(a=>a.id),[f.annotation.id]);
    assert.equal(linked.hidden,2);
    const all=connections(state,f.source.id,{projectId:f.a.id,allProjects:true});
    assert.equal(all.notes.length,2);assert.equal(all.annotations.length,2);
    assert.ok(noteSourceIds(f.note).includes(f.source.id));
    assert.deepEqual(usedExcerpts({...f.note,content:''}),[]);
    assert.equal(connections(state,f.note).notes[0].id,f.legacy.id);
  }finally{s.close();}
});

test('Excerpt references validate against the real annotation and freeze captured evidence',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),bad={...f.ref,id:randomUUID(),quote:'Fabricated quote'};
    assert.throws(()=>s.save('note',{title:'Rejected',sourceIds:[],excerptRefs:[bad]}),/摘錄已變更/);
    assert.throws(()=>s.save('note',{...f.note,excerptRefs:[{...f.ref,verified:false}]},f.note.id),/固定快照/);
    assert.throws(()=>s.save('note',{...f.note,excerptRefs:[f.ref,f.ref]},f.note.id),/重複/);
    assert.throws(()=>s.save('note',{...f.note,excerptRefs:[{...f.ref,locator:''}]},f.note.id),/不完整/);
    const edited=s.save('annotation',{...f.annotation,quote:'Revised evidence'},f.annotation.id);
    assert.match(excerptStatus(f.ref,s.list()),/保留舊版/);
    const oldDraft={...f.note,excerptRefs:[excerptSnapshot(f.annotation,randomUUID())]};
    assert.throws(()=>s.save('note',oldDraft,f.note.id),/摘錄已變更/);
    const note=s.save('note',{...f.note,title:'更名後的筆記'},f.note.id);
    assert.equal(usedExcerpts(note)[0].quote,f.annotation.quote);
    assert.equal(s.get(edited.id).quote,'Revised evidence');
    assert.throws(()=>s.save('note',{...f.note,content:'Stale write'},f.note.id),/其他頁籤/);
  }finally{s.close();}
});

test('Project export carries referenced sources without leaking unrelated project notes',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s);
    // The note remains usable even if its source was not explicitly added to this project.
    const membership=s.list().find(e=>e.kind==='membership'&&e.projectId===f.b.id);
    s.db.prepare('DELETE FROM entities WHERE id=?').run(membership.id);
    const state=projectState(s.list(),f.b.id);
    assert.ok(state.some(r=>r.id===f.source.id));assert.ok(!state.some(r=>r.id===f.legacy.id));
    assert.ok(!state.some(r=>r.id===f.annotation.id));
    const output=markdown(state);
    assert.match(output,/Original evidence \[@literal\]/);assert.match(output,/我的釋義/);
    assert.match(output,/檔案第 3 頁/);assert.match(output,/共同文獻/);assert.match(output,/Lee/);
    assert.match(output,new RegExp(f.annotation.id));assert.doesNotMatch(output,/原專案筆記/);
    assert.doesNotMatch(resolveNote(f.note,[f.source]).content,/2024, p\. 3/);
  }finally{s.close();}
});

test('Source renames keep excerpt links and removals preserve snapshots through backup and restore',async()=>{
  const s=new Store(':memory:'),restored=new Store(':memory:');try{
    const f=fixture(s);
    s.save('source',{...s.get(f.source.id),title:'重新命名的來源'},f.source.id);
    assert.match(resolveNote(f.note,s.list().filter(r=>r.kind==='source')).content,/重新命名的來源/);
    const preview=s.entityDeletionPreview(f.annotation.id);assert.equal(preview.linkedNotes,1);
    s.deleteEntity(f.annotation.id,preview.fingerprint);
    assert.match(excerptStatus(f.ref,s.list()),/摘錄已移除/);
    const sourcePreview=s.sourceDeletionPreview(f.source.id);assert.equal(sourcePreview.notes,2);
    s.deleteSource(f.source.id,sourcePreview.fingerprint);
    const output=markdown(s.list());assert.match(output,/Original evidence/);assert.match(output,/原始來源已移除/);
    await restore(restored,await backup(s));
    assert.deepEqual(restored.get(f.note.id).excerptRefs,f.note.excerptRefs);
    assert.equal(restored.get(f.note.id).id,f.note.id);
  }finally{s.close();restored.close();}
});

test('Unlinking a shared source is blocked while an excerpt-only note still depends on it',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s);const p=s.entityDeletionPreview(f.other.id);s.deleteEntity(f.other.id,p.fingerprint);
    assert.throws(()=>s.unlinkSource(f.source.id,f.b.id,s.get(f.source.id).revision),/仍有筆記/);
    assert.equal(s.get(f.source.id).projectIds.length,2);
  }finally{s.close();}
});

test('HTML rendering escapes evidence and distinguishes shared-source notes from direct citations',()=>{
  const s=new Store(':memory:');try{
    const f=fixture(s),malicious={...f.note,title:'<script>unsafe</script>',excerptRefs:[{...f.ref,quote:'<img src=x onerror=alert(1)>'}]};
    const dom=new JSDOM(renderNoteEditor(malicious,{value:malicious.content,content:'',excerptRefs:malicious.excerptRefs},s.list()));
    assert.equal(dom.window.document.querySelectorAll('script,img').length,0);
    assert.match(dom.window.document.querySelector('.snapshot-card').textContent,/<img/);
    const panel=new JSDOM(renderConnections(s.list(),f.source,{projectId:f.a.id}));
    assert.match(panel.window.document.body.textContent,/使用此來源的筆記/);
    assert.doesNotMatch(panel.window.document.body.textContent,/Private project context/);
    assert.match(renderConnections(s.list(),f.note),/共用來源的其他筆記/);
    assert.doesNotMatch(reportHTML([f.source,malicious]),/<img src=x/);
    const whitespace='\n\n保留開頭空行\n';
    const editor=new JSDOM(renderNoteEditor(f.note,{value:whitespace,content:whitespace,excerptRefs:[]},s.list()));
    assert.equal(editor.window.document.querySelector('textarea').value,whitespace);
    editor.window.close();
    dom.window.close();panel.window.close();
  }finally{s.close();}
});

test('Single-note HTTP exports resolve excerpt-only dependencies for Markdown and HTML',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-workspace-test-'));
  const app=makeServer({dataPath:root,port:0});
  try{
    const f=fixture(app.store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${app.server.address().port}`;
    const page=await(await fetch(url)).text(),token=page.match(/name="inkgraph-token" content="([^"]+)"/)[1];
    for(const module of ['research-workspace.js','workspace-view.js']){
      const response=await fetch(`${url}/${module}`);assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/javascript/);
    }
    for(const format of ['markdown','html']){
      const response=await fetch(`${url}/api/export?format=${format}&id=${f.note.id}`,{headers:{'x-inkgraph-token':token}});
      assert.equal(response.status,200);const body=await response.text();
      assert.match(body,/共同文獻/);assert.match(body,/Original evidence/);assert.match(body,/我的釋義/);assert.match(body,/Lee/);
      assert.doesNotMatch(body,/原專案筆記/);
    }
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});
