import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { posix } from 'node:path';
import { AppError } from './store.mjs';

const tags=(node,name)=>[...node.getElementsByTagNameNS('*',name)];
export async function officeArchive(bytes,required) {
  let zip;try{zip=await JSZip.loadAsync(bytes);}catch{throw new AppError('Office 檔案不是有效的新版格式，可能已加密或損壞');}
  const files=Object.values(zip.files),size=files.reduce((n,f)=>n+(f._data?.uncompressedSize||0),0);
  if(files.length>2500||size>100*1024*1024)throw new AppError('Office 解壓縮內容過大，請分段後再上傳');
  if(!zip.file('[Content_Types].xml')||!zip.file(required))throw new AppError('Office 內容與副檔名不符');
  return zip;
}
async function readXML(zip,path,read) {
  const file=zip.file(path);if(!file)throw new AppError(`Office 缺少必要資料：${path}`);
  if(file._data?.uncompressedSize>8*1024*1024)throw new AppError('Office 單一文字區塊過大，請分段匯入');
  const value=await file.async('string');if(value.length>8*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(value))throw new AppError('Office XML 格式不支援');
  let dom;try{dom=new JSDOM(value,{contentType:'application/xml'});return read(dom.window.document);}catch(e){if(e instanceof AppError)throw e;throw new AppError('Office XML 已損壞或無法解析');}finally{dom?.window.close();}
}
const relId=node=>[...node.attributes].find(a=>a.localName==='id'&&a.namespaceURI?.includes('relationships'))?.value;
async function relationships(zip,path,folder) {
  return readXML(zip,path,doc=>new Map(tags(doc,'Relationship').filter(r=>r.getAttribute('TargetMode')?.toLowerCase()!=='external').map(r=>{
    const target=r.getAttribute('Target')||'',resolved=posix.normalize(target.startsWith('/')?target.slice(1):posix.join(folder,target));
    if(target.includes('\\')||target.includes(':')||resolved.startsWith('../')||resolved.startsWith('/'))throw new AppError('Office 內部參照路徑無效');
    return [r.getAttribute('Id'),resolved];
  })));
}
function combine(pages) {
  const text=pages.map(p=>`〔${p.label}〕\n${p.text}`).join('\n\n');if(text.length>400000)throw new AppError('Office 文字過長，請依工作表或投影片分段匯入');return text;
}
export async function parseSpreadsheet(bytes) {
  const zip=await officeArchive(bytes,'xl/workbook.xml'),links=await relationships(zip,'xl/_rels/workbook.xml.rels','xl');
  const sheets=await readXML(zip,'xl/workbook.xml',doc=>{if(doc.documentElement.localName!=='workbook')throw new AppError('無效的 Excel 活頁簿');return tags(doc,'sheet').map(s=>({name:s.getAttribute('name')||'未命名工作表',path:links.get(relId(s))}));});
  if(sheets.length>100)throw new AppError('Excel 最多支援 100 個工作表，請分段匯入');
  const strings=zip.file('xl/sharedStrings.xml')?await readXML(zip,'xl/sharedStrings.xml',doc=>tags(doc,'si').map(si=>tags(si,'t').filter(t=>{for(let p=t.parentElement;p&&p!==si;p=p.parentElement)if(p.localName==='rPh')return false;return true;}).map(t=>t.textContent).join(''))):[];
  const pages=[];let cells=0,uncached=false;
  for(const [index,sheet] of sheets.entries()) {
    if(!sheet.path?.startsWith('xl/'))throw new AppError('Excel 工作表參照無效');
    const text=await readXML(zip,sheet.path,doc=>{
      if(doc.documentElement.localName==='chartsheet')return '〔圖表工作表，未擷取圖像與數據〕';
      if(doc.documentElement.localName!=='worksheet')throw new AppError('Excel 工作表格式無效');
      return tags(doc,'row').map((row,i)=>{
        const values=tags(row,'c').map((cell,j)=>{
          if(++cells>50000)throw new AppError('Excel 最多擷取 50,000 個儲存格，請分段匯入');
          const type=cell.getAttribute('t'),value=tags(cell,'v')[0]?.textContent,formula=tags(cell,'f').length>0;let text='';
          if(type==='s'){const n=Number(value);if(value==null||!Number.isInteger(n)||n<0||n>=strings.length)throw new AppError('Excel 共用文字參照無效');text=strings[n];}
          else if(type==='inlineStr')text=tags(cell,'t').map(t=>t.textContent).join('');
          else if(type==='b')text=value==='1'?'TRUE':value==='0'?'FALSE':value||'';
          else text=value||'';
          if(formula&&value==null){uncached=true;text='〔公式沒有快取結果，未計算〕';}
          return text?`${cell.getAttribute('r')||`欄 ${j+1}`}：${text}`:'';
        }).filter(Boolean);
        return values.length?`第 ${row.getAttribute('r')||i+1} 列｜${values.join('｜')}`:'';
      }).filter(Boolean).join('\n');
    });
    pages.push({number:index+1,label:`工作表：${sheet.name}`,text});combine(pages);
  }
  const warnings=['Excel 以工作表／儲存格位置擷取文字；數字與日期格式不重建，公式只讀取檔案內快取值，不重新計算；圖表、圖片與外部資料不載入。'];
  if(uncached)warnings.push('部分公式沒有快取結果，請在 Excel 重新計算並另存後再匯入。');
  return {text:combine(pages),pages,warnings,parseStatus:'已擷取儲存格文字（未重算公式）'};
}
export async function parsePresentation(bytes) {
  const zip=await officeArchive(bytes,'ppt/presentation.xml'),links=await relationships(zip,'ppt/_rels/presentation.xml.rels','ppt');
  const slides=await readXML(zip,'ppt/presentation.xml',doc=>{if(doc.documentElement.localName!=='presentation')throw new AppError('無效的 PowerPoint 簡報');return tags(doc,'sldId').map(s=>links.get(relId(s)));});
  if(slides.length>500)throw new AppError('PowerPoint 最多支援 500 張投影片，請分段匯入');
  const pages=[];
  for(const [i,path] of slides.entries()){
    if(!path?.startsWith('ppt/'))throw new AppError('PowerPoint 投影片參照無效');
    const text=await readXML(zip,path,doc=>{if(doc.documentElement.localName!=='sld')throw new AppError('投影片格式無效');return tags(doc,'p').map(p=>[...p.getElementsByTagName('*')].filter(n=>['t','br'].includes(n.localName)).map(n=>n.localName==='br'?'\n':n.textContent).join('')).filter(Boolean).join('\n');});
    pages.push({number:i+1,label:`投影片第 ${i+1} 張`,text});combine(pages);
  }
  return {text:combine(pages),pages,parseStatus:'已擷取投影片文字',warnings:['依簡報順序擷取投影片文字；不重建視覺排版、不載入動畫、備註或外部內容，圖像中的文字尚未 OCR。']};
}
