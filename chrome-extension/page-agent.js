(() => {
  if(globalThis.__inkgraphAgentInstalled)return;globalThis.__inkgraphAgentInstalled=true;
  const local=location.origin==='http://127.0.0.1:4317';let running=false,registered=false;
  const visible=n=>n&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';
  const label=n=>(n.getAttribute('aria-label')||n.getAttribute('title')||n.innerText||n.textContent||'').trim();
  const send=async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw new Error(r?.error||'擴充功能未回應');return r;};
  const wait=async(test,timeout=12000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=test();if(value)return value;await new Promise(r=>setTimeout(r,300));}throw new Error('找不到預期的 Notebook 控制項，請查看目前分頁後重試。');};
  const controls=(root=document)=>[...root.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(n=>visible(n)&&!n.disabled);
  const click=async(pattern,root=document)=>{const node=await wait(()=>controls(root).find(n=>pattern.test(label(n))));node.click();return node;};
  const sourceEntry=name=>[...document.querySelectorAll('span,div,button,a')].find(n=>visible(n)&&!n.closest('[role="dialog"],mat-dialog-container')&&n.textContent.trim()===name&&![...n.children].some(c=>c.textContent.trim()===name));
  async function removeOld(name){
    if(!/^InkGraph-[a-zA-Z0-9-]+--[a-f0-9]{12}\.md$/.test(name))throw new Error('不移除非墨脈來源');
    const entry=sourceEntry(name);if(!entry)return;
    let row=entry.parentElement,menu;
    for(let i=0;row&&i<6;i++,row=row.parentElement){
      if((row.innerText||row.textContent||'').trim().length>name.length+180)break;
      menu=controls(row).find(n=>/more|source actions|更多|選項|选项|來源操作/i.test(label(n)));if(menu)break;
    }
    if(!menu)throw new Error('找不到對應來源的選單');menu.click();
    await click(/remove source|delete source|移除來源|刪除來源|删除来源/i);
    await new Promise(r=>setTimeout(r,400));
    const dialog=[...document.querySelectorAll('[role="dialog"],mat-dialog-container')].find(visible);
    if(dialog)await click(/^(remove|delete|移除|刪除|删除)$/i,dialog);
    await wait(()=>!sourceEntry(name),15000);
  }
  async function upload(source,target){
    if(sourceEntry(source.name))return;
    await click(/add sources?|新增來源|添加来源|加入來源/i);
    const input=await wait(()=>document.querySelector('input[type="file"]'),10000);
    const transfer=new DataTransfer();transfer.items.add(new File([source.text],source.name,{type:'text/markdown'}));
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>{if(location.origin+location.pathname.replace(/\/$/,'')!==target)throw new Error('操作中切換了筆記本，已停止。');return sourceEntry(source.name);},90000);
  }
  async function sync(job){
    const results=[];
    try{
      if(location.origin+location.pathname.replace(/\/$/,'')!==job.payload.notebook)throw new Error('目標筆記本已變更，請重新連接。');
      for(const s of job.payload.sources){
        try{
          if(location.origin+location.pathname.replace(/\/$/,'')!==job.payload.notebook)throw new Error('操作中切換了筆記本，已停止。');
          await upload(s,job.payload.notebook);const pending=[];
          for(const name of s.outdated){if(location.origin+location.pathname.replace(/\/$/,'')!==job.payload.notebook)throw new Error('操作中切換了筆記本，已停止。');if(job.payload.replace){try{await removeOld(name);}catch{pending.push(name);}}else pending.push(name);}
          results.push({sourceId:s.id,status:pending.length?'cleanup_required':'uploaded',pendingCleanupTitles:pending,message:pending.length?'新版已出現；部分舊版仍保留，請在 Notebook 核對或重試。':'已確認來源名稱出現在清單，請在 Notebook 確認內容與索引。'});
        }catch(err){results.push({sourceId:s.id,status:'failed',message:err.message});break;}
      }
    }catch(err){if(!results.length)results.push({sourceId:job.payload.sources[0].id,status:'failed',message:err.message});}
    for(const s of job.payload.sources)if(!results.some(r=>r.sourceId===s.id))results.push({sourceId:s.id,status:'skipped',message:'前項未完成，這篇尚未開始。'});
    await send({type:'complete',jobId:job.id,lease:job.lease,result:{results}});
  }
  const heartbeat=()=>{
    if(local)send({type:'wake'}).catch(()=>{});
    else if(registered)send({type:'register',url:location.href,title:document.title}).catch(()=>{});
  };
  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message.type==='inkgraph-register'){
      if(local){reply({ok:false,error:'請切換到 Notebook 筆記本分頁'});return;}
      send({type:'register',url:location.href,title:document.title}).then(()=>{registered=true;reply({ok:true});},err=>reply({ok:false,error:err.message}));return true;
    }
    if(message.type==='inkgraph-sync'){
      if(local||!registered||running){reply({ok:false,error:'Notebook 未連接或另一批工作尚未完成'});return;}
      running=true;reply({ok:true});sync(message.job).catch(()=>{}).finally(()=>{running=false;});return;
    }
  });
  setInterval(heartbeat,2500);heartbeat();
})();
