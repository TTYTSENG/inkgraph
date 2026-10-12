const token = document.querySelector('meta[name="inkgraph-token"]').content;
const $ = s => document.querySelector(s);
const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  home:'M3 10 12 3l9 7v10H3V10m6 10v-7h6v7',book:'M3 4h7l2 2 2-2h7v16h-7l-2 1-2-1H3V4m9 2v15',quote:'M5 5h6v7H5V5m8 0h6v7h-6V5M5 12c0 4 2 6 5 6m3-6c0 4 2 6 5 6',term:'M3 5h18M8 5v15m-5 0h10M16 12l4 8m-8 0 4-8m-2 5h4',note:'M4 3h12l4 4v14H4V3m12 0v5h4M8 12h8m-8 4h6',matrix:'M3 4h18v16H3V4m0 5h18M9 4v16m6-16v16',graph:'M6 5l12 7M6 19l12-7M6 5v14m-3-14a3 3 0 1 0 6 0 3 3 0 1 0-6 0m12 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0m-12 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0',cite:'M4 4h16v16H4V4m4 5h8m-8 4h6m-6 4h8',export:'M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6',search:'M17 17l5 5M3 10a7 7 0 1 0 14 0 7 7 0 1 0-14 0',upload:'M12 16V3m-4 4 4-4 4 4M4 15v6h16v-6',settings:'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0',plus:'M12 4v16M4 12h16',inbox:'M4 3h16l2 15v3H2v-3L4 3m-2 15h6l2 3h4l2-3h6',arrow:'M5 12h14m-5-5 5 5-5 5',shield:'m12 3 8 3v7c0 5-8 8-8 8s-8-3-8-8V6l8-3m-4 9 3 3 5-6'
};
const icon = (name) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || paths.note}"/></svg>`;
const labels = {dashboard:'研究總覽',inbox:'待整理收件匣',sources:'來源文獻庫',annotations:'摘錄與加註',terms:'字彙辭典',notes:'隨記與寫作',matrix:'文獻比較表',graph:'文獻脈絡',references:'APA 引用清單',exports:'輸出與備份',settings:'設定與說明',source:'閱讀工作區',note:'寫作工作區',search:'搜尋結果'};
const relationLabels = {supports:'支持',contradicts:'反駁',extends:'延伸',compares:'比較'};
const origins = {local:'本機檔案',gemini:'Gemini',notebooklm:'NotebookLM',manual:'手動建立',demo:'示範資料'};
let entities=[], view='dashboard', selectedId='', project='', query='', selectedQuote='', selectedPage='', readerMode='text', citations=null, aiAnswer='', aiKey='', aiModel='', noteDraft=null, toastTimer;

async function api(path, opts={}) {
  const headers={'x-inkgraph-token':token,...opts.headers};
  if(opts.body && typeof opts.body!=='string' && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer)) {opts.body=JSON.stringify(opts.body);headers['Content-Type']='application/json';}
  const response=await fetch(path,{...opts,headers});
  if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error||`請求失敗 (${response.status})`);}
  return response;
}
const toast = message => {$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),5000);};
const byId = id => entities.find(x=>x.id===id);
const ofKind = kind => entities.filter(x=>x.kind===kind);
function scope() {
  if(!project)return entities;
  if(project==='inbox')return entities.filter(x=>x.kind!=='project'&&!x.projectId);
  const ids=new Set(ofKind('source').filter(s=>s.projectId===project).map(s=>s.id));
  return entities.filter(x=>x.id===project||(x.kind==='relation'?ids.has(x.from)&&ids.has(x.to):x.sourceId?ids.has(x.sourceId):x.projectId===project));
}
const records = kind => scope().filter(x=>x.kind===kind);
const authors = s => (s.authors||[]).map(a=>a.literal||`${a.given||''} ${a.family||''}`.trim()).join('、');
const tags = record => String(record.tags||'').split(/[,，]/).filter(Boolean).map(t=>`<span class="tag">${e(t.trim())}</span>`).join('');
const date = record => new Date(record.updated||Date.now()).toLocaleDateString('zh-TW');
const titleLink = (s) => `<a href="#source/${e(s.id)}">${e(s.title)}</a>`;
function empty(title,desc,action='import',button='匯入來源',ico='book') {return `<div class="empty">${icon(ico)}<strong>${e(title)}</strong><p>${e(desc)}</p>${action?`<button class="primary" data-action="${action}">${e(button)}</button>`:''}</div>`;}
function heading(title,sub,actions=''){return `<header class="page-heading"><div><p class="eyebrow">INKGRAPH / YOUR LOCAL RESEARCH SPACE</p><h1>${e(title)}</h1><p>${e(sub)}</p></div><div class="actions">${actions}</div></header>`;}
function button(action,label,cls='',id=''){return `<button class="${cls}" data-action="${action}" ${id?`data-id="${e(id)}"`:''}>${e(label)}</button>`;}
function field(label,name,value='',type='text',help='',required=false,full=false) {
  return `<label class="${full?'full':''}">${e(label)}${required?' *':''}${type==='textarea'?`<textarea name="${name}" ${required?'required':''}>${e(value)}</textarea>`:`<input name="${name}" type="${type}" value="${e(value)}" ${required?'required':''}>`}${help?`<small>${e(help)}</small>`:''}</label>`;
}
function selectField(label,name,options,value='',help='',full=false) {return `<label class="${full?'full':''}">${e(label)}<select name="${name}">${options.map(([v,t])=>`<option value="${e(v)}" ${v===value?'selected':''}>${e(t)}</option>`).join('')}</select>${help?`<small>${e(help)}</small>`:''}</label>`;}
const projectField = value => selectField('所屬專案','projectId',[['','待整理收件匣'],...ofKind('project').map(p=>[p.id,p.title])],value||'');
const sourceField = (value,allowEmpty=true) => selectField('來源文獻','sourceId',[...(allowEmpty?[['','個人整理／未指定']]:[]),...ofKind('source').map(s=>[s.id,s.title])],value||'');
function dialog(title,body,footer='',onSubmit=null) {
  const d=$('#dialog'); d.innerHTML=`<form id="dialog-form"><div class="dialog-header"><h2>${e(title)}</h2><button type="button" class="quiet" data-action="close-dialog" aria-label="關閉">✕</button></div><div class="dialog-body"><div id="form-error" class="error" role="alert"></div>${body}</div><div class="dialog-footer">${footer||'<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">儲存</button>'}</div></form>`;
  if(!d.open)d.showModal();
  $('#dialog-form').onsubmit=async ev=>{
    ev.preventDefault();if(!onSubmit)return;const b=$('#dialog-form button[type="submit"]');if(b)b.disabled=true;
    try{await onSubmit(new FormData(ev.target));}catch(error){$('#form-error').textContent=error.message;}finally{if(b)b.disabled=false;}
  };
}
async function refresh(shell=false) {
  const pending=dirty()?{content:$('#note-content').value,draft:{...noteDraft}}:null;
  entities=(await(await api('/api/state')).json()).entities;citations=null;if(shell)renderShell();else renderMain();
  if(pending&&view==='note'&&byId(pending.draft.id)?.content!==pending.content&&$('#note-content')) {
    $('#note-content').value=pending.content;noteDraft=pending.draft;$('#note-save-status').textContent='有尚未儲存的修改';
  }
}
async function save(kind,data,id) {const entity=await(await api('/api/entities',{method:'POST',body:{kind,data,...(id?{id}: {})}})).json();await refresh();return entity;}
function formSave(kind,record,body) {
  dialog(`${record?'編輯':'新增'}${{project:'專案',source:'來源',annotation:'摘錄',term:'術語',note:'隨記',relation:'文獻關係'}[kind]}`,body,'',async fd=>{
    let data={...(record||{}),...Object.fromEntries(fd)};
    if(kind==='source') {
      data.authors=String(data.authorsText||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>x.includes(',')?{family:x.split(',')[0].trim(),given:x.split(',').slice(1).join(',').trim()}:{literal:x});delete data.authorsText;
      if(!record){data.text=data.text||'';data.pages=[];data.parseStatus='手動建立';data.warnings=[];}
    }
    if(kind==='annotation') {const s=byId(data.sourceId);data.projectId=s?.projectId||null;data.verified=fd.has('verified');data.sourceRevision=s?.revision;data.sourceHash=s?.fileHash||'';}
    if(kind==='term'&&data.sourceId)data.projectId=byId(data.sourceId)?.projectId||null;
    if(kind==='note')data.sourceIds=record?.sourceIds||[];
    data.projectId=data.projectId||null;
    const result=await save(kind,data,record?.id);$('#dialog').close();toast('已儲存在本機');
    if(kind==='project'){project=result.id;renderShell();}
    if(kind==='source')go('source',result.id);
  });
}
function editProject(record) {formSave('project',record,field('專案名稱','title',record?.title,'text','例如：博士論文、產業研究或閱讀筆記',true)+field('研究問題／目的','description',record?.description,'textarea')+selectField('主要用途','purpose',[['academic','學術研究'],['project','專案整理'],['personal','日常學習']],record?.purpose||'academic'));}
function editSource(record) {
  const authorText=(record?.authors||[]).map(a=>a.literal||`${a.family}, ${a.given||''}`).join('; ');
  formSave('source',record,`<div class="form-grid">${field('文獻／來源標題','title',record?.title,'text','',true,true)}${selectField('引用類型','cslType',[['article-journal','期刊論文'],['book','書籍'],['report','研究報告'],['webpage','網頁'],['manuscript','未出版文稿'],['personal-communication','AI 對話／筆記（不列入 APA）']],record?.cslType||'article-journal')}${selectField('資料來源','origin',Object.entries(origins).filter(([k])=>k!=='demo'),record?.origin||'manual')}${field('作者','authorsText',authorText,'text','英文：姓氏, 名字；多位作者用半形分號 ; 分隔。無逗號視為完整姓名／機構名稱。',false,true)}${field('出版年份','year',record?.year,'text','四位數，例如 2024')}${field('期刊名稱','journal',record?.journal)}${field('卷','volume',record?.volume)}${field('期','issue',record?.issue)}${field('頁碼範圍','pageRange',record?.pageRange)}${field('出版社','publisher',record?.publisher)}${field('DOI','doi',record?.doi,'text','例如 10.1234/example')}${field('來源網址','url',record?.url,'url')}${projectField(record?.projectId||project)}${field('標籤','tags',record?.tags,'text','用逗號分隔')}${field('摘要／重點','summary',record?.summary,'textarea','',false,true)}${field('研究方法','method',record?.method,'textarea')}${field('主要發現','findings',record?.findings,'textarea')}${field('研究限制','limitations',record?.limitations,'textarea','',false,true)}${!record?field('貼上原文／對話','text','','textarea','請保留角色標記、時間與原文引用資訊。',false,true):''}</div>`);
}
function editAnnotation(record,sourceId) {
  const source=byId(record?.sourceId||sourceId||selectedId);
  formSave('annotation',record,`${sourceField(source?.id,false)}${field('原文摘錄','quote',record?.quote||selectedQuote,'textarea','逐字保留原文；翻譯請寫在釋義欄。',true)}<div class="form-grid">${field('來源定位','locator',record?.locator||(selectedPage?`檔案第 ${selectedPage} 頁；印刷頁碼待核對`:''),'text','例如：印刷 p. 23／檔案第 28 頁；或第 4 段。',true)}${field('相關術語','term',record?.term,'text','建立辭典後，可使用同一術語名称。')}</div>${field('釋義／翻譯','paraphrase',record?.paraphrase,'textarea')}${field('我的加註／質疑','comment',record?.comment,'textarea')}<label class="checkbox"><input type="checkbox" name="verified" ${record?.verified?'checked':''}>我已人工對照原文及位置</label>`);
}
function editTerm(record,sourceId) {formSave('term',record,field('術語名稱','title',record?.title||selectedQuote,'text','',true)+field('外文／別名','aliases',record?.aliases)+field('定義／作者的用法','definition',record?.definition,'textarea')+field('例句／應用','example',record?.example,'textarea')+sourceField(record?.sourceId||sourceId)+projectField(record?.projectId||project)+field('標籤','tags',record?.tags));}
function editNote(record) {formSave('note',record,field('筆記標題','title',record?.title||`隨記 · ${new Date().toLocaleDateString('zh-TW')}`,'text','',true)+projectField(record?.projectId||project)+selectField('筆記用途','noteType',[['quick','隨記'],['research','研究問題'],['draft','寫作草稿'],['decision','決策紀錄']],record?.noteType||'quick')+field('內容','content',record?.content,'textarea','可使用 Markdown；在寫作工作區可插入文內引用。')+field('標籤','tags',record?.tags));}
function editRelation(record) {const choices=records('source').map(s=>[s.id,s.title]);if(choices.length<2){toast('請先在目前專案建立至少兩個來源');return;}formSave('relation',record,selectField('從這份文獻','from',choices,record?.from||choices[0][0])+selectField('關係','relation',Object.entries(relationLabels),record?.relation||'supports')+selectField('連到這份文獻','to',choices,record?.to||choices[1][0])+field('理由與證據位置','reason',record?.reason,'textarea','寫明支持或反駁哪一項主張，以及證據頁碼。')+projectField(record?.projectId||project));}
function renderShell() {
  const navigation=[['dashboard','home'],['inbox','inbox'],['sources','book'],['annotations','quote'],['terms','term'],['notes','note'],['matrix','matrix'],['graph','graph'],['references','cite'],['exports','export']];
  const counts={inbox:entities.filter(x=>x.kind!=='project'&&!x.projectId).length,sources:records('source').length,annotations:records('annotation').length,terms:records('term').length,notes:records('note').length};
  $('#app').innerHTML=`<div class="layout"><aside class="sidebar"><div class="brand"><img src="/icon.svg" alt=""><div><strong>墨脈</strong><small>INKGRAPH</small></div></div><div class="nav-label">研究工作台</div><nav class="nav" aria-label="主要導覽">${navigation.map(([v,i])=>`<button data-view="${v}" class="${view===v?'active':''}">${icon(i)}<span>${labels[v]}</span>${counts[v]!==undefined?`<span class="nav-count">${counts[v]}</span>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="local-status"><span class="dot"></span>資料保存在本機</div><div>你的資料，你的研究脈絡。</div><button data-view="settings">設定與使用說明 ↗</button><div class="attribution">v0.1.0 · Open source</div></div></aside><section class="workspace"><div class="topbar"><div class="breadcrumb">我的工作台 <strong>/ ${e(labels[view])}</strong></div><label class="search" aria-label="全文搜尋">${icon('search')}<input id="search" type="search" value="${e(query)}" placeholder="搜尋文獻、摘錄、術語與筆記…" aria-label="全文搜尋"><kbd>Ctrl K</kbd></label><select id="project-filter" class="project-select" aria-label="切換專案"><option value="">全部專案</option>${ofKind('project').map(p=>`<option value="${e(p.id)}" ${project===p.id?'selected':''}>${e(p.title)}</option>`).join('')}</select><button class="primary" data-action="new-note">＋ 隨記</button></div><main id="main" tabindex="-1"></main></section></div>`;
  renderMain();
}
function sourceRow(s) {
  const ext=s.attachment?.name.split('.').pop()?.toUpperCase()||'TXT';
  return `<div class="source-row"><div class="file-icon ${s.mime?.startsWith('image/')?'image':ext==='PDF'?'':'text'}">${e(ext.slice(0,4))}</div><div class="source-row-main">${titleLink(s)}<small>${e(authors(s)||origins[s.origin]||'作者待補')} ${s.year?`· ${e(s.year)}`:''} · ${date(s)} ${s.projectId?`· ${e(byId(s.projectId)?.title||'')}`:'· 待整理'}</small></div><span class="badge ${!s.authors?.length?'amber':''}">${s.authors?.length?'已填作者':'書目待補'}</span><button class="quiet small" data-action="edit-source" data-id="${e(s.id)}">編輯</button></div>`;
}
function dashboard() {
  const sources=records('source'),notes=records('note'),annotations=records('annotation'),terms=records('term');
  const quote=annotations[0];const projectTitle=byId(project)?.title;
  return heading(projectTitle||'讓閱讀，長成自己的脈絡。','從原始資料出發，累積可追溯、可引用、可輸出的研究。',button('new-project','＋ 建立專案')+button('import','匯入來源','primary'))+
    `<div class="stats">${[['來源文獻',sources.length,'book','原檔完整保存在本機'],['文段摘錄',annotations.length,'quote',`${annotations.filter(a=>!a.verified).length} 段待人工核對`],['字彙辭典',terms.length,'term','在不同文獻之間連結概念'],['隨記與草稿',notes.length,'note','從靈感到自己的論點']].map(([t,n,i,d])=>`<div class="stat"><div class="stat-top">${t}${icon(i)}</div><strong>${n.toString().padStart(2,'0')}</strong><small>${d}</small></div>`).join('')}</div><div class="dashboard-columns"><div><section class="panel"><div class="panel-head"><h2>把研究帶進來</h2><span class="badge gray">LOCAL FIRST</span></div><div class="panel-body"><div class="dropzone" data-action="import" tabindex="0" role="button" aria-label="匯入本機檔案">${icon('upload')}<strong>拖曳檔案到這裡，或點擊選取</strong><small>PDF · DOCX · Markdown · 對話文字 · 圖片 / 每個檔案最多 25 MB</small></div><div class="actions" style="margin-top:15px">${button('paste-source','貼上 Gemini／NotebookLM 對話','small')}${button('new-source','手動建立文獻','small')}</div></div></section><section class="panel"><div class="panel-head"><h2>最近加入的來源</h2><button class="quiet small" data-view="sources">查看全部 →</button></div>${sources.length?sources.slice(0,5).map(sourceRow).join(''):empty('第一份來源，從這裡開始','匯入文獻或對話後，就可以閱讀、摘錄並建立概念。','demo','載入示範專案')}</section><section class="panel"><div class="panel-head"><h2>最近的思考</h2><button class="quiet small" data-view="notes">全部筆記 →</button></div>${notes.length?notes.slice(0,3).map(n=>`<div class="source-row"><div class="file-icon text">NOTE</div><div class="source-row-main"><a href="#note/${e(n.id)}">${e(n.title)}</a><small>${e((n.content||'').slice(0,80))}</small></div><span class="date">${date(n)}</span></div>`).join(''):empty('捕捉一個問題或靈感','隨記可以連到文獻，也可以之後再整理。','new-note','寫一則隨記','note')}</section></div><aside class="dashboard-side"><div class="quote-feature"><p class="eyebrow">${quote?'FROM YOUR READING':'YOUR RESEARCH, CONNECTED'}</p><blockquote>${e(quote?.quote||'讓每一段摘錄都有出處，讓每一個想法找到連結。')}</blockquote><small>${quote?`${e(byId(quote.sourceId)?.title||'來源')} · ${e(quote.locator)}`:'墨脈 · 研究工作台'}</small></div><section class="panel"><div class="panel-head"><h2>一條完整的研究路徑</h2></div><div class="panel-body">${[['保留來源','匯入原始文獻、對話或圖片。'],['摘錄與釋義','把原文、解釋和自己的判斷分開。'],['連結概念與證據','建立術語、比較方法與研究發現。'],['寫作與輸出','帶著引用，整理成可分享的成果。']].map(([t,d],i)=>`<div class="guide-item"><span class="step">${i+1}</span><div><strong>${t}</strong><p>${d}</p></div></div>`).join('')}</div></section><section class="panel"><div class="panel-body"><strong style="font-size:13px">開放格式，完整帶走。</strong><p class="quiet-text">筆記、摘錄、辭典與來源關係皆可匯出；完整備份包含原始附件。</p><button class="small" data-view="exports">前往輸出與備份 →</button></div></section></aside></div>`;
}
function sourceList(inbox=false) {
  const list=inbox?ofKind('source').filter(s=>!s.projectId):records('source');
  const other=inbox?entities.filter(x=>x.kind!=='project'&&x.kind!=='source'&&!x.projectId):[];
  return heading(inbox?'先收集，再慢慢整理。':'來源文獻庫',inbox?'編輯資料並指定專案，讓收件匣中的資料進入研究脈絡。':'原始文獻、對話與圖片，都是思考的起點。',button('paste-source','貼上對話')+button('import','匯入來源','primary'))+`<div class="toolbar"><span>${list.length} 份來源${inbox?` · ${other.length} 份其他資料`:''}</span>${button('new-source','＋ 手動建立','small')}</div><section class="panel">${list.length?list.map(sourceRow).join(''):empty('目前沒有來源','上傳檔案或貼上對話，原始資料會保存在本機。')}</section>${other.length?`<div class="card-grid">${other.map(recordCard).join('')}</div>`:''}`;
}
function recordCard(r) {
  if(r.kind==='annotation')return `<article class="record-card"><span class="badge ${r.verified?'':'amber'}">${r.verified?'已人工核對':'待核對'}</span><blockquote>${e(r.quote)}</blockquote><p>${e(r.paraphrase||'尚未填寫釋義')}</p>${r.comment?`<p class="quiet-text">加註：${e(r.comment)}</p>`:''}<div class="quiet-text">${e(r.locator)}</div><div class="card-footer"><a href="#source/${e(r.sourceId)}">${e(byId(r.sourceId)?.title||'原始來源')}</a>${button('edit-annotation','編輯','quiet small',r.id)}</div></article>`;
  if(r.kind==='term')return `<article class="record-card"><span class="badge gray">GLOSSARY</span><h2>${e(r.title)}</h2><div class="quiet-text">${e(r.aliases)}</div><p class="definition">${e(r.definition||'尚未填寫定義')}</p>${r.example?`<p class="quiet-text">例句：${e(r.example)}</p>`:''}${tags(r)}<div class="card-footer">${r.sourceId?`<a class="quiet-text" href="#source/${e(r.sourceId)}">查看來源 →</a>`:'<span class="quiet-text">個人整理</span>'}${button('edit-term','編輯','quiet small',r.id)}</div></article>`;
  if(r.kind==='note')return `<article class="record-card"><span class="badge gray">${e(({quick:'隨記',research:'研究問題',draft:'寫作草稿',decision:'決策紀錄'})[r.noteType]||'筆記')}</span><h2><a href="#note/${e(r.id)}">${e(r.title)}</a></h2><p class="note-preview">${e(r.content||'')}</p>${tags(r)}<div class="card-footer"><span class="date">${date(r)}</span>${button('edit-note','編輯資料','quiet small',r.id)}</div></article>`;
  return '';
}
function cardList(kind) {
  const list=records(kind);const titles={annotation:['摘錄與加註','保留原文，在釋義與自己的判斷之間建立清楚的界線。'],term:['把概念，整理成自己的語言。','同一術語可建立多筆條目，保留不同作者的定義。'],note:['捕捉靈感，逐步形成論點。','隨記、研究問題、決策與寫作草稿都在這裡。']};
  const [t,s]=titles[kind];
  return heading(t,s,button(`new-${kind}`,`＋ 新增${{annotation:'摘錄',term:'術語',note:'筆記'}[kind]}`,'primary'))+`<div class="toolbar"><span>${list.length} 筆資料</span><div class="actions">${button('export-markdown','匯出 Markdown','small')}${kind==='term'?button('export-glossary','匯出 CSV','small'):''}</div></div>${list.length?`<div class="card-grid">${list.map(recordCard).join('')}</div>`:empty('留下一筆自己的整理','新增內容後，就能連到來源、加入專案，並輸出分享。',`new-${kind}`,'新增內容',kind==='term'?'term':kind==='annotation'?'quote':'note')}`;
}
function sourceReader() {
  const s=byId(selectedId);if(!s||s.kind!=='source')return empty('找不到來源','請回到來源文獻庫。','', '', 'book');
  const aa=ofKind('annotation').filter(a=>a.sourceId===s.id),tt=ofKind('term').filter(t=>t.sourceId===s.id),rr=ofKind('relation').filter(r=>r.from===s.id||r.to===s.id);
  const url=s.attachment?`/files/${e(s.attachment.id)}`:'';
  let content='';
  if(readerMode==='original'&&url){content=s.mime?.startsWith('image/')?`<img src="${url}" class="image-preview" alt="${e(s.title)}">`:s.mime==='application/pdf'?`<iframe class="file-preview" src="${url}" title="原始 PDF"></iframe>`:`<p>這種格式請下載後使用對應的程式開啟。</p><a href="${url}" download>下載原始檔案 →</a>`;}
  else {content=`<div id="source-text" class="source-text">${s.pages?.length?s.pages.map(p=>`<section class="source-page" data-page="${p.number}"><div class="page-number">檔案第 ${p.number} 頁 · 印刷頁碼請核對原檔</div>${e(p.text)||'<span class="quiet-text">此頁沒有可擷取文字。</span>'}</section>`).join(''):e(s.text||'這份來源沒有可擷取文字。請切換原始檔案閱讀，或手動建立摘錄。')}</div>`;}
  return heading('閱讀與思考','選取文字後建立摘錄；PDF 頁碼與印刷頁碼請分別核對。',button('edit-source','編輯書目','',s.id)+button('ai','AI 整理','',s.id)+button('new-annotation','＋ 建立摘錄','primary',s.id))+`<div class="reader-grid"><section class="reader-main">${(s.warnings||[]).map(w=>`<div class="notice">${e(w)}</div>`).join('')}${s.origin==='gemini'||s.origin==='notebooklm'?'<div class="notice">AI 對話與筆記是整理素材。正式引用請核對其指向的原始文獻。</div>':''}<div class="tabs"><button data-action="reader-text" class="${readerMode==='text'?'active':''}">文字閱讀</button>${url?`<button data-action="reader-original" class="${readerMode==='original'?'active':''}">原始檔案</button><a class="quiet-text" href="${url}" download style="padding:10px">下載原檔 ↗</a>`:''}</div><article class="reader-sheet"><h2>${e(s.title)}</h2><div class="reader-meta">${e(authors(s)||'作者待補')} ${s.year?`· ${e(s.year)}`:''} · ${e(origins[s.origin]||'本機資料')} ${s.doi?`· DOI: ${e(s.doi)}`:''}</div>${content}</article></section><aside class="reader-aside"><section class="panel"><div class="panel-head"><h2>摘錄與加註</h2><span class="badge gray">${aa.length}</span></div><div class="panel-body">${aa.length?aa.map(a=>`<div class="excerpt"><span class="badge ${a.verified?'':'amber'}">${a.verified?'已人工核對':'待核對'}</span><blockquote style="margin-top:10px">${e(a.quote)}</blockquote><p class="quiet-text">${e(a.paraphrase||'釋義待補')}</p>${a.comment?`<p class="quiet-text">${e(a.comment)}</p>`:''}<div class="date">${e(a.locator)}</div>${button('edit-annotation','編輯','quiet small',a.id)}</div>`).join(''):'<p class="quiet-text">選取原文建立摘錄，或手動輸入圖片中的重要文段。</p>'}</div></section><section class="panel"><div class="panel-head"><h2>相關概念</h2>${button('new-term','＋','quiet small',s.id)}</div><div class="panel-body">${tt.length?tt.map(t=>`<p><strong>${e(t.title)}</strong><br><span class="quiet-text">${e(t.definition)}</span> ${button('edit-term','編輯','quiet small',t.id)}</p>`).join(''):'<p class="quiet-text">把重要術語留在辭典，連回這份來源。</p>'}</div></section><section class="panel"><div class="panel-head"><h2>文獻脈絡</h2>${button('new-relation','＋','quiet small')}</div><div class="panel-body">${rr.length?rr.map(r=>`<p class="quiet-text">${e(relationLabels[r.relation])} · <a href="#source/${e(r.from===s.id?r.to:r.from)}">${e(byId(r.from===s.id?r.to:r.from)?.title)}</a><br>${e(r.reason)}</p>`).join(''):'<p class="quiet-text">標記支持、反駁、延伸或方法比較，保留理由。</p>'}</div></section><section class="panel"><div class="panel-body">${button('export-record','匯出這份資料','small',s.id)}</div></section></aside></div>`;
}
function noteReader() {
  const n=byId(selectedId);if(!n||n.kind!=='note')return empty('找不到筆記','請回到隨記與寫作。','');
  noteDraft={id:n.id,content:n.content||'',revision:n.revision};
  const refs=ofKind('source').filter(s=>(n.sourceIds||[]).includes(s.id)||(n.content||'').includes(`[@${s.id}`));
  return heading(n.title,'Markdown 寫作 · 點擊儲存後保存至本機 · 引用標記在輸出時轉成 APA 文內引用。',button('edit-note','編輯資料','',n.id)+button('insert-citation','插入引用')+button('save-note','儲存筆記','primary',n.id))+`<div class="reader-grid"><section class="reader-main"><article class="reader-sheet"><textarea class="editor-textarea" id="note-content" aria-label="筆記內容">${e(n.content)}</textarea><div class="editor-footer"><span id="note-save-status">已儲存 · ${date(n)}</span><span>[@來源ID, p. 頁碼] → APA 引用</span></div></article></section><aside class="reader-aside"><section class="panel"><div class="panel-head"><h2>本篇使用的來源</h2></div><div class="panel-body">${refs.length?refs.map(s=>`<p>${titleLink(s)}<br><span class="quiet-text">${e(authors(s))} · ${e(s.year||'年份待補')}</span></p>`).join(''):'<p class="quiet-text">使用「插入引用」連結來源。輸出時會生成本篇參考文獻清單。</p>'}</div></section><section class="panel"><div class="panel-head"><h2>讓草稿形成論點</h2></div><div class="panel-body"><p class="quiet-text">建議先寫研究問題，再整理支持與反面證據，最後寫出自己的判斷。</p>${button('ai-note','AI 整理草稿','small',n.id)}</div></section><section class="panel"><div class="panel-body">${button('export-record','匯出這篇筆記','small',n.id)}</div></section></aside></div>`;
}
function matrix() {const ss=records('source');return heading('把文獻並排，讓差異浮現。','比較研究方法、主要發現與限制；內容由你填寫或接受 AI 草稿後整理。',button('export-matrix','匯出 CSV','primary'))+`<div class="table-wrap"><table><thead><tr>${['文獻與年份','摘要／研究問題','研究方法','主要發現','研究限制','編輯'].map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody>${ss.map(s=>`<tr><td>${titleLink(s)}<div class="quiet-text">${e(authors(s))} · ${e(s.year||'年份待補')}</div></td>${['summary','method','findings','limitations'].map(f=>`<td>${e(s[f]||'尚未整理')}</td>`).join('')}<td>${button('edit-source','編輯','small',s.id)}</td></tr>`).join('')}</tbody></table>${!ss.length?empty('還沒有比較資料','先匯入來源並整理書目。'):''}</div>`;}
function graphSVG() {
  const ss=records('source'),rr=records('relation'); const columns=Math.max(2,Math.ceil(Math.sqrt(ss.length)));const w=Math.max(760,columns*240+80),h=Math.max(420,Math.ceil(ss.length/columns)*140+80);
  const pos=new Map(ss.map((s,i)=>[s.id,{x:40+(i%columns)*240,y:40+Math.floor(i/columns)*140}]));
  return `<svg id="research-graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="文獻關係圖"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10Z" fill="#a4b596"/></marker></defs>${rr.map((r,i)=>{const a=pos.get(r.from),b=pos.get(r.to);if(!a||!b)return '';const x1=a.x+100,y1=a.y+36,x2=b.x+100,y2=b.y+36;return `<g><title>${e(r.reason||'理由待補')}</title><path class="graph-edge" style="stroke:#a4b596;stroke-width:1.5;fill:none" d="M${x1} ${y1} Q${(x1+x2)/2} ${(y1+y2)/2-35-i%3*15} ${x2} ${y2}" marker-end="url(#arrow)"/><text class="graph-label" style="font:10px sans-serif;fill:#71846b" x="${(x1+x2)/2}" y="${(y1+y2)/2-23-i%3*8}">${e(relationLabels[r.relation])}</text></g>`;}).join('')}${ss.map(s=>{const p=pos.get(s.id);return `<a href="#source/${e(s.id)}"><g class="graph-node" transform="translate(${p.x},${p.y})"><title>${e(s.title)}</title><rect style="fill:#f4f5ed;stroke:#b9c6ad" width="200" height="74" rx="8"/><text style="font:12px sans-serif;fill:#364c3a" x="14" y="27">${e(s.title.slice(0,17))}${s.title.length>17?'…':''}</text><text style="font:10px sans-serif;fill:#819079" x="14" y="52">${e((authors(s)||'作者待補').slice(0,20))} · ${e(s.year||'n.d.')}</text></g></a>`;}).join('')}</svg>`;
}
function graph() {const rr=records('relation');return heading('追蹤文獻之間的對話。','關係由你建立並加註證據；圖中連線表示人工標記，位置僅為排列。',button('export-graph','匯出 SVG')+button('new-relation','＋ 建立關係','primary'))+`<div class="graph">${graphSVG()}</div><div class="section-caption"><h2>關係與證據 · ${rr.length}</h2></div>${rr.length?`<div class="card-grid">${rr.map(r=>`<article class="record-card"><span class="badge">${e(relationLabels[r.relation])}</span><p>${e(byId(r.from)?.title)} → ${e(byId(r.to)?.title)}</p><p class="quiet-text">${e(r.reason||'尚未填寫證據')}</p>${button('edit-relation','編輯','small',r.id)}</article>`).join('')}</div>`:empty('先建立一條有理由的連線','選擇兩份文獻，寫下它們支持、反駁或延伸的主張。','new-relation','建立關係','graph')}`;}
function references() {
  const ss=records('source').filter(s=>s.cslType!=='personal-communication');
  if(!citations){const ids=ss.map(s=>s.id).join(',');api(`/api/citations?ids=${encodeURIComponent(ids)}`).then(r=>r.json()).then(data=>{if(view==='references'&&records('source').filter(s=>s.cslType!=='personal-communication').map(s=>s.id).join(',')===ids){citations=data;renderMain();}}).catch(error=>toast(error.message));}
  return heading('讓引用有一致的格式。','APA 第 7 版 · 本機 CSL 格式引擎 · 請核對書目欄位與機構要求。',button('export-ris','匯出 RIS')+button('export-apa','匯出 APA 清單','primary'))+`<div class="notice">AI 對話／筆記類型不列入清單。缺漏的作者、年份或期刊需人工補齊；目前採通用 APA 樣式，尚未提供機構特定的中文樣式。</div>${citations?.warnings.length?`<div class="panel"><div class="panel-head"><h2>書目待補 · ${citations.warnings.length}</h2></div><div class="panel-body">${citations.warnings.map(w=>`<p class="quiet-text">${e(w.title)}：缺少 ${e(w.missing.join('、'))} ${button('edit-source','補齊','small',w.id)}</p>`).join('')}</div></div>`:''}<section class="panel">${citations?citations.html.length?citations.html.map(h=>`<div class="reference-entry">${h}</div>`).join(''):empty('目前沒有可引用文獻','先匯入原始文獻並填寫书目資料。'): '<div class="empty">正在生成 APA 清單…</div>'}</section><p class="attribution">APA formatting powered by citeproc-js © Frank Bennett. https://github.com/Juris-M/citeproc-js · AGPL-3.0-or-later.<br>APA CSL style © its authors · CC BY-SA 3.0. 此清單為格式輸出，不代表書目已核對。</p>`;
}
function exportsView() {
  const cards=[['note','研究筆記與摘錄','匯出目前專案的文獻摘要、原文摘錄、釋義、辭典、筆記與關係證據。',[['export-markdown','Markdown'],['export-html','HTML 報告'],['print-report','列印／存成 PDF']]],['cite','參考文獻清單','APA 文字清單，以及可供文獻管理工具使用的交換格式。',[['export-apa','APA 清單'],['export-ris','RIS'],['export-csl','CSL-JSON']]],['matrix','文獻比較與辭典','Excel 可讀取的 UTF-8 CSV；學習卡片可對應術語、定義與例句欄位。',[['export-matrix','文獻比較 CSV'],['export-glossary','辭典 CSV']]],['graph','文獻脈絡與結構資料','向量關係圖與保留資料 ID、定位、連結的 JSON。JSON 不包含附件原始位元組。',[['export-graph','關係圖 SVG'],['export-json','結構資料 JSON']]],['shield','完整本機備份','備份全資料庫內容與所有原始附件，附 SHA-256 校驗；API Key 不在備份內。',[['backup','下載完整 ZIP']]],['inbox','合併還原備份','匯入 InkGraph ZIP；相同資料略過，版本衝突會停止並保留目前資料。',[['restore','選取 ZIP 還原']]]];
  return heading('研究成果，完整帶走。','一般輸出遵循目前專案範圍；完整備份涵蓋全部專案。')+`<div class="export-grid">${cards.map(([i,t,d,buttons])=>`<section class="export-card">${icon(i)}<div><h2>${t}</h2><p>${d}</p><div class="actions">${buttons.map(([a,l])=>button(a,l,'small')).join('')}</div></div></section>`).join('')}</div><p class="quiet-text">HTML 報告可在 Chrome 開啟並列印成 PDF。第一版尚未提供 Word 引用欄位整合與 DOCX 報告輸出。</p>`;
}
function settings() {return heading('你的工作台，由你掌握。','本地資料 · 可選雲端 AI · 開放格式')+`<div class="settings-grid"><section class="panel"><div class="panel-head"><h2>本機與隱私</h2><span class="badge">LOCAL FIRST</span></div><div class="panel-body"><ul class="help-list"><li>資料庫與原檔保存在程式的 data/ 目錄。</li><li>閱讀、整理、搜尋、辭典與引用功能可離線使用。</li><li>沒有分析追蹤、廣告或背景同步。</li><li>只有你確認的 AI 文字會送往 Gemini API。</li><li>API Key 只留在目前頁面記憶體；重新整理即清除。</li><li>本機服務只綁定 127.0.0.1；不提供遠端多人使用。</li></ul></div></section><section class="panel"><div class="panel-head"><h2>第一版支援範圍</h2></div><div class="panel-body"><ul class="help-list"><li>PDF 文字擷取、DOCX 文字匯入與圖片預覽。</li><li>掃描文檔與圖片可手動摘錄；OCR 尚未提供。</li><li>Gemini／NotebookLM 可貼上或匯入匯出檔案。</li><li>對話自動同步與專用 Takeout 解析尚未提供。</li><li>中文搜尋採包含比對；尚未提供語意搜尋。</li><li>APA 書目需人工核對；沒有 Word 動態引用欄位。</li></ul></div></section><section class="panel"><div class="panel-head"><h2>常用操作</h2></div><div class="panel-body"><p class="quiet-text">Ctrl K：全文搜尋<br>Ctrl N：快速新增隨記<br>閱讀時選取文字：新增摘錄會帶入選取內容<br>筆記引用格式：[@來源ID, p. 12]</p>${button('new-project','建立專案','small')} ${button('demo','載入示範專案','small')}</div></section><section class="panel"><div class="panel-head"><h2>開源與引用引擎</h2></div><div class="panel-body"><p class="quiet-text">InkGraph 原創程式碼使用 AGPL v3 或更新版本授權。第三方套件與引用樣式依其各自授權使用。</p><p class="attribution">Powered by citeproc-js © Frank Bennett, AGPL-3.0-or-later.<br>APA style: Citation Style Language project, CC BY-SA 3.0.<br>詳見 LICENSE、THIRD_PARTY_NOTICES.md。</p></div></section></div>`;}
function searchResults() {
  const needle=query.toLocaleLowerCase();const list=scope().filter(x=>x.kind!=='project'&&x.kind!=='relation'&&JSON.stringify(x).toLocaleLowerCase().includes(needle));
  return heading('找到思考的線索。',`「${query}」 · 目前範圍內 ${list.length} 筆結果`)+`<section class="panel">${list.filter(x=>x.kind==='source').map(sourceRow).join('')}</section><div class="card-grid">${list.filter(x=>x.kind!=='source').map(recordCard).join('')}</div>${!list.length?empty('沒有符合的資料','試試更短的術語、作者或原文片段。',''):''}`;
}
function renderMain() {
  const content={dashboard,inbox:()=>sourceList(true),sources:()=>sourceList(),annotations:()=>cardList('annotation'),terms:()=>cardList('term'),notes:()=>cardList('note'),source:sourceReader,note:noteReader,matrix,graph,references,exports:exportsView,settings,search:searchResults};
  if(!$('#main'))return;$('#main').innerHTML=(content[query?'search':view]||dashboard)();
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const counts={inbox:entities.filter(x=>x.kind!=='project'&&!x.projectId).length,sources:records('source').length,annotations:records('annotation').length,terms:records('term').length,notes:records('note').length};
  for(const [v,count] of Object.entries(counts)){const b=document.querySelector(`[data-view="${v}"] .nav-count`);if(b)b.textContent=count;}
  const crumb=$('.breadcrumb strong');if(crumb)crumb.textContent='/ '+labels[view];
  const dz=$('.dropzone');if(dz){dz.addEventListener('dragover',ev=>{ev.preventDefault();dz.classList.add('over');});dz.addEventListener('dragleave',()=>dz.classList.remove('over'));dz.addEventListener('drop',ev=>{ev.preventDefault();dz.classList.remove('over');uploadFiles(ev.dataTransfer.files);});dz.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();$('#upload').click();}});}
}
function dirty(){return view==='note'&&$('#note-content')&&noteDraft&&$('#note-content').value!==noteDraft.content;}
function guard(){return !dirty()||window.confirm('這篇筆記有尚未儲存的修改。確定離開並捨棄修改？');}
function go(next,id='') {if(!guard())return;query='';selectedQuote='';selectedPage='';readerMode=next==='source'&&byId(id)?.mime?.startsWith('image/')?'original':'text';noteDraft=null;citations=null;view=next;selectedId=id;if($('#search'))$('#search').value='';const hash=`#${next}${id?`/${id}`:''}`;history.replaceState(null,'',hash);renderMain();window.scrollTo(0,0);}
async function download(path,name) {const response=await api(path);const blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name||response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||'inkgraph-export';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);toast('輸出完成，已交給瀏覽器下載');}
const exportURL = (format,id) => `/api/export?format=${format}${project&&project!=='inbox'?`&project=${encodeURIComponent(project)}`:''}${id?`&id=${encodeURIComponent(id)}`:''}`;
async function uploadFiles(files) {
  let success=0;let lastId='';const errors=[];
  for(const file of files){
    try{
      if(file.size>25*1024*1024)throw new Error(`${file.name} 超過 25 MB`);
      toast(`正在解析 ${file.name}…`);
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(new Error('無法讀取檔案'));r.readAsDataURL(file);});
      const result=await(await api('/api/import',{method:'POST',body:{name:file.name,base64,projectId:project==='inbox'?null:project||null,origin:'local'}})).json();
      if(result.duplicate){toast(`${file.name} 已存在，保留原本資料`);}else success++;lastId=result.sourceId;
    }catch(error){errors.push(error.message);toast(error.message);}
  }
  await refresh(true);if(lastId)go('source',lastId);toast(`匯入結束：${success} 個新來源${errors.length?'\n'+errors.join('\n'):''}`);$('#upload').value='';
}
function pasteSource() {
  dialog('匯入對話或筆記',field('來源標題','title','','text','',true)+selectField('來源','origin',[['gemini','Gemini'],['notebooklm','NotebookLM'],['manual','其他文字來源']],'gemini')+projectField(project)+field('貼上內容','text','','textarea','保留使用者／AI 角色、原有引用及時間資訊。',true),'<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">匯入本機</button>',async fd=>{
    const data=Object.fromEntries(fd);const s=await save('source',{...data,projectId:data.projectId||null,authors:[],cslType:'personal-communication',pages:[],warnings:['對話引用尚未配對原始文獻，請人工核對。'],parseStatus:'貼上文字'});$('#dialog').close();go('source',s.id);toast('對話已匯入本機');
  });
}
function insertCitation() {
  const choices=ofKind('source').filter(s=>s.cslType!=='personal-communication').map(s=>[s.id,s.title]);if(!choices.length){toast('請先建立可引用的原始文獻');return;}
  const editor=$('#note-content'),position=editor.selectionStart;
  dialog('插入 APA 文內引用',selectField('引用來源','sourceId',choices,choices[0][0])+field('印刷頁碼（選填）','page','','text','例如 12 或 12–14；直接引用請填頁碼。')+'<p class="quiet-text">寫作時使用穩定的來源 ID；輸出時會自動生成 APA 格式與清單。</p>','',async fd=>{
    const marker=`[@${fd.get('sourceId')}${fd.get('page')?`, p. ${fd.get('page')}`:''}]`;const value=editor.value;editor.value=value.slice(0,position)+marker+value.slice(position);$('#dialog').close();$('#note-save-status').textContent='有尚未儲存的修改';editor.focus();
  });
}
async function saveNote() {const n=byId(selectedId);const text=$('#note-content').value;const r=await save('note',{...n,content:text,revision:noteDraft.revision},n.id);noteDraft={id:r.id,content:text,revision:r.revision};toast('筆記已儲存在本機');}
function aiDialog(id,isNote=false) {
  const record=byId(id),text=isNote?$('#note-content')?.value||record?.content:record?.text;
  if(!text?.trim()){toast('這份資料沒有可傳送文字；請先新增文字或手動摘錄。');return;}
  const context=selectedQuote||text;aiAnswer='';
  dialog('Gemini · 整理草稿',`<div class="notice">只有下方可見文字會傳送至 Google Gemini API。回應為待核對草稿，不會覆寫原文。需自行提供可用模型 ID 與 API Key。</div><div class="form-grid">${field('Gemini API Key','key',aiKey,'password','僅留在目前頁面記憶體，不寫入資料庫或備份。',true)}${field('模型 ID','model',aiModel,'text','使用你帳號可用的模型 ID，例如 AI Studio 中顯示的名稱。',true)}</div>${field('整理要求與待傳送內容','text',`請整理以下資料的主要論點、重要術語、支持證據、限制與待查事項。\n\n【來源：${record.title}】\n${context}`,'textarea','可在傳送前刪減內容；上限 60,000 字。',true)}<div id="ai-result"></div>`, '<button type="button" data-action="close-dialog">關閉</button><button type="submit" class="primary">傳送上述內容</button>',async fd=>{
    aiKey=String(fd.get('key'));aiModel=String(fd.get('model'));const text=String(fd.get('text'));
    $('#ai-result').textContent='正在等待 Gemini 回應…';
    try{const result=await(await api('/api/ai',{method:'POST',body:{key:aiKey,model:aiModel,text}})).json();aiAnswer=result.answer;$('#ai-result').innerHTML=`<h3 style="font-size:14px">待核對草稿</h3><div class="ai-output">${e(aiAnswer)}</div><button type="button" class="small" data-action="save-ai-note" data-id="${e(id)}" style="margin-top:12px">另存為研究筆記</button>`;}catch(err){$('#ai-result').textContent='';throw err;}
  });
}
async function demo() {
  toast('正在建立示範專案…');
  const p=await save('project',{title:'〔示範〕從閱讀到研究',description:'以下作者、文獻與原文均為合成示範，不可作為真實研究引用。',purpose:'academic'});
  const originals=[
    {title:'〔示範〕知識整理中的脈絡與來源',authors:[{literal:'示範研究者甲'}],year:'2024',text:'【合成示範，非真實文獻】\n\n知識整理的價值，不只在於保存資訊，也在於保留資訊出現的脈絡。\n\n當研究者把原文、自己的解釋與待查問題分開記錄，後續寫作更容易回到證據。\n\n本示範提出三個步驟：保留來源、建立文段摘錄、連結研究問題。',summary:'探討來源追溯與閱讀整理。',method:'合成示範：概念分析',findings:'保留原文與釋義的區別，有助於回查證據。',limitations:'合成內容，沒有實證資料。'},
    {title:'〔示範〕從文段摘錄到概念辭典',authors:[{literal:'示範研究者乙'}],year:'2025',text:'【合成示範，非真實文獻】\n\n同一個術語在不同研究中，可能具有不同的操作定義。\n\n概念辭典應保留作者的定義、原文定位，以及讀者自己的釋義。\n\n比較不同來源的定義，有助於避免把相似名稱視為完全相同的概念。',summary:'比較跨文獻術語定義的差異。',method:'合成示範：跨來源比較',findings:'辭典需要保留定義出處與不同用法。',limitations:'合成內容，沒有實證資料。'},
    {title:'〔示範〕Gemini 研究討論紀錄',authors:[],year:'',cslType:'personal-communication',origin:'gemini',text:'【合成示範對話】\n使用者：我該如何整理研究問題？\nAI：可先列出主要主張、支持證據、反面證據與待查事項。\n使用者：這些建議有具體文獻出處嗎？\nAI：這段建議尚未配對原始文獻，需另外查核。',summary:'用作靈感與待查事項，不列入 APA。'}
  ];
  const ss=[];for(const s of originals)ss.push(await save('source',{...s,projectId:p.id,cslType:s.cslType||'report',origin:s.origin||'demo',publisher:'InkGraph 合成示範',pages:[],parseStatus:'示範文字',warnings:['合成示範資料，不可作為真實研究證據。']}));
  await save('annotation',{sourceId:ss[0].id,projectId:p.id,quote:'知識整理的價值，不只在於保存資訊，也在於保留資訊出現的脈絡。',locator:'示範原文第 2 段',paraphrase:'整理時需要保存出處與上下文，才能理解資料。',comment:'可用來檢查我的摘錄是否只留下句子而遺失背景。',verified:false,term:'來源追溯'});
  await save('term',{title:'來源追溯',aliases:'Source traceability',definition:'在這個示範中，指能從筆記或論點回到原始資料與文段位置的能力。',example:'點擊摘錄的來源，回到原文並核對上下文。',sourceId:ss[0].id,projectId:p.id,tags:'研究方法,閱讀'});
  await save('term',{title:'操作定義',aliases:'Operational definition',definition:'在這個示範中，指研究中對概念的具體界定方式；不同來源可保留各自定義。',sourceId:ss[1].id,projectId:p.id});
  await save('relation',{from:ss[1].id,to:ss[0].id,relation:'extends',reason:'示範乙將來源追溯的觀點延伸到術語定義；比較兩篇示範的第 2 段。',projectId:p.id});
  await save('note',{title:'〔示範〕如何讓文獻整理能支援寫作？',content:`# 研究問題\n如何讓文獻整理能支援後續寫作？\n\n## 我的初步判斷\n保留原文、位置與自己的解釋，是形成可追溯論點的基礎。[@${ss[0].id}]\n\n## 下一步\n- 比較不同文獻中的術語定義。\n- 找到真實文獻，核對這些想法。\n\n> 所有內容都是合成示範，不可作為真實研究證據。`,sourceIds:[ss[0].id],noteType:'research',projectId:p.id,tags:'示範,待查'});
  project=p.id;renderShell();go('dashboard');toast('示範專案已建立；所有內容均為合成示範');
}
document.addEventListener('click',async ev=>{
  const a=ev.target.closest('a[href^="#source/"],a[href^="#note/"]');if(a){ev.preventDefault();const [v,id]=a.getAttribute('href').slice(1).split('/');go(v,id);return;}
  const target=ev.target.closest('[data-action],[data-view]');if(!target)return;
  if(target.dataset.view){go(target.dataset.view);return;}
  const action=target.dataset.action,id=target.dataset.id,record=byId(id);
  const isAsync=['demo','backup','save-note','save-ai-note','print-report'].includes(action)||action.startsWith('export-');if(isAsync)target.disabled=true;
  try{
    if(action==='close-dialog'){$('#dialog').close();return;}
    if(action==='import') {if(guard())$('#upload').click();}
    else if(action==='restore'){$('#restore').click();}
    else if(action==='new-project')editProject();
    else if(action==='new-source')editSource();
    else if(action==='edit-source')editSource(record);
    else if(action==='paste-source')pasteSource();
    else if(action==='new-note')editNote();
    else if(action==='edit-note')editNote(record||byId(selectedId));
    else if(action==='new-annotation'){if(!ofKind('source').length)toast('請先建立來源文獻');else editAnnotation(null,id||ofKind('source')[0]?.id);}
    else if(action==='edit-annotation')editAnnotation(record);
    else if(action==='new-term')editTerm(null,id|| (view==='source'?selectedId:''));
    else if(action==='edit-term')editTerm(record);
    else if(action==='new-relation')editRelation();
    else if(action==='edit-relation')editRelation(record);
    else if(action==='reader-text'){readerMode='text';renderMain();}
    else if(action==='reader-original'){readerMode='original';renderMain();}
    else if(action==='save-note')await saveNote();
    else if(action==='insert-citation')insertCitation();
    else if(action==='ai'||action==='ai-note')aiDialog(id,action==='ai-note');
    else if(action==='save-ai-note'){const n=await save('note',{title:`AI 草稿 · ${record.title}`,content:`> AI 生成，待人工核對。\n\n${aiAnswer}`,noteType:'draft',sourceIds:record.kind==='source'?[record.id]:record.sourceIds||[],projectId:record.projectId||null,tags:'AI草稿,待核對'});$('#dialog').close();toast('AI 草稿已另存為筆記');if(!dirty())go('note',n.id);}
    else if(action==='demo')await demo();
    else if(action==='backup')await download('/api/backup');
    else if(action==='export-graph'){const blob=new Blob([graphSVG()],{type:'image/svg+xml'});const u=URL.createObjectURL(blob);const link=document.createElement('a');link.href=u;link.download='literature-graph.svg';link.click();setTimeout(()=>URL.revokeObjectURL(u),10000);toast('文獻關係圖已輸出');}
    else if(action==='export-record')await download(exportURL('markdown',id));
    else if(action.startsWith('export-'))await download(exportURL(action.slice(7)));
    else if(action==='print-report') {const r=await api(exportURL('html'));const blob=await r.blob();const u=URL.createObjectURL(blob);const f=document.createElement('iframe');f.style.cssText='position:fixed;left:-10000px;width:1px;height:1px';f.src=u;f.onload=()=>{f.contentWindow.focus();f.contentWindow.print();};document.body.appendChild(f);setTimeout(()=>{f.remove();URL.revokeObjectURL(u);},60000);}
  }catch(error){toast(error.message);}finally{if(isAsync)target.disabled=false;}
});
document.addEventListener('input',ev=>{
  if(ev.target.id==='search'){if(!guard()){ev.target.value='';return;}query=ev.target.value.trim();renderMain();}
  if(ev.target.id==='note-content')$('#note-save-status').textContent=dirty()?'有尚未儲存的修改':'已儲存';
});
document.addEventListener('change',ev=>{
  if(ev.target.id==='project-filter'){if(!guard()){ev.target.value=project;return;}project=ev.target.value;query='';if(view==='source'||view==='note')view='dashboard';renderShell();}
});
document.addEventListener('selectionchange',()=>{const s=window.getSelection();if(s?.toString().trim()&&s.anchorNode?.parentElement?.closest('#source-text')){selectedQuote=s.toString();selectedPage=s.anchorNode.parentElement.closest('[data-page]')?.dataset.page||'';}});
document.addEventListener('keydown',ev=>{if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='k'){ev.preventDefault();$('#search').focus();}if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='n'){ev.preventDefault();if(!$('#dialog').open)editNote();}});
window.addEventListener('beforeunload',ev=>{if(dirty()){ev.preventDefault();ev.returnValue='';}});
$('#upload').addEventListener('change',ev=>uploadFiles(ev.target.files));
$('#restore').addEventListener('change',async ev=>{const f=ev.target.files[0];if(!f)return;try{if(f.size>100*1024*1024)throw new Error('備份 ZIP 上限 100 MB');toast('正在校驗並還原…');const r=await(await api('/api/restore',{method:'POST',body:f,headers:{'Content-Type':'application/zip'}})).json();await refresh(true);toast(`已還原 ${r.added} 筆，略過 ${r.skipped} 筆相同資料`);}catch(error){toast(error.message);}finally{ev.target.value='';}});
window.addEventListener('hashchange',()=>{const [v,id]=location.hash.slice(1).split('/');if(!guard())return;view=labels[v]?v:'dashboard';selectedId=id||'';query='';renderShell();});
try{const [v,id]=location.hash.slice(1).split('/');view=labels[v]?v:'dashboard';selectedId=id||'';await refresh(true);}catch(error){$('#app').innerHTML=`<main class="loading"><h1>本機工作台暫時無法開啟</h1><p>${e(error.message)}</p><p>請確認本機服務已啟動，再重新整理頁面。</p></main>`;}
