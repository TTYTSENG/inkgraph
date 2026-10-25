// Explicit browser regression, synthetic data and a temporary browser profile only.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { makeServer } from '../server.mjs';
import { parseFile } from '../lib/imports.mjs';
import { docxFixture,xlsxFixture,pptxFixture } from './office-fixtures.mjs';

const root=mkdtempSync(join(tmpdir(),'inkgraph-project-office-browser-')),app=makeServer({dataPath:root,port:0});let browser;
try{
  const first=app.store.save('source',{title:'〔合成示範〕待整理文章甲',authors:[],text:'合成研究材料甲：可跨專案重用原始來源。'});
  const second=app.store.save('source',{title:'〔合成示範〕待整理文章乙',authors:[],text:'合成研究材料乙：自己的判斷與原文分開保存。'});
  app.store.save('project',{title:'〔合成示範〕既有研究專案'});
  const word=await docxFixture(),parsed=await parseFile('研究稿.docx',word),officeSource=app.store.save('source',{title:'〔合成示範〕Word 原稿',authors:[],...parsed});app.store.attach(officeSource.id,'研究稿.docx',parsed.mime,word);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.INKGRAPH_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base))outside.push(r.url());});
  await page.goto(base+'/#inbox');await page.locator('[data-inbox-select]').first().waitFor();
  await page.locator('#inbox-select-all').check();assert.match(await page.locator('#inbox-selection-count').innerText(),/3 筆/);
  mkdirSync(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/inbox-bulk-project.jpg'),fullPage:true});
  await page.locator('[data-action="inbox-batch-project"]').click();await page.locator('[name="batchProject"]').selectOption('new');await page.locator('[name="newProjectTitle"]').fill('〔合成示範〕批量整理的研究專案');await page.locator('#dialog button[type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#dialog').open);const created=app.store.list().find(r=>r.kind==='project'&&r.title==='〔合成示範〕批量整理的研究專案');assert.ok(created);
  assert.ok([first,second,officeSource].every(r=>app.store.get(r.id).projectIds.includes(created.id)));
  await page.locator('#project-filter').selectOption(created.id);await page.locator('[data-action="edit-project"]').click();await page.locator('[name="title"]').fill('〔合成示範〕已改名的研究專案');await page.locator('#dialog button[type="submit"]').click();
  await page.waitForFunction(id=>document.querySelector(`#project-filter option[value="${id}"]`)?.textContent==='〔合成示範〕已改名的研究專案',created.id);
  assert.equal(app.store.get(created.id).title,'〔合成示範〕已改名的研究專案');
  await page.locator('[data-view="sources"]').click();await page.locator(`a[href="#source/${officeSource.id}"]`).click();await page.locator('#source-text').waitFor();
  assert.match(await page.locator('#source-text').innerText(),/Word 合成/);assert.equal(await page.locator('[data-action="reader-original"]').count(),1);
  const accept=await page.locator('#upload').getAttribute('accept');for(const ext of ['.docx','.doc','.xlsx','.xls','.pptx','.ppt'])assert.ok(accept.includes(ext));
  await page.locator('#upload').setInputFiles([{name:'合成資料.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await xlsxFixture()},{name:'合成簡報.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer:await pptxFixture()}]);
  await page.waitForFunction(()=>document.querySelector('#source-text')?.textContent.includes('第一張合成頁'));
  assert.match(await page.locator('.page-number').first().innerText(),/投影片第 1 張/);
  await page.screenshot({path:resolve('artifacts/office-presentation-reading.jpg'),fullPage:true});
  const sheet=app.store.list().find(r=>r.title==='合成資料.xlsx');assert.ok(sheet);
  await page.locator('#quick-switch').click();await page.locator('#object-search').fill('合成資料.xlsx');await page.keyboard.press('Enter');await page.waitForURL(`**/#source/${sheet.id}`);
  assert.match(await page.locator('#source-text').innerText(),/A1：合成標題/);assert.match(await page.locator('.page-number').first().innerText(),/工作表：合成研究表/);
  await page.screenshot({path:resolve('artifacts/office-spreadsheet-reading.jpg'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('[data-view="inbox"]').click();await page.locator('#inbox-select-all').waitFor();
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({result:'passed',projectRename:true,batchCount:3,officeUpload:['docx','xlsx','pptx'],outsideRequests:0,screenshots:['inbox-bulk-project.jpg','office-presentation-reading.jpg','office-spreadsheet-reading.jpg']}));
}finally{await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
