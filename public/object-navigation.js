import { OBJECT_KINDS, KIND_LABELS, ROLE_LABELS, objectTitle } from './knowledge-model.js';
import { scopedState, projectsOf } from './project-scope.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mapObjectLinks(content,replace) {
  return String(content||'').replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\[\[連結:([a-zA-Z0-9-]{1,80})\]\]/gu,(marker,code,id)=>code?marker:replace({marker,id}));
}
export function usedObjectLinks(note) {
  if(note?.bodyDeferred&&Array.isArray(note.navigationTargetIds))return [...new Set(note.navigationTargetIds)];
  const ids=new Set();mapObjectLinks(note?.content,({id,marker})=>{ids.add(id);return marker;});return [...ids];
}
export function objectLinkText(id,state=[],hints=[]) {
  const row=state.find(r=>r.id===id&&OBJECT_KINDS.includes(r.kind))||hints.find(r=>r.id===id);
  return row&&row.status!=='missing'?`${objectTitle(row)}（${KIND_LABELS[row.kind]||'研究項目'} · ID：${id}${row.external?'；內容未納入':''}）`:`〔連結目標已移除或未提供：${id}〕`;
}
export function searchObjects(state,{query='',projectId='',kind='',excludeId='',limit=40}={}) {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),projects=new Map(state.filter(r=>r.kind==='project').map(r=>[r.id,r.title])),objects=new Map(state.map(r=>[r.id,r]));
  const hits=scopedState(state,projectId).filter(r=>OBJECT_KINDS.includes(r.kind)&&r.id!==excludeId&&(!kind||r.kind===kind)).map(row=>{
    const title=objectTitle(row),projectNames=projectsOf(row).map(id=>projects.get(id)||id).join('、')||'待整理收件匣';
    const source=objects.get(row.sourceId),byline=(row.authors||[]).map(a=>a.literal||`${a.given||''} ${a.family||''}`).join('、');
    const haystack=[title,row.aliases,row.locator,source?.title,byline,row.year,projectNames,KIND_LABELS[row.kind]].filter(Boolean).join(' ').toLocaleLowerCase();
    const match=words.every(w=>haystack.includes(w)),q=query.trim().toLocaleLowerCase();
    return {row,title,projectNames,byline,year:row.year||'',sourceTitle:source?.title||'',score:title.toLocaleLowerCase()===q?0:title.toLocaleLowerCase().startsWith(q)?1:2,match};
  }).filter(r=>r.match).sort((a,b)=>a.score-b.score||a.title.localeCompare(b.title,'zh-TW')||a.row.id.localeCompare(b.row.id));
  return {total:hits.length,rows:hits.slice(0,limit)};
}
export function previewRecord(row) {
  const body=({source:row.summary||row.text,note:row.content,annotation:row.quote,term:row.definition,concept:row.definition,discussion:row.content,message:row.content})[row.kind]||'';
  return {id:row.id,kind:row.kind,title:objectTitle(row).slice(0,500),revision:row.revision,projectId:row.projectId||null,projectIds:row.projectIds||[],sourceId:row.sourceId||null,sourceIds:row.sourceIds||[],discussionId:row.discussionId||null,role:row.role||'',authors:(row.authors||[]).slice(0,10).map(a=>a.literal||`${a.given||''} ${a.family||''}`.trim()),origin:row.origin||'',locator:(row.locator||'').slice(0,300),verified:row.verified===true,body:String(body).slice(0,1200),truncated:String(body).length>1200,paraphrase:String(row.paraphrase||'').slice(0,400),comment:String(row.comment||'').slice(0,400),sourceRevision:row.sourceRevision||null,year:row.year||'',aliases:String(row.aliases||'').slice(0,500)};
}
export function renderObjectLinks(note,state) {
  const ids=usedObjectLinks(note);if(!ids.length)return '';
  return `<section class="inline-object-links" aria-label="筆記內文連結"><h3>內文連結 · ${ids.length}</h3><p class="quiet-text">供導覽與預覽，不會自動加入 APA 或建立證據關係。名稱隨目標更新。</p>${ids.map(id=>{const row=state.find(r=>r.id===id);return `<div class="inline-link-row"><span>${escape(row?`${KIND_LABELS[row.kind]} · ${objectTitle(row)}`:`目標已移除：${id}`)}</span>${row?`<button type="button" class="small" data-action="nav-preview" data-id="${escape(id)}">預覽</button><button type="button" class="quiet small" data-action="nav-open" data-id="${escape(id)}">開啟</button>`:''}</div>`;}).join('')}</section>`;
}
export const shortcutHints=()=>`<details class="shortcut-help"><summary>快捷鍵與語法提示 · Ctrl＋Shift＋L 連結／Ctrl＋S 儲存</summary><dl><dt>Ctrl＋Shift＋L</dt><dd>在筆記游標位置插入研究連結</dd><dt>Ctrl＋Shift＋K</dt><dd>快速切換研究項目</dd><dt>Ctrl＋K／Ctrl＋N</dt><dd>全文搜尋／新增隨記</dd><dt>Ctrl＋S</dt><dd>儲存目前筆記</dd><dt>↑ ↓、Enter、Esc</dt><dd>搜尋視窗中移動選項、選取、取消；中文選字時不觸發選取</dd><dt>[[連結:項目ID]]</dt><dd>研究導覽連結；建議用「連結研究項目」自動插入</dd><dt>[@來源ID, p. 12]</dt><dd>APA 引用；頁碼請填原書刊印刷頁碼</dd><dt>[[摘錄:引用ID]]</dt><dd>固定版本摘錄；由「加入筆記」產生，不是即時更新的全文嵌入</dd><dt># 標題、- 清單、&gt; 引文</dt><dd>常用 Markdown 語法。快捷鍵亦接受 Mac 的 Command 鍵。</dd></dl></details>`;

export function createObjectNavigation({entities,project,api,dialog,toast,open,capture,insert,restore,save,formal,dom=globalThis.document}) {
  let mode='switch',context=null,rows=[],active=0,scope='',kind='',needle='',sequence=0,returnPoint=null,busy=false;
  const d=()=>dom.querySelector('#dialog');
  const btn=(action,label,id='')=>`<button type="button" class="small" data-action="nav-${action}" data-id="${escape(id)}">${escape(label)}</button>`;
  function close(){sequence++;d().close();if(returnPoint){restore(returnPoint);returnPoint=null;}delete d().dataset.objectNavigation;}
  d().addEventListener('close',()=>{sequence++;if(returnPoint&&d().dataset.objectNavigation){restore(returnPoint);returnPoint=null;}delete d().dataset.objectNavigation;});
  function picker(nextMode='switch',savedContext=null) {
    if(d().open&&!d().dataset.objectNavigation){toast('請先關閉目前視窗');return;}
    sequence++;mode=nextMode;context=savedContext||(mode==='insert'?capture():null);if(mode==='insert'&&!context)return;
    returnPoint=context||capture(false);scope=project();kind='';needle='';active=0;
    showPicker();
  }
  function showPicker() {
    const currentProject=project(),scopeName=entities().find(r=>r.id===currentProject)?.title||(currentProject==='inbox'?'待整理收件匣':'目前專案');
    dialog(mode==='insert'?'連結研究項目 · Ctrl＋Shift＋L':'快速切換 · Ctrl＋Shift＋K',`<p class="quiet-text">${mode==='insert'?'插入游標位置／取代選取文字；只建立內文導覽，正式關係另行確認。':'開啟項目前會檢查尚未儲存的筆記。'}搜尋名稱、別名、作者或來源；全文搜尋仍使用 Ctrl＋K。</p><label>搜尋研究項目<input id="object-search" autocomplete="off" aria-describedby="object-search-help"></label><div class="navigation-filters"><label>範圍<select id="object-scope">${currentProject?`<option value="${escape(currentProject)}">${escape(scopeName)}</option>`:''}<option value="">全部專案</option></select></label><label>種類<select id="object-kind"><option value="">全部種類</option>${Object.entries(KIND_LABELS).map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></label></div><p id="object-search-help" class="quiet-text">↑ ↓ 選擇，Enter ${mode==='insert'?'插入':'開啟'}，Esc 取消；也可點按選項。Mac 可用 Command 取代 Ctrl。</p><p id="object-result-status" role="status"></p><div id="object-results" class="object-results" role="list"></div>`,btn('selected-preview','預覽目前選項')+btn('cancel','取消'));
    d().dataset.objectNavigation='picker';dom.querySelector('#object-scope').value=scope;
    const search=dom.querySelector('#object-search');search.value=needle;
    search.oninput=()=>{needle=search.value;active=0;renderResults();};
    search.onkeydown=async ev=>{
      if(ev.isComposing||ev.keyCode===229)return;
      if(['ArrowDown','ArrowUp'].includes(ev.key)){ev.preventDefault();active=Math.max(0,Math.min(rows.length-1,active+(ev.key==='ArrowDown'?1:-1)));markActive();}
      if(ev.key==='Enter'){ev.preventDefault();if(rows[active])try{await choose(rows[active].row.id);}catch(err){dom.querySelector('#form-error').textContent=err.message;}}
    };
    for(const id of ['object-scope','object-kind'])dom.querySelector('#'+id).onchange=()=>{scope=dom.querySelector('#object-scope').value;kind=dom.querySelector('#object-kind').value;active=0;renderResults();};
    renderResults();search.focus();
  }
  function renderResults() {
    const result=searchObjects(entities(),{query:needle,projectId:scope,kind,excludeId:mode==='insert'?context?.noteId:''});rows=result.rows;
    dom.querySelector('#object-result-status').textContent=`${result.total} 筆符合，顯示前 ${rows.length} 筆；同名項目請核對種類、出處與專案。`;
    dom.querySelector('#object-results').innerHTML=rows.map(({row,title,projectNames,sourceTitle,byline,year},i)=>`<article role="listitem"><button type="button" class="object-result" data-action="nav-choose" data-id="${escape(row.id)}" data-result-index="${i}"><span class="badge gray">${escape(KIND_LABELS[row.kind])}</span><strong>${escape(title)}</strong><small>${escape(projectNames)}${byline?` · ${escape(byline)}`:""}${year?` · ${escape(year)}`:""}${sourceTitle?` · ${escape(sourceTitle)}`:''}${row.locator?` · ${escape(row.locator)}`:''}</small><small>ID：${escape(row.id)}</small></button></article>`).join('')||'<p class="notice">沒有符合項目。可以改選全部專案，或用 Ctrl＋K 搜尋全文。</p>';
    markActive(false);
  }
  function markActive(scroll=true) {
    dom.querySelectorAll('[data-result-index]').forEach(el=>{const selected=Number(el.dataset.resultIndex)===active;el.classList.toggle('selected',selected);if(selected){el.setAttribute('aria-current','true');if(scroll)el.scrollIntoView({block:'nearest'});}else el.removeAttribute('aria-current');});
  }
  async function choose(id) {
    if(busy)return;const row=entities().find(r=>r.id===id);if(!row)throw new Error('項目已移除，請重新搜尋');
    if(mode==='insert'){insert(id,context);returnPoint=null;close();toast('連結已插入草稿，請儲存筆記');}
    else {busy=true;try{if(await open(row)!==false)close();}finally{busy=false;}}
  }
  async function preview(id) {
    const seq=++sequence;const back=d().dataset.objectNavigation==='picker';
    if(!back){mode='preview';context=null;}
    if(!returnPoint)returnPoint=capture(false);
    dialog('研究項目預覽','<p role="status">正在讀取目前版本…</p>',(back?btn('back','回到搜尋'):'')+btn('cancel','關閉'));
    d().dataset.objectNavigation='preview';
    try{
      const row=await(await api('/api/entity?id='+encodeURIComponent(id)+'&preview=1')).json();if(seq!==sequence||!d().open)return;
      const names=projectsOf(row).map(id=>entities().find(r=>r.id===id)?.title||id).join('、')||'待整理收件匣';
      const source=entities().find(r=>r.id===row.sourceId),sourceChanged=row.kind==='annotation'&&row.sourceRevision&&source?.revision!==row.sourceRevision;
      dialog('研究項目預覽',`<span class="badge gray">${escape(KIND_LABELS[row.kind])}</span><h3>${escape(row.title)}</h3>${row.authors?.length||row.year?`<p class="quiet-text">${escape((row.authors||[]).join("、"))}${row.year?` · ${escape(row.year)}`:""}</p>`:""}${row.role?`<p>訊息角色：${escape(ROLE_LABELS[row.role]||row.role)}</p>`:""}${row.role==="assistant"||["gemini","notebooklm"].includes(row.origin)?`<p class="notice">AI 對話／筆記是待核對素材，正式引用請回到原始文獻。</p>`:""}<p class="quiet-text">${escape(names)} · 目前版本 ${escape(row.revision)} · ID：${escape(row.id)}</p>${row.locator?`<p>定位：${escape(row.locator)} · ${row.verified?'已人工核對':'待核對'}${sourceChanged?' · 原始來源已變更，請重新核對':''}</p>`:''}${row.aliases?`<p>別名：${escape(row.aliases)}</p>`:''}<div class="object-preview-body">${escape(row.body||'尚無摘要內容')}</div>${row.truncated?'<p class="quiet-text">只顯示前 1,200 字；開啟項目可看完整內容。</p>':''}${row.paraphrase?`<p class="object-preview-body">釋義：${escape(row.paraphrase)}</p>`:''}${row.comment?`<p class="object-preview-body">加註：${escape(row.comment)}</p>`:''}<p class="quiet-text">這是目前版本的預覽，不會改寫筆記中的引用快照。</p>`,(back?btn('back','回到搜尋'):'')+btn('open','開啟項目',row.id)+(mode==='insert'&&context?btn('choose','插入此連結',row.id):'')+(formal&&capture(false)?.noteId!==row.id&&capture(false)?.noteId?btn('formal','建立正式關係…',row.id):'')+btn('cancel','關閉'));
      d().dataset.objectNavigation='preview';
    }catch(err){if(seq===sequence&&d().open){dom.querySelector('.dialog-body').innerHTML=`<p class="notice">${escape(err.message)}。草稿未變更；請重新搜尋或檢查目標是否已移除。</p>`;}}
  }
  async function handle(action,id) {
    if(action==='nav-insert')picker('insert');
    else if(action==='nav-switch')picker('switch');
    else if(action==='nav-choose')await choose(id);
    else if(action==='nav-preview')await preview(id);
    else if(action==='nav-selected-preview'&&rows[active])await preview(rows[active].row.id);
    else if(action==='nav-back'){sequence++;showPicker();}
    else if(action==='nav-cancel')close();
    else if(action==='nav-open'){const row=entities().find(r=>r.id===id);if(!row)throw new Error('項目已移除');if(await open(row)!==false&&d().open)close();}
    else if(action==='nav-formal'){sequence++;delete d().dataset.objectNavigation;returnPoint=null;await formal(id);}
  }
  function keydown(ev) {
    if(ev.isComposing||ev.keyCode===229||!(ev.ctrlKey||ev.metaKey)||ev.altKey)return false;
    const key=ev.key.toLowerCase();
    if(ev.shiftKey&&(key==='k'||key==='l')){ev.preventDefault();if(!ev.repeat)picker(key==='l'?'insert':'switch');return true;}
    if(key==='s'&&!ev.shiftKey&&dom.querySelector('#note-content')&&!d().open){ev.preventDefault();if(!ev.repeat)Promise.resolve(save()).catch(err=>toast(err.message));return true;}
    return false;
  }
  return {handle,keydown,canHandle:action=>action.startsWith('nav-')};
}
