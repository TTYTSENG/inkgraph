import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import JSZip from 'jszip';
import { Store } from '../lib/store.mjs';
import { bibliography, inText, ris, missingFields } from '../lib/citations.mjs';
import { backup, restore, exportContent, resolveNote, csv, reportHTML, projectState } from '../lib/exports.mjs';
import { parseFile } from '../lib/imports.mjs';
import { makeServer } from '../server.mjs';

const source = (extra={}) => ({title:'A test of evidence',authors:[{family:'Smith',given:'Jane'}],year:'2024',journal:'Journal of Testing',volume:'12',issue:'2',pageRange:'10-20',doi:'10.1234/example',projectId:null,cslType:'article-journal',text:'An original passage with context.',...extra});

test('SQLite persists records, references and attachment bytes across reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-test-'));let s;
  try{s=new Store(join(dir,'vault.sqlite'));const p=s.save('project',{title:'Research'});const doc=s.save('source',source({projectId:p.id}));const bytes=Buffer.from('original file');const fid=s.attach(doc.id,'paper.txt','text/plain',bytes);s.close();s=new Store(join(dir,'vault.sqlite'));assert.equal(s.get(doc.id).projectId,p.id);assert.deepEqual(Buffer.from(s.file(fid).bytes),bytes);assert.equal(s.state().find(x=>x.id===doc.id).attachment.name,'paper.txt');}
  finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('Rejects broken references and concurrent edits',()=>{
  const s=new Store(':memory:');try{const doc=s.save('source',source());assert.throws(()=>s.save('annotation',{sourceId:'missing',quote:'x',locator:'p. 1'}),/找不到/);assert.throws(()=>s.save('annotation',{sourceId:doc.id,quote:'x',locator:''}),/頁碼/);const updated=s.save('source',{...doc,title:'Updated'},doc.id);assert.equal(updated.revision,2);assert.throws(()=>s.save('source',{...doc,title:'Stale'},doc.id),/其他頁籤/);assert.equal(s.get(doc.id).title,'Updated');}finally{s.close();}
});
test('APA journal/book citations and direct-quote locator use CSL, omit AI chat',()=>{
  const article={...source(),id:'article'};const book={...source({title:'The evidence book',cslType:'book',publisher:'Test Press'}),id:'book'};const ai={...source({title:'AI chat',cslType:'personal-communication'}),id:'chat'};
  const refs=bibliography([article,book,ai],'text').join('\n');assert.match(refs,/Smith, J\./);assert.match(refs,/\(2024a\)/);assert.match(refs,/\(2024b\)/);assert.match(refs,/https:\/\/doi.org\/10.1234\/example/);assert.match(refs,/Test Press/);assert.doesNotMatch(refs,/AI chat/);assert.match(inText([article],'article','12'),/Smith, 2024, p\. 12/);assert.equal(bibliography([ai]).length,0);assert.deepEqual(missingFields({...article,authors:[],year:''}),['作者','年份']);assert.match(ris([article]),/SP  - 10\r\nEP  - 20/);
});
test('Complete backup restores identities and original files; conflicts and tampering leave data unchanged',async()=>{
  const s=new Store(':memory:'),out=new Store(':memory:');try{
    const p=s.save('project',{title:'My project'}),doc=s.save('source',source({projectId:p.id}));
    s.save('annotation',{sourceId:doc.id,projectId:p.id,quote:'original passage',locator:'paragraph 1',verified:false});s.save('term',{title:'Evidence',definition:'Definition',sourceId:doc.id,projectId:p.id});s.save('note',{title:'Draft',content:`See [@${doc.id}, p. 12]`,sourceIds:[doc.id],projectId:p.id});s.attach(doc.id,'original.txt','text/plain',Buffer.from('ORIGINAL'));
    const bytes=await backup(s);assert.equal((await restore(out,bytes)).added,5);assert.deepEqual(out.list(),s.list());assert.equal(Buffer.from(out.files()[0].bytes).toString(),'ORIGINAL');assert.equal((await restore(out,bytes)).skipped,5);
    const current=out.get(doc.id);out.save('source',{...current,title:'New edition'},doc.id);await assert.rejects(restore(out,bytes),/不同版本/);assert.equal(out.get(doc.id).title,'New edition');
    const zip=await JSZip.loadAsync(bytes);zip.file(`attachments/${s.files()[0].id}`,'tampered');const bad=await zip.generateAsync({type:'nodebuffer'});const fresh=new Store(':memory:');try{await assert.rejects(restore(fresh,bad),/校驗失敗/);assert.equal(fresh.list().length,0);}finally{fresh.close();}
  }finally{s.close();out.close();}
});
test('Exports preserve notes, locators, relationships, citations and spreadsheet safety',()=>{
  const a={...source(),id:'a',kind:'source'},b={...source({title:'Another paper'}),id:'b',kind:'source'};
  const note={id:'n',kind:'note',title:'My note',sourceIds:[],content:'A finding [@a, p. 12]'};
  const state=[a,b,note,{id:'r',kind:'relation',from:'b',to:'a',relation:'contradicts',reason:'Different evidence, p. 9'},{id:'q',kind:'annotation',sourceId:'a',quote:'Original text',locator:'printed p. 12; file p. 14',verified:false}];
  const resolved=resolveNote(note,[a,b]);assert.match(resolved.content,/Smith, 2024, p\. 12/);assert.equal(resolved.refs.length,1);const md=exportContent(state,'markdown')[2];assert.match(md,/printed p\. 12; file p\. 14/);assert.match(md,/待核對/);assert.match(md,/Different evidence/);assert.match(csv([['=HYPERLINK("x")']]),/"'=HYPERLINK/);
  const html=reportHTML([{...a,title:'<img src=x onerror=alert(1)>',summary:'<script>alert(1)</script>'}]);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;script&gt;/);
  const moved=state.map(x=>x.kind==='source'?{...x,projectId:'new-project'}:x);
  const scoped=projectState(moved,'new-project');assert.ok(scoped.some(x=>x.id==='q'));assert.ok(scoped.some(x=>x.id==='r'));assert.ok(!scoped.some(x=>x.id==='n'));
});
function minimalPDF(text='A PDF passage with evidence.') {
  const stream=`BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let output='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(output);output+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(output);
}
test('File import extracts PDF/DOCX and preserves text, rejects mismatched binaries',async()=>{
  const pdf=await parseFile('paper.pdf',minimalPDF());assert.equal(pdf.pages.length,1);assert.match(pdf.pages[0].text,/PDF passage/);
  const zip=new JSZip();zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A DOCX paragraph.</w:t></w:r></w:p></w:body></w:document>');
  const doc=await parseFile('doc.docx',await zip.generateAsync({type:'nodebuffer'}));assert.match(doc.text,/DOCX paragraph/);const html=await parseFile('chat.html',Buffer.from('<p>Hello</p><script>steal()</script>'));assert.equal(html.text.trim(),'Hello');await assert.rejects(parseFile('bad.png',Buffer.from('not image')),/不符/);await assert.rejects(parseFile('file.exe',Buffer.from('x')),/支援/);
});
test('HTTP isolation, file privacy, duplicate imports and Gemini request boundary',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'inkgraph-api-'));let sent;
  const app=makeServer({dataPath:dir,port:0,aiFetch:async(url,options)=>{sent={url,options};return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'A grounded draft.'}]}}]}),{status:200});}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const req=(path,opts={})=>fetch(base+path,{...opts,headers:{'x-inkgraph-token':app.token,...opts.headers}});
  try{
    assert.equal((await fetch(base+'/api/state')).status,403);assert.equal((await req('/api/state',{headers:{Origin:'https://hostile.example'}})).status,403);
    const hostileHostStatus=await new Promise((resolve,reject)=>{httpGet(base+'/api/state',{headers:{Host:'hostile.example','x-inkgraph-token':app.token}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(hostileHostStatus,403);
    const payload={name:'source.txt',base64:Buffer.from('Private source text').toString('base64')};const imported=await(await req('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();assert.ok(imported.sourceId);
    const duplicate=await(await req('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();assert.equal(duplicate.duplicate,true);assert.equal(app.store.list().length,1);
    const fid=app.store.files()[0].id;assert.equal((await fetch(base+'/files/'+fid)).status,403);const file=await fetch(base+'/files/'+fid,{headers:{Cookie:`inkgraph_session=${app.token}`}});assert.equal(await file.text(),'Private source text');
    const apiKey='TEST-KEY-NOT-A-REAL-SECRET';const ai=await req('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:apiKey,model:'test-model',text:'Only this approved excerpt.'})});assert.equal(ai.status,200);assert.equal(sent.options.headers['x-goog-api-key'],apiKey);assert.equal(JSON.parse(sent.options.body).contents[0].parts[0].text,'Only this approved excerpt.');assert.equal(JSON.stringify(app.store.list()).includes(apiKey),false);assert.equal((await(await backup(app.store)).toString()).includes(apiKey),false);
    assert.equal((await req('/api/entities',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'source',id:'does-not-exist',data:source()})})).status,404);
    const page=await fetch(base+'/');assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(page.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(dir,{recursive:true,force:true});}
});
