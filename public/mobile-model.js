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

// Reception, machine processing and human review are independent states.
// Jobs arrive newest first; a retained older result is not a completed retry.
export function captureWorkflow(capture,jobs=[]){
  const sourceIds=new Set(capture.sourceIds||[]),latest=new Map();
  for(const job of jobs)if(sourceIds.has(job.source_id)&&!latest.has(job.source_id))latest.set(job.source_id,job);
  const counts={queued:0,running:0,done:0,failed:0,cancelled:0,unavailable:Math.max(0,Number(capture.mediaCount||0)-latest.size)};
  for(const job of latest.values())if(Object.hasOwn(counts,job.state))counts[job.state]++;else counts.unavailable++;
  const needsHelp=counts.failed+counts.cancelled>0;
  let phase='processing',label='等待辨識';
  if(!capture.mediaCount){phase='text';label='純文字，無需辨識';}
  else if(needsHelp){phase='attention';label=`${counts.failed+counts.cancelled} 份需處理${counts.done?` · ${counts.done} 份已產生文字`:''}`;}
  else if(counts.running){label=`辨識中${counts.done?` · ${counts.done} 份已完成`:''}`;}
  else if(counts.queued){label=`${counts.queued} 份等待辨識${counts.done?` · ${counts.done} 份已完成`:''}`;}
  else if(counts.unavailable){phase='unavailable';label='部分附件進度未載入，請查看原始記錄';}
  else{phase='review';label='文字已產生，待人工核對';}
  return {phase,label,counts,received:'電腦已保存此版本',review:'尚未登記人工校對結果'};
}
