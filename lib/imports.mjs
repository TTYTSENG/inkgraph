import mammoth from 'mammoth';
import { AppError, hash } from './store.mjs';

export const MAX_FILE = 25 * 1024 * 1024;
const types = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export async function parseFile(name, bytes) {
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  const mime = types[ext];
  if (!mime) throw new AppError('支援 PDF、DOCX、TXT、MD、HTML、JSON、CSV 與 PNG/JPG/WebP');
  if (bytes.length > MAX_FILE) throw new AppError('單一檔案上限為 25 MB', 413);
  let text = '', pages = [], parseStatus = '已解析', warnings = [];
  if (ext === '.pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AppError('檔案不是有效的 PDF');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, disableFontFace: true }).promise;
      if (doc.numPages > 1000) throw new AppError('第一版支援最多 1,000 頁的 PDF');
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        const t = content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('').trim();
        pages.push({ number, text: t });
      }
      text = pages.map(p => `〔檔案第 ${p.number} 頁〕\n${p.text}`).join('\n\n');
      if (!pages.some(p => p.text.trim())) { parseStatus = '需要 OCR'; warnings.push('這份 PDF 沒有可擷取文字；請閱讀原檔並手動摘錄。第一版尚未提供 OCR。'); }
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('PDF 解析失敗：可能已加密、損壞或不支援'); }
    finally { if (doc) await doc.destroy(); }
  } else if (ext === '.docx') {
    try { const r = await mammoth.extractRawText({ buffer: bytes }); text = r.value; warnings = r.messages.map(m => m.message); }
    catch { throw new AppError('DOCX 解析失敗，請確認檔案格式'); }
  } else if (mime.startsWith('image/')) {
    const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
      ['.jpg','.jpeg'].includes(ext) ? bytes[0] === 255 && bytes[1] === 216 : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
    if (!valid) throw new AppError('圖片內容與副檔名不符');
    parseStatus = '手動摘錄'; warnings.push('圖片可預覽與加註；第一版尚未提供 OCR。');
  } else {
    text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (ext === '.html' || ext === '.htm') {
      // Never render imported markup. Preserve original bytes, provide a best-effort plain text view.
      text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      warnings.push('HTML 以純文字匯入；對話角色與引用標記請人工確認。');
    }
    if (ext === '.json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { throw new AppError('JSON 格式錯誤'); } warnings.push('JSON 作為原始文字匯入，不會假設為完整 Gemini 對話。'); }
  }
  if (text.length > 1_500_000) throw new AppError('解析文字過長，請將檔案分段匯入');
  return { mime, text, pages, parseStatus, warnings, fileHash: hash(bytes) };
}
