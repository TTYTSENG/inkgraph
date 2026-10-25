import { randomUUID,createHash,generateKeyPairSync,createPrivateKey,sign } from 'node:crypto';
import { promises as fs,readFileSync,openSync,readSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './store.mjs';
import { UUID,SHA,inspectZip,entryBytes,extractChecked,installOriginal,safeFile } from './mobile-files.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=value=>typeof value==='string'&&value.length<80&&/(Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
function location(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!['unknown','captured','pending','denied','disabled','timeout','stale','manual'].includes(value.status))throw new AppError('地點狀態無效');
  if(value.label!=null&&(typeof value.label!=='string'||value.label.length>500))throw new AppError('地點名稱過長');
  if(value.status==='captured'&&(!Number.isFinite(value.lat)||Math.abs(value.lat)>90||!Number.isFinite(value.lon)||Math.abs(value.lon)>180||!Number.isFinite(value.accuracyMeters)||value.accuracyMeters<0||!iso(value.measuredAt)))throw new AppError('定位資料不完整');
}
export function validateCapture(manifest){
  const c=manifest?.capture;if(manifest?.format!=='inkgraph-capture'||manifest.version!==1||!UUID.test(manifest.deviceId)||!c||!UUID.test(c.id)||!Number.isInteger(c.revision)||c.revision<1||c.revision>100000)throw new AppError('手機資料包版本或身份無效');
  if(!iso(c.createdAt)||!iso(c.updatedAt)||!iso(c.completedAt)||typeof c.timezone!=='string'||c.timezone.length>100||!Number.isInteger(c.utcOffsetMinutes)||Math.abs(c.utcOffsetMinutes)>840)throw new AppError('手機時間或時區資料無效');
  try{new Intl.DateTimeFormat('zh-TW',{timeZone:c.timezone});}catch{throw new AppError('找不到手機時區');}
  if(typeof c.text!=='string'||c.text.length>100000||!Array.isArray(c.media)||c.media.length>50||(!c.text.trim()&&!c.media.length))throw new AppError('手機記錄內容無效');
  location(c.location);const ids=new Set();let size=0;
  for(const m of c.media){const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','audio/wav':'wav'})[m.mime];
    if(!UUID.test(m.id)||ids.has(m.id)||!ext||m.file!==`media/${m.id}.${ext}`||!SHA.test(m.sha256)||!Number.isSafeInteger(m.size)||m.size<=0||m.size>25*1024*1024||!iso(m.capturedAt)||typeof m.name!=='string'||m.name.length>250||m.type!==(m.mime==='audio/wav'?'audio':'photo'))throw new AppError('手機附件身份、格式、大小或時間錯誤');
    if(m.type==='audio'&&(!Number.isFinite(m.durationMs)||m.durationMs<=0||m.durationMs>600000||!Number.isFinite(m.offsetMs)||m.offsetMs<0))throw new AppError('錄音長度或片段位置無效');
    if(m.location)location(m.location);ids.add(m.id);size+=m.size;
  }
  if(size>200*1024*1024)throw new AppError('單則記錄附件總量超過200MB');return c;
}
function verifyMagic(path,mime){const header=Buffer.alloc(12),fd=openSync(path,'r');try{readSync(fd,header,0,12,0);}finally{closeSync(fd);}
  const valid=mime==='image/jpeg'?header[0]===255&&header[1]===216&&header[2]===255:mime==='image/png'?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/webp'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP':header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WAVE';if(!valid)throw new AppError('附件實際內容與格式不符');
}
export function vaultIdentity(store){let row=store.db.prepare("SELECT value FROM mobile_meta WHERE key='identity'").get();if(row)return JSON.parse(row.value);
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1',publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}),identity={id:randomUUID(),name:'墨脈 USB 測試研究庫',publicKey:keys.publicKey.toString('base64'),privateKey:keys.privateKey};
  store.db.prepare("INSERT INTO mobile_meta VALUES ('identity',?)").run(JSON.stringify(identity));return identity;
}
export function receiptFor(store,manifest,digestValue,noteId){const identity=vaultIdentity(store),payload=Buffer.from(JSON.stringify({deviceId:manifest.deviceId,captureId:manifest.capture.id,revision:manifest.capture.revision,digest:digestValue,noteId,vaultId:identity.id,vaultName:identity.name,receivedAt:new Date().toISOString(),mediaShas:manifest.capture.media.map(m=>m.sha256)}));return {format:'inkgraph-receipt',version:1,publicKey:identity.publicKey,payload:payload.toString('base64'),signature:sign('sha256',payload,identity.privateKey).toString('base64')};}
export async function importCapture(store,path,{projectId=null}={}){
  if(projectId&&store.get(projectId)?.kind!=='project')throw new AppError('找不到所選專案');
  const staged=join(store.mobileTempRoot,randomUUID()),installed=[];await fs.mkdir(staged,{recursive:true});let zip;
  try{
    const inspected=await inspectZip(path,{maxEntries:102,maxExpanded:201*1024*1024});zip=inspected.zip;const entries=inspected.entries.filter(e=>!e.fileName.endsWith('/'));
    const bytes=await entryBytes(zip,entries.find(e=>e.fileName==='manifest.json'),512*1024);let manifest;try{manifest=JSON.parse(bytes);}catch{throw new AppError('手機清單不是有效JSON');}
    const capture=validateCapture(manifest),key=[manifest.deviceId,capture.id,capture.revision],hash=digest(bytes),allowed=new Set(['manifest.json',...capture.media.map(m=>m.file)]);
    if(entries.length!==allowed.size||entries.some(e=>!allowed.has(e.fileName)))throw new AppError('資料包檔案清單不符');
    for(const m of capture.media){const file=join(staged,m.id);await extractChecked(zip,entries.find(e=>e.fileName===m.file),file,{sha:m.sha256,size:m.size});verifyMagic(file,m.mime);}
    const previous=store.db.prepare('SELECT * FROM mobile_captures WHERE device_id=? AND capture_id=? AND revision=?').get(...key);
    if(previous){if(previous.digest!==hash)throw new AppError('同一手機記錄版本出現不同內容，未覆寫',409);return {duplicate:true,noteId:previous.note_id,receipt:JSON.parse(previous.receipt)};}
    const mediaFiles=capture.media.map(m=>{const f=installOriginal(store,join(staged,m.id),{sha:m.sha256,mime:m.mime});if(f.created)installed.push(f.path);return {m,f};});
    return store.transaction(()=>{
      const sourceIds=[];
      for(const {m,f} of mediaFiles){
        let source=store.list().find(r=>r.kind==='source'&&r.mobileMedia?.deviceId===manifest.deviceId&&r.mobileMedia.mediaId===m.id&&r.fileHash===m.sha256);
        if(!source){source=store.save('source',{title:`手機${m.type==='audio'?'錄音':'照片'} · ${m.capturedAt}`,authors:[],origin:'mobile-capture',cslType:'personal-communication',text:'',pages:[],mime:m.mime,fileHash:m.sha256,projectId,parseStatus:'等待本地辨識',warnings:['機器辨識內容待人工核對'],mobileMedia:{deviceId:manifest.deviceId,mediaId:m.id,...m}});
          const fileId=randomUUID();store.db.prepare('INSERT INTO external_attachments VALUES (?,?,?,?,?,?,?,?)').run(fileId,source.id,m.name,m.mime,m.sha256,m.size,f.relative,new Date().toISOString());
          store.db.prepare('INSERT INTO media_jobs(id,source_id,kind,state,settings,result,error,created,updated,attempts) VALUES (?,?,?,?,?,?,?,?,?,0)').run(randomUUID(),source.id,m.type==='audio'?'asr':'ocr','queued',JSON.stringify({model:'base',rawSha:m.sha256}),null,'',new Date().toISOString(),new Date().toISOString());
        }else if(projectId)store.linkSource(source.id,projectId);
        sourceIds.push(source.id);
      }
      const older=store.db.prepare('SELECT note_id,revision FROM mobile_captures WHERE device_id=? AND capture_id=? ORDER BY revision DESC LIMIT 1').get(manifest.deviceId,capture.id);
      const description=capture.media.map((m,i)=>`- ${m.type==='audio'?'錄音':'照片'} ${i+1} · ${m.capturedAt}${m.type==='audio'?` · ${(m.durationMs/1000).toFixed(1)} 秒`:''} [[連結:${sourceIds[i]}]]`).join('\n');
      const title=capture.text.trim().split('\n')[0].slice(0,60)||`手機隨記 · ${capture.createdAt}`;
      const note=store.save('note',{title,content:`${capture.text}\n\n## 原始附件\n\n${description}`,sourceIds,noteType:'quick',projectId,tags:'手機隨記,待整理',mobileCapture:{deviceId:manifest.deviceId,...capture,receivedAt:new Date().toISOString(),digest:hash}});
      if(older&&store.get(older.note_id))store.save('link',{title:'手機記錄版本',from:note.id,to:older.note_id,relation:'derived',reason:`手機記錄第${capture.revision}版；原有整理內容保留，不自動覆寫`,projectId});
      const receipt=receiptFor(store,manifest,hash,note.id);store.db.prepare('INSERT INTO mobile_captures VALUES (?,?,?,?,?,?,?,?)').run(...key,hash,note.id,JSON.stringify(manifest),JSON.stringify(receipt),new Date().toISOString());
      return {duplicate:false,noteId:note.id,sourceIds,receipt,olderRevision:older?.revision||null};
    });
  }catch(e){for(const path of installed){const relative=path.slice(store.originalsRoot.length+1).replaceAll('\\','/');if(!store.db.prepare('SELECT id FROM external_attachments WHERE path=?').get(relative))await fs.rm(path,{force:true});}throw e;}
  finally{zip?.close();await fs.rm(staged,{recursive:true,force:true});}
}
