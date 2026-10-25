import { ZipArchive } from 'archiver';
import { Readable } from 'node:stream';
import { promises as fs,createReadStream,readFileSync,existsSync,renameSync,mkdirSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError,validateEntity,KINDS,hash } from './store.mjs';
import { restore as restoreLegacy,markdown } from './exports.mjs';
import { inspectZip,entryBytes,extractChecked,externalPath,safeFile,SHA,UUID } from './mobile-files.mjs';

export function hasMobileData(store){return Boolean(store.db.prepare('SELECT id FROM external_attachments LIMIT 1').get()||store.db.prepare('SELECT capture_id FROM mobile_captures LIMIT 1').get());}
export function backupStream(store){
  const manifest=store.transaction(()=>({format:'inkgraph',version:5,exported:new Date().toISOString(),entities:store.list(),
    attachments:[...store.db.prepare('SELECT id,source_id,name,mime,sha,length(bytes) size FROM attachments').all().map(f=>({...f,storage:'blob'})),...store.db.prepare('SELECT * FROM external_attachments').all().map(f=>({...f,storage:'external'}))],
    mobile:{meta:store.db.prepare('SELECT * FROM mobile_meta').all(),captures:store.db.prepare('SELECT * FROM mobile_captures').all(),jobs:store.db.prepare('SELECT * FROM media_jobs').all()}}));
  const encoded=JSON.stringify(manifest);if(Buffer.byteLength(encoded)>32*1024*1024)throw new AppError('備份清單超過32MB，請先分庫備份');
  const archive=new ZipArchive({zlib:{level:4},forceZip64:true});archive.on('warning',e=>archive.destroy(e));archive.append(encoded,{name:'manifest.json'});archive.append(markdown(manifest.entities),{name:'research.md'});
  for(const file of manifest.attachments){
    if(file.storage==='external')archive.file(externalPath(store,file),{name:`attachments/${file.id}`});
    else archive.append(Readable.from((async function*(){let offset=1;while(offset<=file.size){const row=store.db.prepare('SELECT substr(bytes,?,?) chunk FROM attachments WHERE id=?').get(offset,64*1024,file.id);if(!row?.chunk?.length)throw new AppError('備份期間附件已移除，請重試');yield Buffer.from(row.chunk);offset+=row.chunk.length;}})()),{name:`attachments/${file.id}`});
  }
  return archive;
}
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([k])=>k!=='projectIds').sort(([a],[b])=>a.localeCompare(b))));
export async function restoreMobileFile(store,path){
  const stage=join(store.mobileTempRoot,'restore-'+randomUUID()),moved=[];await fs.mkdir(stage,{recursive:true});let zip;
  try{
    const inspected=await inspectZip(path);zip=inspected.zip;const entries=inspected.entries.filter(e=>!e.fileName.endsWith('/')),mf=await entryBytes(zip,entries.find(e=>e.fileName==='manifest.json'),32*1024*1024);let manifest;try{manifest=JSON.parse(mf);}catch{throw new AppError('備份清單不是有效JSON');}
    if(manifest.version!==5){zip.close();zip=null;const size=(await fs.stat(path)).size;if(size>250*1024*1024)throw new AppError('舊版備份超過250MB');return restoreLegacy(store,await fs.readFile(path));}
    if(manifest.format!=='inkgraph'||!Array.isArray(manifest.entities)||!Array.isArray(manifest.attachments)||!manifest.mobile||!['meta','captures','jobs'].every(k=>Array.isArray(manifest.mobile[k])))throw new AppError('第5版備份格式錯誤');
    const byId=new Map();for(const row of manifest.entities){if(!row||!UUID.test(row.id)||!KINDS.includes(row.kind)||byId.has(row.id))throw new AppError('備份項目身份無效');byId.set(row.id,row);}
    for(const row of byId.values()){validateEntity(row.kind,row,id=>byId.get(id));const current=store.get(row.id);if(current&&canonical(current)!==canonical(row))throw new AppError('備份與目前研究庫有不同版本，請還原至新的隔離目錄',409);}
    const ids=new Set(),allowed=new Set(['manifest.json','research.md']);for(const f of manifest.attachments){
      if(!UUID.test(f.id)||ids.has(f.id)||byId.get(f.source_id)?.kind!=='source'||!SHA.test(f.sha)||typeof f.name!=='string'||f.name.length>250||typeof f.mime!=='string'||!Number.isSafeInteger(f.size)||f.size<0||f.size>256*1024*1024||!['blob','external'].includes(f.storage))throw new AppError('備份附件清單無效');
      if(f.storage==='external'&&(!/^[a-f0-9]{2}\/[a-f0-9]{64}\.(jpg|png|webp|wav)$/.test(f.path||'')||!f.path.startsWith(`${f.sha.slice(0,2)}/${f.sha}.`)))throw new AppError('外部附件位置無效');
      ids.add(f.id);allowed.add(`attachments/${f.id}`);const existing=store.file(f.id);if(existing&&(existing.sha!==f.sha||existing.source_id!==f.source_id||existing.name!==f.name||existing.mime!==f.mime))throw new AppError('附件與目前版本衝突',409);
      const entry=entries.find(e=>e.fileName===`attachments/${f.id}`);if(!entry)throw new AppError('備份遺失附件');await extractChecked(zip,entry,join(stage,f.id),f);
    }
    if(entries.some(e=>!allowed.has(e.fileName)))throw new AppError('備份含有清單以外的檔案');
    const expectedTables={meta:['key'],captures:['device_id','capture_id','revision'],jobs:['id']};
    for(const [group,keys] of Object.entries(expectedTables)){const seen=new Set();for(const row of manifest.mobile[group]){if(!row||typeof row!=='object'||keys.some(k=>row[k]==null))throw new AppError('手機備份索引無效');const key=keys.map(k=>row[k]).join(':');if(seen.has(key))throw new AppError('手機備份索引重複');seen.add(key);
      if(group==='jobs'&&(byId.get(row.source_id)?.kind!=='source'||!['ocr','asr'].includes(row.kind)||!['queued','running','done','failed','cancelled'].includes(row.state)))throw new AppError('辨識工作參照錯誤');
      if(group==='captures'&&(!UUID.test(row.device_id)||!UUID.test(row.capture_id)||!Number.isInteger(row.revision)||row.revision<1||!SHA.test(row.digest)))throw new AppError('手機記錄索引無效');
      const table={meta:'mobile_meta',captures:'mobile_captures',jobs:'media_jobs'}[group],where=keys.map(k=>`${k}=?`).join(' AND '),existing=store.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...keys.map(k=>row[k]));if(existing&&canonical(existing)!==canonical(row))throw new AppError('手機索引已有不同版本，請還原至新目錄',409);
    }}
    for(const f of manifest.attachments.filter(f=>f.storage==='external')){const final=safeFile(store.originalsRoot,f.path);mkdirSync(dirname(final),{recursive:true});if(existsSync(final)){if(hash(readFileSync(final))!==f.sha)throw new AppError('還原目標原始檔校驗失敗');}else{renameSync(join(stage,f.id),final);moved.push(final);}}
    return store.transaction(()=>{
      let added=0;for(const row of manifest.entities){if(store.get(row.id))continue;const {id,kind,created,updated,revision,projectIds,...data}=row;store.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?,?)').run(id,kind,JSON.stringify(data),created,updated,revision);added++;}
      for(const f of manifest.attachments){if(store.file(f.id))continue;if(f.storage==='blob')store.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(f.id,f.source_id,f.name,f.mime,f.sha,readFileSync(join(stage,f.id)));else store.db.prepare('INSERT INTO external_attachments VALUES (?,?,?,?,?,?,?,?)').run(f.id,f.source_id,f.name,f.mime,f.sha,f.size,f.path,f.created||manifest.exported);}
      for(const row of manifest.mobile.meta)store.db.prepare('INSERT OR IGNORE INTO mobile_meta VALUES (?,?)').run(row.key,row.value);
      for(const row of manifest.mobile.captures)store.db.prepare('INSERT OR IGNORE INTO mobile_captures VALUES (?,?,?,?,?,?,?,?)').run(row.device_id,row.capture_id,row.revision,row.digest,row.note_id,row.manifest,row.receipt,row.received);
      for(const row of manifest.mobile.jobs)store.db.prepare('INSERT OR IGNORE INTO media_jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.source_id,row.kind,row.state==='running'?'queued':row.state,row.settings,row.result,row.error,row.created,row.updated,row.attempts);
      return {added,skipped:manifest.entities.length-added,version:5};
    });
  }catch(e){for(const path of moved){const relative=path.slice(store.originalsRoot.length+1).replaceAll('\\','/');if(!store.db.prepare('SELECT id FROM external_attachments WHERE path=?').get(relative))await fs.rm(path,{force:true});}throw e;}
  finally{zip?.close();await fs.rm(stage,{recursive:true,force:true});}
}
