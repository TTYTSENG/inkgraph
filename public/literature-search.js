export function createLiteratureSearch({api,e,heading,toast,openBundle}) {
  let result=null,busy=false,job=null;
  const names={crossref:'Crossref',europepmc:'Europe PMC',openalex:'OpenAlex'};
  const reasons={page_limit:'已達設定頁數',key_required:'後續翻頁需要 OpenAlex 金鑰',exhausted:'已無下一頁',unavailable:'來源暫不可用',cancelled:'使用者停止'};
  const call=async(path,body)=>(await api('/api/literature/'+path,body?{method:'POST',body}:{})).json();
  function render(){return heading('學術文獻搜尋','搜尋只送出你輸入的查詢文字。先選候選，再預覽匯入；書目與摘要不是全文或主張核驗。')+`<section class="panel"><div class="panel-body"><form id="literature-form"><label>研究問題／關鍵詞<input name="query" required maxlength="300" placeholder="例如 low vision adaptive lighting"></label><div class="actions">${Object.entries(names).map(([id,name])=>`<label><input type="checkbox" name="provider" value="${id}" checked> ${name}</label>`).join('')}</div><label>每來源每頁筆數<input name="size" type="number" min="1" max="25" value="10"></label><label>最多頁數<input name="pages" type="number" min="1" max="5" value="1"></label><div class="actions"><button class="primary">搜尋文獻</button><button id="literature-cancel" type="button">停止搜尋</button></div></form><p id="literature-status" role="status" aria-live="polite"></p><div id="literature-results"></div></div></section><section class="panel"><div class="panel-body"><button id="literature-history">讀取檢索紀錄</button><div id="literature-history-list"></div></div></section>`;}
  function bind(){
    const form=document.querySelector('#literature-form'),out=document.querySelector('#literature-results'),status=document.querySelector('#literature-status');if(!form)return;
    const draw=()=>{
      status.textContent=`${result.query}：${result.candidates.length} 篇候選。`;
      out.innerHTML=`${result.logs.map(l=>`<p><strong>${e(names[l.provider])}</strong>：${l.pages} 頁；${e(reasons[l.stop]||l.stop)} ${e(l.error)}</p>`).join('')}<p>請勾選要帶入預覽的文獻。</p><button type="button" id="literature-all">全選／取消全選</button>${result.candidates.map(r=>`<details><summary><label><input type="checkbox" data-paper="${e(r.key)}"> ${e(r.title)} (${e(r.year)})</label></summary><p>${e(r.authors.map(a=>a.literal||a.family).join('；'))}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${e(r.summary||'來源未提供摘要')}</p><p>DOI：${e(r.doi||'未提供')} · ${e(r.foundVia.join('、'))}</p></details>`).join('')}<button type="button" id="literature-preview" class="primary">將勾選文獻帶入匯入預覽</button>`;
      out.querySelector('#literature-all').onclick=()=>{const checks=[...out.querySelectorAll('[data-paper]')],value=!checks.every(c=>c.checked);checks.forEach(c=>c.checked=value);};
      out.querySelector('#literature-preview').onclick=async()=>{
        try{const keys=[...out.querySelectorAll('[data-paper]:checked')].map(c=>c.dataset.paper);const b=await call('bundle',{id:result.id,keys});openBundle(b);}
        catch(err){toast(err.message);}
      };
    };
    if(result)draw();
    form.onsubmit=async ev=>{
      ev.preventDefault();if(busy)return;busy=true;job=crypto.randomUUID();
      form.querySelector('button').disabled=true;status.textContent='正在查詢文獻來源…';out.innerHTML='';
      const fd=new FormData(form);
      try{result=await call('search',{id:job,query:fd.get('query'),providers:fd.getAll('provider'),pageSize:Number(fd.get('size')),pages:Number(fd.get('pages'))});draw();}
      catch(err){status.textContent=err.message;}finally{busy=false;job=null;form.querySelector('button').disabled=false;}
    };
    document.querySelector('#literature-cancel').onclick=async()=>{if(job){await call('cancel',{id:job});status.textContent='已要求停止，正在保存已取得的紀錄…';}};
    document.querySelector('#literature-history').onclick=async()=>{
      try{const list=await call('history');const box=document.querySelector('#literature-history-list');box.innerHTML=list.map(r=>`<p><button data-run="${e(r.id)}">${e(r.query)} · ${e(new Date(r.at).toLocaleString('zh-TW'))}</button></p>`).join('')||'尚無紀錄';
        box.onclick=async ev=>{const id=ev.target.closest('[data-run]')?.dataset.run;if(id){result=await call('result?id='+encodeURIComponent(id));draw();}};
      }catch(err){toast(err.message);}
    };
  }
  return {render,bind};
}
