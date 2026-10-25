// Exercise the actual app event handlers in a disposable DOM and local HTTP server.
// Only unrelated research/import modules are stubbed; workspace and persistence are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { makeServer } from '../server.mjs';
import * as references from '../public/research-workspace.js';
import * as views from '../public/workspace-view.js';
import { scopedState, projectsOf } from '../public/project-scope.js';
import { evidenceText } from '../public/research-evidence.js';
import { createKnowledgeWorkspace } from '../public/knowledge-workspace.js';
import { createDiscoveryWorkspace } from '../public/discovery-workspace.js';
import { createObjectNavigation } from '../public/object-navigation.js';
import { createGlossaryWorkspace } from '../public/glossary-workspace.js';

async function until(predicate) {
  for(let attempt=0;attempt<100;attempt++){
    if(predicate())return;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('Timed out waiting for workspace interaction');
}
async function harness(run,initial='source') {
  const root=mkdtempSync(join(tmpdir(),'inkgraph-workspace-dom-')),app=makeServer({dataPath:root,port:0});
  let dom;
  try {
    const project=app.store.save('project',{title:'A'}),other=app.store.save('project',{title:'B'});
    const source=app.store.save('source',{title:'Original',authors:[],text:'Original evidence',projectId:initial==='inbox'?null:project.id,pages:[]});
    if(initial!=='inbox')app.store.linkSource(source.id,other.id);
    const annotation=app.store.save('annotation',{sourceId:source.id,projectId:project.id,quote:'Evidence',locator:'paragraph 1',paraphrase:'Interpretation',verified:true});
    app.store.save('annotation',{sourceId:source.id,projectId:other.id,quote:'Other project',locator:'paragraph 2'});
    const note=app.store.save('note',{title:'My note',projectId:project.id,content:'Original draft',sourceIds:[]});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${app.server.address().port}`,html=await(await fetch(base)).text();
    dom=new JSDOM(html,{url:`${base}/#${initial}${initial==='source'?'/'+source.id:''}`,runScripts:'outside-only',pretendToBeVisual:true});
    const window=dom.window,document=window.document,errors=[];
    window.fetch=(url,opts)=>fetch(new URL(url,base),opts);
    window.structuredClone=structuredClone;
    window.HTMLElement.prototype.scrollIntoView=()=>{};
    window.scrollTo=()=>{};
    window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
    window.addEventListener('error',event=>errors.push(event.error?.message||event.message));
    const unused=()=>({render:()=>'',bind:()=>{}});
    window.__workspaceModules={...references,...views,scopedState,projectsOf,evidenceText,createGlossaryWorkspace:options=>createGlossaryWorkspace({...options,dom:document}),createObjectNavigation:options=>createObjectNavigation({...options,dom:document}),createDiscoveryWorkspace:options=>createDiscoveryWorkspace({...options,dom:document}),createKnowledgeWorkspace:options=>createKnowledgeWorkspace({...options,dom:document}),createWebResearch:unused,createLightImport:unused,createLiteratureSearch:unused};
    const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
    await window.eval(`(async()=>{const {${Object.keys(window.__workspaceModules).join(',')}}=window.__workspaceModules;${appSource}\n})()`);
    const click=selector=>{const element=document.querySelector(selector);assert.ok(element,selector);element.click();};
    const input=(selector,value)=>{const element=document.querySelector(selector);element.value=value;element.dispatchEvent(new window.Event('input',{bubbles:true}));};
    const change=(selector,value)=>{const element=document.querySelector(selector);if(element.type==='checkbox')element.checked=value;else element.value=value;element.dispatchEvent(new window.Event('change',{bubbles:true}));};
    await run({app,window,document,project,other,source,annotation,note,click,input,change});
    assert.deepEqual(errors,[]);
  }finally{dom?.window.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
}

test('Discovery opens from the actual shared sidebar, shows graph and confirms a mention without AI calls',async()=>{
  await harness(async({app,document,source,note,click})=>{
    click(`[data-action="discovery-explore"][data-id="${source.id}"]`);
    assert.ok(document.querySelector('.local-graph svg'));
    click('[data-action="discovery-mentions"]');
    assert.match(document.querySelector('#dialog').textContent,/My note/);
    click(`[data-action="discovery-accept"][data-id="${note.id}"]`);
    await until(()=>app.store.list().some(r=>r.kind==='link'&&r.from===note.id&&r.to===source.id));
    await until(()=>!document.querySelector('[data-action="discovery-accept"]'));
    assert.match(document.querySelector('#dialog').textContent,/沒有候選/);
  });
});

test('Inbox source opening retains attachment metadata on the first click',async()=>{
  await harness(async({app,document,source,click})=>{
    app.store.attach(source.id,'original.txt','text/plain',Buffer.from('Original evidence'));
    click('[data-view="inbox"]');click(`a[href="#source/${source.id}"]`);
    await until(()=>document.querySelector('#source-text'));
    assert.ok(document.querySelector('[data-action="reader-original"]'),'First click must retain the original-file tab without refreshing');
  },'inbox');
});

test('A delayed article response cannot overwrite a later inbox navigation',async()=>{
  await harness(async({window,document,source,click})=>{
    let release;const originalFetch=window.fetch;
    window.fetch=async(url,opts)=>{if(String(url).startsWith('/api/entity?id='+source.id))await new Promise(resolve=>release=resolve);return originalFetch(url,opts);};
    click('[data-view="inbox"]');click(`a[href="#source/${source.id}"]`);
    await until(()=>release);click('[data-view="inbox"]');
    release();await new Promise(r=>setTimeout(r,120));
    assert.equal(window.location.hash,'#inbox');assert.match(document.querySelector('#main h1').textContent,/先收集/);
  },'inbox');
});

test('Inbox selection can add originals to a new project and rename it without changing its ID',async()=>{
  await harness(async({app,document,source,click,input,change})=>{
    change('#inbox-select-all',true);assert.match(document.querySelector('#inbox-selection-count').textContent,/1 筆/);
    click('[data-action="inbox-batch-project"]');change('#dialog [name="batchProject"]','new');input('#dialog [name="newProjectTitle"]','My new research');click('#dialog button[type="submit"]');
    await until(()=>app.store.list().some(r=>r.kind==='project'&&r.title==='My new research'));await until(()=>!document.querySelector('#dialog').open);
    const p=app.store.list().find(r=>r.kind==='project'&&r.title==='My new research');assert.ok(app.store.get(source.id).projectIds.includes(p.id));
    await until(()=>document.querySelector('#project-filter option[value="'+p.id+'"]'));change('#project-filter',p.id);
    click('[data-action="edit-project"]');input('#dialog [name="title"]','Renamed project');click('#dialog button[type="submit"]');
    await until(()=>app.store.get(p.id).title==='Renamed project');await until(()=>document.querySelector('#project-filter option[value="'+p.id+'"]').textContent==='Renamed project');
    assert.ok(app.store.get(source.id).projectIds.includes(p.id));assert.equal(app.store.list().filter(r=>r.kind==='source').length,1);
  },'inbox');
});

test('Article load failure is handled and the next click succeeds without a page refresh',async()=>{
  await harness(async({window,document,source,click})=>{
    const fetch=window.fetch;let fail=true;
    window.fetch=(url,opts)=>{if(fail&&String(url).startsWith('/api/entity?id='+source.id)){fail=false;return Promise.reject(new Error('Synthetic network failure'));}return fetch(url,opts);};
    click(`a[href="#source/${source.id}"]`);await until(()=>document.querySelector('#toast').textContent.includes('開啟失敗'));
    assert.equal(window.location.hash,'#inbox');click(`a[href="#source/${source.id}"]`);await until(()=>document.querySelector('#source-text'));
    assert.equal(window.location.hash,`#source/${source.id}`);assert.match(document.querySelector('#source-text').textContent,/Original evidence/);
  },'inbox');
});

test('Writing navigation replaces selection, restores caret after preview and saves via shortcut without creating evidence links',async()=>{
  await harness(async({app,window,document,source,note,click,input})=>{
    click('[data-view="notes"]');click(`a[href="#note/${note.id}"]`);await until(()=>document.querySelector('#note-content'));
    input('#note-content','prefix REPLACE suffix');document.querySelector('#note-content').setSelectionRange(7,14);
    document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'L',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    input('#object-search','Original');click(`[data-action="nav-choose"][data-id="${source.id}"]`);
    const marker=`[[連結:${source.id}]]`,expected=`prefix ${marker} suffix`,caret=7+marker.length;
    assert.equal(document.querySelector('#note-content').value,expected);assert.equal(document.querySelector('#note-content').selectionStart,caret);assert.equal(app.store.get(note.id).content,'Original draft');
    assert.match(document.querySelector('.shortcut-help').textContent,/Ctrl＋Shift＋L/);assert.match(document.querySelector('.inline-object-links').textContent,/Original/);
    click(`[data-action="nav-preview"][data-id="${source.id}"]`);await until(()=>document.querySelector('.object-preview-body'));
    assert.match(document.querySelector('#dialog').textContent,/Original evidence/);assert.equal(document.querySelector('#note-content').value,expected);
    click('[data-action="nav-cancel"]');assert.equal(document.querySelector('#note-content').selectionStart,caret);assert.equal(document.activeElement.id,'note-content');
    document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));await until(()=>app.store.get(note.id).content===expected);await until(()=>document.querySelector('#note-save-status').textContent==='已儲存');
    assert.equal(app.store.list().filter(r=>r.kind==='link').length,0);assert.deepEqual(app.store.get(note.id).sourceIds,[]);
    click(`[data-action="nav-preview"][data-id="${source.id}"]`);await until(()=>document.querySelector('[data-action="nav-formal"]'));
    click('[data-action="nav-formal"]');await until(()=>document.querySelector('#dialog [name="to"]')?.value===source.id);assert.equal(app.store.list().filter(r=>r.kind==='link').length,0);
  });
});

test('Quick switch honors scope, IME, keyboard hints and canceling navigation with an unsaved draft',async()=>{
  await harness(async({window,document,project,other,source,note,click,input,change})=>{
    change('#project-filter',project.id);click('[data-view="notes"]');click(`a[href="#note/${note.id}"]`);await until(()=>document.querySelector('#note-content'));
    input('#note-content','Unsaved draft');document.querySelector('#note-content').setSelectionRange(3,5);
    document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'K',ctrlKey:true,shiftKey:true,isComposing:true,bubbles:true,cancelable:true}));assert.ok(!document.querySelector('#dialog').open);
    document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'K',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));assert.ok(document.querySelector('#object-search'));assert.equal(document.querySelector('#object-scope').value,project.id);
    input('#object-search','Other project');assert.match(document.querySelector('#object-result-status').textContent,/0 筆/);
    change('#object-scope','');assert.ok(document.querySelector('[data-action="nav-choose"]'));input('#object-search','Original');
    document.querySelector('#object-search').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));assert.ok(document.querySelector('#dialog').open);
    window.confirm=()=>false;click(`[data-action="nav-choose"][data-id="${source.id}"]`);await new Promise(r=>setTimeout(r,25));assert.equal(window.location.hash,`#note/${note.id}`);assert.equal(document.querySelector('#note-content').value,'Unsaved draft');assert.ok(document.querySelector('#dialog').open);
    click('[data-action="nav-cancel"]');assert.equal(document.querySelector('#note-content').selectionStart,3);assert.equal(document.querySelector('#note-content').selectionEnd,5);
    click('[data-action="nav-insert"]');input('#object-search','Original');
    document.querySelector('#object-search').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.ok(document.querySelector('#note-content').value.includes(`[[連結:${source.id}]]`));
  });
});

test('Opening a deleted search target never discards the current unsaved draft',async()=>{
  await harness(async({app,window,document,source,note,click,input})=>{
    click('[data-view="notes"]');click(`a[href="#note/${note.id}"]`);await until(()=>document.querySelector('#note-content'));
    input('#note-content','Keep my unsaved text');click('#quick-switch');input('#object-search','Original');
    const preview=app.store.sourceDeletionPreview(source.id);app.store.deleteSource(source.id,preview.fingerprint);
    let prompted=false;window.confirm=()=>{prompted=true;return true;};click(`[data-action="nav-choose"][data-id="${source.id}"]`);
    await until(()=>document.querySelector('#toast').textContent.includes('找不到資料'));assert.equal(prompted,false);assert.equal(document.querySelector('#note-content').value,'Keep my unsaved text');
    click('[data-action="nav-cancel"]');document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));
    await until(()=>app.store.get(note.id).content==='Keep my unsaved text');
  });
});

test('Reader split editor preserves draft/caret across redraws, blocks conflicting saves and honors leave cancellation',async()=>{
  await harness(async({app,window,document,project,source,annotation,note,click,input,change})=>{
    change('#project-filter',project.id);
    click('[data-view="sources"]');click(`a[href="#source/${source.id}"]`);
    await until(()=>document.querySelector('[data-action="choose-split-note"]'));
    click('[data-action="choose-split-note"]');change('#dialog [name="noteId"]',note.id);click('#dialog button[type="submit"]');
    await until(()=>document.querySelector('#note-content'));
    click(`[data-action="add-excerpt"][data-id="${annotation.id}"]`);
    assert.match(document.querySelector('.excerpt-preview').textContent,/Evidence/);
    const withQuote=document.querySelector('#note-content').value;
    const draft='\n\n'+withQuote+'\nUnsaved interpretation';input('#note-content',draft);
    document.querySelector('#note-content').setSelectionRange(4,8);
    change('#connections-all',true);
    assert.equal(document.querySelector('#note-content').value,draft);
    assert.equal(document.querySelector('#note-content').selectionStart,4);
    click('[data-action="reader-text"]');assert.equal(document.querySelector('#note-content').value,draft);
    let prompts=0;window.confirm=()=>{prompts++;return false;};click('[data-view="dashboard"]');
    assert.equal(prompts,1);assert.equal(document.querySelector('#note-content').value,draft);
    click('[data-action="save-note"]');await until(()=>app.store.get(note.id).content===draft);
    await until(()=>document.querySelector('#note-save-status').textContent==='已儲存');
    assert.equal(app.store.get(note.id).excerptRefs[0].annotationId,annotation.id);
    assert.ok(document.querySelector(`.connections-panel a[href="#note/${note.id}"]`));
    input('#note-content',draft+'\nLocal work');
    const latest=app.store.get(note.id);app.store.save('note',{...latest,title:'External metadata update'},note.id);
    click('[data-action="save-note"]');await until(()=>document.querySelector('#toast').textContent.includes('其他頁籤'));
    assert.equal(document.querySelector('#note-content').value,draft+'\nLocal work');
    assert.equal(app.store.get(note.id).content,draft);
    window.confirm=()=>true;click('[data-view="dashboard"]');
    assert.ok(!document.querySelector('#note-content'));
  });
});

test('Excerpt list can open an existing note, jump back to the source and export after saving',async()=>{
  await harness(async({app,window,document,annotation,note,click,change})=>{
    click('[data-view="annotations"]');click(`[data-action="add-excerpt"][data-id="${annotation.id}"]`);
    change('#dialog [name="noteId"]',note.id);click('#dialog button[type="submit"]');
    await until(()=>document.querySelector('#note-content')?.value.includes('[[摘錄:'));
    assert.match(document.querySelector('h1').textContent,/My note/);
    click('.snapshot-card [data-action="workspace-excerpt"]');await until(()=>document.querySelector('#source-text'));
    assert.match(document.querySelector('#source-text').textContent,/Original evidence/);
    assert.ok(document.querySelector('.selected-excerpt'));
    click('[data-action="save-note"]');await until(()=>app.store.get(note.id).excerptRefs?.length===1);
    await until(()=>document.querySelector('#note-save-status').textContent==='已儲存');
    const response=await fetch(`${window.location.origin}/api/export?format=markdown&id=${note.id}`,{headers:{'x-inkgraph-token':app.token}});
    assert.equal(response.status,200);assert.match(await response.text(),/Interpretation/);
  });
});

test('Discussion, message and concept interfaces create one bidirectional relationship and preserve navigation',async()=>{
  await harness(async({app,document,source,click,input,change})=>{
    click(`[data-action="knowledge-new-discussion"][data-id="${source.id}"]`);
    input('#dialog [name="title"]','How should evidence support trust?');
    change('#dialog [name="origin"]','gemini');input('#dialog [name="content"]','A discussion linked to original evidence');
    click('#dialog button[type="submit"]');await until(()=>app.store.list().some(r=>r.kind==='discussion'));
    await until(()=>document.querySelector('[data-action="knowledge-new-message"]'));
    click('[data-action="knowledge-new-message"]');change('#dialog [name="role"]','assistant');input('#dialog [name="content"]','This is a model answer, not original evidence.');click('#dialog button[type="submit"]');
    await until(()=>app.store.list().some(r=>r.kind==='message'));
    await until(()=>document.querySelector('h1').textContent.includes('model answer'));
    const message=app.store.list().find(r=>r.kind==='message');
    click('[data-view="concepts"]');click('[data-action="knowledge-new-concept"]');input('#dialog [name="title"]','Trust');input('#dialog [name="definition"]','A reusable research concept');click('#dialog button[type="submit"]');
    await until(()=>app.store.list().some(r=>r.kind==='concept'));
    const concept=app.store.list().find(r=>r.kind==='concept');await until(()=>document.querySelector('h1').textContent==='Trust');
    click(`[data-action="knowledge-link"][data-id="${concept.id}"]`);change('#dialog [name="relation"]','related');change('#dialog [name="to"]',message.id);input('#dialog [name="reason"]','Review the model claim against this concept');click('#dialog button[type="submit"]');
    await until(()=>app.store.list().some(r=>r.kind==='link'));await until(()=>document.querySelector(`.connections-panel [data-action="knowledge-open"][data-id="${message.id}"]`));
    assert.ok(document.querySelector(`.connections-panel [data-action="knowledge-open"][data-id="${message.id}"]`));
    click(`.connections-panel [data-action="knowledge-open"][data-id="${message.id}"]`);await until(()=>document.querySelector('h1').textContent.includes('model answer'));
    assert.ok(document.querySelector(`.connections-panel [data-action="knowledge-open"][data-id="${concept.id}"]`));
    assert.equal(app.store.list().filter(r=>r.kind==='link').length,1);
  });
});
