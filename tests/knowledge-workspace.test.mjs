import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Store } from '../lib/store.mjs';
import { backup,restore,projectState,markdown,reportHTML } from '../lib/exports.mjs';
import { recordState } from '../lib/knowledge-export.mjs';
import { relatedLinks } from '../public/knowledge-model.js';
import { scopedState,projectsOf } from '../public/project-scope.js';
import { makeServer } from '../server.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function setup(s) {
  const a=s.save('project',{title:'A'}),b=s.save('project',{title:'B'});
  const source=s.save('source',{title:'Original paper',authors:[{family:'Lee'}],year:'2024',text:'Verifiable source text',projectId:a.id});
  const note=s.save('note',{title:'A private interpretation',content:'PRIVATE OTHER PROJECT COMMENT',sourceIds:[source.id],projectId:a.id});
  const discussion=s.save('discussion',{title:'Research question',content:'Discussion context',origin:'gemini',sourceIds:[source.id],projectId:a.id});
  const message=s.save('message',{title:'A model answer',content:'An answer to be checked',role:'assistant',discussionId:discussion.id,sourceIds:[],projectId:a.id});
  const concept=s.save('concept',{title:'Trust',aliases:'信任',definition:'Shared research concept',projectId:b.id});
  const link=s.save('link',{title:'關於',from:message.id,to:concept.id,relation:'about',reason:'Distinguish trust from mere agreement',fromLocator:'message body',toLocator:'definition',projectId:b.id});
  return {a,b,source,note,discussion,message,concept,link};
}

test('Typed links are bidirectional views of one record, scoped by project and stable after renames',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s);
    assert.equal(relatedLinks(s.list(),f.message.id,{projectId:f.b.id}).links[0].id,f.link.id);
    assert.equal(relatedLinks(s.list(),f.concept.id,{projectId:f.b.id}).links[0].id,f.link.id);
    assert.equal(relatedLinks(s.list(),f.discussion.id,{projectId:f.b.id}).links[0].id,f.link.id);
    assert.equal(relatedLinks(s.list(),f.concept.id,{projectId:f.a.id}).links.length,0);
    assert.equal(relatedLinks(s.list(),f.concept.id,{projectId:f.a.id,allProjects:true}).hidden,0);
    s.save('concept',{...f.concept,title:'Renamed trust'},f.concept.id);
    assert.equal(s.get(f.link.id).to,f.concept.id);
    assert.equal(s.list().filter(r=>r.kind==='link').length,1);
  }finally{s.close();}
});

test('Object references, roles and evidence-bearing link types are validated',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s);
    assert.throws(()=>s.save('message',{title:'Bad role',role:'invented',content:'Text',sourceIds:[],discussionId:f.discussion.id}),/角色/);
    assert.throws(()=>s.save('message',{title:'Bad parent',role:'user',content:'Text',sourceIds:[],discussionId:f.note.id}),/discussion/);
    assert.throws(()=>s.save('link',{title:'Self',from:f.note.id,to:f.note.id,relation:'related'}),/不同/);
    assert.throws(()=>s.save('link',{title:'Wrong definition',from:f.note.id,to:f.source.id,relation:'defines'}),/指向概念/);
    assert.throws(()=>s.save('link',{title:'Unsupported',from:f.message.id,to:f.note.id,relation:'supports',reason:''}),/理由/);
    assert.throws(()=>s.save('link',{title:'Wrong target',from:f.message.id,to:f.concept.id,relation:'supports',reason:'Reason'}),/筆記或訊息/);
    assert.throws(()=>s.save('link',{title:'Missing',from:f.message.id,to:'missing',relation:'related'}),/研究項目/);
    const valid=s.save('link',{title:'Supports',from:f.source.id,to:f.note.id,relation:'supports',reason:'Evidence in paragraph 1',fromLocator:'paragraph 1'});
    assert.equal(valid.relation,'supports');
  }finally{s.close();}
});

test('Global edges remain available in project views without importing external note bodies',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s),global=s.save('link',{title:'Global relation',from:f.concept.id,to:f.note.id,relation:'related',projectId:null});
    assert.ok(relatedLinks(s.list(),f.concept.id,{projectId:f.b.id}).links.some(r=>r.id===global.id));
    const state=projectState(s.list(),f.b.id);assert.ok(state.some(r=>r.id===global.id));
    assert.doesNotMatch(markdown(state),/PRIVATE OTHER PROJECT COMMENT/);
    assert.ok(!scopedState(s.list(),'inbox').some(r=>r.id===global.id));
    const legacy=s.save('term',{title:'Legacy definition',sourceId:f.source.id});
    assert.ok(scopedState(s.list(),f.a.id).some(r=>r.id===legacy.id));
  }finally{s.close();}
});

test('Notes, concepts and complete discussion threads can be shared without copying their content',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s);
    for(const row of [f.note,f.discussion])s.linkEntity(row.id,f.b.id);
    s.linkEntity(f.concept.id,f.a.id);
    const b=scopedState(s.list(),f.b.id);
    for(const row of [f.note,f.discussion,f.message,f.concept])assert.ok(b.some(e=>e.id===row.id));
    assert.deepEqual(new Set(projectsOf(s.get(f.message.id))),new Set([f.a.id,f.b.id]));
    assert.equal(s.list().filter(r=>r.kind==='discussion').length,1);
    const hits=s.search('answer',{projectId:f.b.id}).entities;assert.ok(hits.some(r=>r.id===f.message.id));
    assert.throws(()=>s.unlinkEntity(f.discussion.id,f.b.id,s.get(f.discussion.id).revision),/仍有物件連結/);
    s.deleteEntity(f.link.id,s.entityDeletionPreview(f.link.id).fingerprint);
    s.unlinkEntity(f.discussion.id,f.b.id,s.get(f.discussion.id).revision);
    assert.ok(!scopedState(s.list(),f.b.id).some(r=>r.id===f.message.id));
    assert.ok(s.get(f.message.id));
  }finally{s.close();}
});

test('Project and single-record exports retain relationship endpoints without copying private external comments',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s),state=projectState(s.list(),f.b.id),output=markdown(state);
    assert.match(output,/A model answer/); // Endpoint title, not its body.
    assert.match(output,/外部項目/);assert.doesNotMatch(output,/An answer to be checked/);
    assert.doesNotMatch(output,/PRIVATE OTHER PROJECT COMMENT/);
    const discussion=recordState(s.list(),f.discussion.id),full=markdown(discussion);
    assert.match(full,/An answer to be checked/);assert.match(full,/AI 回覆/);assert.match(full,/Original paper/);assert.match(full,/Trust/);
    assert.match(reportHTML(discussion),/Distinguish trust/);
    assert.doesNotMatch(full,/PRIVATE OTHER PROJECT COMMENT/);
    assert.match(markdown(recordState(s.list(),f.concept.id)),/Shared research concept/);
  }finally{s.close();}
});

test('Deleting a discussion previews and atomically removes child messages and links, preserving the other objects',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s);s.linkEntity(f.discussion.id,f.b.id);
    const preview=s.entityDeletionPreview(f.discussion.id);
    assert.equal(preview.removedMessages,1);assert.equal(preview.removedLinks,1);
    const extra=s.save('link',{title:'Related',from:f.source.id,to:f.discussion.id,relation:'discusses'});
    assert.throws(()=>s.deleteEntity(f.discussion.id,preview.fingerprint),/資料已變更/);
    s.deleteEntity(f.discussion.id,s.entityDeletionPreview(f.discussion.id).fingerprint);
    for(const row of [f.discussion,f.message,f.link,extra])assert.equal(s.get(row.id),null);
    assert.ok(s.get(f.concept.id));assert.ok(s.get(f.source.id));assert.equal(s.get(f.note.id).content,'PRIVATE OTHER PROJECT COMMENT');
    assert.ok(!s.list().some(r=>r.kind==='membership'&&r.entityId===f.discussion.id));
  }finally{s.close();}
});

test('Deleting a source detaches discussion source references but preserves the conversation and other links',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s),citation=s.save('link',{title:'Cites',from:f.message.id,to:f.source.id,relation:'cites'});
    const preview=s.sourceDeletionPreview(f.source.id);assert.equal(preview.discussions,1);assert.equal(preview.objectLinks,1);
    s.deleteSource(f.source.id,preview.fingerprint);
    assert.deepEqual(s.get(f.discussion.id).sourceIds,[]);assert.ok(s.get(f.message.id));assert.ok(s.get(f.link.id));assert.equal(s.get(citation.id),null);
  }finally{s.close();}
});

test('Backup v4 restores object IDs, message roles, shared memberships and edges; old v2 remains accepted',async()=>{
  const s=new Store(':memory:'),out=new Store(':memory:'),oldOut=new Store(':memory:');try{
    const f=setup(s);s.linkEntity(f.discussion.id,f.b.id);
    const bytes=await backup(s),zip=await JSZip.loadAsync(bytes),manifest=JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.version,4);await restore(out,bytes);assert.deepEqual(out.list(),s.list());
    assert.equal(out.get(f.message.id).role,'assistant');assert.equal(out.get(f.link.id).to,f.concept.id);
    const old=new JSZip();old.file('manifest.json',JSON.stringify({format:'inkgraph',version:2,entities:[f.a,{...f.source,projectIds:undefined}],attachments:[]}));
    await restore(oldOut,await old.generateAsync({type:'nodebuffer'}));assert.ok(oldOut.get(f.source.id));
  }finally{s.close();out.close();oldOut.close();}
});

test('Importing an existing Gemini source preserves raw text and does not infer message roles',()=>{
  const s=new Store(':memory:');try{
    const chat=s.save('source',{title:'Original Gemini transcript',authors:[],text:'USER: Question\nAI: Answer',origin:'gemini',cslType:'personal-communication'});
    const discussion=s.discussionFromSource({sourceId:chat.id,title:'Imported discussion',origin:'gemini'});
    const message=s.list().find(r=>r.kind==='message'&&r.discussionId===discussion.id);
    assert.equal(message.content,chat.text);assert.equal(message.role,'unknown');assert.equal(message.importedSourceId,chat.id);assert.ok(s.get(chat.id));
    const before=s.list();assert.throws(()=>s.discussionFromSource({sourceId:chat.id,title:'Rejected',origin:'invalid'}),/討論來源/);assert.deepEqual(s.list(),before);
  }finally{s.close();}
});

test('Knowledge APIs serve browser modules, require authorization and share imported discussions atomically',async()=>{
  const root=mkdtempSync(join(tmpdir(),'inkgraph-knowledge-http-')),app=makeServer({dataPath:root,port:0});
  try{
    const a=app.store.save('project',{title:'A'}),b=app.store.save('project',{title:'B'});
    const source=app.store.save('source',{title:'Notebook transcript',authors:[],text:'Question and answer remain raw.',origin:'notebooklm',cslType:'personal-communication',projectId:a.id});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    for(const path of ['/knowledge-model.js','/knowledge-workspace.js'])assert.equal((await fetch(base+path)).status,200);
    const request={method:'POST',headers:{'Content-Type':'application/json','x-inkgraph-token':app.token}};
    assert.equal((await fetch(base+'/api/discussions/from-source',{...request,headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    const response=await fetch(base+'/api/discussions/from-source',{...request,body:JSON.stringify({title:'Imported',origin:'notebooklm',sourceId:source.id,projectId:a.id})});assert.equal(response.status,200);
    const discussion=await response.json();
    const share=await fetch(base+'/api/objects/project',{...request,body:JSON.stringify({id:discussion.id,projectId:b.id,operation:'link'})});assert.equal(share.status,200);
    const body=await(await fetch(base+`/api/export?project=${b.id}&format=markdown`,{headers:{'x-inkgraph-token':app.token}})).text();
    assert.match(body,/Question and answer remain raw/);assert.match(body,/未標示角色/);assert.match(body,/匯入原文來源/);
    assert.equal(app.store.list().filter(r=>r.kind==='source').length,1);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
});

test('Discussion-to-note creation records separate interpretation, source references and derivation in one transaction',()=>{
  const s=new Store(':memory:');try{
    const f=setup(s),note=s.noteFromDiscussion({id:f.message.id,title:'My reviewed interpretation',content:'My own claim',projectId:f.b.id});
    assert.match(note.content,/My own claim/);assert.match(note.content,/An answer to be checked/);assert.match(note.content,/不等於原始文獻/);
    assert.ok(note.sourceIds.includes(f.source.id));
    const link=s.list().find(r=>r.kind==='link'&&r.from===note.id);
    assert.equal(link.to,f.message.id);assert.equal(link.relation,'derived');assert.equal(link.targetRevision,f.message.revision);
    s.save('message',{...f.message,content:'Revised answer'},f.message.id);
    assert.match(s.get(note.id).content,/An answer to be checked/);
    const before=s.list();assert.throws(()=>s.noteFromDiscussion({id:f.message.id,title:'',content:'Invalid title'}),/標題/);assert.deepEqual(s.list(),before);
  }finally{s.close();}
});
