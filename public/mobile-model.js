export function locationText(location={}){
  const labels={unknown:'未取得',pending:'保存時尚未取得',denied:'未授權',disabled:'定位未開啟',timeout:'定位逾時',stale:'舊位置（需核對）',manual:'手動標示'};
  if(location.status==='captured')return `${location.label?location.label+' · ':''}${location.lat}, ${location.lon} · 精度約${location.accuracyMeters}公尺 · 定位時間${location.measuredAt}`;
  return `${location.label?location.label+' · ':''}${labels[location.status]||'未取得'}`;
}
export function captureText(row,{omitLocation=false}={}){
  const capture=row.mobileCapture;if(!capture)return '';
  return `手機原始記錄：${capture.id} · 第${capture.revision}版\n記錄時間：${capture.createdAt}\n時區：${capture.timezone}（UTC偏移${capture.utcOffsetMinutes}分鐘）\n修改時間：${capture.updatedAt}\n完成時間：${capture.completedAt}\n桌面接收時間：${capture.receivedAt}\n地點：${omitLocation||row.mobileLocationOmitted?'已於此次輸出排除':locationText(capture.location)}\n原始附件數：${capture.media?.length||0}（機器辨識另列，待核對）`;
}
export function withoutMobileLocation(state){return state.map(row=>{const r=structuredClone(row);if(r.mobileCapture){delete r.mobileCapture.location;for(const m of r.mobileCapture.media||[])delete m.location;r.mobileLocationOmitted=true;}if(r.mobileMedia)delete r.mobileMedia.location;return r;});}
