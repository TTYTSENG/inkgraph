import JSZip from 'jszip';
import { randomUUID,createHash } from 'node:crypto';
export function wavFixture(seconds=.25){const n=Math.round(seconds*16000)*2,b=Buffer.alloc(44+n);b.write('RIFF',0);b.writeUInt32LE(n+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n,40);return b;}
export const pngFixture=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTFAAAAAASUVORK5CYII=','base64');
export async function captureFixture({manifest,photo=false,audio=true,text='〔合成〕本地測試想法',extra,corrupt=false}={}){
  const files=new Map(),now='2026-10-25T10:00:00.000Z';
  if(!manifest){const media=[];for(const type of [...(audio?['audio']:[]),...(photo?['photo']:[])]){const id=randomUUID(),bytes=type==='audio'?wavFixture():pngFixture(),ext=type==='audio'?'wav':'png',path=`media/${id}.${ext}`;files.set(path,bytes);media.push({id,file:path,name:`sample.${ext}`,type,mime:type==='audio'?'audio/wav':'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),capturedAt:now,...(type==='audio'?{durationMs:250,offsetMs:0,sampleRate:16000}:{})});}
    manifest={format:'inkgraph-capture',version:1,deviceId:randomUUID(),capture:{id:randomUUID(),revision:1,createdAt:now,updatedAt:now,completedAt:now,timezone:'Asia/Taipei',utcOffsetMinutes:480,text,location:{status:'denied'},media}};
  }else for(const m of manifest.capture.media)files.set(m.file,m.type==='audio'?wavFixture(m.durationMs/1000):pngFixture());
  const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest));for(const [name,data] of files)zip.file(name,corrupt?Buffer.from('corrupt'):data);if(extra)zip.file(extra.name,extra.bytes||'bad');return {manifest,files,bytes:await zip.generateAsync({type:'nodebuffer'})};
}
