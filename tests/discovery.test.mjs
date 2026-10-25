import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { graphData,unlinkedMentions,semanticPayload,parseSemantic } from '../public/discovery-model.js';
import { createDiscoveryWorkspace,localGraphSVG } from '../public/discovery-workspace.js';

const seed=()=>[
  {id:'p',kind:'project',title:'A'}, {id:'q',kind:'project',title:'B'},
  {id:'s',kind:'source',title:'原始文獻',text:'信任與可追溯性',projectId:'p',revision:1},
  {id:'n',kind:'note',title:'研究判斷',content:'比較信任（Trust）與原始文獻。',sourceIds:['s'],projectId:'p',revision:1},
  {id:'c',kind:'concept',title:'信任',aliases:'Trust;Confidence',definition:'可核對的理解',projectId:'p',revision:2},
  {id:'a',kind:'annotation',sourceId:'s',quote:'原文',projectId:'p',revision:1},
  {id:'d',kind:'discussion',title:'討論',sourceIds:['s'],projectId:'p',revision:1},
  {id:'m',kind:'message',title:'訊息',content:'信任的判斷',discussionId:'d',projectId:'p',revision:1},
  {id:'secret',kind:'note',title:'信任私評',content:'信任的另一種解釋',projectId:'q',revision:1},
  {id:'l',kind:'link',from:'n',to:'d',relation:'related',projectId:'p',reason:'脈絡'},
  {id:'private',kind:'link',from:'n',to:'c',relation:'related',projectId:'q',reason:'B 私評'},
];
test('Local graph bounds cycles, derives provenance and respects project, depth, kind and relation filters',()=>{
  const state=seed();state.push({id:'cycle',kind:'link',from:'d',to:'n',relation:'related',projectId:'p'});
  const one=graphData(state,'n',{projectId:'p'});assert.deepEqual(new Set(one.nodes.map(n=>n.id)),new Set(['n','s','d']));
  assert.ok(!one.edges.some(e=>e.id==='private'));
  const two=graphData(state,'n',{projectId:'p',depth:2});assert.ok(two.nodes.some(n=>n.id==='m'));assert.ok(two.nodes.some(n=>n.id==='a'));assert.ok(!two.nodes.some(n=>n.id==='secret'));
  assert.deepEqual(graphData(state,'secret',{projectId:'p'}).nodes,[]);
  assert.deepEqual(graphData(state,'n',{projectId:'p',kind:'source'}).nodes.map(n=>n.id),['s','n']);
  assert.equal(graphData(state,'n',{projectId:'p',relation:'related'}).nodes.length,2);
  const limited=graphData(state,'n',{projectId:'p',depth:2,limit:2});assert.equal(limited.nodes.length,2);assert.equal(limited.truncated,true);
});
test('Mention candidates show Chinese aliases and exact English words, ignore existing scoped relations and support session ignore',()=>{
  const state=seed(),rows=unlinkedMentions(state,'n',{projectId:'p'});
  assert.ok(rows.some(r=>r.id==='c'&&r.term==='信任'));assert.ok(!rows.some(r=>r.id==='secret'||r.id==='d'));
  assert.ok(!unlinkedMentions(state,'n',{projectId:'p',ignored:new Set(['c'])}).some(r=>r.id==='c'));
  state.find(r=>r.id==='n').content='Untrustworthy confidence';state.find(r=>r.id==='c').title='Trust';state.find(r=>r.id==='c').aliases='';
  assert.ok(!unlinkedMentions(state,'n',{projectId:'p'}).some(r=>r.id==='c'));
  state.find(r=>r.id==='n').content='A Trust-based interpretation';assert.ok(unlinkedMentions(state,'n',{projectId:'p'}).some(r=>r.id==='c'));
  state.push({id:'new',kind:'link',from:'c',to:'n',relation:'related',projectId:'p'});assert.ok(!unlinkedMentions(state,'n',{projectId:'p'}).some(r=>r.id==='c'));
});
test('Semantic request includes only explicitly selected scoped text, limits size, and rejects invented, duplicate or malformed IDs',()=>{
  const state=seed();state.find(r=>r.id==='c').definition='字'.repeat(10000);
  const {payload,prompt}=semanticPayload(state,'n',['c'],{projectId:'p'});
  assert.equal(payload.candidates.length,1);assert.equal(payload.candidates[0].text.length,1500);assert.ok(!prompt.includes('信任私評'));assert.ok(!prompt.includes('B 私評'));
  assert.throws(()=>semanticPayload(state,'n',['secret'],{projectId:'p'}));assert.throws(()=>semanticPayload(state,'n',[],{projectId:'p'}));
  assert.deepEqual(parseSemantic('[]',payload),[]);
  const parsed=parseSemantic('```json\n[{"id":"c","reason":"均探討信任"}]\n```',payload);assert.equal(parsed[0].revision,2);assert.equal(parsed[0].method,'ai');
  for(const answer of ['bad','{}','[{"id":"secret","reason":"x"}]','[{"id":"c","reason":""}]','[{"id":"c","reason":"x"},{"id":"c","reason":"x"}]'])assert.throws(()=>parseSemantic(answer,payload));
});
test('SVG escapes research data and preserves graph direction and inspectable node links',()=>{
  const graph=graphData(seed(),'n',{projectId:'p'});graph.nodes[0].title='<script>alert(1)</script>';const svg=localGraphSVG(graph);
  assert.ok(!svg.includes('<script>'));assert.match(svg,/&lt;script&gt;/);assert.match(svg,/marker-end/);assert.match(svg,/data-action="discovery-open"/);assert.match(svg,/不代表語意距離/);
});

function workspace(){
  const dom=new JSDOM('<dialog id="dialog"></dialog>'),document=dom.window.document,state=seed(),calls=[];let submit,scope='p',answer='[{"id":"c","reason":"討論信任與判斷"}]';
  const api=async(path,opts={})=>{calls.push({path,body:opts.body});if(path==='/api/state?summary=1')return {json:async()=>({entities:state})};if(path==='/api/ai')return {json:async()=>({answer})};if(path==='/api/entities'){state.push({id:'saved',kind:'link',revision:1,...opts.body.data});return {json:async()=>state.at(-1)};}throw new Error(path);};
  const ui=createDiscoveryWorkspace({entities:()=>state,project:()=>scope,api,refresh:async()=>{},go:async()=>{},toast:()=>{},dom:document,dialog:(title,body,footer,onSubmit)=>{const d=document.querySelector('#dialog');d.setAttribute('open','');d.innerHTML=body+footer;submit=onSubmit;}});
  return {ui,state,calls,document,dom,submit:fd=>submit(fd),scope:value=>scope=value,answer:value=>answer=value};
}
test('AI stays off through graph/mention/selection/preview; only explicit consent sends exactly the preview, then human acceptance saves',async()=>{
  const w=workspace();try{
    await w.ui.handle('discovery-explore','n');await w.ui.handle('discovery-mentions');await w.ui.handle('discovery-ai-select');assert.equal(w.calls.length,0);
    assert.equal(w.document.querySelector('[name="enabled"]').checked,false);
    await assert.rejects(()=>w.submit(new Map()),/啟用/);
    const check=w.document.querySelector('[data-candidate="c"]');check.checked=true;check.dispatchEvent(new w.dom.window.Event('change'));
    await w.submit(new Map([['enabled','on']]));assert.equal(w.calls.length,0);
    const prompt=w.document.querySelector('.semantic-preview').value;
    await assert.rejects(()=>w.submit(new Map([['key','demo-key-123'],['model','model-id']])),/確認送出/);assert.equal(w.calls.length,0);
    await w.submit(new Map([['key','demo-key-123'],['model','model-id'],['consent','on']]));assert.equal(w.calls.length,1);assert.equal(w.calls[0].body.text,prompt);assert.equal(w.state.filter(r=>r.id==='saved').length,0);
    await w.ui.handle('discovery-accept-ai','c');assert.equal(w.state.filter(r=>r.id==='saved').length,1);assert.equal(w.state.at(-1).relation,'related');assert.match(w.state.at(-1).reason,/人工確認 AI/);assert.ok(!JSON.stringify(w.state).includes('demo-key-123'));
  }finally{w.dom.window.close();}
});
test('Candidate acceptance rechecks revisions, deleted endpoints, existing links, and serializes double clicks',async()=>{
  const w=workspace();try{
    await w.ui.handle('discovery-explore','n');await w.ui.handle('discovery-mentions');
    await Promise.all([w.ui.handle('discovery-accept','c'),w.ui.handle('discovery-accept','c')]);assert.equal(w.state.filter(r=>r.id==='saved').length,1);
    // AI snapshots must be rejected after an endpoint changes.
    w.state.splice(w.state.findIndex(r=>r.id==='saved'),1);await w.ui.handle('discovery-ai-select');
    const check=w.document.querySelector('[data-candidate="c"]');check.checked=true;check.dispatchEvent(new w.dom.window.Event('change'));
    await w.submit(new Map([['enabled','on']]));await w.submit(new Map([['key','demo-key-123'],['model','model-id'],['consent','on']]));
    w.state.find(r=>r.id==='c').revision++;
    await assert.rejects(()=>w.ui.handle('discovery-accept-ai','c'),/內容已更新/);assert.ok(!w.state.some(r=>r.id==='saved'));
    w.state.splice(w.state.findIndex(r=>r.id==='c'),1);
    await assert.rejects(()=>w.ui.handle('discovery-accept-ai','c'),/內容已更新或刪除/);
    w.scope('q');await assert.rejects(()=>w.ui.handle('discovery-accept-ai','c'),/專案範圍已變更/);
  }finally{w.dom.window.close();}
});
test('Graph SVG/JSON and candidate JSON download handlers preserve scope, labels and unconfirmed status',async()=>{
  const w=workspace(),downloads=[];
  w.dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push({name:this.download,url:this.href});};
  try{
    await w.ui.handle('discovery-explore','n');await w.ui.handle('discovery-export');
    const graph=await(await fetch(downloads.at(-1).url)).json();assert.equal(downloads.at(-1).name,'local-graph.json');assert.ok(graph.nodes.some(n=>n.id==='n'));assert.ok(!graph.nodes.some(n=>n.id==='secret'));
    await w.ui.handle('discovery-svg');const svg=await(await fetch(downloads.at(-1).url)).text();assert.match(svg,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);assert.match(svg,/研究判斷/);
    await w.ui.handle('discovery-mentions');await w.ui.handle('discovery-export');const candidates=await(await fetch(downloads.at(-1).url)).json();assert.equal(candidates.status,'unconfirmed-candidates');assert.ok(candidates.candidates.some(r=>r.id==='c'));assert.ok(!JSON.stringify(candidates).includes('信任私評'));
  }finally{w.dom.window.close();for(const d of downloads)URL.revokeObjectURL(d.url);}
});
