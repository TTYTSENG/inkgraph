export function createWebResearch({api,e,heading,toast,refresh,renderMain,project,entities,dialog,download}) {
  const state={url:'',topic:'',browser:true,seed:null,articles:[],chosen:new Set(),selected:new Set(),notebooks:[],notebook:'',busy:false,message:'',warnings:[],results:[]};
  const post=async(path,body={})=>(await(await api(path,{method:'POST',body})).json());
  const webSources=()=>entities().filter(s=>s.kind==='source'&&s.origin==='web'&&(!project()||s.projectId===project()));
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function finishJob(jobId){
    const until=Date.now()+26*60*1000;
    while(Date.now()<until){
      const r=await(await api('/api/notebooks/jobs?id='+encodeURIComponent(jobId))).json();
      if(r.status==='failed'){sessionStorage.removeItem('inkgraph-sync-job');throw new Error(r.message);}
      if(r.status==='done'){sessionStorage.removeItem('inkgraph-sync-job');return r.results;}
      await pause(1500);
    }
    throw new Error('尚未收到最終結果，可按「查看上次上傳結果」繼續核對。');
  }
  const btn=(action,label)=>`<button type="button" data-web-action="${action}" ${state.busy?'disabled':''}>${label}</button>`;
  function render(){
    const sources=webSources();
    return heading('從網頁，累積研究脈絡。','貼上文章 → 同站搜尋 → 勾選轉 Markdown → 選筆記本 → 上傳與保留歷史。')+
      `<section class="panel"><div class="panel-head"><h2>1．搜尋相關文章</h2></div><div class="panel-body"><label>起始文章網址<input id="web-url" type="url" placeholder="https://www.mckinsey.com/…" value="${e(state.url)}" ${state.busy?'disabled':''}></label><label>搜尋主題（可修改）<input id="web-topic" value="${e(state.topic)}" placeholder="例如 CEO strategy resource allocation" ${state.busy?'disabled':''}><small>留白時使用文章標題。以關鍵詞交集排序，同一主機名稱（含 www 的對應），最多 10 篇。</small></label><label class="checkbox"><input type="checkbox" id="web-browser" ${state.browser?'checked':''} ${state.busy?'disabled':''}>優先使用一般 Google Chrome 擷取與 Google 搜尋（需連接擴充功能）</label><div class="actions">${btn('discover','搜尋同站文章')}${btn('capture-seed','只擷取貼上的文章')}</div>${state.seed?`<label class="checkbox"><input type="checkbox" data-web-candidate="${e(state.seed.url)}" ${state.chosen.has(state.seed.url)?'checked':''} ${state.busy?'disabled':''}><strong>起始文章：${e(state.seed.title)}</strong></label>`:''}${state.articles.map(a=>`<article class="web-candidate"><label class="checkbox"><input type="checkbox" data-web-candidate="${e(a.url)}" ${state.chosen.has(a.url)?'checked':''} ${state.busy?'disabled':''}>${e(a.title)}</label><a href="${e(a.url)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a><p class="quiet-text">${e(a.reason)}</p></article>`).join('')}${state.seed?btn('capture','擷取勾選文章並儲存 Markdown'):''}</div></section>`+
      `<div class="notice green" role="status" aria-live="polite">${e(state.message||'準備就緒。每次擷取保留一份本機歷史；網頁圖表請另行核對。')}</div>${state.warnings.map(w=>`<div class="notice">${e(w)}</div>`).join('')}`+
      `<section class="panel"><div class="panel-head"><h2>2．本機文章與歷史版本</h2></div><div class="panel-body">${sources.length?sources.map(s=>{const receipt=s.notebookSync?.[state.notebook];return `<article class="web-candidate"><label class="checkbox"><input type="checkbox" data-web-source="${e(s.id)}" ${state.selected.has(s.id)?'checked':''} ${state.busy?'disabled':''}>${e(s.title)}</label><p class="quiet-text">本機 ${s.webVersions?.length||0} 個版本 · ${receipt?.hash===s.fileHash?(receipt.status==='cleanup_required'?'新版已上傳；舊版待清理':'來源已在目標筆記本出現'):'尚未同步至所選筆記本或內容已更新'}</p><div class="actions"><a href="#source/${e(s.id)}">閱讀與核對</a><button type="button" data-web-action="history" data-id="${e(s.id)}">下載／歷史</button></div></article>`;}).join(''):'<p>尚未擷取文章。擷取結果會存入目前選擇的墨脈專案。</p>'}${sources.length?btn('recapture','重新擷取勾選的本機文章'):''}</div></section>`+
      `<section class="panel"><div class="panel-head"><h2>3．上傳到 Google Notebook</h2></div><div class="panel-body"><p class="quiet-text">在一般 Google Chrome 安裝墨脈擴充功能。先在墨脈分頁按擴充功能「連接墨脈」，授權文章網站與 Google 搜尋；再在已登入的 Notebook 筆記本分頁按「連接這本 Notebook」。保持兩個分頁開啟。</p><div class="actions"><a href="https://notebooklm.google.com/" target="_blank" rel="noopener noreferrer">開啟 Google Notebook ↗</a>${btn('notebooks','讀取已連接筆記本')}${btn('install-help','擴充功能安裝說明')}</div><label>目標筆記本<select id="web-notebook" ${state.busy?'disabled':''}><option value="">請選擇筆記本</option>${state.notebooks.map(n=>`<option value="${e(n.url)}" ${n.url===state.notebook?'selected':''}>${e(n.title)}</option>`).join('')}</select></label>${btn('sync','上傳勾選文章／替換舊版')}${sessionStorage.getItem('inkgraph-sync-job')?btn('resume','查看上次上傳結果'):''}<p class="quiet-text">更新時會先確認新版來源出現，再嘗試移除墨脈管理的舊版；既有雲端引用可能受影響。本機 Markdown 歷史持續保留。此功能透過 Google 網頁操作，需登入且可能因介面變更中斷。</p>${state.results.map(r=>`<div class="notice ${r.status==='uploaded'?'green':''}">${e(r.title||r.url||'文章')}：${e(r.message||r.status)}</div>`).join('')}</div></section>`;
  }
  document.addEventListener('input',ev=>{if(ev.target.id==='web-url')state.url=ev.target.value;if(ev.target.id==='web-topic')state.topic=ev.target.value;});
  document.addEventListener('change',ev=>{
    const t=ev.target;
    if(t.id==='web-browser')state.browser=t.checked;
    if(t.dataset.webCandidate){if(t.checked)state.chosen.add(t.dataset.webCandidate);else state.chosen.delete(t.dataset.webCandidate);}
    if(t.dataset.webSource){if(t.checked)state.selected.add(t.dataset.webSource);else state.selected.delete(t.dataset.webSource);}
    if(t.id==='web-notebook'){state.notebook=t.value;renderMain();}
  });
  async function captureAll(urls){
    if(!urls.length||urls.length>11)throw new Error('請勾選 1 至 11 篇文章');state.results=[];
    for(let i=0;i<urls.length;i++){
      state.message=`正在擷取 ${i+1}/${urls.length}：${urls[i]}`;renderMain();
      try{const result=await post('/api/web/capture',{url:urls[i],projectId:project()||null,browser:state.browser});state.selected.add(result.sourceId);state.results.push({title:result.title,status:'local',message:`已儲存第 ${result.version} 版，${result.changed?'內容有更新':'內容相同；仍保留本次擷取歷史'}`});}
      catch(err){state.results.push({url:urls[i],status:'failed',message:err.message});}
    }
    await refresh();const good=state.results.filter(r=>r.status==='local').length;state.message=`擷取結束：${good} 篇成功，${state.results.length-good} 篇失敗。${good?'請先閱讀核對，再選筆記本上傳。':'請查看逐篇錯誤，處理後重試。'}`;
  }
  document.addEventListener('click',async ev=>{
    const target=ev.target.closest('[data-web-action]');if(!target||state.busy)return;
    const action=target.dataset.webAction;
    if(action==='install-help'){dialog('安裝一般 Chrome 擴充功能','<p>在你平常使用的 Google Chrome 開啟 chrome://extensions，開啟「開發人員模式」，按「載入未封裝項目」，選擇下方資料夾。</p><p><strong>D:\\全球展會\\inkgraph\\chrome-extension</strong></p><ol><li>在一般 Chrome 開啟 http://127.0.0.1:4317/#web，點擴充功能「連接墨脈」。</li><li>在擴充功能填入文章網址，按「允許這個網站與 Google 搜尋」。</li><li>手動登入 Notebook，開啟筆記本，點擴充功能「連接目前這本 Notebook」。</li><li>回墨脈讀取已連接筆記本，即可選擇目標並上傳。</li></ol><p>Google 登入由你在一般 Chrome 完成。若重啟墨脈或 Chrome，請重新連接。只有你授權的文章網站會被擷取。</p>','<button type="button" data-action="close-dialog">關閉</button>');return;}
    if(action==='history'){
      const s=entities().find(x=>x.id===target.dataset.id);if(!s)return;
      const versions=[...(s.webVersions||[])].reverse();
      // Attachments remain available via the existing authenticated file route.
      dialog('Markdown 與擷取歷史',`<p>${e(s.title)}</p><p>目前 ${versions.length} 個歷史版本；完整 ZIP 備份也會包含這些檔案。</p>${versions.map(v=>`<div class="web-candidate"><p>${e(new Date(v.capturedAt).toLocaleString('zh-TW'))} · ${e(v.hash.slice(0,12))}</p><button type="button" data-web-version="${e(v.id)}" data-web-source-id="${e(s.id)}">下載 Markdown</button></div>`).join('')}`,'<button type="button" data-action="close-dialog">關閉</button>');return;
    }
    if(action==='sync'){
      if(!state.notebook){toast('請先選擇目標筆記本');return;}
      if(!window.confirm('將把勾選文章上傳至所選 Google 筆記本。若有墨脈舊版，將在新版出現後移除舊版，可能影響舊引用；本機保留歷史。是否繼續？'))return;
    }
    state.busy=true;state.warnings=[];renderMain();
    try{
      if(action==='discover'){
        state.message='正在擷取起始文章並搜尋同站相關議題…';renderMain();
        const r=await post('/api/web/discover',{url:state.url,topic:state.topic,browser:state.browser});state.seed=r.seed;state.articles=r.articles;state.chosen=new Set([r.seed.url,...r.articles.map(a=>a.url)]);state.warnings=r.warnings;state.message=`找到 ${r.articles.length} 篇相關文章，請勾選要轉檔的內容。`;
      }else if(action==='capture')await captureAll([...state.chosen]);
      else if(action==='capture-seed')await captureAll([state.url]);
      else if(action==='recapture')await captureAll(webSources().filter(s=>state.selected.has(s.id)).map(s=>s.url));
      else if(action==='notebooks'){const r=await(await api('/api/notebooks')).json();state.notebooks=r.notebooks;state.message=r.message;if(!state.notebook&&r.notebooks.length===1)state.notebook=r.notebooks[0].url;}
      else if(action==='resume'){const id=sessionStorage.getItem('inkgraph-sync-job');if(!id)throw new Error('沒有待查詢的上傳工作');state.message='正在查詢上次上傳結果…';renderMain();state.results=await finishJob(id);await refresh();state.message='已讀取上次結果。';}
      else if(action==='sync'){
        const ids=webSources().filter(s=>state.selected.has(s.id)).map(s=>s.id);if(!ids.length||ids.length>11)throw new Error('請勾選 1 至 11 篇本機文章');
        state.message='等待一般 Chrome 擴充功能上傳與核對。請保持墨脈與已連接的 Notebook 分頁開啟…';renderMain();
        const r=await post('/api/notebooks/sync',{sourceIds:ids,notebook:state.notebook,replace:true});sessionStorage.setItem('inkgraph-sync-job',r.jobId);state.results=await finishJob(r.jobId);await refresh();state.message='同步程序結束。請查看逐篇結果；來源內容是否完成索引請在 Google Notebook 核對。';
      }
    }catch(err){state.message=err.message;toast(err.message);}finally{state.busy=false;renderMain();}
  });
  document.addEventListener('click',async ev=>{
    const target=ev.target.closest('[data-web-version]');if(!target)return;
    try{await download(`/api/web/version?source=${encodeURIComponent(target.dataset.webSourceId)}&version=${encodeURIComponent(target.dataset.webVersion)}`);}catch(err){toast(err.message);}
  });
  return {render};
}
