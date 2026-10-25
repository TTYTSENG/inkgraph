// Manual end-to-end acceptance; disposable database and mocked academic providers only.
import { chromium } from 'playwright-core';
import { existsSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { makeServer } from '../server.mjs';
const exe=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const root=mkdtempSync(join(tmpdir(),'inkgraph-rounds23-'));
const app=makeServer({dataPath:root,port:0,literatureOptions:{retrieve:async()=>({message:{items:[{title:['隔離學術搜尋文獻'],DOI:'10.1234/browser-shared',author:[{family:'Author'}],published:{'date-parts':[[2025]]},URL:'https://example.org/test',abstract:'Synthetic abstract; not research evidence.'}]}})}});
let browser;
try{
  const a=app.store.save('project',{title:'原專案'}),b=app.store.save('project',{title:'第二專案'});
  const source=app.store.save('source',{title:'原始共用文獻',authors:[],projectId:a.id,doi:'10.1234/browser-shared',text:'needle full text',pages:[{number:1,text:'needle original page'}]});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({executablePath:exe,headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#literature`);
  await page.getByRole('heading',{name:'學術文獻搜尋',exact:true}).waitFor();
  await page.locator('[name="query"]').fill('adaptive lighting');
  await page.locator('[name="provider"][value="europepmc"]').uncheck();await page.locator('[name="provider"][value="openalex"]').uncheck();
  await page.getByRole('button',{name:'搜尋文獻',exact:true}).click();await page.locator('[data-paper]').waitFor();
  assert.equal(app.store.list().filter(r=>r.kind==='source').length,1);
  await page.locator('[data-paper]').check();await page.getByRole('button',{name:'將勾選文獻帶入匯入預覽'}).click();
  await page.locator('#light-project').selectOption(b.id);await page.getByRole('button',{name:'預覽成果',exact:true}).click();
  await page.locator('#light-confirm').waitFor();assert.match(await page.locator('#light-preview').textContent(),/沿用共用來源/);
  await page.locator('[data-light-filter="status"]').selectOption('link');
  await page.locator('[data-light-bulk="exclude"]').click();await page.locator('#light-status').filter({hasText:'已移除 1 筆'}).waitFor();
  await page.locator('[data-light-filter="status"]').selectOption('excluded');await page.locator('[data-light-bulk="restore"]').click();
  await page.locator('#light-confirm').click();await page.getByRole('status').filter({hasText:'已新增 1 筆成果'}).waitFor();
  assert.equal(app.store.list().filter(r=>r.kind==='source').length,1);assert.ok(app.store.get(source.id).projectIds.includes(b.id));
  await page.locator('#project-filter').selectOption(b.id);await page.locator('[data-view="sources"]').click();
  await page.getByRole('link',{name:'原始共用文獻',exact:true}).click();await page.locator('#source-text').waitFor();
  assert.match(await page.locator('#source-text').textContent(),/needle original page/);
  await page.locator('#search').fill('needle');await page.getByRole('link',{name:'原始共用文獻',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS rounds 2/3: scholarly search, candidate selection, seeded preview, grouped bulk exclusion/restore, shared import, project filter, deferred body, full-text search and mobile layout; no page errors.');
}finally{await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
