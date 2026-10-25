import { AXES,categoryPath,filterTerms,descendants } from './taxonomy-model.js';
import { scopedState } from './project-scope.js';
export function createGlossaryWorkspace({entities,project,api,refresh,go,guard,dirty,dialog,e,heading,button,toast,renderMain,dom=globalThis.document}){
  const document=dom;
  const get=id=>entities().find(r=>r.id===id),categories=()=>entities().filter(r=>r.kind==='category');
  const request=async(path,body,method='POST')=>(await api(path,body?{method,body}:{})).json();
  const input=(label,name,value='',area=false)=>`<label>${e(label)}${area?`<textarea name="${name}">\n${e(value)}</textarea>`:`<input name="${name}" value="${e(value)}" ${name==='title'?'required maxlength="500"':''}>`}</label>`;
  const picker=(chosen=[])=>`<fieldset class="category-picker"><legend>三軸分類（可複選；也可暫不分類）</legend>${Object.entries(AXES).map(([axis,label])=>`<details open><summary>${label}</summary>${categories().filter(c=>c.axis===axis).sort((a,b)=>categoryPath(a,entities()).localeCompare(categoryPath(b,entities()),'zh-Hant')).map(c=>`<label class="checkbox"><input type="checkbox" name="categoryIds" value="${e(c.id)}" ${chosen.includes(c.id)?'checked':''}>${e(categoryPath(c,entities()))}</label>`).join('')||'<p class="quiet-text">尚無分類，請至辭典「管理分類」新增。</p>'}</details>`).join('')}</fieldset>`;
  const footer='<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">確認儲存</button>';
  let filters={selected:[],query:'',includeChildren:true,unclassified:false};
  const paths=row=>(row.categoryIds||[]).map(id=>{const c=get(id);return c?`${AXES[c.axis]}：${categoryPath(c,entities())}`:'分類已移除';});
  async function finish(row){document.querySelector('#dialog').close();await refresh(true);await go(row.kind,row.id);toast('已儲存在本機');}
  function render(){
    const terms=scopedState(entities(),project()).filter(r=>r.kind==='term'),shown=filterTerms(terms,entities(),filters);
    const tree=(axis,parentId=null)=>categories().filter(c=>c.axis===axis&&(c.parentId||null)===parentId).sort((a,b)=>a.title.localeCompare(b.title,'zh-Hant')).map(c=>{
      const children=categories().some(r=>r.parentId===c.id),ids=descendants(c.id,entities()),count=terms.filter(t=>(t.categoryIds||[]).some(id=>ids.has(id))).length;
      const label=`<label class="checkbox"><input type="checkbox" data-category-filter="${e(c.id)}" ${filters.selected.includes(c.id)?'checked':''}>${e(c.title)} <small>${count}</small></label>`;
      return children?`<details open><summary>${e(c.title)}</summary>${label}<div class="category-children">${tree(axis,c.id)}</div></details>`:label;
    }).join('');
    return heading('字彙辭典','保留作者語境與來源；學科、思想脈絡、應用領域可交叉查找。',button('glossary-new','＋ 新增詞條','primary')+button('glossary-categories','管理分類'))+`<div class="toolbar"><span>${shown.length}／${terms.length} 個詞條</span><div class="actions">${button('export-glossary','辭典 CSV','small')}${button('export-taxonomy','分類對照 CSV','small')}${button('export-markdown','Markdown','small')}</div></div><div class="glossary-layout"><aside class="panel glossary-filters"><details open><summary>分類與搜尋</summary><div class="panel-body"><label>搜尋詞名／原語／別名<input id="glossary-query" type="search" value="${e(filters.query)}"></label><p class="quiet-text">同一軸符合任一；不同軸同時符合。數字為目前專案含子分類的去重詞條數。</p><label class="checkbox"><input type="checkbox" id="glossary-descendants" ${filters.includeChildren?'checked':''}>包含子分類</label><label class="checkbox"><input type="checkbox" id="glossary-unclassified" ${filters.unclassified?'checked':''}>只看未分類</label>${Object.entries(AXES).map(([axis,label])=>`<h3>${label}</h3>${tree(axis)||'<small>尚無分類</small>'}`).join('')}${button('glossary-clear','清除篩選','small')}</div></details></aside><section><p class="quiet-text">${filters.selected.length?filters.selected.map(id=>get(id)?`${AXES[get(id).axis]}：${categoryPath(get(id),entities())}`:'').map(e).join('；'):'尚未選擇分類條件'}</p><div class="card-grid">${shown.map(t=>`<article class="record-card"><span class="badge gray">${e(t.reviewStatus||'待整理')}</span><h2>${button('knowledge-open',t.title,'quiet',t.id)}</h2><small>${e(t.aliases||'')}</small><p>${e((t.definition||'釋義待補').slice(0,300))}</p><small>${paths(t).map(e).join('<br>')||'未分類'}</small><div class="actions">${button('glossary-edit','編輯','small',t.id)}${button('glossary-convert','改列資料類型','quiet small',t.id)}</div></article>`).join('')||'<p class="notice">目前沒有符合條件的詞條。可清除篩選，或新增詞條。</p>'}</div></section></div>`;
  }
  function bind(){
    const q=document.querySelector('#glossary-query');if(!q)return;
    q.oninput=()=>{const start=q.selectionStart;filters.query=q.value;renderMain();const next=document.querySelector('#glossary-query');next.focus();next.setSelectionRange(start,start);};
    document.querySelectorAll('[data-category-filter]').forEach(el=>el.onchange=()=>{filters.selected=el.checked?[...filters.selected,el.dataset.categoryFilter]:filters.selected.filter(id=>id!==el.dataset.categoryFilter);renderMain();});
    document.querySelector('#glossary-descendants').onchange=ev=>{filters.includeChildren=ev.target.checked;renderMain();};
    document.querySelector('#glossary-unclassified').onchange=ev=>{filters.unclassified=ev.target.checked;renderMain();};
  }
  function editTerm(row,sourceId=''){
    if(dirty()){toast('請先儲存目前編輯內容，再編輯詞條資料');return;}
    const sources=entities().filter(r=>r.kind==='source'),selected=[...new Set([...(row?.sourceIds||[]),row?.sourceId,sourceId].filter(Boolean))];
    dialog(row?'編輯字彙詞條':'新增字彙詞條',input('詞名','title',row?.title||'')+input('原語／別名','aliases',row?.aliases||'')+input('簡明釋義（自己的整理）','definition',row?.definition||'',true)+input('使用範圍／辨義提醒','scopeNote',row?.scopeNote||'',true)+input('例句／應用','example',row?.example||'',true)+input('完整說明（保留 Markdown、引用及連結語法）','content',row?.content||'',true)+`<label>整理狀態<select name="reviewStatus">${['待整理','待核對','已人工核對'].map(s=>`<option ${row?.reviewStatus===s?'selected':''}>${s}</option>`).join('')}</select></label>`+picker(row?.categoryIds)+`<fieldset class="source-picker"><legend>來源文獻（可複選；各段位置請留在正文引用或摘錄）</legend><input id="glossary-source-search" type="search" aria-label="搜尋來源選項" placeholder="搜尋來源選項">${sources.map(s=>`<label class="checkbox" data-source-choice><input type="checkbox" name="sourceIds" value="${e(s.id)}" ${selected.includes(s.id)?'checked':''}>${e(s.title)}</label>`).join('')}</fieldset>`+input('標籤','tags',row?.tags||''),footer,async fd=>{
      const data={...(row||{}),...Object.fromEntries(fd),sourceId:null,sourceIds:fd.getAll('sourceIds'),categoryIds:fd.getAll('categoryIds'),projectId:row?.projectId||(get(project())?.kind==='project'?project():null)};
      if(row)data.projectId=row.projectId||null;
      const result=await request('/api/entities',{kind:'term',data,...(row?{id:row.id}:{})});await finish(result);
    });
    document.querySelector('#glossary-source-search').oninput=ev=>{const q=ev.target.value.toLocaleLowerCase();document.querySelectorAll('[data-source-choice]').forEach(el=>el.hidden=!el.textContent.toLocaleLowerCase().includes(q));};
  }
  async function convert(row){
    if(dirty()){toast('請先儲存目前內容，再預覽改列');return;}
    if(!guard())return;
    const targetKind=row.kind==='note'?'term':'note',p=await request('/api/conversion/preview',{id:row.id,targetKind});
    dialog('改列資料類型：影響預覽',`<p>${e(row.title)} → <strong>${targetKind==='term'?'字彙詞條':'一般筆記'}</strong></p><p>保留完整正文、${p.sourceCount} 個來源、專案歸屬、引用及摘錄快照。直接改列沿用原 ID；舊連結仍可開啟。</p>${p.conflicts.length?`<div class="notice">有 ${p.conflicts.length} 條支持／反駁關係指向此筆記，請保留原筆記另建詞條。</div><ul>${p.conflicts.map(c=>`<li>${e(c.title)} · ${e(c.from)}</li>`).join('')}</ul>`:''}<label>處理方式<select name="mode">${!p.conflicts.length?'<option value="convert">直接改列同一項目</option>':''}${targetKind==='term'?'<option value="derive">保留原筆記，另建相連詞條</option>':''}</select></label>`+input('詞名／標題','title',p.proposal.title)+(targetKind==='term'?input('原語／別名','aliases',p.proposal.aliases||'')+input('簡明釋義（不填也會保留完整正文）','definition',p.proposal.definition||'',true)+input('使用範圍／辨義提醒','scopeNote',p.proposal.scopeNote||'',true)+picker(p.proposal.categoryIds):'')+`<details><summary>核對完整正文（保持原文）</summary><pre class="conversion-original">${e(p.proposal.content)}</pre></details><label class="checkbox"><input type="checkbox" required>我已核對欄位與影響範圍</label>`,footer,async fd=>{
      const fields={title:fd.get('title')};if(targetKind==='term')Object.assign(fields,{aliases:fd.get('aliases'),definition:fd.get('definition'),scopeNote:fd.get('scopeNote'),categoryIds:fd.getAll('categoryIds')});
      const r=await request('/api/conversion/commit',{id:row.id,targetKind,revision:p.revision,fingerprint:p.fingerprint,mode:fd.get('mode'),fields});await finish(r.entity);
    });
  }
  function editCategory(row){
    const forbidden=row?descendants(row.id,entities()):new Set();
    dialog(row?'編輯／移動分類':'新增分類',input('分類名稱','title',row?.title||'')+`<label>分類軸<select name="axis" ${row?'disabled':''}>${Object.entries(AXES).map(([id,label])=>`<option value="${id}" ${row?.axis===id?'selected':''}>${label}</option>`).join('')}</select></label><label>父分類<select name="parentId"></select></label><p>移動父分類會保留詞條指派；不可移入本身或子分類。</p>`,footer,async fd=>{
      await request('/api/entities',{kind:'category',...(row?{id:row.id}:{}),data:{...(row||{}),title:fd.get('title'),axis:row?.axis||fd.get('axis'),parentId:fd.get('parentId')||null}});document.querySelector('#dialog').close();await refresh();manageCategories();
    });
    const axis=document.querySelector('#dialog [name="axis"]'),parent=document.querySelector('#dialog [name="parentId"]');
    const update=()=>{parent.innerHTML='<option value="">最上層</option>'+categories().filter(c=>c.axis===axis.value&&!forbidden.has(c.id)).map(c=>`<option value="${e(c.id)}">${e(categoryPath(c,entities()))}</option>`).join('');parent.value=row?.parentId||'';};axis.onchange=update;update();
  }
  function manageCategories(){
    if(dirty()){toast('請先儲存目前編輯內容');return;}
    dialog('管理全庫分類',`<p>分類名稱與結構由你設定；詞條可跨軸、跨分類。刪除分類不會刪除詞條。</p>${button('glossary-category-new','＋ 新增分類','primary')}${Object.entries(AXES).map(([axis,label])=>`<h3>${label}</h3>${categories().filter(c=>c.axis===axis).map(c=>`<p>${e(categoryPath(c,entities()))} ${button('glossary-category-edit','改名／移動','small',c.id)} ${button('glossary-category-delete','刪除','small',c.id)}</p>`).join('')||'<p>尚無分類</p>'}`).join('')}`,'<button type="button" data-action="close-dialog">關閉</button>');
  }
  async function removeCategory(id){
    const p=await request('/api/categories/preview?id='+encodeURIComponent(id)),blocked=descendants(id,entities());
    dialog('刪除分類：影響預覽',`<p>刪除「${e(p.row.title)}」，影響 ${p.affected.filter(r=>r.kind!=='category').length} 個項目、${p.affected.filter(r=>r.kind==='category').length} 個直接子分類。</p><p>子分類會移至替代分類之下，未選替代時移至原父層；詞條保留。</p><details><summary>受影響項目</summary>${p.affected.map(r=>`<p>${e(r.title)}</p>`).join('')}</details><label>替代分類<select name="replacementId"><option value="">移除分類指派</option>${categories().filter(c=>c.axis===p.row.axis&&!blocked.has(c.id)).map(c=>`<option value="${e(c.id)}">${e(categoryPath(c,entities()))}</option>`).join('')}</select></label><label class="checkbox"><input type="checkbox" required>確認上述影響</label>`,footer,async fd=>{await request('/api/categories',{id,fingerprint:p.fingerprint,replacementId:fd.get('replacementId')},'DELETE');document.querySelector('#dialog').close();filters.selected=filters.selected.filter(c=>c!==id);await refresh();manageCategories();});
  }
  async function history(row){
    if(dirty()){toast('請先儲存目前編輯內容');return;}
    const rows=await request('/api/conversion/history?id='+encodeURIComponent(row.id));
    dialog('改列歷程',rows.map(r=>`<article><p>${e(r.title)} · ${e(new Date(r.created).toLocaleString('zh-TW'))}</p>${r.canUndo?button('glossary-undo','撤回這次改列','small',r.id):'<p class="quiet-text">目前資料或連結已有變更，或採用另建詞條，不能直接撤回；可使用改列預覽重新整理。</p>'}</article>`).join('')||'<p>尚無改列紀錄。</p>','<button type="button" data-action="close-dialog">關閉</button>');
  }
  async function handle(action,id){
    const row=get(id);
    if(action==='glossary-new')editTerm();else if(action==='glossary-edit')editTerm(row?.bodyDeferred?await request('/api/entity?id='+encodeURIComponent(id)):row);else if(action==='glossary-convert')await convert(row);
    else if(action==='glossary-clear'){filters={selected:[],query:'',includeChildren:true,unclassified:false};renderMain();}
    else if(action==='glossary-categories')manageCategories();else if(action==='glossary-category-new')editCategory();else if(action==='glossary-category-edit')editCategory(row);else if(action==='glossary-category-delete')await removeCategory(id);
    else if(action==='glossary-history')await history(row);else if(action==='glossary-undo'){const event=await request('/api/entity?id='+encodeURIComponent(id)),current=get(event.entityId);await finish(await request('/api/conversion/undo',{id:current.id,historyId:id,revision:current.revision}));}
  }
  return {render,bind,editTerm,paths,handle,canHandle:action=>action.startsWith('glossary-')};
}
