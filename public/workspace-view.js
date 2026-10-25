import { connections, usedExcerpts, excerptStatus } from './research-workspace.js';
import { relatedLinks, LINK_LABELS, objectTitle } from './knowledge-model.js';
import { scopedState } from './project-scope.js';
import { renderObjectLinks, shortcutHints, usedObjectLinks } from './object-navigation.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action,label,id='',cls='quiet small') => `<button class="${cls}" data-action="${action}" data-id="${escape(id)}">${escape(label)}</button>`+(action==='knowledge-link'?`<button class="quiet small" data-action="discovery-explore" data-id="${escape(id)}">探索關係</button>`:'');
const projectName = (state, row) => state.find(r => r.kind === 'project' && r.id === row.projectId)?.title || '待整理收件匣';
function section(title,body,count) {
  return `<details class="connection-section" ${count===0?'':'open'}><summary>${escape(title)}${count == null ? '' : `<span class="badge gray">${count}</span>`}</summary><div>${body || '<p class="quiet-text">目前沒有相關資料。</p>'}</div></details>`;
}
export function renderConnections(state, focus, {projectId='', allProjects=false, selectedAnnotationId=''}={}) {
  const linked = connections(state, focus, {projectId,allProjects});
  const scopedIds=new Set(scopedState(state,projectId).map(r=>r.id));
  const excerptNotes=id=>state.filter(n=>['note','term'].includes(n.kind)&&(allProjects||!projectId||scopedIds.has(n.id))&&((n.bodyDeferred?n.excerptAnnotationIds||[]:[]).includes(id)||usedExcerpts(n).some(ref=>ref.annotationId===id)));
  const snapshots = ['note','term'].includes(focus.kind) ? usedExcerpts(focus) : [];
  const sources = linked.sources.map(s => `<div class="connection-item">${button('workspace-source',s.title,s.id)}<small>${escape(s.year || '年份待補')} · ${escape(s.origin === 'gemini' || s.origin === 'notebooklm' ? '對話／筆記素材' : '原始來源')}</small></div>`).join('');
  const excerpts = linked.annotations.map(a => `<article class="connection-item excerpt ${a.id === selectedAnnotationId ? 'selected-excerpt' : ''}" id="excerpt-${escape(a.id)}"><span class="badge ${a.verified ? '' : 'amber'}">${a.verified ? '已人工核對' : '待核對'}</span><blockquote>${escape(a.quote)}</blockquote><p>${escape(a.paraphrase || '釋義待補')}</p><small>${escape(a.locator)} · ${escape(projectName(state,a))}</small><div class="actions">${button('add-excerpt','加入筆記',a.id,'small')}${button('knowledge-open','開啟摘錄',a.id)}${button('edit-annotation','編輯',a.id)}</div>${excerptNotes(a.id).map(n=>`<small>引用此摘錄：<a href="#note/${escape(n.id)}">${escape(n.title)}</a></small>`).join('')}</article>`).join('');
  const cited = snapshots.map(ref => `<div class="connection-item"><strong>${escape(ref.locator)}</strong><p>${escape(ref.quote)}</p><small>${escape(excerptStatus(ref,state))}</small>${button('workspace-excerpt','查看摘錄出處',ref.annotationId)}</div>`).join('');
  const notes = linked.notes.map(n => `<div class="connection-item"><a href="#note/${escape(n.id)}">${escape(n.title)}</a><small>${escape(projectName(state,n))}</small><p>${escape((n.content || '').replace(/\[\[摘錄:[^\]]+\]\]/g,'〔引用摘錄〕').slice(0,100))}</p></div>`).join('');
  const terms = linked.terms.map(t => `<div class="connection-item"><strong>${escape(t.title)}</strong><p>${escape(t.definition || '定義待補')}</p>${button('edit-term','編輯術語',t.id)}</div>`).join('');
  const relations = linked.relations.map(r => `<div class="connection-item"><p>${escape(state.find(s=>s.id===r.from)?.title || r.from)} → ${escape(({supports:'支持',contradicts:'反駁',extends:'延伸',compares:'比較'})[r.relation])} → ${escape(state.find(s=>s.id===r.to)?.title || r.to)}</p><small>${escape(r.reason || '證據待補')}</small></div>`).join('');
  const objectLinks=relatedLinks(state,focus.id,{projectId,allProjects});
  const links=objectLinks.links.map(link=>`<article class="connection-item"><small>${link.to===focus.id?'連入':link.from===focus.id?'連出':'討論內連結'} · ${escape(LINK_LABELS[link.relation])} · ${escape(state.find(r=>r.id===link.projectId)?.title||'全庫')}</small><div>${button('knowledge-open',objectTitle(state.find(r=>r.id===link.from)),link.from)} → ${button('knowledge-open',objectTitle(state.find(r=>r.id===link.to)),link.to)}</div>${link.reason?`<p>${escape(link.reason)}</p>`:''}${link.fromLocator||link.toLocator?`<small>位置：${escape(link.fromLocator||'未標示')} → ${escape(link.toLocator||'未標示')}</small>`:''}${button('delete-entity','移除連結',link.id)}</article>`).join('');
  const discussions=(linked.discussions||[]).map(d=>`<div class="connection-item">${button('knowledge-open',d.title,d.id)}<small>${escape(projectName(state,d))}</small></div>`).join('');
  const hidden=linked.hidden+objectLinks.hidden;
  const navigationNotes=state.filter(n=>['note','term'].includes(n.kind)&&(allProjects||!projectId||scopedIds.has(n.id))&&usedObjectLinks(n).includes(focus.id));
  const navigationBacklinks=section('被筆記連結（導覽）',navigationNotes.map(n=>`<div class="connection-item"><strong>${escape(n.title)}</strong><div>${button('nav-preview','預覽',n.id)}${button('nav-open','開啟',n.id)}</div></div>`).join(''),navigationNotes.length);
  return `<aside class="connections-panel" aria-label="關聯側欄"><div class="connections-heading"><span class="eyebrow">CONNECTIONS</span><h2>關聯與出處</h2><p>${escape(objectTitle(focus))}</p><div class="actions">${button('knowledge-link','＋ 建立物件連結',focus.id)}</div>${projectId ? `<label class="checkbox"><input type="checkbox" id="connections-all" ${allProjects ? 'checked' : ''}>顯示跨專案關聯</label><small>${hidden ? `另有 ${hidden} 筆跨專案關聯` : '已顯示目前範圍的關聯'}</small>` : '<small>目前範圍：全部專案</small>'}</div>${section('物件連結',links,objectLinks.links.length)}${navigationBacklinks}${section('原始依據',sources,linked.sources.length)}${snapshots.length ? section('本篇引用的摘錄',cited,snapshots.length) : ''}${focus.kind==='annotation'?section('引用此摘錄的筆記',excerptNotes(focus.id).map(n=>`<p><a href="#note/${escape(n.id)}">${escape(n.title)}</a></p>`).join(''),excerptNotes(focus.id).length):''}${section(focus.kind==='source' ? '使用此來源的筆記' : '共用來源的其他筆記',notes,linked.notes.length)}${section('來源相關討論',discussions,linked.discussions?.length||0)}${section('摘錄與加註',excerpts,linked.annotations.length)}${section('相關辭典條目',terms,linked.terms.length)}${section('文獻脈絡',relations,linked.relations.length)}${section('所屬專案',linked.projects.map(p=>`<p>${escape(p.title)}</p>`).join(''),linked.projects.length)}</aside>`;
}
export function renderNoteEditor(note, draft, state, {split=false}={}) {
  const term=note.kind==='term';
  const snapshots = usedExcerpts({...note,content:draft.value,excerptRefs:draft.excerptRefs});
  const previews=snapshots.map(ref=>`<article class="snapshot-card"><blockquote>${escape(ref.quote)}</blockquote><p>釋義：${escape(ref.paraphrase || '尚未填寫')}</p>${ref.comment ? `<p>加註：${escape(ref.comment)}</p>` : ''}<small>${escape(state.find(s=>s.id===ref.sourceId)?.title || '來源已移除')} · ${escape(ref.locator)}</small><small>${escape(excerptStatus(ref,state))}</small><div class="actions">${button('workspace-excerpt','查看摘錄出處',ref.annotationId)}</div></article>`).join('');
  return `<section class="note-writing-pane" aria-label="筆記編輯區">
    <header class="pane-heading"><div><span class="eyebrow">${term?'GLOSSARY CONTEXT':'YOUR THINKING'}</span><h2>${escape(note.title)}</h2></div><div class="actions">${split ? button('workspace-note-full','單獨開啟',note.id) : ''}${!term?button('choose-split-note','切換筆記'):''}<button type="button" class="small" data-action="nav-insert" title="連結研究項目（Ctrl＋Shift＋L）" aria-keyshortcuts="Control+Shift+L">連結研究項目 <kbd>Ctrl⇧L</kbd></button>${button('insert-citation','插入引用')}${button('save-note',term?'儲存詞條說明':'儲存筆記',note.id,'primary small')}</div></header>
    <div class="reader-sheet writing-sheet"><label class="editor-label" for="note-content">筆記內容</label><textarea class="editor-textarea" id="note-content" aria-label="筆記內容">
${escape(draft.value)}</textarea><div class="editor-footer"><span id="note-save-status">${draft.value !== draft.content ? '有尚未儲存的修改' : '已儲存'}</span><span>Markdown · 手動儲存</span></div></div>
    ${shortcutHints()}${renderObjectLinks({...note,content:draft.value},state)}
    ${snapshots.length ? `<section class="excerpt-preview" aria-label="引用摘錄預覽"><h3>引用摘錄預覽</h3><p class="quiet-text">上方的摘錄標記會在匯出時展開為原文、釋義與出處。移除標記即可移除該次引用。</p>${previews}</section>` : ''}
  </section>`;
}
