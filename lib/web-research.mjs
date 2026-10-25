import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { AppError, hash } from './store.mjs';

export function publicURL(value) {
  let u; try { u = new URL(value); } catch { throw new AppError('請輸入完整的公開 https 網址'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || isIP(u.hostname) || u.hostname.includes(':') || !u.hostname.includes('.') || /\.(local|localhost|internal)$/i.test(u.hostname)) throw new AppError('只接受公開網站的 https 網址');
  return u;
}
export function canonicalURL(value) {
  const u=publicURL(value); u.hash='';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|stcr$|cid$|hlkid$|hctky$|hdpid$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort(); u.pathname=u.pathname.replace(/\/$/,'')||'/'; return u.href;
}
export function privateAddress(a) {
  if (a.includes(':')) return !/^2[0-9a-f]{3}:/i.test(a) || /^2001:(db8|0):/i.test(a);
  const [x,y]=a.split('.').map(Number);
  return x===0||x===10||x===127||x>=224||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&[0,168].includes(y))||(x===100&&y>=64&&y<=127)||(x===198&&[18,19].includes(y));
}
export async function fetchPublic(value) {
  let u=publicURL(value);
  for(let hop=0;hop<6;hop++) {
    let timer;
    const addresses=await Promise.race([lookup(u.hostname,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError('網站 DNS 查詢逾時，請稍後重試')),8000);})]).finally(()=>clearTimeout(timer));
    if(!addresses.length||addresses.some(a=>privateAddress(a.address))) throw new AppError('拒絕存取內部網路位址');
    // Direct requests pin the validated DNS result; an explicitly configured
    // system HTTPS proxy remains responsible for its own destination DNS.
    const proxy=process.env.HTTPS_PROXY||process.env.https_proxy;
    const agent=proxy?new HttpsProxyAgent(proxy):false;
    const pinnedLookup=proxy?undefined:(_host,options,callback)=>{const a=addresses[0];if(options?.all)callback(null,[a]);else callback(null,a.address,a.family);};
    const response=await new Promise((resolve,reject)=>{
      const req=request(u,{agent,signal:AbortSignal.timeout(25000),lookup:pinnedLookup,headers:{'User-Agent':'InkGraph/0.2 (+local personal research)','Accept':'text/html,application/xml,text/xml;q=0.9'}},resolve);
      req.on('error',reject);req.end();
    });
    if([301,302,303,307,308].includes(response.statusCode)){response.destroy();u=publicURL(new URL(response.headers.location,u).href);continue;}
    if(response.statusCode<200||response.statusCode>=300){response.destroy();throw new AppError(`網站回應 HTTP ${response.statusCode}；請在原網站確認是否需要登入`,502);}
    if(!/html|xml|text\/plain/i.test(response.headers['content-type']||'')){response.destroy();throw new AppError('目前僅支援網頁文章，請以文件匯入處理 PDF');}
    let size=0; const chunks=[];
    for await(const chunk of response){size+=chunk.length;if(size>3*1024*1024){response.destroy();throw new AppError('網頁超過 3 MB，請改用文件匯入');}chunks.push(chunk);}
    return {url:u.href,html:Buffer.concat(chunks).toString('utf8')};
  }
  throw new AppError('網站重新導向次數過多');
}
export function parseArticle(html,url) {
  const dom=new JSDOM(html,{url}); const doc=dom.window.document;
  try {
    const meta=key=>doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content||'';
    const published=meta('article:published_time')||meta('date')||doc.querySelector('time[datetime]')?.getAttribute('datetime')||'';
    const links=[...doc.querySelectorAll('a[href]')].map(a=>({url:a.href,title:a.textContent.trim()})).filter(a=>a.title.length>15);
    const article=new Readability(doc.cloneNode(true)).parse();
    if(!article||article.textContent.trim().length<600)throw new AppError('正文不足 600 字元，可能是登入／驗證頁或動態網頁；未儲存為文章');
    if(/access denied|verify you are human|just a moment|sign in to continue/i.test(article.title))throw new AppError('網站需要登入或人工驗證；未儲存為文章');
    const convert=new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced'});convert.use(gfm);convert.remove(['script','style','iframe','form']);
    return {url:canonicalURL(url),title:article.title,byline:article.byline||meta('author'),published,markdown:convert.turndown(article.content),text:article.textContent.trim(),links,warnings:['正文由自動擷取產生，請核對章節、表格與結尾；圖片圖表未轉成文字。']};
  }finally{dom.window.close();}
}
const stop=new Set('the a an of and or to for in on at with from how what why must not is are be as by this that your our their can do'.split(' '));
export function keywords(value){return [...new Set((value.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]{2,}/g)||[]).filter(s=>!stop.has(s)).map(s=>s.replace(/(ies|ing|es|s)$/,'')).filter(s=>s.length>2))];}
export function rankCandidates(seed,candidates,topic='') {
  const terms=keywords(topic||seed.title),host=new URL(seed.url).hostname.replace(/^www\./,'');const seen=new Set([canonicalURL(seed.url)]),out=[];
  for(const c of candidates){let url;try{url=canonicalURL(c.url);}catch{continue;}const u=new URL(url);if(u.hostname.replace(/^www\./,'')!==host||seen.has(url)||/\.(pdf|jpg|png|zip)$/i.test(u.pathname)||!c.title||c.title.length<15)continue;seen.add(url);
    const words=keywords(c.title+' '+u.pathname.replace(/-/g,' '));const matches=terms.filter(t=>words.includes(t));if(!matches.length)continue;
    out.push({url,title:c.title.slice(0,500),score:matches.length,reason:`關鍵詞相符：${matches.join('、')}（非 AI 判定）`});
  }
  return out.sort((a,b)=>b.score-a.score).slice(0,10);
}
export function markdownDocument(a,when) {return `# ${a.title}\n\n來源：${a.url}\n\n作者：${a.byline||'未提供'}\n\n發布日期：${a.published||'未提供'}\n\n擷取時間：${when}\n\n---\n\n${a.markdown}\n`;}
export class WebResearch {
  constructor(store,{retrieve=fetchPublic,search}={}){this.store=store;this.retrieve=retrieve;this.search=search;}
  async discover(url,topic='') {
    const page=await this.retrieve(canonicalURL(url));const seed=parseArticle(page.html,page.url);let candidates=[...seed.links],warnings=[];
    try{
      const query=`site:${new URL(seed.url).hostname} ${(topic||seed.title).slice(0,180)}`;
      if(this.search)candidates.push(...await this.search(query));
      else {
        const rss=await this.retrieve(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`);
        const dom=new JSDOM(rss.html,{contentType:'text/xml'});
        candidates.push(...[...dom.window.document.querySelectorAll('item')].map(n=>({url:n.querySelector('link')?.textContent,title:n.querySelector('title')?.textContent})));dom.window.close();
      }
    }catch{warnings.push('搜尋引擎暫時無法使用，目前只從起始頁的同站連結篩選。');}
    const articles=rankCandidates(seed,candidates,topic);
    if(!articles.length)warnings.push('未找到有關鍵詞交集的同站文章；可修改搜尋主題，或另外貼入相關文章網址。');
    return {seed:{url:seed.url,title:seed.title},articles,warnings};
  }
  async capture(url,projectId=null) {
    const page=await this.retrieve(canonicalURL(url));const a=parseArticle(page.html,page.url);const when=new Date().toISOString(),digest=hash(Buffer.from(a.markdown));
    return this.store.transaction(()=>{
      const old=this.store.list().find(s=>s.kind==='source'&&s.origin==='web'&&s.url===a.url);
      const doc=markdownDocument(a,when);const versionId=randomUUID();
      const name=`${a.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,75)}--${versionId.slice(0,8)}.md`;
      const saved=this.store.save('source',{...(old||{}),title:a.title,authors:old?.authors?.length?old.authors:a.byline?[{literal:a.byline}]:[],year:old?.year||a.published.match(/^\d{4}/)?.[0]||'',projectId:old?old.projectId:projectId,cslType:'webpage',origin:'web',url:a.url,text:doc,pages:[],mime:'text/markdown',fileHash:digest,warnings:a.warnings,parseStatus:'網頁擷取，待人工核對',webVersions:[...(old?.webVersions||[]),{id:versionId,capturedAt:when,hash:digest,name}],notebookSync:old?.notebookSync||{}},old?.id);
      const attachmentId=this.store.attach(saved.id,name,'text/markdown',Buffer.from(doc));
      if(old?.fileHash!==digest)for(const annotation of this.store.list().filter(x=>x.kind==='annotation'&&x.sourceId===saved.id))this.store.save('annotation',{...annotation,verified:false},annotation.id);
      return {sourceId:saved.id,title:saved.title,url:saved.url,hash:digest,attachmentId,changed:old?.fileHash!==digest,version: saved.webVersions.length,warnings:a.warnings};
    });
  }
}
