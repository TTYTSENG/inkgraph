import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { AppError } from './store.mjs';

export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const SHA=/^[a-f0-9]{64}$/;
export async function fileHash(path){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}
export function safeFile(root,relative){
  if(typeof relative!=='string'||relative.includes('\\')||relative.includes('\0')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw new AppError('無效的附件路徑');
  const result=resolve(root,relative);if(!result.startsWith(resolve(root)+sep))throw new AppError('附件路徑超出研究庫');return result;
}
export function externalPath(store,file){if(!file?.path)throw new AppError('找不到外部附件');return safeFile(store.originalsRoot,file.path);}
export async function receiveFile(root,input,{limit=256*1024*1024}={}){
  await fs.mkdir(root,{recursive:true});const path=join(root,randomUUID()+'.partial');let size=0;
  try{await pipeline(input,new Transform({transform(chunk,encoding,cb){size+=chunk.length;cb(size>limit?new AppError('傳輸包過大',413):null,chunk);}}),createWriteStream(path,{flags:'wx'}));return path;}catch(e){await fs.rm(path,{force:true});throw e;}
}
export async function inspectZip(path,{maxEntries=10000,maxExpanded=10*1024**3}={}){
  const zip=await new Promise((ok,no)=>yauzl.open(path,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(e,z)=>e?no(new AppError('不是有效的ZIP資料包')):ok(z)));
  const entries=[];let expanded=0;const seen=new Set();
  try{await new Promise((ok,no)=>{zip.on('error',no);zip.on('end',ok);zip.on('entry',entry=>{try{
    const name=entry.fileName;if(seen.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').some(p=>p==='..'||p.includes(':'))||entry.generalPurposeBitFlag&1)throw new AppError('資料包含重複、加密或不安全路徑');
    const mode=entry.externalFileAttributes>>>16;if((mode&0xf000)===0xa000)throw new AppError('資料包不可包含符號連結');
    seen.add(name);expanded+=entry.uncompressedSize;if(entries.length>=maxEntries||expanded>maxExpanded)throw new AppError('資料包解壓後過大或檔案太多');entries.push(entry);zip.readEntry();
  }catch(e){no(e);}});zip.readEntry();});return {zip,entries,expanded};}catch(e){zip.close();throw e;}
}
export const openEntry=(zip,entry)=>new Promise((ok,no)=>zip.openReadStream(entry,(e,s)=>e?no(e):ok(s)));
export async function entryBytes(zip,entry,limit=1024*1024){if(!entry||entry.uncompressedSize>limit)throw new AppError('缺少清單或清單過大');const input=await openEntry(zip,entry),parts=[];let size=0;for await(const p of input){size+=p.length;if(size>limit)throw new AppError('清單過大');parts.push(p);}return Buffer.concat(parts);}
export async function extractChecked(zip,entry,target,expected){
  if(!SHA.test(expected.sha)||!Number.isSafeInteger(expected.size)||expected.size<0||entry.uncompressedSize!==expected.size)throw new AppError('附件大小或校驗欄位錯誤');
  let size=0;const hash=createHash('sha256');await fs.mkdir(dirname(target),{recursive:true});
  await pipeline(await openEntry(zip,entry),new Transform({transform(chunk,encoding,cb){size+=chunk.length;hash.update(chunk);cb(size>expected.size?new AppError('附件超過宣告大小'):null,chunk);}}),createWriteStream(target,{flags:'wx'}));
  if(size!==expected.size||hash.digest('hex')!==expected.sha)throw new AppError('附件雜湊不符，未匯入');
}
export function installOriginal(store,staged,{sha,mime}){
  const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','audio/wav':'wav'})[mime];if(!ext)throw new AppError('不支援的手機附件格式');
  const relative=`${sha.slice(0,2)}/${sha}.${ext}`,path=safeFile(store.originalsRoot,relative);mkdirSync(dirname(path),{recursive:true});
  if(existsSync(path)){const current=createHash('sha256').update(readFileSync(path)).digest('hex');if(current!==sha)throw new AppError('本機原檔校驗失敗，請先檢查研究庫');return {relative,path,created:false};}
  renameSync(staged,path);return {relative,path,created:true};
}
