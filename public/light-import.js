export function createLightImport({api,e,heading,toast,refresh,project,entities}) {
  let bundle=null,preview=null,target=null,busy=false,undoBatch=null;
  let pendingRaw=null;
  let draftKey=null,storageWarning='',resumed=false;
  const storage=()=>document.defaultView.localStorage;
  function saveSelection(excludedIds){
    if(!draftKey)return;
    try{
      const db=JSON.parse(storage().getItem('inkgraph-light-selections-v1')||'{}');
      db[draftKey]={ids:[...excludedIds],at:Date.now()};
      const recent=Object.entries(db).sort((a,b)=>b[1].at-a[1].at).slice(0,30);
      storage().setItem('inkgraph-light-selections-v1',JSON.stringify(Object.fromEntries(recent)));
    }catch{storageWarning='此瀏覽器無法保存預覽選擇；離開後請重新選擇。';}
  }
  async function restoreSelection(raw,projectId,excludedIds){
    const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
    const key=JSON.stringify([Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''),projectId]);
    if(key===draftKey)return;
    draftKey=key;excludedIds.clear();resumed=false;storageWarning='';
    try{
      const db=JSON.parse(storage().getItem('inkgraph-light-selections-v1')||'{}'),ids=db[key]?.ids;
      const allowed=new Set(['sources','notes','annotations','relations'].flatMap(group=>Array.isArray(bundle[group])?bundle[group].map((_,i)=>`${group}:${i}`):[]));
      if(Array.isArray(ids)&&ids.length<=2000&&ids.every(id=>allowed.has(id))){ids.forEach(id=>excludedIds.add(id));resumed=ids.length>0;}
    }catch{storageWarning='此瀏覽器無法讀取預覽選擇；本次仍可匯入。';}
  }
  const names={source:'文獻',annotation:'摘錄',note:'筆記',term:'字彙詞條',relation:'關聯'};
  const request=async(path,body)=>(await api(`/api/light/${path}`,body?{method:'POST',body}:{})).json();
  function render(){
    const options=entities().filter(r=>r.kind==='project').map(r=>`<option value="${e(r.id)}">${e(r.title)}</option>`).join('');
    return heading('Light 研究成果匯入','在 Codex 完成研究後，將成果包帶進墨脈。先預覽，再確認匯入。')+`<section class="panel"><div class="panel-body"><p>1. 下載格式範例，交給 Codex，請它依此格式產生研究成果 JSON。<br>2. 選擇成果檔與所屬專案，檢查預覽。<br>3. 確認後匯入；原始 PDF 請另外加入。</p><p>查證狀態為產生者聲明，匯入不代表已核查；摘錄一律保留待人工核對。相同 DOI／網址沿用既有文獻，不覆寫內容；同篇文獻可連結到多個專案，共用書目與附件。</p><button id="light-example">下載格式範例</button><form id="light-form"><label>所屬專案<select id="light-project"><option value="">待整理收件匣</option>${options}</select></label><label>研究成果 JSON（最多 5 MB）<input id="light-file" type="file" accept=".json,application/json" required></label><button type="submit" class="primary">預覽成果</button></form><p id="light-status" role="status" aria-live="polite"></p><div id="light-preview"></div></div></section><section class="panel"><div class="panel-head"><h2>最近匯入批次</h2></div><div class="panel-body"><p>撤回只移除該批新增資料。資料已修改、附加檔案或被其他內容引用時，會停止撤回。</p><button id="light-history">讀取批次紀錄</button><div id="light-batches"></div></div></section>`;
  }
  function bind(){
    const form=document.querySelector('#light-form');if(!form)return;
    const status=document.querySelector('#light-status'),out=document.querySelector('#light-preview'),select=document.querySelector('#light-project'),fileControl=document.querySelector('#light-file');
    const excludedIds=new Set();
    const filter={kind:'',status:''};
    const visible=r=>(!filter.kind||r.kind===filter.kind)&&(!filter.status||r.status===filter.status);
    select.value=project()==='inbox'?'':project();
    bundle=null;preview=null;undoBatch=null;draftKey=null;
    const invalidate=()=>{bundle=null;preview=null;draftKey=null;excludedIds.clear();out.innerHTML='';status.textContent='請重新預覽成果；同檔案與同專案會接續已保存的排除選擇。';};
    select.onchange=invalidate;document.querySelector('#light-file').onchange=()=>{pendingRaw=null;invalidate();};
    if(pendingRaw){fileControl.required=false;status.textContent='已帶入搜尋勾選結果；請選擇專案並按「預覽成果」。';}
    const setBusy=value=>{
      busy=value;select.disabled=value;fileControl.disabled=value;form.querySelector('button').disabled=value;
      out.querySelectorAll('button').forEach(b=>{b.disabled=value||b.dataset.lightLocked==='true';});
    };
    function drawPreview(openRows=new Set()){
      status.textContent=`預計新增 ${preview.added} 筆，略過 ${preview.skipped} 筆重複資料，已移除 ${preview.removed||0} 筆${preview.automaticRemoved?`（含 ${preview.automaticRemoved} 筆相依資料）`:''}。`;
      status.textContent+=(resumed?' 已接續先前的排除選擇。':'')+(storageWarning?' '+storageWarning:'');
      out.innerHTML=`<p>「移除此筆」只排除本次匯入，可隨時復原，不會刪除既有資料。</p><div class="actions"><label>類型<select data-light-filter="kind"><option value="">全部類型</option>${Object.entries(names).map(([value,label])=>`<option value="${value}" ${filter.kind===value?'selected':''}>${label}</option>`).join('')}</select></label><label>狀態<select data-light-filter="status"><option value="">全部狀態</option>${[['new','新增'],['link','新增專案連結'],['duplicate','重複沿用'],['excluded','已排除']].map(([value,label])=>`<option value="${value}" ${filter.status===value?'selected':''}>${label}</option>`).join('')}</select></label><button type="button" data-light-bulk="exclude">移除篩選結果</button><button type="button" data-light-bulk="restore">復原篩選結果</button></div><p>顯示 ${preview.rows.filter(visible).length}／${preview.rows.length} 筆。</p>${excludedIds.size?'<button type="button" data-light-restore-all>復原全部移除項目</button>':''}<ul>${preview.rows.filter(visible).map(r=>{
        const excluded=r.status==='excluded';
        const action=r.automaticExcluded?'請先復原來源文獻':excluded?'復原此筆':'移除此筆';
        const index=r.rowId?.startsWith('notes:')?Number(r.rowId.split(':')[1]):-1,item=bundle?.notes?.[index],type=item?.kind==='term'?'term':item?.noteType||'quick';
        const typeChoice=index>=0&&r.status==='new'?`<label>匯入為<select data-light-type="${index}">${[['quick','一般筆記／待整理'],['research','研究問題'],['draft','寫作草稿'],['decision','決策紀錄'],['term','字彙詞條']].map(([value,label])=>`<option value="${value}" ${type===value?'selected':''}>${label}</option>`).join('')}</select></label>`:'';
        return `<li style="margin:12px 0;${excluded?'opacity:.75;':''}"><div style="display:flex;gap:12px;align-items:start;flex-wrap:wrap"><details data-light-details="${e(r.rowId)}" ${openRows.has(r.rowId)?'open':''} style="flex:1;min-width:0;overflow-wrap:anywhere"><summary><strong>${e(excluded?'已移除':r.status==='new'?'新增':r.status==='link'?'連結':'沿用')}</strong> · ${e(names[r.kind])} · ${e(r.title)}${r.kind==='source'&&!excluded?` · ${e(r.verification)}`:''}</summary>${(r.details||[]).map(([label,value])=>`<p><strong>${e(label)}</strong><br><span style="white-space:pre-wrap;overflow-wrap:anywhere">${e(value)}</span></p>`).join('')}${r.status==='duplicate'?'<p>顯示既有內容；本次不覆寫類型、分類與釋義。</p>':''}</details>${typeChoice}${r.rowId?`<button type="button" class="small" data-light-row="${e(r.rowId)}" data-light-locked="${Boolean(r.automaticExcluded)}" ${r.automaticExcluded?'disabled':''} aria-label="${e(action+'：'+r.title)}">${e(action)}</button>`:''}</div>${(r.warnings||[]).map(w=>`<p style="overflow-wrap:anywhere"><strong>提示：</strong>${e(w)}</p>`).join('')}</li>`;
      }).join('')}</ul>${preview.added?'<button type="button" id="light-confirm" class="primary">確認匯入這批成果</button>':'<p>沒有待新增項目；可以復原移除項目或選擇其他成果檔。</p>'}`;
      const confirm=document.querySelector('#light-confirm');if(confirm)confirm.onclick=async()=>{
        if(busy||!preview)return;setBusy(true);
        try{const result=await request('commit',{bundle,projectId:target,fingerprint:preview.fingerprint,excludedIds:[...excludedIds]});excludedIds.clear();saveSelection(excludedIds);pendingRaw=null;bundle=null;preview=null;await refresh(true);toast(`已新增 ${result.added} 筆成果，略過 ${result.skipped} 筆重複資料，排除 ${result.removed||0} 筆`);}
        catch(err){status.textContent=err.message;preview=null;confirm.remove();}finally{setBusy(false);}
      };
    }
    out.onchange=async ev=>{
      const key=ev.target.dataset.lightFilter;if(key&&preview){filter[key]=ev.target.value;drawPreview();return;}
      const index=ev.target.dataset.lightType;if(index==null||busy||!preview)return;
      const item=bundle.notes[Number(index)],type=ev.target.value;item.kind=type==='term'?'term':'note';if(type==='term')delete item.noteType;else item.noteType=type;
      setBusy(true);try{await updatePreview();}catch(err){status.textContent=err.message;}finally{setBusy(false);}
    };
    async function updatePreview(){
      const openRows=new Set([...out.querySelectorAll('details[open]')].map(d=>d.dataset.lightDetails));
      preview=null;out.innerHTML='';status.textContent='正在更新預覽…';
      preview=await request('preview',{bundle,projectId:target,excludedIds:[...excludedIds]});
      drawPreview(openRows);
    }
    out.onclick=async ev=>{
      const row=ev.target.closest('[data-light-row]'),restoreAll=ev.target.closest('[data-light-restore-all]'),bulk=ev.target.closest('[data-light-bulk]');
      if((!row&&!restoreAll&&!bulk)||busy||!preview)return;
      if(row?.dataset.lightLocked==='true')return;
      if(bulk){for(const r of preview.rows.filter(visible).filter(r=>!r.automaticExcluded)){if(bulk.dataset.lightBulk==='restore')excludedIds.delete(r.rowId);else excludedIds.add(r.rowId);}}
      else if(restoreAll)excludedIds.clear();else if(excludedIds.has(row.dataset.lightRow))excludedIds.delete(row.dataset.lightRow);else excludedIds.add(row.dataset.lightRow);
      saveSelection(excludedIds);
      const focusRow=row?.dataset.lightRow;
      setBusy(true);
      try{await updatePreview();[...out.querySelectorAll('[data-light-row]')].find(b=>b.dataset.lightRow===focusRow)?.focus();}
      catch(err){status.textContent=err.message+'；請按「預覽成果」重試。';}finally{setBusy(false);}
    };
    document.querySelector('#light-example').onclick=async()=>{try{const data=await request('example');const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='light-inkgraph-example.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}catch(err){status.textContent=err.message;}};
    form.onsubmit=async ev=>{
      ev.preventDefault();if(busy)return;setBusy(true);out.innerHTML='';preview=null;bundle=null;
      const fileControl=document.querySelector('#light-file'),file=fileControl.files[0];
      try{
        if((!file&&!pendingRaw)||file?.size>5_000_000)throw Error('請選擇不超過 5 MB 的 JSON 檔');
        const raw=file?await file.text():pendingRaw;
        try{bundle=JSON.parse(raw);}catch{throw Error('JSON 格式錯誤，請 Codex 重新產生成果包');}
        target=select.value||null;await restoreSelection(raw,target,excludedIds);await updatePreview();
      }catch(err){status.textContent=err.message;}finally{setBusy(false);}
    };
    document.querySelector('#light-history').onclick=async()=>{
      try{
        const list=await request('batches'),box=document.querySelector('#light-batches');if(!box)return;
        box.innerHTML=list.length?list.map(b=>`<p>${e(new Date(b.at).toLocaleString('zh-TW'))} · ${e(b.count)} 筆 <button data-light-undo="${e(b.id)}">撤回此批</button></p>`).join(''):'尚無匯入批次。';
        box.onclick=async ev=>{
          const b=ev.target.closest('[data-light-undo]');if(!b||busy)return;
          if(undoBatch!==b.dataset.lightUndo){undoBatch=b.dataset.lightUndo;b.textContent='確認撤回此批新增資料';return;}
          busy=true;b.disabled=true;
          try{const r=await request('undo',{batch:undoBatch});undoBatch=null;await refresh(true);toast(`已撤回 ${r.removed} 筆成果`);}catch(err){toast(err.message);b.disabled=false;b.textContent='撤回此批';undoBatch=null;}finally{busy=false;}
        };
      }catch(err){toast(err.message);}
    };
  }
  return {render,bind,seed:b=>{pendingRaw=JSON.stringify(b);}};
}
