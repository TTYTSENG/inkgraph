import { spawn } from 'node:child_process';
import { existsSync,readFileSync,mkdirSync,statSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { externalPath,fileHash } from './mobile-files.mjs';
import { AppError } from './store.mjs';

export class MediaJobs {
  constructor(store,{python=process.env.INKGRAPH_MEDIA_PYTHON,models=process.env.INKGRAPH_MEDIA_MODELS,worker=fileURLToPath(new URL('../workers/media_worker.py',import.meta.url)),autoStart=true}={}){
    this.store=store;this.python=python;this.models=models;this.worker=worker;this.current=null;this.closing=false;this.autoStart=autoStart;
    this.paused=store.db.prepare("SELECT value FROM mobile_meta WHERE key='paused'").get()?.value==='true';
    store.db.prepare("UPDATE media_jobs SET state='queued',error='上次辨識中斷，已重新排隊' WHERE state='running'").run();
    if(autoStart)setImmediate(()=>this.kick());
  }
  list(){return this.store.db.prepare('SELECT id,source_id,kind,state,error,created,updated,attempts,settings,result FROM media_jobs ORDER BY created DESC LIMIT 200').all().map(r=>{const result=r.result?JSON.parse(r.result):null;return {...r,settings:JSON.parse(r.settings),result:result?{engine:result.engine,version:result.version,text:result.text?.slice(0,1500)||'',elapsedSeconds:result.elapsedSeconds,peakRssBytes:result.peakRssBytes}:null};});}
  status(){return {configured:Boolean(this.python&&this.models&&existsSync(this.python)),paused:this.paused,running:this.current?.id||null,jobs:this.list()};}
  pause(value){this.paused=Boolean(value);this.store.db.prepare("INSERT INTO mobile_meta VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.paused));if(!this.paused)this.kick();return this.status();}
  retry(id){const row=this.store.db.prepare('SELECT * FROM media_jobs WHERE id=?').get(id);if(!row||!['failed','cancelled'].includes(row.state))throw new AppError('找不到可重試的工作');if(row.attempts>=3)throw new AppError('此工作已嘗試3次；請檢查環境後從原始附件另建辨識工作');this.store.db.prepare("UPDATE media_jobs SET state='queued',error='',updated=? WHERE id=?").run(new Date().toISOString(),id);this.kick();}
  reprocess(sourceId,model='base'){const source=this.store.get(sourceId);if(!source?.mobileMedia||!['base','small'].includes(model))throw new AppError('請選擇手機原始媒體與可用模型');const id=randomUUID(),now=new Date().toISOString();this.store.db.prepare('INSERT INTO media_jobs VALUES (?,?,?,?,?,?,?,?,?,0)').run(id,sourceId,source.mobileMedia.type==='audio'?'asr':'ocr','queued',JSON.stringify({model,rawSha:source.fileHash}),null,'',now,now);this.kick();return {id};}
  cancel(id){this.store.db.prepare("UPDATE media_jobs SET state='cancelled',error='已取消辨識，原檔保留',updated=? WHERE id=? AND state IN ('queued','running')").run(new Date().toISOString(),id);if(this.current?.id===id)this.current.child?.kill();}
  async kick(){
    if(this.closing||this.paused||this.current||!this.python||!this.models)return;
    const row=this.store.db.prepare("SELECT * FROM media_jobs WHERE state='queued' ORDER BY created,id LIMIT 1").get();if(!row)return;
    this.current={id:row.id,child:null};this.store.db.prepare("UPDATE media_jobs SET state='running',attempts=attempts+1,error='',updated=? WHERE id=?").run(new Date().toISOString(),row.id);
    try{
      const source=this.store.get(row.source_id),meta=this.store.attachment(row.source_id),file=meta&&this.store.file(meta.id);if(!source||!file?.path)throw new AppError('找不到手機原始附件');
      const input=externalPath(this.store,file);if(await fileHash(input)!==file.sha)throw new AppError('原始附件校驗失敗');
      const resultPath=join(this.store.mobileTempRoot,'results',row.id+'.json');mkdirSync(dirname(resultPath),{recursive:true});
      const settings=JSON.parse(row.settings),args=[this.worker,'--models',this.models,'--kind',row.kind,'--model',settings.model||'base','--input',input,'--output',resultPath];let stderr='';
      const outcome=await new Promise((ok,no)=>{
        const child=spawn(this.python,args,{windowsHide:true,env:{...process.env,OMP_NUM_THREADS:'4',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});this.current.child=child;
        const timer=setTimeout(()=>{child.kill();no(new AppError('辨識超過20分鐘，已停止；原檔保留'));},20*60*1000);timer.unref();
        child.stdout.on('data',()=>{});child.stderr.on('data',b=>{stderr=(stderr+b.toString('utf8')).slice(-2000);});child.once('error',e=>{clearTimeout(timer);no(new AppError('辨識環境無法啟動：'+e.message));});child.once('close',code=>{clearTimeout(timer);ok(code);});
      });
      if(this.closing)return;const current=this.store.db.prepare('SELECT state FROM media_jobs WHERE id=?').get(row.id);if(!current||current.state==='cancelled')return;
      let result;try{if(statSync(resultPath).size>2*1024*1024)throw Error();result=JSON.parse(readFileSync(resultPath,'utf8'));}catch{throw new AppError('辨識程序未傳回有效結果'+(stderr?'；請檢查專用環境':''));}
      if(outcome!==0||result.error)throw new AppError(result.error||'辨識失敗，原檔保留');if(typeof result.text!=='string'||result.text.length>1000000)throw new AppError('辨識結果格式無效');
      if(await fileHash(input)!==file.sha)throw new AppError('處理期間原檔已變更，結果未採用');
      result={...result,sourceSha:file.sha,completedAt:new Date().toISOString(),verified:false};
      this.store.transaction(()=>{this.store.db.prepare("UPDATE media_jobs SET state='done',result=?,updated=? WHERE id=?").run(JSON.stringify(result),new Date().toISOString(),row.id);const fresh=this.store.get(row.source_id);if(fresh&&!fresh.text)this.store.save('source',{...fresh,text:result.text,recognitionResultId:row.id,parseStatus:result.text?'已辨識，待核對':'未辨識到內容，請核對原檔'},fresh.id);});
    }catch(error){if(!this.closing)this.store.db.prepare("UPDATE media_jobs SET state='failed',error=?,updated=? WHERE id=? AND state='running'").run(String(error.message||error).slice(0,700),new Date().toISOString(),row.id);}
    finally{this.current=null;if(!this.closing)setImmediate(()=>this.kick());}
  }
  close(){this.closing=true;if(this.current){this.store.db.prepare("UPDATE media_jobs SET state='queued',error='服務重新啟動後可重試' WHERE id=? AND state='running'").run(this.current.id);this.current.child?.kill();}}
}

export function resultExport(store,sourceId,format='json'){
  const row=store.db.prepare("SELECT result FROM media_jobs WHERE source_id=? AND state='done' ORDER BY updated DESC,id DESC LIMIT 1").get(sourceId);if(!row)throw new AppError('尚無完成的辨識結果',404);const result=JSON.parse(row.result);
  if(format==='json')return ['application/json; charset=utf-8','recognition.json',JSON.stringify(result,null,2)];
  if(format==='txt')return ['text/plain; charset=utf-8','recognition.txt',result.text];
  if(!['srt','vtt'].includes(format)||!Array.isArray(result.segments))throw new AppError('此辨識結果沒有音訊時間碼');
  const stamp=(value,separator)=>{let ms=Math.max(0,Math.round(value*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;};
  const sep=format==='srt'?',':'.',body=(format==='vtt'?'WEBVTT\n\n':'')+result.segments.map((s,i)=>`${format==='srt'?`${i+1}\n`:''}${stamp(s.start,sep)} --> ${stamp(s.end,sep)}\n${s.text.trim()}\n`).join('\n');return ['text/plain; charset=utf-8','transcript.'+format,body];
}
