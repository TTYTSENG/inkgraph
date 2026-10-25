import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppError } from './store.mjs';

export const providers=['crossref','europepmc','openalex'];
const norm=s=>String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const doi=s=>String(s||'').replace(/^https?:\/\/(dx\.)?doi.org\//i,'').trim().toLowerCase();
const plain=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
export function mergeCandidates(records) {
  const out=[],seen=new Map();
  for(const r of records){
    const title=norm(r.title),authors=(r.authors||[]).map(a=>norm(a.literal||a.family)).join('|');
    const key=doi(r.doi)?`doi:${doi(r.doi)}`:title&&r.year&&authors?`title:${title}:${r.year}:${authors}`:null;
    if(key&&seen.has(key)){const old=seen.get(key);old.foundVia=[...new Set([...old.foundVia,...r.foundVia])];continue;}
    const row={...r,key:`paper${out.length+1}`,doi:doi(r.doi)};out.push(row);if(key)seen.set(key,row);
  }
  return out;
}
export function fetchScholarlyJSON(url,{signal}={}) {
  const host=new URL(url).hostname;
  if(!['api.crossref.org','www.ebi.ac.uk','api.openalex.org'].includes(host))throw new AppError('不支援的文獻來源');
  return new Promise((resolve,reject)=>{
    const proxy=process.env.HTTPS_PROXY||process.env.https_proxy;
    const req=request(url,{agent:proxy?new HttpsProxyAgent(proxy):undefined,signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),headers:{Accept:'application/json','User-Agent':'InkGraph local literature research/0.3'}},res=>{
      let bytes=0;const chunks=[];
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>5_000_000){res.destroy(Error('來源回傳過大'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{
        if(res.statusCode!==200){const err=Error(`HTTP ${res.statusCode}`);err.status=res.statusCode;return reject(err);}
        try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('來源未回傳有效 JSON'));}
      });
    });req.on('error',reject);req.end();
  });
}
function requestPage(provider,query,size,cursor,key) {
  const u=new URL(provider==='crossref'?'https://api.crossref.org/works':provider==='europepmc'?'https://www.ebi.ac.uk/europepmc/webservices/rest/search':'https://api.openalex.org/works');
  if(provider==='crossref'){u.searchParams.set('query',query);u.searchParams.set('rows',size);u.searchParams.set('cursor',cursor||'*');}
  if(provider==='europepmc'){u.searchParams.set('query',query);u.searchParams.set('pageSize',size);u.searchParams.set('format','json');u.searchParams.set('resultType','core');u.searchParams.set('cursorMark',cursor||'*');}
  if(provider==='openalex'){u.searchParams.set('search',query);u.searchParams.set('per_page',size);u.searchParams.set('cursor',cursor||'*');if(key)u.searchParams.set('api_key',key);}
  return u;
}
function pageData(provider,data) {
  const items=provider==='crossref'?data.message?.items:provider==='europepmc'?data.resultList?.result:data.results;
  if(!Array.isArray(items))throw Error('來源回應缺少結果陣列');
  const records=items.map(r=>{
    if(provider==='crossref')return {title:plain(r.title?.[0]),authors:(r.author||[]).map(a=>a.name?{literal:a.name}:{family:a.family||'',given:a.given||''}).filter(a=>a.literal||a.family),year:String((r.published||r.issued)?.['date-parts']?.[0]?.[0]||''),doi:r.DOI,url:r.URL,summary:plain(r.abstract),journal:r['container-title']?.[0]||''};
    if(provider==='europepmc')return {title:plain(r.title),authors:r.authorList?.author?.map(a=>({literal:a.fullName||a.collectiveName||''})).filter(a=>a.literal)||[],year:String(r.pubYear||''),doi:r.doi,url:r.id?`https://europepmc.org/article/${r.source||'MED'}/${encodeURIComponent(r.id)}`:'',summary:plain(r.abstractText),journal:r.journalInfo?.journal?.title||''};
    let summary='';if(r.abstract_inverted_index){const tokens=[];for(const [word,positions]of Object.entries(r.abstract_inverted_index))for(const p of positions)if(Number.isInteger(p)&&p>=0&&p<30000)tokens[p]=word;summary=tokens.join(' ');}
    return {title:plain(r.title),authors:(r.authorships||[]).map(a=>({literal:a.author?.display_name||''})).filter(a=>a.literal),year:String(r.publication_year||''),doi:r.doi,url:r.primary_location?.landing_page_url||r.id||'',summary:plain(summary),journal:r.primary_location?.source?.display_name||''};
  }).filter(r=>r.title).map(r=>({...r,title:r.title.slice(0,500),authors:r.authors.slice(0,200),summary:r.summary.slice(0,6000),url:/^https?:\/\//i.test(r.url||'')?r.url:'',foundVia:[provider]}));
  return {records,count:items.length,next:provider==='crossref'?data.message?.['next-cursor']:provider==='europepmc'?data.nextCursorMark:data.meta?.next_cursor};
}
export class LiteratureSearch {
  constructor(store,{retrieve=fetchScholarlyJSON,key=process.env.OPENALEX_API_KEY||'',wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){this.store=store;this.retrieve=retrieve;this.key=key;this.wait=wait;this.jobs=new Map();}
  cancel(id){this.jobs.get(id)?.abort();return {cancelled:this.jobs.has(id)};}
  async run(input) {
    const {query}=input;
    if(typeof query!=='string'||!query.trim()||query.length>300)throw new AppError('請輸入 1 至 300 字研究問題或關鍵詞');
    const selected=input.providers||providers;if(!Array.isArray(selected)||!selected.length||selected.some(p=>!providers.includes(p)))throw new AppError('請選擇有效文獻來源');
    const size=Math.floor(Math.max(1,Math.min(25,Number(input.pageSize)||10))),pages=Math.floor(Math.max(1,Math.min(5,Number(input.pages)||1)));
    const id=input.id||randomUUID();if(!/^[a-zA-Z0-9-]{1,80}$/.test(id)||this.jobs.has(id))throw new AppError('搜尋工作代號無效或重複');
    if(this.jobs.size>=3)throw new AppError('已有三項搜尋進行中，請稍後再試',429);
    const controller=new AbortController();this.jobs.set(id,controller);
    const at=new Date().toISOString(),logs=[],records=[];
    try{
      await Promise.all([...new Set(selected)].map(async provider=>{
        let cursor='',stop='page_limit',pageCount=0,retries=0,error='';
        for(let page=1;page<=pages;page++){
          if(controller.signal.aborted){stop='cancelled';break;}
          if(provider==='openalex'&&page>1&&!this.key){stop='key_required';break;}
          let data;
          for(let attempt=0;attempt<2;attempt++){
            try{data=await this.retrieve(requestPage(provider,query.trim(),size,cursor,this.key),{signal:controller.signal});break;}
            catch(e){error=e.status?`HTTP ${e.status}`:e.name==='TimeoutError'?'timeout':e.name==='AbortError'?'cancelled':'來源連線或格式失敗';
              if(attempt===0&&[429,500,502,503,504].includes(e.status)&&!controller.signal.aborted){retries++;await this.wait(1000);continue;}
              break;
            }
          }
          if(!data){stop=controller.signal.aborted?'cancelled':'unavailable';break;}
          try{
            const result=pageData(provider,data);records.push(...result.records);pageCount++;error='';
            if(result.count<size||!result.next||result.next===cursor){stop='exhausted';break;}
            cursor=result.next;
          }catch{error='來源格式不符';stop='unavailable';break;}
        }
        logs.push({provider,pages:pageCount,pageSize:size,stop,retries,error});
      }));
      const candidates=mergeCandidates(records).slice(0,375);
      const result={id,query:query.trim(),at,finishedAt:new Date().toISOString(),logs,candidates,cancelled:controller.signal.aborted};
      this.store.save('search-run',{title:query.trim(),...result},id);
      return result;
    }finally{this.jobs.delete(id);}
  }
  history(){return this.store.db.prepare("SELECT id,json_extract(data,'$.query') AS query,json_extract(data,'$.at') AS at FROM entities WHERE kind='search-run' ORDER BY created DESC LIMIT 30").all();}
  result(id){const r=this.store.get(id);if(r?.kind!=='search-run')throw new AppError('找不到搜尋紀錄',404);return r;}
  bundle(id,keys){
    const run=this.result(id);if(!Array.isArray(keys)||!keys.length||keys.length>375||keys.some(k=>typeof k!=='string'||!run.candidates.some(r=>r.key===k)))throw new AppError('請勾選有效的候選文獻');
    return {format:'light-inkgraph',version:1,sources:run.candidates.filter(r=>keys.includes(r.key)).map(({foundVia,...r})=>({...r,verification:'UNRESOLVED',evidence:{provider:foundVia.join('、'),readLevel:r.summary?'abstract':'metadata',checkedAt:run.at,url:r.url,note:`檢索：${run.query}\n工作：${run.id}\n發現途徑：${foundVia.join('、')}\n停止紀錄：${JSON.stringify(run.logs)}`}})),notes:[],annotations:[],relations:[]};
  }
}
