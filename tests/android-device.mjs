// Operates only the explicitly authorized InkGraph test package.
import assert from 'node:assert/strict';
import { execFileSync,spawnSync } from 'node:child_process';
import { writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const adb=process.env.INKGRAPH_ADB;if(!adb)throw Error('Set INKGRAPH_ADB to the authorized platform tool');
const pkg='app.inkgraph.capture.dev',activity=pkg+'/app.inkgraph.capture.MainActivity';
const run=args=>execFileSync(adb,args,{encoding:'utf8',timeout:20000,windowsHide:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function nodes(){run(['shell','uiautomator','dump','/data/local/tmp/inkgraph-capture-test-ui.xml']);const xml=run(['exec-out','cat','/data/local/tmp/inkgraph-capture-test-ui.xml']);const result=[...xml.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));assert.ok(result.some(n=>n.package===pkg),'Stop: InkGraph is not the visible app; unlock the device and open it');return result.filter(n=>n.package===pkg);}
function tap(node){const b=node?.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);assert.ok(b,'Visible target bounds missing');const [x1,y1,x2,y2]=b.slice(1).map(Number);assert.ok(x2>x1&&y2>y1);run(['shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2))]);}
run(['shell','am','start','-n',activity]);await wait(800);let list=nodes();
assert.ok(list.some(n=>n.text.includes('新增筆記')));assert.ok(list.some(n=>n.text.startsWith('草稿 ')));assert.ok(list.some(n=>n.text.startsWith('待傳至電腦')));assert.ok(list.some(n=>n.text.startsWith('電腦已接收')));
mkdirSync(resolve('artifacts'),{recursive:true});const image=spawnSync(adb,['exec-out','screencap','-p'],{timeout:10000,maxBuffer:12*1024*1024});assert.equal(image.status,0);writeFileSync(resolve('artifacts/android-home-status.png'),image.stdout);
tap(list.find(n=>n.text==='查看全部記錄與傳輸狀態'));await wait(400);list=nodes();
const item=list.find(n=>n.text.startsWith('電腦已接收 ·')||n.text.startsWith('待傳輸／待回執 ·'));if(item){tap(item);await wait(300);list=nodes();assert.ok(list.some(n=>n.text==='記錄與傳輸狀態'));assert.equal(list.filter(n=>n.class==='android.widget.EditText').length,0);tap(list.find(n=>n.text==='返回首頁'));}
else tap(list.find(n=>n.text==='關閉'));
let draftTested=false;
let deletionTested=false;
function findScrolled(text){for(let i=0;i<6;i++){const found=nodes().find(n=>n.text===text);if(found)return found;run(['shell','input','swipe','540','1900','540','700','250']);}throw Error('Missing visible control: '+text);}
if(process.argv.includes('--delete')){
  await wait(300);list=nodes();const initialDrafts=list.find(n=>n.text.startsWith('草稿 '))?.text;assert.ok(initialDrafts);
  tap(list.find(n=>n.text.includes('新增筆記')));await wait(400);list=nodes();const editors=list.filter(n=>n.class==='android.widget.EditText');assert.ok(editors.length>=2);tap(editors[editors.length-1]);run(['shell','input','text','IGDELETEONLY20261025']);await wait(1200);run(['shell','input','keyevent','4']);
  tap(findScrolled('刪除此記錄'));await wait(300);list=nodes();assert.ok(list.some(n=>n.text.includes('尚未確認傳到電腦')));tap(list.find(n=>n.text==='取消'));await wait(200);assert.ok(nodes().some(n=>n.class==='android.widget.EditText'&&n.text.includes('IGDELETEONLY20261025')));
  tap(findScrolled('刪除此記錄'));await wait(200);tap(nodes().find(n=>n.text==='確認刪除'));await wait(1000);list=nodes();assert.ok(list.some(n=>n.text===initialDrafts));
  run(['shell','am','force-stop',pkg]);run(['shell','am','start','-n',activity]);await wait(500);assert.ok(nodes().some(n=>n.text===initialDrafts));deletionTested=true;
}
if(process.argv.includes('--draft')){
  await wait(300);list=nodes();tap(list.find(n=>n.text.includes('新增筆記')));await wait(400);list=nodes();const editors=list.filter(n=>n.class==='android.widget.EditText');assert.ok(editors.length>=2);tap(editors[editors.length-1]);run(['shell','input','text','IGDRAFTCHECK20261025']);await wait(1500);
  run(['shell','am','force-stop',pkg]);run(['shell','am','start','-n',activity]);await wait(500);list=nodes();tap(list.find(n=>n.text.startsWith('草稿 ')));await wait(250);list=nodes();assert.ok(list.some(n=>n.text.includes('IGDRAFTCHECK20261025')));tap(list.find(n=>n.text==='關閉'));draftTested=true;
}
console.log(JSON.stringify({visibleHomeEntries:true,completedRecordReadOnly:true,draftSurvivesProcessRestart:draftTested?'passed':'not-run',syntheticDeletionAndCancel:deletionTested?'passed':'not-run',screenshot:'artifacts/android-home-status.png'}));
