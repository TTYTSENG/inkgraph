const BASE='http://127.0.0.1:4317';let polling=false;
const notebookURL=value=>{const u=new URL(value);if(u.protocol!=='https:'||!['notebooklm.google.com','notebook.google.com'].includes(u.hostname)||!/^\/notebook\/[a-zA-Z0-9-]+\/?$/.test(u.pathname))throw new Error('不是有效的 Google 筆記本');return u.origin+u.pathname.replace(/\/$/,'');};
async function call(path,body={},pairToken){
  const {connection}=await chrome.storage.session.get('connection');if(!pairToken&&!connection)throw new Error('請先在墨脈分頁點擴充功能「連接墨脈」。');
  const response=await fetch(BASE+'/api/extension/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-inkgraph-extension':chrome.runtime.id,...(pairToken?{'x-inkgraph-token':pairToken}:{'x-inkgraph-capability':connection.capability})},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'本機連接失敗');return data;
}
async function complete(job,result){return call('complete',{jobId:job.id,lease:job.lease,result});}
async function loadPublic(url,search=false){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port)throw new Error('只接受 https 網站');
  if(!await chrome.permissions.contains({origins:[u.origin+'/*']}))throw new Error(`尚未允許 ${u.hostname}。請點擴充功能，填入文章網址並按「允許這個網站與 Google 搜尋」。`);
  const tab=await chrome.tabs.create({url:u.href,active:false});
  try{
    await new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);chrome.tabs.onUpdated.removeListener(update);chrome.tabs.onRemoved.removeListener(removed);};
      const update=(id,info)=>{if(id===tab.id&&info.status==='complete'){done();resolve();}};
      const removed=id=>{if(id===tab.id){done();reject(new Error('文章分頁已關閉'));}};
      const timer=setTimeout(()=>{done();reject(new Error('網頁載入逾時，請查看 Chrome 的文章分頁後重試。'));},45000);
      chrome.tabs.onUpdated.addListener(update);chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.get(tab.id).then(t=>{if(t.status==='complete'){done();resolve();}},err=>{done();reject(err);});
    });
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
      await new Promise(r=>setTimeout(r,800));
      const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script,style,iframe').forEach(n=>n.remove());
      return {url:location.href,html:clone.outerHTML,title:document.title,textLength:document.body?.innerText.length||0,links:[...document.querySelectorAll('a[href]')].slice(0,1000).map(n=>({url:n.href,title:n.innerText?.trim()||''}))};
    }});
    if(new URL(result.url).origin!==u.origin)throw new Error('網站已跳轉至其他網域；請在一般 Chrome 確認並重新授權。');
    if(!search&&(result.textLength<600||/access denied|just a moment|驗證|sign in/i.test(result.title)))throw new Error('文章尚未完整顯示或需要人工驗證。請查看已保留的 Chrome 分頁，再重試。');
    if(result.html.length>8*1024*1024)throw new Error('網頁過大，請改用文件匯入');
    await chrome.tabs.remove(tab.id);return result;
  }catch(err){await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});throw err;}
}
async function tick(){
  if(polling)return;polling=true;
  try{
    const {connection,notebooks={}}=await chrome.storage.session.get(['connection','notebooks']);if(!connection)return;
    const live=[];const registrations={};
    for(const [id,n] of Object.entries(notebooks)){
      if(Date.now()-n.seen>20000)continue;
      try{await chrome.tabs.get(Number(id));registrations[id]=n;live.push(n);}catch{}
    }
    await chrome.storage.session.set({notebooks:registrations});
    const {job}=await call('poll',{notebooks:live});if(!job)return;
    if(job.type==='sync'){
      const match=Object.entries(registrations).find(([,n])=>n.url===job.payload.notebook);
      if(!match){await complete(job,{error:'目標筆記本已斷線，請在該分頁重新連接。'});return;}
      try{const r=await chrome.tabs.sendMessage(Number(match[0]),{type:'inkgraph-sync',job});if(!r?.ok)throw new Error(r?.error||'Notebook 分頁無法接收工作');}
      catch(err){await complete(job,{error:err.message});}
    }else{
      try{
        if(job.type==='retrieve'){const r=await loadPublic(job.payload.url);await complete(job,{url:r.url,html:r.html});}
        else if(job.type==='search'){
          const r=await loadPublic('https://www.google.com/search?q='+encodeURIComponent(job.payload.query),true);
          const links=r.links.map(a=>{try{const u=new URL(a.url);if(u.hostname==='www.google.com'&&u.pathname==='/url')return {...a,url:u.searchParams.get('q')||u.searchParams.get('url')||a.url};}catch{}return a;}).filter(a=>a.title.length>15).slice(0,500);
          await complete(job,{links});
        }else await complete(job,{error:'未知的工作類型'});
      }catch(err){await complete(job,{error:err.message});}
    }
  }catch(err){await chrome.storage.session.set({lastError:String(err.message).slice(0,700)});}finally{polling=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    const popup=!sender.tab&&sender.id===chrome.runtime.id;
    const source=sender.tab?.url||sender.url||'';
    if(message.type==='pair'){
      if(!popup||typeof message.token!=='string')throw new Error('配對僅接受擴充功能面板操作');
      const r=await call('pair',{},message.token);await chrome.storage.session.set({connection:{capability:r.capability},notebooks:{}});
      await chrome.alarms.create('inkgraph-poll',{periodInMinutes:0.5});await tick();return {ok:true,message:r.message};
    }
    if(message.type==='disconnect'){
      if(!popup)throw new Error('請從擴充功能面板中斷連線');await chrome.storage.session.clear();await chrome.alarms.clear('inkgraph-poll');return {ok:true};
    }
    if(message.type==='register'){
      if(!sender.tab?.id)throw new Error('缺少 Notebook 分頁');const url=notebookURL(source);if(notebookURL(message.url)!==url)throw new Error('分頁網址不符');
      const {notebooks={}}=await chrome.storage.session.get('notebooks');notebooks[sender.tab.id]={url,title:String(message.title||'Notebook').slice(0,500),seen:Date.now()};await chrome.storage.session.set({notebooks});await tick();return {ok:true};
    }
    if(message.type==='wake'){
      if(!sender.tab||new URL(source).origin!==BASE)throw new Error('僅接受墨脈分頁連線');await tick();return {ok:true};
    }
    if(message.type==='complete'){
      const {notebooks={}}=await chrome.storage.session.get('notebooks');const registration=notebooks[sender.tab?.id];if(!registration||notebookURL(source)!==registration.url)throw new Error('不是已連接的 Notebook 分頁');
      return {ok:true,...await call('complete',{jobId:message.jobId,lease:message.lease,result:message.result})};
    }
    throw new Error('不支援的操作');
  })().then(reply,error=>reply({ok:false,error:String(error.message).slice(0,700)}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='inkgraph-poll')tick();});
