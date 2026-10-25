import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { AppError } from './store.mjs';
import { publicURL } from './web-research.mjs';

export function notebookURL(value) {
  let u;try{u=new URL(value);}catch{throw new AppError('請選擇有效筆記本');}
  if(u.protocol!=='https:'||!['notebooklm.google.com','notebook.google.com'].includes(u.hostname)||!/^\/notebook\/[a-zA-Z0-9-]+\/?$/.test(u.pathname)||u.username||u.password||u.port)throw new AppError('僅接受 Google Notebook 的筆記本網址');
  return u.origin+u.pathname.replace(/\/$/,'');
}
export const managedTitle=(source)=>`InkGraph-${source.id}--${source.fileHash.slice(0,12)}.md`;

// This module uses the visible browser UI only. No private Google endpoints or cookie export.
export class NotebookBrowser {
  constructor(store,dataPath){this.store=store;this.profile=resolve(dataPath,'notebook-browser');this.context=null;this.pending=null;this.busy=false;this.activePage=null;}
  async browser(){
    if(this.context)return this.context;
    if(!this.pending)this.pending=chromium.launchPersistentContext(this.profile,{channel:'chrome',headless:false,viewport:null,acceptDownloads:false}).then(context=>{
      this.context=context;context.on('close',()=>{this.context=null;this.activePage=null;});return context;
    }).catch(()=>{throw new AppError('工作瀏覽器無法啟動，請確認已安裝 Chrome，且墨脈工作瀏覽器未被另一個墨脈程序占用。',503);}).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async open(){const context=await this.browser();let page=context.pages().find(p=>/^https:\/\/(notebooklm|notebook)\.google\.com\//.test(p.url()));if(!page){page=await context.newPage();await page.goto('https://notebooklm.google.com/',{waitUntil:'domcontentloaded',timeout:45000});}this.activePage=page;await page.bringToFront();return {message:'請在工作瀏覽器登入 Google、開啟目標筆記本，再回墨脈按「讀取筆記本」。'};}
  async retrieveArticle(url){
    publicURL(url);const context=await this.browser();
    let page=context.pages().find(p=>p.url()===url);
    try{if(!page){page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}else await page.reload({waitUntil:'domcontentloaded',timeout:45000});}catch{throw new AppError('文章載入未完成。請查看工作瀏覽器的頁面或登入／驗證提示，處理後重試。',502);}
    await page.bringToFront();publicURL(page.url());
    await page.locator('body').waitFor({state:'visible',timeout:10000});
    await page.locator('article, main').first().waitFor({state:'visible',timeout:5000}).catch(()=>{});
    return {url:page.url(),html:await page.content()};
  }
  async searchArticles(query){
    const context=await this.browser(),page=await context.newPage();
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`,{waitUntil:'domcontentloaded',timeout:30000});
    const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>({url:n.href,title:n.textContent?.trim()})));
    await page.close();
    return links.map(a=>{try{const u=new URL(a.url);if(u.hostname==='www.bing.com'&&u.pathname==='/ck/a'){const encoded=u.searchParams.get('u');if(encoded?.startsWith('a1'))return {...a,url:Buffer.from(encoded.slice(2),'base64url').toString()};}}catch{}return a;});
  }
  async notebooks(){
    const context=await this.browser(),items=new Map();
    for(const page of context.pages()){
      let current;try{current=notebookURL(page.url());}catch{}
      if(current){const title=await page.title();items.set(current,{url:current,title:title.replace(/ - (NotebookLM|Gemini Notebook)$/,'')||current});}
      if(/^https:\/\/(notebooklm|notebook)\.google\.com\//.test(page.url()))for(const a of await page.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>({url:n.href,title:n.textContent?.trim()})))){try{const url=notebookURL(a.url);if(!items.has(url))items.set(url,{url,title:a.title||url});}catch{}}
    }
    return {notebooks:[...items.values()],message:items.size?'請選擇目標筆記本。':'尚未找到筆記本。請在工作瀏覽器完成登入，並開啟要使用的筆記本。'};
  }
  async pageFor(url){const context=await this.browser();let page=context.pages().find(p=>{try{return notebookURL(p.url())===url;}catch{return false;}});if(!page){page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}await page.bringToFront();if(!/^https:\/\/(notebooklm|notebook)\.google\.com\//.test(page.url()))throw new AppError('需要登入 Google，完成後請重試。',409);return page;}
  async sync(sourceIds,target,{replace=false}={}){
    if(this.busy)throw new AppError('另一批同步正在進行，請稍候。',409);
    const url=notebookURL(target);if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>11||new Set(sourceIds).size!==sourceIds.length)throw new AppError('請選擇 1 至 11 筆不同來源');
    for(const id of sourceIds){const s=this.store.get(id);if(s?.kind!=='source'||s.origin!=='web')throw new AppError('只能同步已擷取的網頁文章');}
    this.busy=true;const results=[];
    try{
      const page=await this.pageFor(url);
      for(const id of sourceIds){
        const source=this.store.get(id),name=managedTitle(source),old=source.notebookSync?.[url];
        try{
          const entry=page.getByText(name,{exact:true});
          if(!await entry.count()){
            await page.getByRole('button',{name:/add sources?|新增來源|添加来源|加入來源/i}).first().click({timeout:10000});
            const input=page.locator('input[type="file"]');
            if(await input.count())await input.first().setInputFiles({name,mimeType:'text/markdown',buffer:Buffer.from(source.text)});
            else {
              const [chooser]=await Promise.all([page.waitForEvent('filechooser',{timeout:15000}),page.getByText(/upload files?|choose files?|上傳檔案|選擇檔案|上传文件/i).first().click({timeout:10000})]);
              await chooser.setFiles({name,mimeType:'text/markdown',buffer:Buffer.from(source.text)});
            }
          }
          await entry.first().waitFor({state:'visible',timeout:90000});
          const cleanup=[];
          const outdated=[...new Set([old?.title,...(old?.pendingCleanupTitles||[]),old?.pendingCleanup].filter(t=>t&&t!==name))];
          for(const title of outdated){if(replace){try{await this.removeManaged(page,title);}catch{cleanup.push(title);}}else cleanup.push(title);}
          const current=this.store.get(id);
          if(current.fileHash!==source.fileHash)throw new AppError('同步時本機文章已更新，請重新同步');
          this.store.save('source',{...current,notebookSync:{...current.notebookSync,[url]:{title:name,hash:source.fileHash,uploadedAt:new Date().toISOString(),status:cleanup.length?'cleanup_required':'uploaded',pendingCleanup:cleanup[0]||'',pendingCleanupTitles:cleanup,verification:'已確認來源名稱出現在頁面；內容索引由 Google 處理'}}},id);
          results.push({sourceId:id,title:source.title,status:cleanup.length?'cleanup_required':'uploaded',message:cleanup.length?'新版已出現；舊版仍保留，請在 Notebook 核對或重試替換。':'已確認來源出現在筆記本，請檢查 Google 是否完成處理。'});
        }catch(error){results.push({sourceId:id,title:source.title,status:'failed',message:error instanceof AppError?error.message:'瀏覽器操作未完成：可能需要登入、人工驗證、來源配額已滿或 Google 介面已變更。請查看工作瀏覽器後重試；已出現的同名來源不會重傳。'});for(const remaining of sourceIds.slice(sourceIds.indexOf(id)+1))results.push({sourceId:remaining,title:this.store.get(remaining).title,status:'skipped',message:'前一篇未完成，這篇尚未開始，請處理後重試。'});break;}
      }
      return {results,notebook:url};
    }finally{this.busy=false;}
  }
  async removeManaged(page,title){
    if(!/^InkGraph-[a-zA-Z0-9-]+--[a-f0-9]{12}\.md$/.test(title))throw new AppError('拒絕移除非墨脈管理的來源');
    const entry=page.getByText(title,{exact:true});if(!await entry.count())return;
    const row=entry.first().locator('xpath=ancestor::*[.//button][1]');
    const more=row.getByRole('button',{name:/more|source actions|更多|選項|选项|來源操作/i});
    if(await more.count())await more.first().click({timeout:5000});else throw new AppError('找不到舊版來源選單');
    await page.getByRole('menuitem',{name:/remove source|delete source|移除來源|刪除來源|删除来源/i}).click({timeout:5000});
    const dialog=page.getByRole('dialog');
    if(await dialog.count())await dialog.getByRole('button',{name:/^(remove|delete|移除|刪除|删除)$/i}).click({timeout:5000});
    await page.getByText(title,{exact:true}).waitFor({state:'hidden',timeout:15000});
  }
  async close(){await this.context?.close();}
}
