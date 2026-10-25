const $=id=>document.getElementById(id);
const status=message=>{$('status').textContent=message;};
const send=async message=>{const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error||'擴充功能未回應');return r;};
async function active(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw new Error('找不到目前分頁');return tab;}
const local=url=>{try{const u=new URL(url);return u.origin==='http://127.0.0.1:4317';}catch{return false;}};
async function run(id,task){$(id).disabled=true;try{await task();}catch(err){status(err.message);}finally{$(id).disabled=false;}}
$('pair').onclick=()=>run('pair',async()=>{
  const tab=await active();if(!local(tab.url))throw new Error('請切換到一般 Chrome 的墨脈分頁，再點「連接墨脈」。');
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({token:document.querySelector('meta[name="inkgraph-token"]')?.content,site:document.getElementById('web-url')?.value})});
  if(!result?.token)throw new Error('不是有效的墨脈頁面，請重新整理後再試。');
  const r=await send({type:'pair',token:result.token});if(result.site)$('site').value=result.site;
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page-agent.js']});status(r.message);
});
$('grant').onclick=()=>run('grant',async()=>{
  const u=new URL($('site').value);if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||u.hostname==='accounts.google.com')throw new Error('請輸入要擷取文章的公開 https 網址。');
  const granted=await chrome.permissions.request({origins:[u.origin+'/*','https://www.google.com/*']});
  status(granted?'已允許這個文章網站與 Google 搜尋。回墨脈按「搜尋同站文章」。':'未取得網站權限；你可以稍後再次選擇。');
});
$('notebook').onclick=()=>run('notebook',async()=>{
  const tab=await active();const u=new URL(tab.url);
  if(!['notebooklm.google.com','notebook.google.com'].includes(u.hostname)||!/^\/notebook\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new Error('請先在一般 Chrome 登入並開啟一個 Notebook 筆記本，再點這個按鈕。');
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['page-agent.js']});
  const r=await chrome.tabs.sendMessage(tab.id,{type:'inkgraph-register'});if(!r?.ok)throw new Error(r?.error||'連接失敗');status('已連接這本筆記本。請保持此分頁開啟，回墨脈按「讀取已連接筆記本」。');
});
$('disconnect').onclick=()=>run('disconnect',async()=>{await send({type:'disconnect'});status('已中斷連線。已授予的網站權限可在 Chrome 擴充功能設定撤回。');});
try{const tab=await active();if(local(tab.url)){const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>document.getElementById('web-url')?.value||''});$('site').value=result;}const {connection}=await chrome.storage.session.get('connection');if(connection)status('墨脈已配對。若已重啟本機服務，請重新按「連接墨脈」。');}catch{}
