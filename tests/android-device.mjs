// Only this authorized package and explicitly marked synthetic records are changed.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const adb=process.env.INKGRAPH_ADB;if(!adb)throw Error('Set INKGRAPH_ADB');
const pkg='app.inkgraph.capture.dev',activity=pkg+'/app.inkgraph.capture.MainActivity';
const run=args=>execFileSync(adb,args,{encoding:'utf8',timeout:20000,windowsHide:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const size=run(['shell','wm','size']).match(/(?:Override|Physical) size: (\d+)x(\d+)/g)?.at(-1)?.match(/(\d+)x(\d+)/);
const width=Number(size?.[1]||1080),height=Number(size?.[2]||2400);
function nodes(){
  run(['shell','uiautomator','dump','/data/local/tmp/inkgraph-capture-test-ui.xml']);
  const xml=run(['exec-out','cat','/data/local/tmp/inkgraph-capture-test-ui.xml']);
  const result=[...xml.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
  assert.ok(result.some(n=>n.package===pkg),'Stop: unlock and open InkGraph');return result.filter(n=>n.package===pkg);
}
function bounds(node){const b=node?.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);assert.ok(b,'Missing visible target');return b.slice(1).map(Number);}
function tap(node){const [x1,y1,x2,y2]=bounds(node);assert.ok(x2>x1&&y2>y1);run(['shell','input','tap',String(Math.round((x1+x2)/2)),String(Math.round((y1+y2)/2))]);}
function find(predicate){for(let i=0;i<9;i++){const n=nodes().find(predicate);if(n)return n;run(['shell','input','swipe',String(width/2),String(Math.round(height*.7)),String(width/2),String(Math.round(height*.3)),'250']);}return null;}
function capture(name){mkdirSync(resolve('artifacts'),{recursive:true});const r=spawnSync(adb,['exec-out','screencap','-p'],{timeout:10000,maxBuffer:15*1024*1024});assert.equal(r.status,0);writeFileSync(resolve('artifacts',name),r.stdout);}
function footer(list){for(const text of ['錄音','照片','完成記錄']){const n=list.find(n=>n.text===text);assert.ok(n,'Fixed footer missing: '+text);const [x1,y1,x2,y2]=bounds(n);assert.ok(x1>=0&&x2<=width&&y1>0&&y2<height,'Footer outside viewport: '+text);}}
function total(list){return list.find(n=>/^全部 \d+$/.test(n.text))?.text;}
async function removeCurrent(){tap(nodes().find(n=>n.text==='更多'));await wait(150);tap(nodes().find(n=>n.text==='刪除此記錄'));await wait(150);tap(nodes().find(n=>n.text==='確認刪除'));await wait(600);}

run(['shell','am','start','-n',activity]);await wait(500);let list=nodes();
assert.ok(!list.some(n=>n.text==='停止並保存'),'Stop: a real recording is active');
if(!list.some(n=>n.text==='新增筆記')){tap(list.find(n=>n.text==='返回'));list=nodes();}
assert.ok(list.some(n=>n.text==='新增筆記'));assert.ok(total(list));assert.ok(list.some(n=>/^草稿 \d+$/.test(n.text)));
const received=list.some(n=>/^已接收 [1-9]\d*$/.test(n.text))?find(n=>n.class==='android.widget.Button'&&n.text.includes('此版本已接收')):null;
let completedReadOnly=false;if(received){tap(received);list=nodes();assert.equal(list.filter(n=>n.class==='android.widget.EditText').length,0);assert.ok(list.some(n=>n.text==='編輯記錄'));completedReadOnly=true;tap(list.find(n=>n.text==='返回'));}
list=nodes();capture('android-home-status.png');
let experience=false,deletion=false,longList=false;
if(process.argv.includes('--experience')||process.argv.includes('--delete')){
  const initialTotal=total(list);tap(list.find(n=>n.text==='新增筆記'));await wait(300);list=nodes();
  const edit=list.filter(n=>n.class==='android.widget.EditText').at(-1);assert.ok(edit);tap(edit);run(['shell','input','text','IGEXPERIENCE20261031']);await wait(1200);list=nodes();
  assert.ok(list.some(n=>n.class==='android.widget.EditText'&&n.text==='IGEXPERIENCE20261031'));footer(list);capture('android-experience-keyboard.png');
  tap(list.find(n=>n.text==='返回'));list=nodes();assert.ok(total(list));
  const saved=find(n=>n['content-desc']==='開啟記錄：IGEXPERIENCE20261031');assert.ok(saved,'Saved draft must appear directly on home');tap(saved);
  assert.ok(nodes().some(n=>n.class==='android.widget.EditText'&&n.text==='IGEXPERIENCE20261031'));
  tap(nodes().find(n=>n.text==='更多'));tap(nodes().find(n=>n.text==='刪除此記錄'));list=nodes();assert.ok(list.some(n=>n.text.includes('尚未確認傳到電腦')));tap(list.find(n=>n.text==='取消'));
  assert.ok(nodes().some(n=>n.class==='android.widget.EditText'&&n.text==='IGEXPERIENCE20261031'));
  tap(nodes().find(n=>n.text==='返回'));run(['shell','am','force-stop',pkg]);run(['shell','am','start','-n',activity]);await wait(400);
  const restored=find(n=>n['content-desc']==='開啟記錄：IGEXPERIENCE20261031');assert.ok(restored,'Draft must survive process restart');tap(restored);await removeCurrent();assert.equal(total(nodes()),initialTotal);experience=true;deletion=true;
}
if(process.argv.includes('--layout')){
  const item=find(n=>n['content-desc']==='開啟記錄：IGLAYOUT20261031');assert.ok(item,'Run the synthetic long-list fixture preparation first');tap(item);list=nodes();footer(list);
  tap(list.filter(n=>n.class==='android.widget.EditText').at(-1));await wait(200);list=nodes();footer(list);capture('android-experience-long-list.png');
  await removeCurrent();longList=true;
}
console.log(JSON.stringify({directRecordList:true,completedRecordReadOnly:completedReadOnly,syntheticDraftReopenAndRestart:experience,syntheticDeletionAndCancel:deletion,longListFixedFooter:longList,screenshot:'artifacts/android-home-status.png'}));
