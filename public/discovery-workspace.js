import { graphData, unlinkedMentions, semanticPayload, parseSemantic, alreadyLinked } from './discovery-model.js';
import { OBJECT_KINDS, KIND_LABELS, LINK_LABELS, objectTitle, objectView } from './knowledge-model.js';
import { scopedState } from './project-scope.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const edgeName=type=>({...LINK_LABELS,source:'原始來源',message:'所屬討論',extends:'延伸',compares:'比較'})[type]||type;
export function localGraphSVG(graph) {
  const nodes=graph.nodes,positions=new Map(),width=900,layers=[0,1,2].map(d=>nodes.filter(n=>n.distance===d)),height=Math.max(380,Math.max(...layers.map(rows=>rows.length))*100+100);
  layers.forEach((rows,d)=>rows.forEach((n,i)=>positions.set(n.id,{x:120+d*320,y:60+(i+.5)*(height-100)/Math.max(1,rows.length)})));
  const edges=graph.edges.map(edge=>{const a=positions.get(edge.from),b=positions.get(edge.to);return `<g><title>${escape(edgeName(edge.relation))}：${escape(edge.reason)}</title><path d="M${a.x},${a.y} L${b.x},${b.y}" stroke="${edge.implicit?'#9ba8a0':'#245f50'}" stroke-width="1.5" ${edge.implicit?'stroke-dasharray="5 4"':''} fill="none" marker-end="url(#arrow)"/></g>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="graph-title"><title id="graph-title">局部關係圖：依連結層次排列，不代表語意距離；箭頭由起點指向目標</title><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="20" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#245f50"/></marker></defs><rect width="100%" height="100%" fill="#f7f6f0"/>${layers.map((rows,d)=>rows.length?`<text x="${120+d*320}" y="30" text-anchor="middle" font-size="14" fill="#526a5d">${['目前項目','一層關係','兩層關係'][d]}</text>`:'').join('')}${edges}${nodes.map(n=>{const p=positions.get(n.id),chars=Array.from(n.title),label=chars.slice(0,28);return `<a href="#${objectView(n)}/${escape(n.id)}" data-action="discovery-open" data-id="${escape(n.id)}"><title>${escape(KIND_LABELS[n.kind])}：${escape(n.title)}</title><circle cx="${p.x}" cy="${p.y}" r="${n.distance===0?21:14}" fill="${n.distance===0?'#173f35':'#e0e9df'}" stroke="#245f50"/><text x="${p.x}" y="${p.y-28}" text-anchor="middle" font-size="11" fill="#526a5d">${escape(KIND_LABELS[n.kind])}</text><text x="${p.x}" y="${p.y+32}" text-anchor="middle" font-size="12" fill="#173f35">${escape(label.slice(0,14).join(''))}<tspan x="${p.x}" dy="17">${escape(label.slice(14).join(''))}${chars.length>28?'…':''}</tspan></text></a>`;}).join('')}</svg>`;
}
export function createDiscoveryWorkspace({entities,project,api,refresh,go,dialog,toast,credentials=()=>({}),dom=globalThis.document}) {
  const ignored=new Map();let focusId='',mode='graph',depth=1,kind='',relation='',aiCandidates=[],aiScope='',graphSnapshot=null,accepting=false;
  const get=id=>entities().find(r=>r.id===id);
  const scoped=()=>scopedState(entities(),project()).filter(r=>OBJECT_KINDS.includes(r.kind));
  const ignoreSet=()=>{const key=`${project()}:${focusId}`;if(!ignored.has(key))ignored.set(key,new Set());return ignored.get(key);};
  const btn=(action,label,id='')=>`<button type="button" data-action="discovery-${action}" data-id="${escape(id)}">${escape(label)}</button>`;
  const select=(label,name,values,value)=>`<label>${label}<select name="${name}">${values.map(([id,title])=>`<option value="${escape(id)}" ${id===String(value)?'selected':''}>${escape(title)}</option>`).join('')}</select></label>`;
  function exportFile(name,value,type='application/json') {
    const url=URL.createObjectURL(new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type}));const link=dom.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已交給瀏覽器下載');
  }
  function candidates(){return unlinkedMentions(entities(),focusId,{projectId:project(),ignored:ignoreSet()});}
  function candidateCards(rows) {
    return rows.map(row=>`<article class="discovery-candidate"><span class="badge gray">${row.method==='ai'?'AI 語意候選 · 待核對':'文字提及 · 待核對'}</span><h3>${escape(row.title)}</h3><p>${escape(row.reason||row.direction)}</p>${row.snippet?`<blockquote>${escape(row.snippet)}</blockquote><small>命中：${escape(row.term)}</small>`:''}<div class="actions">${btn('open','開啟核對',row.id)}${btn(row.method==='ai'?'accept-ai':'accept','確認建立相關連結',row.id)}${btn(row.method==='ai'?'ignore-ai':'ignore','本次忽略',row.id)}</div></article>`).join('')||'<p class="notice">此範圍沒有候選。沒有文字命中不代表沒有概念關聯。</p>';
  }
  function show() {
    if(!get(focusId)){toast('項目已移除');return;}
    const head=`<p><strong>${escape(objectTitle(get(focusId)))}</strong></p><p class="quiet-text">範圍：${escape(get(project())?.title||(project()==='inbox'?'待整理收件匣':'全部專案'))}。圖譜只含正式關係；候選需確認才會加入。</p><div class="actions">${btn('graph','局部關係圖')}${btn('mentions','未連結提及')}${btn('ai-select','可選 AI 語意推薦')}</div>`;
    let body;
    if(mode==='graph'){
      graphSnapshot=graphData(entities(),focusId,{projectId:project(),depth,kind,relation});
      body=`<div class="discovery-filters">${select('深度','graphDepth',[['1','一層'],['2','兩層']],depth)}${select('物件種類','graphKind',[['','全部'],...Object.entries(KIND_LABELS)],kind)}${select('關係種類','graphRelation',[['','全部'],...Object.entries({...LINK_LABELS,source:'原始來源',message:'所屬討論',extends:'延伸',compares:'比較'})],relation)}</div><p class="quiet-text">${graphSnapshot.nodes.length} 個項目、${graphSnapshot.edges.length} 條關係。依連結層次排列，不代表語意距離；虛線是出處／所屬關係，實線是人工連結。${graphSnapshot.truncated?'已達 80 個項目上限，請縮小範圍。':''}</p>${graphSnapshot.nodes.length?`<div class="local-graph">${localGraphSVG(graphSnapshot)}</div>`:'<p class="notice">目前項目不在所選專案範圍，請切換至全部專案。</p>'}<details><summary>可操作的項目與關係清單</summary>${graphSnapshot.nodes.map(n=>`<p>${btn('center',`以此為中心：${n.title}`,n.id)} ${btn('open','開啟項目',n.id)}</p>`).join('')}${graphSnapshot.edges.map(edge=>`<p>${escape(get(edge.from)&&objectTitle(get(edge.from)))} → ${escape(edgeName(edge.relation))} → ${escape(get(edge.to)&&objectTitle(get(edge.to)))}${edge.reason?`：${escape(edge.reason)}`:''}</p>`).join('')}</details>`;
    }else body=`<p class="quiet-text">${mode==='ai'?'AI 提供語意建議，不能證明引用或證據支持。':'依已儲存內容、完整標題與別名尋找文字提及；中文採字串比對，英文採完整詞界。'}</p>${candidateCards(mode==='ai'?aiCandidates:candidates())}`;
    dialog('探索關係',head+body,btn('export',mode==='graph'?'匯出圖譜 JSON':'匯出候選 JSON')+(mode==='graph'?btn('svg','匯出 SVG'):btn('reset','清除本次忽略'))+'<button type="button" data-action="close-dialog">關閉</button>');
    dom.querySelectorAll('.discovery-filters select').forEach(el=>el.onchange=()=>{depth=Number(dom.querySelector('[name="graphDepth"]').value);kind=dom.querySelector('[name="graphKind"]').value;relation=dom.querySelector('[name="graphRelation"]').value;show();});
  }
  function chooseAI() {
    const rows=scoped().filter(r=>r.id!==focusId&&!alreadyLinked(scopedState(entities(),project()),focusId,r.id)),selected=new Set();
    dialog('選擇 AI 推薦範圍',`<p>AI 預設關閉。僅手動選取的項目會在下一步預覽後送至 Google Gemini；每項最多 1,500 字，不附原始檔案。可沿用本次工作階段的 Gemini 金鑰與模型。</p><label class="checkbox"><input type="checkbox" name="enabled" required>本次啟用 AI 語意推薦</label><label>搜尋候選<input name="candidateSearch"></label><div id="semantic-choices" class="semantic-choices"></div><p id="semantic-selection" role="status"></p>`,'<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">檢視將送出的文字</button>',async fd=>{if(!fd.has('enabled'))throw new Error('請先啟用本次 AI 推薦');const built=semanticPayload(entities(),focusId,[...selected],{projectId:project()});previewAI(built);});
    const render=()=>{const needle=dom.querySelector('[name="candidateSearch"]').value.trim().toLocaleLowerCase(),found=rows.filter(r=>`${objectTitle(r)} ${r.aliases||''}`.toLocaleLowerCase().includes(needle));dom.querySelector('#semantic-choices').innerHTML=found.slice(0,200).map(r=>`<label class="checkbox"><input type="checkbox" data-candidate="${escape(r.id)}" ${selected.has(r.id)?'checked':''}>${escape(KIND_LABELS[r.kind])} · ${escape(objectTitle(r))}</label>`).join('')||'<p>無符合項目</p>';dom.querySelector('#semantic-selection').textContent=`已選 ${selected.size} 項（最多 12）；顯示符合條件的前 200 項。`;dom.querySelectorAll('[data-candidate]').forEach(el=>el.onchange=()=>{if(el.checked&&selected.size>=12){el.checked=false;toast('最多選擇 12 項');return;}el.checked?selected.add(el.dataset.candidate):selected.delete(el.dataset.candidate);render();});};
    dom.querySelector('[name="candidateSearch"]').oninput=render;render();
  }
  function previewAI(built) {
    const prefs=credentials(),scopeAtRequest=project();
    dialog('確認送至 Gemini 的內容',`<p>以下為完整請求文字。只有按下「傳送並取得候選」才會連接雲端；回覆不會自動建立連結。金鑰僅用於本次請求。</p><label>Gemini API Key<input type="password" name="key" autocomplete="off" value="${escape(prefs.key||'')}" required></label><label>模型 ID<input name="model" value="${escape(prefs.model||'')}" required></label><label>完整送出文字<textarea class="semantic-preview" readonly>${escape(built.prompt)}</textarea></label><label class="checkbox"><input type="checkbox" name="consent" required>我已核對這些文字，確認送至 Google Gemini</label>`,'<button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">傳送並取得候選</button>',async fd=>{
      if(!fd.has('consent'))throw new Error('請先核對並確認送出');
      const result=await(await api('/api/ai',{method:'POST',body:{key:fd.get('key'),model:fd.get('model'),text:built.prompt}})).json();
      if(focusId!==built.payload.focus.id||project()!==scopeAtRequest||!dom.querySelector('#dialog[open] .semantic-preview'))return;
      aiCandidates=parseSemantic(result.answer,built.payload);aiScope=project();mode='ai';show();
    });
  }
  async function accept(row) {
    if(!row)throw new Error('候選已失效，請重新探索');
    const requestFocus=focusId,requestScope=project();
    const state=(await(await api('/api/state?summary=1')).json()).entities;
    if(focusId!==requestFocus||project()!==requestScope)throw new Error('探索範圍已變更，請重新確認');
    const a=state.find(r=>r.id===focusId),b=state.find(r=>r.id===row.id);
    if(!a||!b||a.revision!==row.focusRevision||b.revision!==row.revision)throw new Error('內容已更新或刪除，請關閉後重新探索');
    const allowed=new Set(scopedState(state,project()).map(r=>r.id));if(!allowed.has(a.id)||!allowed.has(b.id))throw new Error('項目不在目前範圍');
    if(alreadyLinked(scopedState(state,project()),a.id,b.id)){await refresh();show();toast('已有正式連結，未重複建立');return;}
    const reason=row.method==='ai'?`人工確認 AI 語意建議：${row.reason}`:`人工確認文字提及「${row.term}」；${row.direction}。片段：${row.snippet}`;
    await api('/api/entities',{method:'POST',body:{kind:'link',data:{title:'相關',from:row.from,to:row.to,relation:'related',reason,targetRevision:state.find(r=>r.id===row.to).revision,projectId:project()&&project()!=='inbox'?project():null}}});
    aiCandidates=aiCandidates.filter(r=>r.id!==row.id);await refresh();if(focusId===requestFocus&&project()===requestScope&&dom.querySelector('#dialog[open] [data-action^="discovery-"]'))show();toast('已建立相關連結；不代表證據支持');
  }
  async function handle(action,id) {
    const verb=action.slice(10);
    if(verb==='explore'){focusId=id;mode='graph';depth=1;kind='';relation='';aiCandidates=[];show();}
    else if(verb==='center'){focusId=id;mode='graph';show();}
    else if(verb==='open'){const row=get(id);if(!row)throw new Error('項目已移除');dom.querySelector('#dialog').close();await go(objectView(row),id);}
    else if(verb==='graph'||verb==='mentions'){mode=verb;show();}
    else if(verb==='ai-select')chooseAI();
    else if(verb==='accept'||verb==='accept-ai'){
      if(accepting)return;accepting=true;
      try{if(verb==='accept-ai'&&aiScope!==project())throw new Error('專案範圍已變更，請重新取得候選');await accept((verb==='accept-ai'?aiCandidates:candidates()).find(r=>r.id===id));}finally{accepting=false;}
    }
    else if(verb==='ignore'){ignoreSet().add(id);show();}
    else if(verb==='ignore-ai'){aiCandidates=aiCandidates.filter(r=>r.id!==id);show();}
    else if(verb==='reset'){ignoreSet().clear();if(mode==='ai')aiCandidates=[];show();}
    else if(verb==='export')exportFile(mode==='graph'?'local-graph.json':'relation-candidates.json',mode==='graph'?graphSnapshot:{focusId,projectId:project(),status:'unconfirmed-candidates',method:mode,candidates:mode==='ai'?aiCandidates:candidates()});
    else if(verb==='svg')exportFile('local-graph.svg',localGraphSVG(graphSnapshot),'image/svg+xml');
  }
  return {handle,canHandle:action=>action.startsWith('discovery-')};
}
