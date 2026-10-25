import JSZip from 'jszip';
const contentTypes='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
export async function xlsxFixture({unsafeXML=false,external=false}={}) {
  const zip=new JSZip();zip.file('[Content_Types].xml',contentTypes);
  zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="合成研究表" sheetId="1" r:id="r1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="${external?'https://example.invalid/never':'worksheets/sheet1.xml'}" ${external?'TargetMode="External"':''}/></Relationships>`);
  zip.file('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>合成標題</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml',(unsafeXML?'<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///never">]>':'')+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>研究用文字</t></is></c></row><row r="3"><c r="A3"><f>SUM(1,2)</f><v>3</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><f>NOW()</f></c></row></sheetData></worksheet>');
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function pptxFixture() {
  const zip=new JSZip();zip.file('[Content_Types].xml',contentTypes);
  zip.file('ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="300" r:id="r2"/><p:sldId id="301" r:id="r1"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>');
  for(const [number,text] of [[1,'第二張合成頁'],[2,'第一張合成頁']])zip.file(`ppt/slides/slide${number}.xml`,`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r><a:br/><a:r><a:t>可引用的投影片文字</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function docxFixture() {
  const zip=new JSZip();zip.file('[Content_Types].xml',contentTypes);
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 合成研究文字</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({type:'nodebuffer'});
}
export const legacyFixture=()=>Buffer.concat([Buffer.from([0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1]),Buffer.alloc(128)]);
