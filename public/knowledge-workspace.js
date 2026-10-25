import { scopedState,projectsOf } from './project-scope.js';
import { KIND_LABELS,LINK_LABELS,ROLE_LABELS,OBJECT_KINDS,SHARED_KINDS,objectTitle,objectView } from './knowledge-model.js';
import { renderConnections } from './workspace-view.js';

export function createKnowledgeWorkspace({entities,project,allProjects,api,refresh,go,guard,dialog,e,heading,button,toast,dom=globalThis.document}) {
  const get=id=>entities().find(r=>r.id===id);
  const text=(label,name,value='',required=false)=>`<label>${e(label)}<textarea name="${name}" ${required?'required':''}>\n${e(value)}</textarea></label>`;
  const input=(label,name,value='',required=false)=>`<label>${e(label)}<input name="${name}" value="${e(value)}" ${required?'required':''}></label>`;
  const select=(label,name,options,value='')=>`<label>${e(label)}<select name="${name}">${options.map(([id,title])=>`<option value="${e(id)}" ${id===value?'selected':''}>${e(title)}</option>`).join('')}</select></label>`;
  const projectId=()=>get(project())?.kind==='project'?project():null;
  const footer='<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">儲存</button>';
  async function save(kind,data,id) {return (await api('/api/entities',{method:'POST',body:{kind,data,...(id?{id}:{})}})).json();}
  async function finish(row,view=objectView(row)) {dom.querySelector('#dialog').close();await refresh();await go(view,row.id);toast('已儲存在本機');}
  function editDiscussion(record,source) {
    if(!guard())return;
    const sources=entities().filter(r=>r.kind==='source');
    dialog(record?'編輯討論':'建立討論',input('討論標題','title',record?.title||'',true)+select('討論來源','origin',[['manual','手動整理'],['gemini','Gemini'],['notebooklm','NotebookLM／Gemini Notebook']],record?.origin||source?.origin||'manual')+select('起始來源（其他來源可用物件連結加入）','sourceId',[['','不指定'],...sources.map(s=>[s.id,s.title])],record?.sourceIds?.[0]||source?.id||'')+text('討論背景／摘要','content',record?.content||'')+(!record&&source&&['gemini','notebooklm'].includes(source.origin)?'<label class="checkbox"><input type="checkbox" name="importText" checked>將選定來源的全文保存為一則「未標示角色」訊息</label>':'')+'<p class="quiet-text">原始來源保留不動。訊息逐則標示角色，匯入文字不會自動猜測問答角色。</p>',footer,async fd=>{
      const id=fd.get('sourceId');
      const data={...(record||{}),title:String(fd.get('title')).trim(),origin:fd.get('origin'),content:fd.get('content'),sourceIds:[...new Set([...(record?.sourceIds?.slice(1)||[]),...(id?[id]:[])])],projectId:record?(record.projectId||null):projectId()||source?.projectId||null};
      const row=fd.has('importText')?(await(await api('/api/discussions/from-source',{method:'POST',body:{...data,sourceId:id}})).json()):await save('discussion',data,record?.id);
      await finish(row);
    });
  }
  function editMessage(record,discussionId) {
    const parent=get(record?.discussionId||discussionId);if(parent?.kind!=='discussion'){toast('請先建立討論');return;}
    dialog(record?'編輯討論訊息':'新增討論訊息',select('角色','role',Object.entries(ROLE_LABELS),record?.role||'researcher')+text('訊息內容','content',record?.content||'',true)+select('此訊息的原始文獻（選填）','sourceId',[['','沿用討論來源'],...entities().filter(r=>r.kind==='source').map(s=>[s.id,s.title])],record?.sourceIds?.[0]||''),footer,async fd=>{
      const content=String(fd.get('content')).trim();
      const row=await save('message',{...(record||{}),title:content.slice(0,70),content,role:fd.get('role'),discussionId:parent.id,sourceIds:fd.get('sourceId')?[fd.get('sourceId')]:[],projectId:parent.projectId||null},record?.id);
      await finish(row);
    });
  }
  function editConcept(record) {
    if(!guard())return;
    dialog(record?'編輯概念':'建立概念',input('概念名稱','title',record?.title||'',true)+input('別名／外文','aliases',record?.aliases||'')+text('概念說明','definition',record?.definition||'')+'<p class="quiet-text">概念是連結研究內容的入口。不同作者的定義仍保留為獨立辭典條目，可用「定義」關係連到此概念。</p>',footer,async fd=>{
      await finish(await save('concept',{...(record||{}),title:String(fd.get('title')).trim(),aliases:fd.get('aliases'),definition:fd.get('definition'),projectId:record?(record.projectId||null):projectId()},record?.id));
    });
  }
  function noteFromDiscussion(row) {
    if(!guard())return;
    const parent=row.kind==='message'?get(row.discussionId):row;
    dialog('將討論整理成自己的筆記',input('筆記標題','title',`討論筆記 · ${parent.title}`.slice(0,500),true)+text('自己的理解／判斷','content','',true)+'<p class="quiet-text">討論素材會另列為待核對內容，並自動建立「衍生自」連結。正式引用仍以原始文獻為依據。</p>',footer,async fd=>{
      const note=await(await api('/api/notes/from-discussion',{method:'POST',body:{id:row.id,title:fd.get('title'),content:fd.get('content'),projectId:projectId()||row.projectId||null}})).json();
      await finish(note,'note');
    });
  }
  function editLink(id) {
    const from=get(id);if(!OBJECT_KINDS.includes(from?.kind))return;
    const targets=entities().filter(r=>OBJECT_KINDS.includes(r.kind)&&r.id!==id);
    dialog('建立雙向可追溯的連結',`<p>從：<strong>${e(objectTitle(from))}</strong>（${e(KIND_LABELS[from.kind])}）</p>`+select('關係','relation',Object.entries(LINK_LABELS),'related')+select('關係使用範圍','projectId',[['','全庫共用連結'],...entities().filter(r=>r.kind==='project').map(r=>[r.id,r.title])],projectId()||from.projectId||'')+input('搜尋連結目標','targetFilter','')+select('連到項目（全庫，可跨專案）','to',targets.map(r=>[r.id,`${KIND_LABELS[r.kind]} · ${objectTitle(r)} · ${get(r.projectId)?.title||'收件匣'}`]),targets[0]?.id||'')+text('理由／證據','reason')+input('起點位置（頁碼、段落或訊息位置）','fromLocator',from.kind==='annotation'?from.locator:'')+input('目標位置（選填）','toLocator','')+'<p class="quiet-text">連結會同時出現在兩端。支持／反駁需指向筆記或訊息，並附理由；相關不等於證據支持。全庫連結可在不同專案查看，專案連結預設只在指定專案顯示。</p>',footer,async fd=>{
      const row=await save('link',{title:LINK_LABELS[fd.get('relation')]||'物件連結',from:id,to:fd.get('to'),relation:fd.get('relation'),reason:fd.get('reason'),fromLocator:fd.get('fromLocator'),toLocator:fd.get('toLocator'),projectId:fd.get('projectId')||null});
      dom.querySelector('#dialog').close();await refresh();toast('連結已建立，兩端均可追溯');return row;
    });
    const filter=dom.querySelector('#dialog [name="targetFilter"]');
    filter.oninput=()=>{
      const needle=filter.value.trim().toLocaleLowerCase(),select=dom.querySelector('#dialog [name="to"]');
      const found=targets.filter(r=>`${objectTitle(r)} ${KIND_LABELS[r.kind]}`.toLocaleLowerCase().includes(needle));
      select.innerHTML=found.map(r=>`<option value="${e(r.id)}">${e(KIND_LABELS[r.kind])} · ${e(objectTitle(r))} · ${e(get(r.projectId)?.title||'收件匣')}</option>`).join('');
    };
  }
  function manageProjects(id) {
    const record=get(id);if(!SHARED_KINDS.includes(record?.kind))return;
    dialog('共用項目的專案連結',`<p>已加入：${e(projectsOf(record).map(id=>get(id)?.title||id).join('、')||'待整理收件匣')}</p>`+select('專案','projectId',entities().filter(r=>r.kind==='project').map(r=>[r.id,r.title]),project())+select('操作','operation',[['link','加入專案'],['unlink','只解除此專案連結']])+'<p class="quiet-text">這是同一份內容，不是副本。修改共用筆記或討論時，其他使用它的專案也會看到更新；若需不同觀點，請建立另一則筆記並連結。</p>',footer,async fd=>{
      await api('/api/objects/project',{method:'POST',body:{id,projectId:fd.get('projectId'),operation:fd.get('operation'),revision:record.revision}});
      dom.querySelector('#dialog').close();await refresh();toast('專案連結已更新');
    });
  }
  function renderList(kind) {
    const rows=scopedState(entities(),project()).filter(r=>r.kind===kind),isConcept=kind==='concept';
    return heading(isConcept?'概念與主題':'討論與思考脈絡',isConcept?'用概念連結不同文獻、定義、討論與自己的筆記。':'保留問題、AI 回覆與自己的判斷，並連回原始文獻。',button(isConcept?'knowledge-new-concept':'knowledge-new-discussion',isConcept?'＋ 建立概念':'＋ 建立討論','primary'))+`<div class="card-grid">${rows.map(r=>`<article class="record-card"><span class="badge gray">${e(KIND_LABELS[kind])}</span><h2>${button('knowledge-open',r.title,'quiet',r.id)}</h2><p>${e((isConcept?r.definition:r.content)||'尚未填寫說明')}</p><small>${e(get(r.projectId)?.title||'待整理收件匣')}</small><div class="actions">${button('knowledge-link','建立連結','small',r.id)}${button('knowledge-project','專案連結','quiet small',r.id)}</div></article>`).join('')||'<div class="empty"><strong>從一個問題或概念開始。</strong><p>建立後可以連到現有文獻與筆記。</p></div>'}</div>`;
  }
  function renderRecord(id) {
    const row=get(id);if(!row)return heading('找不到研究項目','可能已被移除，請回到資料清單。');
    const discussion=row.kind==='message'?get(row.discussionId):row.kind==='discussion'?row:null;
    let body='';
    const edit=({discussion:'knowledge-edit-discussion',message:'knowledge-edit-message',concept:'knowledge-edit-concept',annotation:'edit-annotation',term:'edit-term'})[row.kind];
    let actions=button(edit,'編輯','',row.id)+button('knowledge-link','建立連結','primary',row.id)+button('export-record','匯出這份資料','',row.id);
    if(discussion)actions+=button('knowledge-note','整理成筆記','',row.id);
    if(['discussion','concept'].includes(row.kind))actions+=button('knowledge-project','專案連結','',row.id);
    if(discussion){
      const messages=entities().filter(r=>r.kind==='message'&&r.discussionId===discussion.id).sort((a,b)=>a.created.localeCompare(b.created)||a.id.localeCompare(b.id));
      body=`<section class="reader-sheet"><span class="eyebrow">DISCUSSION</span><h2>${e(discussion.title)}</h2><p class="knowledge-body">${e(discussion.content||'')}</p><small class="quiet-text">來源：${e(({manual:'手動整理',gemini:'Gemini',notebooklm:'NotebookLM／Gemini Notebook'})[discussion.origin])} · 建立時間為本機保存時間</small><div class="actions">${button('knowledge-new-message','＋ 新增訊息','primary small',discussion.id)}${row.kind==='message'?button('knowledge-open','查看完整討論','small',discussion.id):''}</div></section><div class="discussion-thread">${messages.map(m=>`<article class="message-card ${row.id===m.id?'selected-excerpt':''}" id="message-${e(m.id)}"><span class="badge gray">${e(ROLE_LABELS[m.role])}</span><p class="knowledge-body">${e(m.content)}</p><small class="quiet-text">${e(new Date(m.created).toLocaleString('zh-TW'))}</small><div class="actions">${button('knowledge-open','訊息關聯','small',m.id)}${button('knowledge-link','建立連結','quiet small',m.id)}${button('knowledge-edit-message','編輯訊息','quiet small',m.id)}${button('delete-entity','刪除訊息','quiet small',m.id)}</div></article>`).join('')||'<p class="notice">尚無訊息。請逐則新增，保留提問、回覆與自己的整理；匯入文字不會自動猜測角色。</p>'}</div>`;
    }else if(row.kind==='annotation')body=`<article class="reader-sheet"><span class="eyebrow">EXCERPT</span><h2>原文摘錄</h2><blockquote class="knowledge-body">${e(row.quote)}</blockquote><p>定位：${e(row.locator)}</p><p class="knowledge-body">釋義：${e(row.paraphrase||'尚未填寫')}</p><p class="knowledge-body">加註：${e(row.comment||'')}</p>${button('add-excerpt','加入筆記','primary',row.id)} ${button('knowledge-open','開啟原始來源','',row.sourceId)}</article>`;
    else body=`<article class="reader-sheet"><span class="eyebrow">${row.kind==='concept'?'CONCEPT':'GLOSSARY'}</span><h2>${e(row.title)}</h2><small>${e(row.aliases||'')}</small><p class="knowledge-body">${e(row.definition||'尚未填寫說明')}</p>${row.example?`<p class="knowledge-body">例句：${e(row.example)}</p>`:''}<div class="notice">${row.kind==='concept'?'概念頁整合不同來源與觀點；請在關聯側欄建立連結。':'此條目保留特定用法與定義，可用「定義」關係連到概念頁。'}</div></article>`;
    return heading(objectTitle(row),`${KIND_LABELS[row.kind]} · 連結保留原始項目與專案脈絡`,actions)+`<div class="research-workspace"><div>${body}</div>${renderConnections(entities(),row,{projectId:project(),allProjects:allProjects()})}</div>`;
  }
  async function handle(action,id) {
    const row=get(id);
    if(action==='knowledge-new-discussion')editDiscussion(null,row?.kind==='source'?row:null);
    else if(action==='knowledge-edit-discussion')editDiscussion(row);
    else if(action==='knowledge-new-message')editMessage(null,id);
    else if(action==='knowledge-edit-message')editMessage(row,row?.discussionId);
    else if(action==='knowledge-new-concept')editConcept();
    else if(action==='knowledge-edit-concept')editConcept(row);
    else if(action==='knowledge-note')noteFromDiscussion(row);
    else if(action==='knowledge-link')editLink(id);
    else if(action==='knowledge-project')manageProjects(id);
    else if(action==='knowledge-open'){
      if(!row){toast('連結目標已移除');return;}
      await go(objectView(row),row.id);
    }
  }
  return {renderList,renderRecord,handle,canHandle:action=>action.startsWith('knowledge-')};
}
