export function evidenceText(source) {
  if (!source.lightEvidence && source.origin !== 'light') return '';
  const data=source.lightEvidence || {verification:source.verification || 'UNRESOLVED'};
  const levels={metadata:'書目',abstract:'摘要',fulltext:'全文',unknown:'未說明'};
  return [`提供者聲明：${data.verification || 'UNRESOLVED'}`,
    '墨脈機器核查：未執行', '墨脈人工核查：未確認',
    `提供者閱讀範圍：${levels[data.readLevel] || '未說明'}`,
    data.provider && `提供者：${data.provider}`,
    data.checkedAt && `提供者查證時間：${data.checkedAt}`,
    data.url && `提供者證據位置：${data.url}`,
    data.note && `提供者核對紀錄：${data.note}`].filter(Boolean).join('\n');
}
