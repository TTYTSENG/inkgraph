import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { AppError } from './store.mjs';
import { canonicalURL } from './web-research.mjs';
import { notebookURL,managedTitle } from './notebook-browser.mjs';

export const extensionIdOK=id=>typeof id==='string'&&/^[a-p]{32}$/.test(id);
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export class ExtensionBridge {
  constructor(store,{now=()=>Date.now()}={}){this.store=store;this.now=now;this.connection=null;this.jobs=new Map();this.timer=setInterval(()=>this.expire(),5000);this.timer.unref();}
  pair(id){
    if(!extensionIdOK(id))throw new AppError('無效的擴充功能識別碼');
    this.failPending('擴充功能已重新連接，請重試。');
    const capability=randomBytes(32).toString('hex');this.connection={id,capability,lastSeen:this.now(),notebooks:[]};
    return {capability,message:'墨脈已連接。接著在一般 Chrome 開啟目標 Notebook，點擴充功能連接該筆記本。'};
  }
  authenticate(id,capability){if(!this.connection||this.connection.id!==id||!equal(this.connection.capability,capability))throw new AppError('擴充功能未連接或本機服務已重啟，請在墨脈分頁重新連接。',403);this.connection.lastSeen=this.now();}
  status(){const connected=Boolean(this.connection&&this.now()-this.connection.lastSeen<45000);return {connected,notebooks:connected?this.connection.notebooks:[],message:connected?'一般 Chrome 擴充功能已連線。':'尚未連線。請在一般 Chrome 開啟墨脈，點擴充功能「連接墨脈」。'};}
  poll(notebooks=[]){
    this.connection.lastSeen=this.now();
    this.connection.notebooks=Array.isArray(notebooks)?notebooks.slice(0,20).flatMap(n=>{try{return [{url:notebookURL(n.url),title:String(n.title||'Notebook').slice(0,500)}];}catch{return [];}}):[];
    this.expire();
    const job=[...this.jobs.values()].find(j=>j.status==='queued'&&(j.type!=='sync'||this.connection.notebooks.some(n=>n.url===j.payload.notebook)));
    if(!job)return {job:null};
    job.status='running';job.startedAt=this.now();job.lease=randomBytes(24).toString('hex');
    return {job:{id:job.id,type:job.type,lease:job.lease,payload:job.payload}};
  }
  create(type,payload,timeout=90000){
    if(!this.status().connected)throw new AppError('請先在一般 Chrome 用擴充功能連接墨脈。',409);
    this.expire();if([...this.jobs.values()].filter(j=>['queued','running'].includes(j.status)).length>=12)throw new AppError('待辦工作過多，請等目前工作結束。',409);
    const job={id:randomUUID(),type,payload,status:'queued',createdAt:this.now(),deadline:this.now()+timeout};this.jobs.set(job.id,job);return job;
  }
  async request(type,payload){
    const job=this.create(type,payload);
    return new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
  }
  async retrieveArticle(url){return this.request('retrieve',{url:canonicalURL(url)});}
  async searchArticles(query){return this.request('search',{query:String(query).slice(0,400)});}
  sync(ids,target,{replace=false}={}){
    const notebook=notebookURL(target);
    if(!this.status().notebooks.some(n=>n.url===notebook))throw new AppError('請在目標 Notebook 分頁點擴充功能「連接這本筆記本」。',409);
    if(!Array.isArray(ids)||!ids.length||ids.length>11||new Set(ids).size!==ids.length)throw new AppError('請勾選 1 至 11 筆不同的網頁來源');
    if([...this.jobs.values()].some(j=>j.type==='sync'&&['queued','running'].includes(j.status)))throw new AppError('另一批上傳正在進行，請稍候。',409);
    const sources=ids.map(id=>{
      const s=this.store.get(id);if(s?.kind!=='source'||s.origin!=='web'||typeof s.text!=='string'||!s.fileHash)throw new AppError('只能同步已擷取的網頁來源');
      const old=s.notebookSync?.[notebook];const title=managedTitle(s);
      return {id:s.id,title:s.title,name:title,hash:s.fileHash,text:s.text,outdated:[...new Set([old?.title,...(old?.pendingCleanupTitles||[]),old?.pendingCleanup].filter(t=>t&&t!==title))]};
    });
    const job=this.create('sync',{notebook,sources,replace},25*60*1000);return {queued:true,jobId:job.id};
  }
  jobStatus(id){this.expire();const j=this.jobs.get(id);if(!j)throw new AppError('找不到這批工作；服務可能已重啟。',404);return {jobId:j.id,status:j.status,results:j.results||[],message:j.error||''};}
  complete(id,lease,result){
    const j=this.jobs.get(id);if(!j||j.status!=='running'||!equal(j.lease,lease))throw new AppError('工作已過期或回報憑證無效。',409);
    if(this.now()>j.deadline){this.expire();throw new AppError('工作已逾時，請重試。',409);}
    if(result?.error){this.fail(j,String(result.error).slice(0,700));return {ok:true};}
    if(j.type==='retrieve'){
      if(typeof result?.html!=='string'||Buffer.byteLength(result.html)>8*1024*1024||new URL(canonicalURL(result.url)).hostname!==new URL(j.payload.url).hostname)throw new AppError('文章回報格式、大小或網站不符');
      j.resolve?.({html:result.html,url:canonicalURL(result.url)});
    }else if(j.type==='search'){
      if(!Array.isArray(result?.links)||result.links.length>500)throw new AppError('搜尋回報格式錯誤');
      j.resolve?.(result.links.filter(x=>typeof x?.url==='string'&&typeof x?.title==='string').map(x=>({url:x.url.slice(0,3000),title:x.title.slice(0,500)})));
    }else {
      if(!Array.isArray(result?.results)||result.results.length!==j.payload.sources.length)throw new AppError('逐篇上傳回報不完整');
      const seen=new Set();
      const validated=result.results.map(r=>{
        const s=j.payload.sources.find(s=>s.id===r.sourceId);
        if(!s||seen.has(s.id)||!['uploaded','cleanup_required','failed','skipped'].includes(r.status))throw new AppError('上傳回報來源或狀態不符');seen.add(s.id);
        const pending=(Array.isArray(r.pendingCleanupTitles)?r.pendingCleanupTitles:[]).filter(t=>s.outdated.includes(t));
        if(r.status==='uploaded'&&pending.length)throw new AppError('舊版尚未清理，不能回報完成');
        if(r.status==='cleanup_required'&&!pending.length)throw new AppError('缺少待清理舊版清單');
        return {source:s,report:r,pending};
      });
      j.results=this.store.transaction(()=>validated.map(({source:s,report:r,pending})=>{
        if(['uploaded','cleanup_required'].includes(r.status)){
          const current=this.store.get(s.id);if(!current)throw new AppError('本機來源已不存在');
          this.store.save('source',{...current,notebookSync:{...current.notebookSync,[j.payload.notebook]:{title:s.name,hash:s.hash,uploadedAt:new Date(this.now()).toISOString(),status:r.status,pendingCleanup:pending[0]||'',pendingCleanupTitles:pending,verification:'一般 Chrome 擴充功能已確認來源名稱出現在頁面；索引需在 Google 核對'}}},s.id);
        }
        return {sourceId:s.id,title:s.title,status:r.status,message:String(r.message||'').slice(0,700)};
      }));
    }
    j.status='done';delete j.payload;delete j.resolve;delete j.reject;delete j.lease;return {ok:true};
  }
  fail(j,error){j.status='failed';j.error=error;j.reject?.(new AppError(error,502));delete j.resolve;delete j.reject;delete j.payload;delete j.lease;}
  expire(){for(const [id,j] of this.jobs){if(['queued','running'].includes(j.status)&&this.now()>j.deadline)this.fail(j,'擴充功能工作逾時。請保持一般 Chrome 的墨脈與已連接 Notebook 分頁開啟，再重試。');if(this.now()-j.createdAt>60*60*1000)this.jobs.delete(id);}}
  failPending(message){for(const j of this.jobs.values())if(['queued','running'].includes(j.status))this.fail(j,message);}
  close(){clearInterval(this.timer);this.failPending('本機服務已關閉，請重新連接。');return Promise.resolve();}
}
