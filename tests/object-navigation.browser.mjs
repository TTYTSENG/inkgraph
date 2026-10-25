// Standalone browser regression in a fresh, temporary profile and synthetic database.
// Run explicitly: node tests/object-navigation.browser.mjs
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { makeServer } from '../server.mjs';

const dataPath=mkdtempSync(join(tmpdir(),'inkgraph-navigation-browser-'));
const app=makeServer({dataPath,port:0});let browser;
try {
  const project=app.store.save('project',{title:'〔合成示範〕閱讀與研究'});
  const source=app.store.save('source',{title:'〔合成示範〕信任與證據',authors:[{literal:'示範研究者'}],year:'2026',text:'合成測試材料：信任需要能回到原文核對的證據。這不是正式研究文獻。',projectId:project.id});
  const concept=app.store.save('concept',{title:'信任',aliases:'Trust',definition:'合成定義：讓判斷與原始材料保持可檢查的關係。',projectId:project.id});
  const note=app.store.save('note',{title:'〔合成示範〕我的研究判斷',content:'prefix SELECT suffix',sourceIds:[],projectId:project.id});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.INKGRAPH_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1});
  const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(base)&&/^https?:/.test(r.url()))external.push(r.url());});
  await page.goto(`${base}/#note/${note.id}`);await page.locator('#note-content').waitFor();
  await page.locator('#note-content').evaluate(el=>{el.focus();el.setSelectionRange(7,13);});
  await page.keyboard.press('Control+Shift+L');await page.locator('#object-search').fill('信任');
  await page.locator(`[data-action="nav-choose"][data-id="${source.id}"]`).click();
  const marker=`[[連結:${source.id}]]`,expected=`prefix ${marker} suffix`;
  assert.equal(await page.locator('#note-content').inputValue(),expected);
  assert.equal(await page.locator('#note-content').evaluate(el=>el.selectionStart),7+marker.length);
  assert.equal(app.store.get(note.id).content,'prefix SELECT suffix');
  await page.locator('.shortcut-help summary').click();
  assert.match(await page.locator('.shortcut-help').innerText(),/Ctrl＋Shift＋L/);
  await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#note-save-status')?.textContent==='已儲存');
  assert.equal(app.store.get(note.id).content,expected);
  await page.locator('.shortcut-help summary').click();
  mkdirSync(resolve('artifacts'),{recursive:true});
  await page.screenshot({path:resolve('artifacts/native-navigation-writing.jpg'),fullPage:true});
  await page.locator(`[data-action="nav-preview"][data-id="${source.id}"]`).click();
  await page.locator('.object-preview-body').waitFor();assert.match(await page.locator('#dialog').innerText(),/回到原文/);
  await page.screenshot({path:resolve('artifacts/native-navigation-preview.jpg')});
  await page.locator('[data-action="nav-cancel"]').click();assert.equal(await page.locator('#note-content').inputValue(),expected);
  await page.keyboard.press('Control+Shift+k');await page.locator('#object-search').fill('Trust');
  assert.equal(await page.locator('[data-action="nav-choose"]').count(),1);
  await page.screenshot({path:resolve('artifacts/native-navigation-switcher.jpg')});
  await page.keyboard.press('Enter');await page.waitForURL(`**/#concept/${concept.id}`);
  assert.match(await page.locator('#main').innerText(),/合成定義/);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#quick-switch').click();await page.locator('#object-search').fill('我的研究判斷');await page.keyboard.press('Enter');
  await page.locator('#note-content').waitFor();assert.equal(await page.locator('#note-content').inputValue(),expected);
  assert.equal(app.store.list().filter(r=>r.kind==='link').length,0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({result:'passed',desktop:'1280x900',mobile:'390x844',externalRequests:external.length,screenshots:['native-navigation-writing.jpg','native-navigation-preview.jpg','native-navigation-switcher.jpg']}));
}finally {
  await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(dataPath,{recursive:true,force:true});
}
