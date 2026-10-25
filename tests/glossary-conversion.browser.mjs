// Synthetic research material; temporary database and isolated Chrome profile.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { makeServer } from '../server.mjs';
import { excerptSnapshot } from '../public/research-workspace.js';

const root=mkdtempSync(join(tmpdir(),'inkgraph-glossary-browser-')),app=makeServer({dataPath:root,port:0});let browser;
try{
  const project=app.store.save('project',{title:'〔合成示範〕思想與應用研究'}),other=app.store.save('project',{title:'〔合成示範〕其他專案'});
  const source=app.store.save('source',{title:'〔合成示範〕透明性與文本詮釋',authors:[{literal:'Example Author'}],year:'2024',projectId:project.id,text:'原文證據：此處僅為測試用合成材料。',pages:[]});
  const a=app.store.save('annotation',{sourceId:source.id,quote:'此處僅為測試用合成材料。',locator:'第 1 段',verified:true}),snapshot=excerptSnapshot(a,'browser-snapshot');
  const note=app.store.save('note',{title:'〔合成示範〕T31｜透明性',projectId:project.id,noteType:'research',sourceIds:[source.id],content:`# 透明性\n\n原詞：transparency\n\n白話定義：保留特定作者的詮釋語境。\n\n辨義提醒：這不是所有領域共用的單一定義。\n\n[[摘錄:${snapshot.id}]]`,excerptRefs:[snapshot]});
  app.store.linkEntity(note.id,other.id);
  const discipline=app.store.save('category',{title:'人文',axis:'discipline'}),child=app.store.save('category',{title:'哲學',axis:'discipline',parentId:discipline.id}),context=app.store.save('category',{title:'啟蒙思想',axis:'context'});
  app.store.save('note',{title:'〔合成示範〕可連結的思考',sourceIds:[],content:'獨立筆記',projectId:project.id});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.INKGRAPH_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base))outside.push(r.url());});
  await page.goto(base+'/#note/'+note.id);await page.locator('#note-content').waitFor();
  await page.locator('[data-action="glossary-convert"]').click();await page.locator('#dialog [name="title"]').fill('〔合成示範〕透明性');
  await page.locator('#dialog [name="definition"]').fill('自己的釋義：用詞必須連同作者語境與原始依據理解。');await page.locator('#dialog [name="aliases"]').fill('transparency');
  await page.locator('#dialog [name="scopeNote"]').fill('辨義提醒：此詞在不同應用領域可能有不同用法。');
  await page.locator(`#dialog [name="categoryIds"][value="${child.id}"]`).check();await page.locator(`#dialog [name="categoryIds"][value="${context.id}"]`).check();
  await page.locator('#dialog input[required][type="checkbox"]').check();
  mkdirSync(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/glossary-conversion-preview.jpg'),fullPage:true});
  await page.locator('#dialog button[type="submit"]').click();await page.waitForURL('**/#term/'+note.id);
  assert.equal(app.store.get(note.id).kind,'term');assert.ok(app.store.get(note.id).projectIds.includes(other.id));assert.deepEqual(app.store.get(note.id).excerptRefs,[snapshot]);
  await page.locator('#note-content').waitFor();assert.ok((await page.locator('#main').innerText()).includes('辨義提醒'));assert.ok((await page.locator('#main').innerText()).includes('此處僅為測試用合成材料。'));
  await page.locator('#note-content').fill(app.store.get(note.id).content+'\n\n後續整理：保留所有引文。');await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#note-save-status')?.textContent==='已儲存');
  assert.ok(app.store.get(note.id).content.includes('後續整理'));
  await page.locator('#note-content').focus();await page.keyboard.press('Control+Shift+l');await page.locator('#object-search').fill('可連結的思考');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#dialog').open);await page.locator('[data-action="save-note"]').click();await page.waitForFunction(()=>document.querySelector('#note-save-status')?.textContent==='已儲存');assert.match(app.store.get(note.id).content,/\[\[連結:/);
  await page.locator('[data-action="edit-term"]').click();await page.locator('#dialog [name="definition"]').fill('修改後的釋義');await page.locator('#dialog button[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);assert.equal(app.store.get(note.id).definition,'修改後的釋義');
  await page.goto(base+'/#note/'+note.id);await page.waitForURL('**/#term/'+note.id);await page.locator('#note-content').waitFor();
  await page.screenshot({path:resolve('artifacts/glossary-term-writing.jpg'),fullPage:true});
  await page.locator('[data-view="terms"]').click();await page.locator('#glossary-query').fill('transparency');assert.equal(await page.locator('.glossary-layout .record-card').count(),1);
  await page.locator(`[data-category-filter="${discipline.id}"]`).check();await page.locator(`[data-category-filter="${context.id}"]`).check();assert.equal(await page.locator('.glossary-layout .record-card').count(),1);
  await page.locator('#glossary-descendants').uncheck();assert.equal(await page.locator('.glossary-layout .record-card').count(),0);await page.locator('#glossary-descendants').check();
  await page.screenshot({path:resolve('artifacts/glossary-taxonomy-desktop.jpg'),fullPage:true});
  await page.locator('[data-action="glossary-categories"]').click();await page.locator(`[data-action="glossary-category-edit"][data-id="${child.id}"]`).click();await page.locator('#dialog [name="title"]').fill('政治哲學');await page.locator('#dialog button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#dialog')?.textContent.includes('人文 → 政治哲學'));assert.equal(app.store.get(child.id).title,'政治哲學');await page.locator('#dialog [data-action="close-dialog"]').last().click();
  await page.locator('[data-action="glossary-categories"]').click();await page.locator('[data-action="glossary-category-new"]').click();await page.locator('#dialog [name="title"]').fill('文本詮釋');await page.locator('#dialog [name="axis"]').selectOption('application');await page.locator('#dialog button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#dialog')?.textContent.includes('文本詮釋'));assert.ok(app.store.list().some(r=>r.kind==='category'&&r.title==='文本詮釋'));await page.locator('#dialog [data-action="close-dialog"]').last().click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve('artifacts/glossary-taxonomy-mobile.jpg'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  // Explicit Light preview selection through the real UI.
  await page.locator('[data-view="light"]').click();const bundle={format:'light-inkgraph',version:1,notes:[{title:'〔合成示範〕新匯入詞彙',content:'完整定義段落'}]};
  await page.locator('#light-file').setInputFiles({name:'glossary.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});await page.locator('#light-form button[type="submit"]').click();await page.locator('[data-light-type="0"]').waitFor();assert.equal(await page.locator('[data-light-type="0"]').inputValue(),'quick');await page.locator('[data-light-type="0"]').selectOption('term');await page.locator('#light-confirm').waitFor();await page.locator('#light-confirm').click();await page.waitForFunction(()=>!document.querySelector('#light-confirm'));assert.equal(app.store.list().find(r=>r.title==='〔合成示範〕新匯入詞彙').kind,'term');
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);console.log(JSON.stringify({result:'passed',conversion:true,stableId:true,snapshots:true,shortcutSaveAndLink:true,legacyRoute:true,multiAxisFilters:true,categoryRenameAndCreate:true,lightTypeSelection:true,mobileOverflow:false,outsideRequests:0}));
}finally{await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
