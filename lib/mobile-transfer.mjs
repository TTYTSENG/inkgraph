import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';
import { importCapture,vaultIdentity } from './mobile-import.mjs';
const exec=promisify(execFile),PACKAGE='app.inkgraph.capture.dev';
export class MobileTransfer {
  constructor(store,{adb=process.env.INKGRAPH_ADB}={}){this.store=store;this.adb=adb;this.busy=false;}
  async run(args,timeout=12000){if(!this.adb)throw new AppError('尚未設定Android USB工具');try{return (await exec(this.adb,args,{windowsHide:true,timeout,maxBuffer:1024*1024})).stdout;}catch(e){throw new AppError('USB操作失敗，請檢查手機解鎖、授權與連線');}}
  async devices(){if(!this.adb)return {configured:false,devices:[]};const raw=await this.run(['devices','-l']);return {configured:true,devices:raw.split(/\r?\n/).filter(s=>/\s(device|unauthorized|offline)(\s|$)/.test(s)).map(s=>{const parts=s.trim().split(/\s+/);return {id:parts[0],state:parts[1],model:parts.find(v=>v.startsWith('model:'))?.slice(6)||'Android手機'};})};}
  async pull(deviceId,{projectId=null}={}){
    if(this.busy)throw new AppError('手機匯入進行中，請稍候',409);const current=await this.devices();if(!current.devices.some(d=>d.id===deviceId&&d.state==='device'))throw new AppError('所選手機未連接或尚未授權');
    this.busy=true;const result=[];
    try{
      const text=await this.run(['-s',deviceId,'shell','find','/sdcard/Download/InkGraph-Capture','-type','f','-name','*.igc']).catch(e=>{throw new AppError('手機尚無可傳輸包；請先在App完成一則筆記');});
      const files=text.split(/\r?\n/).filter(p=>/^\/sdcard\/Download\/InkGraph-Capture\/[a-f0-9-]{36}\/[a-f0-9-]{36}-r\d+\.igc$/.test(p));if(files.length>200)throw new AppError('手機傳輸包超過200份，請分批整理');
      await fs.mkdir(this.store.mobileTempRoot,{recursive:true});
      for(const remote of files){const local=join(this.store.mobileTempRoot,randomUUID()+'.igc');try{await this.run(['-s',deviceId,'pull',remote,local],120000);const stat=await fs.stat(local);if(stat.size>256*1024*1024)throw new AppError('手機資料包過大');const imported=await importCapture(this.store,local,{projectId});let delivered=false;
        try{const encoded=Buffer.from(JSON.stringify(imported.receipt)).toString('base64');await this.run(['-s',deviceId,'shell','am','start','-n',`${PACKAGE}/app.inkgraph.capture.MainActivity`,'--es','inkgraph_receipt_b64',encoded]);delivered=true;}catch{}
        result.push({...imported,receiptDelivered:delivered});
      }finally{await fs.rm(local,{force:true});}}
      const identity=vaultIdentity(this.store);return {results:result,added:result.filter(r=>!r.duplicate).length,duplicates:result.filter(r=>r.duplicate).length,vault:{id:identity.id,name:identity.name,fingerprint:await this.fingerprint(identity.publicKey)}};
    }finally{this.busy=false;}
  }
  async fingerprint(publicKey){const {createHash}=await import('node:crypto');return createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex').slice(0,16);}
}
