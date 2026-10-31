import {captureWorkflow} from './mobile-model.js';

export function createMobileCapture({api,e,heading,button,toast,refresh,go,project,entities,renderMain,dialog,dom=globalThis.document}){
  let state=null,devices=[],busy=false,started=false,loadPromise=null,checking=false;
  let statusError='',transferError='',deviceError='',selectedDevice='',filter='all',advancedOpen=false,lastTransfer=null;
  const statusLabels={queued:'等待辨識',running:'正在辨識',done:'文字已產生 · 待核對',failed:'辨識失敗 · 原檔保留',cancelled:'已取消 · 原檔保留'};
  const request=async(path,body)=>(await api(path,body?{method:'POST',body}:{})).json();
  const visible=()=>Boolean(dom.querySelector('#mobile-workspace'));
  function redraw(){
    if(!visible())return;
    const view=dom.defaultView,x=view?.scrollX||0,y=view?.scrollY||0;
    renderMain();view?.scrollTo(x,y);
  }
  async function discover(){
    checking=true;deviceError='';
    try{const r=await request('/api/mobile/devices');devices=r.devices||[];
      if(!devices.some(d=>d.id===selectedDevice&&d.state==='device'))selectedDevice=devices.find(d=>d.state==='device')?.id||'';
      if(!r.configured)deviceError='尚未設定 Android USB 工具；仍可從檔案匯入。';
      else if(!devices.length)deviceError='尚未偵測到手機。請接上可傳資料的 USB 線，解鎖手機並允許 USB 偵錯。';
      else if(!selectedDevice)deviceError=devices.some(d=>d.state==='unauthorized')?'請在手機上允許這台電腦的 USB 偵錯授權。':'手機目前離線，請重新連接。';
    }catch(err){deviceError=err.message;}finally{checking=false;}
  }
  async function load(){
    if(loadPromise)return loadPromise;
    loadPromise=(async()=>{try{state=await request('/api/mobile/status');statusError='';}catch(err){statusError=err.message;}finally{loadPromise=null;redraw();}})();
    return loadPromise;
  }
  function jobCard(j,get){
    return `<article class="mobile-capture-row mobile-job" data-job-id="${e(j.id)}"><div class="mobile-card-title"><span class="badge ${j.state==='failed'?'amber':'gray'}">${e(statusLabels[j.state]||j.state)}</span><span>${j.kind==='asr'?'語音轉文字':'照片文字'}</span></div><h3>${e(get(j.source_id)?.title||'原始附件已移除')}</h3>${j.error?`<p class="error">${e(j.error)}</p>`:''}${j.result?`<pre class="mobile-result">${e(j.result.text||'沒有辨識到內容，請核對原檔')}</pre><small>機器結果，尚未人工校對 · ${e(j.result.engine)} ${e(j.result.version)} · ${Number(j.result.elapsedSeconds).toFixed(1)}秒 · 峰值${(Number(j.result.peakRssBytes)/1024**2).toFixed(0)}MiB</small>`:''}<div class="actions">${button('mobile-source','原檔／播放','small',j.source_id)}${['queued','running'].includes(j.state)?button('mobile-cancel','取消這份辨識','quiet small',j.id):''}${['failed','cancelled'].includes(j.state)?button('mobile-retry','重試這份附件','small',j.id):''}${j.state==='done'?['txt','json',...(j.kind==='asr'?['srt','vtt']:[])].map(f=>`<a class="button" href="/api/mobile/result?id=${e(j.source_id)}&format=${f}" data-mobile-export="${f}" data-source="${e(j.source_id)}">${f.toUpperCase()}</a>`).join(''):''}</div><small>已嘗試 ${j.attempts} 次；接收原始檔與辨識是不同步驟。</small></article>`;
  }
  function render(){
    if(!started){started=true;queueMicrotask(async()=>{await Promise.allSettled([load(),discover()]);redraw();});}
    const jobs=state?.jobs||[],get=id=>entities().find(r=>r.id===id),captures=(state?.captures||[]).map(c=>({...c,workflow:captureWorkflow(c,jobs)}));
    const shown=captures.filter(c=>filter==='all'||c.workflow.phase===filter),shownSources=new Set(shown.flatMap(c=>c.sourceIds||[]));
    const shownJobs=filter==='all'?jobs:jobs.filter(j=>shownSources.has(j.source_id));
    const waiting=jobs.filter(j=>j.state==='queued').length,running=jobs.filter(j=>j.state==='running').length,failed=jobs.filter(j=>['failed','cancelled'].includes(j.state)).length;
    const ready=devices.some(d=>d.id===selectedDevice&&d.state==='device');
    return heading('手機收件與整理','先確認電腦保存，再查看辨識進度；最後開啟筆記整理。')+`<div id="mobile-workspace" aria-busy="${busy}">
      <p class="notice">隔離測試研究庫：此頁的手機記錄與原件不會自動帶入正式研究庫。</p>
      <ol class="mobile-steps" aria-label="手機記錄整理流程"><li><strong>1 連接手機</strong><span>解鎖並允許 USB 偵錯</span></li><li><strong>2 接收原件</strong><span>重傳會判重，手機原件保留</span></li><li><strong>3 查看辨識</strong><span>每份附件各自顯示進度</span></li><li><strong>4 整理筆記</strong><span>校對後再用於研究</span></li></ol>
      <section class="panel"><div class="panel-head"><h2>接收手機記錄</h2></div><div class="panel-body">
        ${devices.length?`<label>手機<select id="mobile-device">${devices.map(d=>`<option value="${e(d.id)}" ${d.id===selectedDevice?'selected':''} ${d.state!=='device'?'disabled':''}>${e(d.model)} · ${e(d.state==='device'?'已授權':d.state==='unauthorized'?'等待手機授權':'離線')} · ${e(d.id.slice(-4))}</option>`).join('')}</select></label>`:''}
        <p role="status" aria-live="polite">${e(busy?'正在接收，請保持 USB 連接…':checking?'正在偵測手機…':deviceError||'手機已連接，可接收 App 中已完成的記錄。')}</p>
        <div class="actions">${ready?button('mobile-pull','接收手機記錄','primary'):button('mobile-devices','偵測 USB 手機','primary')}${ready?button('mobile-devices','重新偵測','quiet'):''}${button('mobile-load','更新辨識進度','quiet')}</div>
        ${transferError?`<p class="error" role="alert">接收尚未完成：${e(transferError)}。已接收部分會保留，可重新接收，由系統判重。</p>`:''}
        ${lastTransfer?`<div class="mobile-receipt" role="status"><strong>接收完成：新增 ${lastTransfer.added} 則，已存在 ${lastTransfer.duplicates} 則。</strong><p>${e(lastTransfer.receiptMessage)}</p><small>電腦指紋：${e(lastTransfer.fingerprint)} · 回執只證明此版本已保存，不代表辨識完成。</small></div>`:''}
        <details id="mobile-advanced" ${advancedOpen?'open':''}><summary>從檔案匯入／環境資訊</summary><label>選取從手機複製的 .igc 傳輸包<input id="mobile-package" type="file" accept=".igc,.zip,application/zip"></label><p>${state?.configured?'本地辨識環境已設定':'辨識環境尚未設定；仍可接收原檔，待模型備妥後再處理。'} · 單一辨識工作、最多 4 個 CPU 執行緒。</p><p>已接收的記錄不會自動從手機刪除；匯出可排除結構化地點，原圖仍可能含 EXIF。</p></details>
      </div></section>
      ${statusError?`<p class="error" role="alert">進度讀取失敗：${e(statusError)}。保留上次畫面，請按「更新辨識進度」重試。</p>`:''}
      <dl class="mobile-summary"><div><dt>已接收記錄</dt><dd>${state?.captures.length||0}</dd></div><div><dt>等待辨識</dt><dd>${waiting}</dd></div><div><dt>辨識中</dt><dd>${running}</dd></div><div><dt>需處理附件</dt><dd>${failed}</dd></div></dl>
      <section class="panel"><div class="panel-head"><h2>已接收記錄</h2><div class="mobile-filters" aria-label="記錄處理篩選">${[['all','全部'],['attention','需處理'],['processing','處理中'],['review','待核對'],['text','純文字']].map(([key,name])=>`<button type="button" data-action="mobile-filter" data-id="${key}" aria-pressed="${filter===key}">${name}</button>`).join('')}</div></div><div class="panel-body">
        ${shown.map(c=>`<article class="mobile-capture-row" data-capture-id="${e(c.captureId)}"><h3>${e(c.text.trim().split('\n')[0].slice(0,100)||'語音／照片筆記')}</h3><small>原始記錄：${e(c.createdAt)} · ${e(c.timezone)} · 第 ${c.revision} 版 · ${c.mediaCount} 份附件</small><div class="mobile-state-lines"><p><strong>接收</strong> ${e(c.workflow.received)}</p><p><strong>辨識</strong> ${e(c.workflow.label)}</p><p><strong>校對</strong> ${e(c.workflow.review)}</p></div><small>地點：${e(c.location?.label||({captured:'已有定位（精度見筆記）',denied:'未授權',timeout:'未取得',disabled:'定位未開啟'})[c.location?.status]||'未取得')} · 電腦接收：${e(c.received)}</small><div class="actions">${c.noteMissing?'<span class="error">整理筆記已移除，原接收紀錄仍保留。</span>':button('mobile-open','開啟整理筆記','small',c.noteId)+button('mobile-share','匯出文字／結構資料','quiet small',c.noteId)}</div></article>`).join('')||`<p>${captures.length?'此分類沒有記錄，可切換其他篩選。':'尚未接收手機記錄。先在手機完成記錄，再連接並接收。'}</p>`}
      </div></section>
      <section class="panel"><div class="panel-head"><h2>附件辨識與輸出</h2>${button('mobile-pause',state?.paused?'繼續辨識':'暫停後續辨識','quiet')}</div><div class="panel-body"><p>${state?.paused?'後續辨識已暫停；已開始的工作會繼續，原始檔仍保留。':'原件已保存後逐份辨識；失敗的附件可單獨重試。'}</p>${shownJobs.map(j=>jobCard(j,get)).join('')||'<p>目前範圍沒有辨識工作，純文字記錄不需要辨識。</p>'}<small>此頁最多顯示最近 100 則接收記錄與 200 份辨識工作；未載入的進度不當作已完成。</small></div></section>
    </div>`;
  }
  function download(blob,name){const url=URL.createObjectURL(blob),link=dom.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  function bind(){
    const input=dom.querySelector('#mobile-package'),select=dom.querySelector('#mobile-device'),advanced=dom.querySelector('#mobile-advanced');
    if(select)select.onchange=()=>{selectedDevice=select.value;};
    if(advanced)advanced.ontoggle=()=>{advancedOpen=advanced.open;};
    if(busy)dom.querySelectorAll('#mobile-workspace button, #mobile-workspace input, #mobile-workspace select').forEach(el=>{el.disabled=true;});
    if(input)input.onchange=async()=>{
      if(busy||!input.files[0])return;const file=input.files[0];busy=true;transferError='';redraw();
      try{const q=project()&&project()!=='inbox'?'?project='+encodeURIComponent(project()):'';const r=await(await api('/api/mobile/import'+q,{method:'POST',body:file})).json();
        toast(r.duplicate?'相同版本已存在，沒有重複新增':'原始檔已保存；辨識進度請看附件狀態');lastTransfer=null;await refresh();await load();
      }catch(err){transferError=err.message;}finally{busy=false;input.value='';redraw();}
    };
    dom.querySelectorAll('[data-action="mobile-source"]').forEach(b=>{
      const job=state?.jobs.find(j=>j.source_id===b.dataset.id&&j.state==='done');if(!job)return;
      const host=b.closest('article'),box=dom.createElement('details');box.className='mobile-reprocess';box.innerHTML='<summary>重新辨識（保留舊結果）</summary>'+(job.kind==='asr'?'<label>模型<select><option value="base">base（快速）</option><option value="small">small（較慢）</option></select></label>':'');
      const redo=dom.createElement('button');redo.type='button';redo.textContent='開始重新辨識';redo.disabled=busy;redo.onclick=async()=>{if(busy)return;busy=true;redo.disabled=true;try{await request('/api/mobile/jobs',{action:'reprocess',sourceId:job.source_id,model:box.querySelector('select')?.value||'base'});await load();}catch(err){toast(err.message);}finally{busy=false;redraw();}};box.append(redo);host.append(box);
    });
    dom.querySelectorAll('[data-mobile-export]').forEach(a=>a.onclick=async ev=>{ev.preventDefault();try{const r=await api(`/api/mobile/result?id=${encodeURIComponent(a.dataset.source)}&format=${a.dataset.mobileExport}`);download(await r.blob(),`recognition.${a.dataset.mobileExport}`);}catch(err){toast(err.message);}});
  }
  async function handle(action,id){
    if(busy)return;
    try{
      if(action==='mobile-devices'){busy=true;redraw();await discover();}
      else if(action==='mobile-pull'){
        if(!selectedDevice)throw Error('請先連接並授權手機');busy=true;transferError='';redraw();
        try{const r=await request('/api/mobile/usb',{deviceId:selectedDevice,projectId:project()&&project()!=='inbox'?project():null});
          const delivered=(r.results||[]).filter(item=>item.receiptDelivered).length,total=(r.results||[]).length;
          lastTransfer={added:r.added,duplicates:r.duplicates,fingerprint:r.vault.fingerprint,receiptMessage:total===0?'手機沒有已完成的傳輸包；請先在 App 完成記錄。':delivered===total?'回執已送至手機；首次請在手機核對並確認電腦指紋。':`${total-delivered} 份回執尚未送到手機；電腦已保存，可重新接收以重送回執。`};
          await refresh(true);await load();toast('接收完成，原件已保存。');
        }catch(err){transferError=err.message;await refresh();await load();}
      }
      else if(action==='mobile-load')await load();
      else if(action==='mobile-filter'){filter=id;}
      else if(action==='mobile-pause'){busy=true;await request('/api/mobile/jobs',{action:'pause',value:!state?.paused});await load();}
      else if(action==='mobile-share')dialog('匯出手機記錄',`<label>格式<select name="format"><option value="markdown">Markdown 文字</option><option value="json">JSON 結構資料</option></select></label><label class="checkbox"><input type="checkbox" name="omitLocation" checked>排除定位欄位與手動地名</label><p>不包含原圖或原音位元組。正文或照片中可見的地址仍需自行核對；另行下載的原圖可能含 EXIF 定位。</p>`,'<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">下載</button>',async fd=>{const format=fd.get('format'),r=await api(`/api/export?id=${encodeURIComponent(id)}&format=${format}${fd.has('omitLocation')?'&omitLocation=1':''}`);download(await r.blob(),`capture.${format==='json'?'json':'md'}`);dom.querySelector('#dialog').close();});
      else if(action==='mobile-cancel'||action==='mobile-retry'){busy=true;await request('/api/mobile/jobs',{action:action==='mobile-cancel'?'cancel':'retry',id});await load();}
      else if(action==='mobile-open')await go('note',id);
      else if(action==='mobile-source')await go('source',id);
    }catch(err){statusError=err.message;toast(err.message);}finally{busy=false;redraw();}
  }
  const timer=dom.defaultView?.setInterval(()=>{if(!busy&&visible()&&dom.activeElement?.tagName!=='SELECT')load();},5000);
  return {render,bind,handle,canHandle:a=>a.startsWith('mobile-'),close:()=>dom.defaultView?.clearInterval(timer)};
}
