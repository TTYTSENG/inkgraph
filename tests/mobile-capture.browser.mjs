import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { makeServer } from '../server.mjs';
import { captureFixture } from './mobile-fixtures.mjs';
const root=mkdtempSync(join(tmpdir(),'inkgraph-mobile-browser-')),app=makeServer({dataPath:root,port:0,mobileOptions:{autoStart:false}});let browser;
try{
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.INKGRAPH_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[],outside=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base))outside.push(r.url());});
  await page.goto(base+'/#mobile');await page.locator('#mobile-package').waitFor();
  const f=await captureFixture({photo:true,text:'〔合成示範〕手機記錄測試'});f.manifest.capture.location={status:'captured',lat:0,lon:0,accuracyMeters:100,measuredAt:'2026-10-25T10:00:00Z',label:'合成地點'};const actual=await captureFixture({manifest:f.manifest});
  await page.locator('#mobile-package').setInputFiles({name:'capture.igc',mimeType:'application/zip',buffer:actual.bytes});await page.locator('[data-action="mobile-open"]').waitFor();
  assert.equal(app.store.list().filter(r=>r.kind==='note').length,1);assert.equal(app.store.list().filter(r=>r.kind==='source').length,2);
  const notes=app.store.list().filter(r=>r.kind==='note'),sources=app.store.list().filter(r=>r.kind==='source'),audio=sources.find(r=>r.mime==='audio/wav');
  app.store.db.prepare("UPDATE media_jobs SET state='done',result=? WHERE source_id=?").run(JSON.stringify({text:'合成測試逐字稿',segments:[{start:0,end:.25,text:'合成測試逐字稿'}],engine:'synthetic',version:'test',elapsedSeconds:.01,peakRssBytes:1000000,verified:false}),audio.id);
  await page.locator('[data-action="mobile-load"]').click();await page.getByText('合成測試逐字稿',{exact:true}).waitFor();assert.ok(await page.locator('[data-action="mobile-pause"]').innerText());
  await page.locator('[data-action="mobile-pause"]').click();await page.getByRole('button',{name:'繼續辨識',exact:true}).waitFor();assert.equal(app.mediaJobs.status().paused,true);
  mkdirSync(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/mobile-desktop-synthetic.jpg'),fullPage:true});
  const jsonDownload=page.waitForEvent('download');await page.locator('[data-mobile-export="json"]').click();const exported=await jsonDownload;const jsonPath=resolve('artifacts/mobile-result-synthetic.json');await exported.saveAs(jsonPath);assert.equal(JSON.parse(readFileSync(jsonPath,'utf8')).text,'合成測試逐字稿');
  await page.locator('[data-action="mobile-share"]').click();await page.locator('#dialog [name="format"]').selectOption('json');assert.equal(await page.locator('#dialog [name="omitLocation"]').isChecked(),true);const sharedDownload=page.waitForEvent('download');await page.locator('#dialog button[type="submit"]').click();const shared=await sharedDownload,sharedPath=resolve('artifacts/mobile-share-synthetic.json');await shared.saveAs(sharedPath);assert.ok(!readFileSync(sharedPath,'utf8').includes('合成地點'));assert.ok(readFileSync(sharedPath,'utf8').includes('Asia/Taipei'));
  await page.locator(`[data-action="mobile-source"][data-id="${audio.id}"]`).click();await page.waitForURL('**/#source/'+audio.id);await page.locator('[data-action="reader-original"]').click();assert.equal(await page.locator('audio[controls]').count(),1);
  await page.goto(base+'/#mobile');await page.locator('[data-action="mobile-open"]').waitFor();await page.locator('[data-action="mobile-open"]').click();await page.waitForURL('**/#note/'+notes[0].id);assert.ok((await page.locator('#main').innerText()).includes('手機記錄時間與地點'));
  await page.goto(base+'/#mobile');await page.locator('#mobile-package').waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve('artifacts/mobile-browser-small.jpg'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({passed:true,rawImport:true,originalAudio:true,privateSharing:true,resultJSON:true,pauseQueue:true,timeLocationVisible:true,mobileOverflow:false,outsideRequests:0}));
}finally{await browser?.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});}
