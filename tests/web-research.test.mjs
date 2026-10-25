import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { WebResearch,canonicalURL,publicURL,privateAddress,parseArticle,rankCandidates } from '../lib/web-research.mjs';
import { NotebookBrowser,notebookURL,managedTitle } from '../lib/notebook-browser.mjs';
import { backup,restore } from '../lib/exports.mjs';
import { makeServer } from '../server.mjs';

const url='https://example.com/insights/ceo-strategy';
const target='https://notebooklm.google.com/notebook/test-notebook';
const html=(word='strategy')=>`<!doctype html><html><head><title>CEO strategy and capital allocation</title><meta name="author" content="Test Author"><meta property="article:published_time" content="2026-10-16"></head><body><nav>Discard navigation</nav><article><h1>CEO strategy and capital allocation</h1><h2>Resource allocation</h2>${Array.from({length:12},(_,i)=>`<p>Evidence paragraph ${i}: The CEO leads ${word} decisions, resource allocation and the leadership team, while balancing growth and long term priorities.</p>`).join('')}<table><thead><tr><th>Role</th><th>Owner</th></tr></thead><tbody><tr><td>Strategy</td><td>CEO</td></tr></tbody></table><a href="/insights/ceo-capital-allocation">CEO capital allocation priorities</a><a href="https://outsider.com/ceo-strategy">External CEO strategy article</a></article></body></html>`;
const retrieve=async u=>({url:u,html:html()});

test('Related article search returns ten unique same-site results, excludes the seed and preserves smaller result sets',()=>{
  const seed={url,title:'CEO strategy and capital allocation'};
  const candidates=Array.from({length:15},(_,i)=>({url:`https://example.com/insights/ceo-strategy-${i}`,title:`CEO strategy and capital allocation study ${i}`}));
  const result=rankCandidates(seed,[{url:url+'?utm_source=email',title:seed.title},...candidates,...candidates.map(c=>({...c,url:c.url+'?utm_source=email'})),{url:'https://elsewhere.com/ceo-strategy',title:seed.title}]);
  assert.equal(result.length,10);assert.equal(new Set(result.map(x=>x.url)).size,10);assert.ok(result.every(x=>x.url!==url&&new URL(x.url).hostname==='example.com'));
  assert.equal(rankCandidates(seed,candidates.slice(0,3)).length,3);
});

test('Web URL normalization keeps functional parameters and rejects local/private destinations',()=>{
  assert.equal(canonicalURL(url+'?utm_source=email&cid=123&page=2#section'),url+'?page=2');
  for(const u of ['http://example.com','https://127.0.0.1','https://localhost','https://foo.internal','https://user:pass@example.com','https://example.com:8443','file:///C:/secret'])assert.throws(()=>publicURL(u));
  for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(privateAddress(ip),true);
  assert.equal(privateAddress('8.8.8.8'),false);assert.equal(privateAddress('2606:4700::1111'),false);
});
test('Article conversion keeps headings, tables, metadata, rejects thin login pages and ranks same-site candidates',()=>{
  const a=parseArticle(html(),url);assert.match(a.markdown,/## Resource allocation/);assert.match(a.markdown,/\| Role/);assert.equal(a.byline,'Test Author');assert.equal(a.published,'2026-10-16');
  assert.throws(()=>parseArticle('<title>Sign in</title><p>Login</p>',url),/正文不足/);
  const articles=rankCandidates(a,[...a.links,{url:url+'?utm_source=x',title:'Duplicate CEO strategy'},{url:'https://example.com/other',title:'Cooking tips with tomatoes'}]);
  assert.equal(articles.length,1);assert.equal(new URL(articles[0].url).hostname,'example.com');assert.match(articles[0].reason,/非 AI/);
});
test('Every capture preserves immutable Markdown and stable source identity; changed source invalidates annotations; backup restores history',async()=>{
  const s=new Store(':memory:'),out=new Store(':memory:');let word='strategy';const web=new WebResearch(s,{retrieve:async u=>({url:u,html:html(word)})});
  try{
    const first=await web.capture(url);const initial=s.get(first.sourceId),file=s.file(first.attachmentId);
    const note=s.save('note',{title:'Linked note',content:'My notes',sourceIds:[initial.id]});
    const annotation=s.save('annotation',{sourceId:initial.id,quote:'Evidence',locator:'paragraph 1',verified:true,sourceHash:initial.fileHash});
    const same=await web.capture(url+'?utm_source=mail');assert.equal(same.sourceId,initial.id);assert.equal(same.changed,false);assert.equal(s.get(annotation.id).verified,true);
    word='transformation';const third=await web.capture(url);assert.equal(third.sourceId,initial.id);assert.equal(third.changed,true);assert.equal(s.get(annotation.id).verified,false);
    assert.equal(s.get(note.id).sourceIds[0],initial.id);assert.equal(s.get(initial.id).webVersions.length,3);assert.equal(s.files().length,3);assert.equal(s.attachment(initial.id).id,third.attachmentId);assert.deepEqual(s.file(first.attachmentId).bytes,file.bytes);
    await restore(out,await backup(s));assert.deepEqual(out.get(initial.id).webVersions,s.get(initial.id).webVersions);assert.equal(out.files().length,3);assert.equal(out.attachment(initial.id).id,third.attachmentId);
  }finally{s.close();out.close();}
});
test('Discovery reports search failure and still offers relevant links from the seed',async()=>{
  const s=new Store(':memory:');try{const web=new WebResearch(s,{retrieve:async u=>{if(u.includes('bing.com'))throw Error('offline');return retrieve(u);}});const r=await web.discover(url);assert.equal(r.articles.length,1);assert.equal(r.warnings.length,1);assert.equal(s.list().length,0);}finally{s.close();}
});

function fakePage(initial=[],{failUpload=false}={}){
  const titles=new Set(initial);let uploads=0;
  return {titles,get uploads(){return uploads;},getByText:name=>({count:async()=>titles.has(name)?1:0,first:()=>({waitFor:async()=>{if(!titles.has(name))throw Error('missing');}})}),getByRole:()=>({first:()=>({click:async()=>{if(failUpload)throw Error('login required');}})}),locator:()=>({count:async()=>1,first:()=>({setInputFiles:async f=>{uploads++;titles.add(f.name);}})})};
}
test('Notebook upload retries are idempotent and cloud deletion never occurs before the new source appears',async()=>{
  const s=new Store(':memory:');try{
    const first=await new WebResearch(s,{retrieve}).capture(url);const page=fakePage();const browser=new NotebookBrowser(s,'.');browser.pageFor=async()=>page;
    let r=await browser.sync([first.sourceId],target,{replace:true});assert.equal(r.results[0].status,'uploaded');assert.equal(page.uploads,1);
    await browser.sync([first.sourceId],target,{replace:true});assert.equal(page.uploads,1);
    const oldTitle=managedTitle(s.get(first.sourceId));await new WebResearch(s,{retrieve:async u=>({url:u,html:html('changed')})}).capture(url);
    browser.removeManaged=async(_page,title)=>{assert.equal(title,oldTitle);assert.equal(page.titles.has(managedTitle(s.get(first.sourceId))),true);throw Error('UI changed');};
    r=await browser.sync([first.sourceId],target,{replace:true});assert.equal(r.results[0].status,'cleanup_required');assert.equal(s.get(first.sourceId).notebookSync[target].pendingCleanup,oldTitle);
    browser.removeManaged=async(_page,title)=>{page.titles.delete(title);};await browser.sync([first.sourceId],target,{replace:true});assert.equal(s.get(first.sourceId).notebookSync[target].status,'uploaded');assert.equal(page.uploads,2);
  }finally{s.close();}
});
test('Failed upload does not create a success receipt; rejects wrong notebook destinations',async()=>{
  for(const bad of ['https://evil.com/notebook/abc','https://notebooklm.google.com.evil.com/notebook/abc','http://notebooklm.google.com/notebook/abc'])assert.throws(()=>notebookURL(bad));
  const s=new Store(':memory:');try{const captured=await new WebResearch(s,{retrieve}).capture(url);const browser=new NotebookBrowser(s,'.');browser.pageFor=async()=>fakePage([],{failUpload:true});const r=await browser.sync([captured.sourceId],target);assert.equal(r.results[0].status,'failed');assert.deepEqual(s.get(captured.sourceId).notebookSync,{});}finally{s.close();}
});
test('Web endpoints require local session; historical download returns original version rather than latest',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-web-'));
  const app=makeServer({dataPath:dir,port:0,retrieveWeb:retrieve,notebookFactory:()=>({close:async()=>{}})});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;const req=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'x-inkgraph-token':app.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await fetch(base+'/api/web/capture',{method:'POST'})).status,403);
    const captured=await(await req('/api/web/capture',{url})).json();assert.ok(captured.sourceId);const version=app.store.get(captured.sourceId).webVersions[0];
    const history=await req(`/api/web/version?source=${captured.sourceId}&version=${version.id}`);assert.equal(history.status,200);assert.match(await history.text(),/# CEO strategy/);
    assert.equal((await req(`/api/web/version?source=${captured.sourceId}&version=missing`)).status,404);
    assert.equal((await req('/api/web/capture',{url:url+'/new',projectId:'missing'})).status,400);
  }finally{await new Promise(r=>app.server.close(r));app.store.close();rmSync(dir,{recursive:true,force:true});}
});
