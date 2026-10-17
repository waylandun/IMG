import { createEditor } from './editor.js';
import { initTheme } from './theme.js';
import { createReferenceEditor } from './reference-editor.js';
import { createConfigPanel } from './config-panel.js';

initTheme();

const $ = selector => document.querySelector(selector);
const mcp = window.__IMAGEBOARD_MCP__, embed = window.__IMAGEBOARD_EMBED__ || (mcp ? { mcp: true } : null), imageCache = new Map();
const state = { config: null, jobs: [], conversations: [], conversationId: null, conversation: null, chatSource: null, pendingSubmission: null, selected: null, outputIndex: 0, view: 'studio', references: [], parent: null, edit: null, source: null, sending: false, uploading: false, galleryFilter: 'all', search: '', managing: null };
state.editingResult = null; state.advancedOpen = false;
let referenceEditor;
const labels = { refining: '理解你的想法', generating: '正在创建图像', completed: '已完成', prepared: '提示词已就绪', failed: '生成失败', cancelled: '已停止' };
const active = job => job && ['refining', 'generating'].includes(job.status);
const chatActive = item => item && ['thinking', 'generating'].includes(item.status);
const busy = () => state.sending || state.uploading || state.jobs.some(active) || state.conversations.some(chatActive);
const current = () => state.jobs.find(job => job.id === state.selected);
const outputs = job => job.outputs || [];
const title = job => job.title || job.prompt;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, callback, className = 'tool-button') => { const b = el('button', className, text); b.type = 'button'; b.onclick = callback; return b; };
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function localFetch(url, options = {}) { if (mcp) return mcp.fetch(url, options); return fetch(embed ? new URL(url, embed.origin) : url, { ...options, ...(embed ? { credentials: 'omit', headers: { ...options.headers, 'X-Imageboard-Embed': embed.capability } } : {}) }); }
async function api(url, options) {
  let response; try { response = await localFetch(url, options); } catch (error) { throw new Error(mcp ? error.message || '连接中断，请在 Codex 中重新加载 Imageboard。' : '本地服务连接中断，请确认 Imageboard 仍在运行。'); }
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || '请求失败，请重试。'), { status: response.status }); return data;
}
const post = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const configPanel = createConfigPanel({ api, notify: toast, onConfig: config => {
  state.config = config;
  const label = `${config.channelName || 'Codex 扫描配置'} · ${config.imageModel || '未配置'}`;
  $('#connection-label').textContent = label;
  $('#connection').title = `模型与连接配置：${label}`;
  $('#connection').classList.toggle('not-ready', !config.ready);
  const warning = !config.promptReady ? `聊天模型不可用：${config.promptError}` : !config.ready ? `生图暂不可用，仍可继续讨论：${config.error}` : '';
  $('#config-warning').hidden = !warning; $('#config-warning').textContent = warning;
  updateControls();
} });
async function imageData(url) {
  if (!imageCache.has(url)) imageCache.set(url, (async () => {
    const response = await localFetch(url);
    if (!response.ok) throw new Error('图片读取失败，请重新打开面板。');
    const blob = await response.blob();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size) throw new Error('图片内容无效，请重新打开面板。');
    return { blob, url: URL.createObjectURL(blob) };
  })().catch(error => { imageCache.delete(url); throw error; }));
  return imageCache.get(url);
}
async function imageSource(url) { return embed ? (await imageData(url)).url : url; }
function setImage(img, assetOrUrl) {
  const assetUrl = typeof assetOrUrl === 'string' ? assetOrUrl : assetOrUrl.url;
  img.onerror = () => toast('图片显示失败，请刷新 Imageboard 面板后重试。');
  void imageSource(assetUrl).then(url => { img.src = url; }).catch(error => toast(error.message));
}
function imageElement(asset, alt = '') { const img = el('img'); img.alt = alt; img.loading = 'lazy'; if (asset.width && asset.height) { img.width = asset.width; img.height = asset.height; } setImage(img, asset); return img; }
function preview(asset) { setImage($('#preview-image'), asset); $('#preview-image').alt = asset.name || '图片预览'; $('#preview-dialog').showModal(); }
function downloadLink(asset) {
  const link = el('a', 'download-button', '↓ 下载'); link.download = `imageboard-${asset.id.slice(0, 8)}.${asset.format}`;
  if (!embed) link.href = `${asset.url}?download=1`;
  else {
    link.setAttribute('role', 'button'); link.tabIndex = 0;
    link.onclick = async event => { event.preventDefault(); try { const { blob, url } = await imageData(asset.url); if (mcp && await mcp.download(blob, link.download)) return; const a = el('a'); a.href = url; a.download = link.download; document.body.append(a); a.click(); a.remove(); } catch (error) { toast(error.message); } };
    link.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); link.click(); } };
  }
  return link;
}
async function upload(blob, name, mask = false) {
  const mime = blob.type || (/\.webp$/i.test(name) ? 'image/webp' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || blob.size > 20 * 1024 * 1024) throw new Error('请选择 20 MB 以内的 PNG、JPEG 或 WebP。');
  return api(`/api/assets${mask ? '?mask=1' : ''}`, { method: 'POST', headers: { 'Content-Type': mime, 'X-Imageboard-Filename': encodeURIComponent(name || '参考图.png') }, body: blob });
}
async function uploadFiles(files) {
  if (busy() || state.advancedOpen) { toast('请等待当前操作结束后再添加图片。'); return; }
  const list = [...files]; if (!list.length) return;
  if (state.references.length + list.length > 16) { toast('最多添加 16 张参考图。'); return; }
  if (state.view === 'gallery') newImage();
  state.uploading = true; updateControls();
  try {
    for (const file of list) { const asset = await upload(file, file.name); state.references.push({ assetId: asset.id, asset, role: 'general', note: '' }); renderReferences(); }
    toast(`已添加 ${list.length} 张参考图`);
  } catch (error) { toast(error.message); }
  finally { state.uploading = false; renderReferences(); updateControls(); $('#prompt').focus(); }
}
function clearEdit() { state.edit = null; }
function removeReference(index) {
  if (busy()) return;
  const ref = state.references[index];
  if (state.parent?.assetId === ref.assetId) state.parent = null;
  if (index === 0) clearEdit(); state.references.splice(index, 1); renderReferences(); updateControls();
  const remaining = document.querySelectorAll('.reference-remove');
  (remaining[Math.min(index, remaining.length - 1)] || $('#upload-reference')).focus();
}
function renderReferences() {
  const root = $('#reference-list'); root.replaceChildren();
  state.references.forEach((ref, index) => {
    if (state.editingResult?.ref === ref) return;
    if (state.conversationId && state.parent?.assetId === ref.assetId && !ref.comments?.length) return;
    const card = el('div', 'reference-card');
    const thumb = button('', () => referenceEditor.open(ref, { readOnly: busy() }), 'reference-thumb'); thumb.setAttribute('aria-label', `查看参考图${index + 1}`); thumb.title = ref.asset.name; thumb.append(imageElement(ref.asset));
    if (ref.comments?.length) thumb.append(el('span', 'reference-comment-badge', `${ref.comments.length} 条评论`));
    const remove = button('', () => removeReference(index), 'reference-remove'); remove.disabled = busy(); remove.setAttribute('aria-label', `移除参考图${index + 1}`); remove.title = '移除图片'; remove.append($('#reference-remove-icon').content.cloneNode(true));
    card.append(thumb, remove); root.append(card);
  });
  root.hidden = !root.childElementCount;
  const context = $('#edit-context'); context.replaceChildren(); context.hidden = !state.parent && !state.edit;
  if (state.parent && !state.editingResult) {
    const ref = state.references.find(item => item.assetId === state.parent.assetId);
    if (state.conversationId && ref) {
      const chip = button('', () => referenceEditor.open(ref, { readOnly: busy() }), 'current-image');
      chip.append(imageElement(ref.asset), el('span', '', `当前图片 · 方案 ${state.parent.outputIndex + 1}`)); chip.setAttribute('aria-label', '查看当前编辑图片'); context.append(chip);
      const reset = button('清除选择', () => removeReference(state.references.indexOf(ref)), 'text-button'); reset.disabled = busy(); context.append(reset);
    } else context.append(el('span', '', `正在编辑「${title(state.jobs.find(j => j.id === state.parent.jobId) || { prompt: '历史版本' })}」的方案 ${state.parent.outputIndex + 1}`));
  }
  if (state.edit) {
    context.append(el('span', 'edit-badge', state.edit.type === 'inpaint' ? '已设置局部选区' : '已设置扩图画布'));
    const reset = button('取消选区', () => { clearEdit(); renderReferences(); }, 'text-button'); reset.disabled = busy(); context.append(reset);
  }
  context.hidden = !context.childElementCount;
  resizeComposer();
}
function settings() { return { size: $('#size').value, quality: $('#quality').value, count: Number($('#count').value), format: $('#format').value, compression: Number($('#compression').value), background: $('#background').value, action: 'none', optimize: true, useVision: $('#use-vision').checked }; }
function restoreSettings(job) {
  for (const [name, fallback] of [['size','auto'],['quality','auto'],['count',1],['format','png'],['compression',90],['background','auto']]) $(`#${name}`).value = job[name] ?? fallback;
  $('#use-vision').checked = job.useVision !== false; syncOutputOptions();
}
function syncOutputOptions() {
  if ($('#background').value === 'transparent' && $('#format').value === 'jpeg') { $('#format').value = 'png'; toast('透明背景已使用 PNG 格式'); }
  $('#compression-control').hidden = $('#format').value === 'png'; $('#compression-value').textContent = $('#compression').value;
}
function draftEdit(job) { return job.edit ? job.edit.type === 'inpaint' ? { type: 'inpaint', maskId: job.edit.mask.id, sourceId: job.references[0].assetId } : { type: 'outpaint', margins: job.edit.margins, sourceId: job.references[0].assetId } : null; }
function baseOn(job, index = 0) {
  const asset = outputs(job)[index]; if (!asset) return;
  state.outputIndex = index; state.parent = { jobId: job.id, outputIndex: index, assetId: asset.id }; state.edit = null;
  state.references = [{ assetId: asset.id, asset, role: 'base', note: '保留未要求修改的内容' }, ...(job.references || []).filter(ref => ref.role !== 'base' && ref.role !== 'general' && ref.assetId !== asset.id).slice(0,15).map(ref => ({ ...ref }))];
  renderReferences(); updateControls();
}
function selectJob(job, index = 0) {
  if (job.conversationId) { void selectConversation(job.conversationId, { job, index }); return; }
  if (!closeResultEditor()) return;
  state.conversationId = null; state.conversation = null; rememberConversation(null);
  closeHistory(); state.selected = job.id; state.outputIndex = index; state.view = 'studio'; restoreSettings(job);
  if (job.status === 'completed' && !job.deletedAt) baseOn(job, index);
  else { state.references = (job.references || []).map(ref => ({ ...ref })); state.parent = job.parent || null; state.edit = draftEdit(job); }
  render();
}
function closeResultEditor() { return !state.editingResult || referenceEditor.close(); }
async function openResultEditor(job, index = 0) {
  if (busy() || job.deletedAt || !outputs(job)[index]) return;
  if (state.editingResult?.jobId === job.id && state.editingResult.index === index) { $('#reference-dialog').focus(); return; }
  if (referenceEditor.isProcessing()) { toast('图片正在处理，请稍候。'); return; }
  if (!referenceEditor.close()) return;
  state.selected = job.id; baseOn(job, index); state.editingResult = { jobId: job.id, index, ref: state.references[0] };
  renderStage(); renderReferences(); updateControls();
  await referenceEditor.open(state.editingResult.ref, { docked: true });
  resizeComposer();
}
function updateJob(job) {
  const index = state.jobs.findIndex(item => item.id === job.id), previous = state.jobs[index];
  if (previous && JSON.stringify(previous) === JSON.stringify(job)) return;
  if (index < 0) state.jobs.unshift(job); else state.jobs[index] = job;
  if (state.selected === job.id && job.status === 'completed' && previous?.status !== 'completed') baseOn(job, 0);
  renderHistory(); updateControls(); if (state.selected === job.id || state.view === 'gallery') renderStage();
}
function watch(job) {
  state.source?.close(); let closed = false, timer;
  const source = { close() { closed = true; clearTimeout(timer); } }; state.source = source;
  const poll = async () => {
    try { const next = await api(`/api/jobs/${job.id}`); if (closed) return; updateJob(next); if (!active(next)) { source.close(); if (state.source === source) state.source = null; renderReferences(); return; } }
    catch { /* A disconnected client resumes polling; it never resubmits a generation. */ }
    if (!closed) timer = setTimeout(poll, 1200);
  }; void poll();
}
function rememberConversation(id) { try { if (id) localStorage.setItem('imageboard-conversation', id); else localStorage.removeItem('imageboard-conversation'); } catch {} }
function rememberPending(value) {
  state.pendingSubmission = value;
  try { if (value) localStorage.setItem('imageboard-pending-message', JSON.stringify(value)); else localStorage.removeItem('imageboard-pending-message'); } catch {}
}
function updateConversation(conversation) {
  const { turns, ...summary } = conversation;
  const index = state.conversations.findIndex(item => item.id === conversation.id);
  if (index < 0) state.conversations.unshift(summary); else state.conversations[index] = summary;
  for (const turn of turns) if (turn.job) {
    const jobIndex = state.jobs.findIndex(job => job.id === turn.job.id);
    if (jobIndex < 0) state.jobs.unshift(turn.job); else state.jobs[jobIndex] = turn.job;
  }
  if (state.conversationId === conversation.id) {
    const previous = state.conversation, last = turns.at(-1);
    const stage = $('#stage'), follow = stage.scrollHeight - stage.clientHeight - stage.scrollTop < 80;
    const completedImage = last?.job?.status === 'completed' && previous?.turns.at(-1)?.job?.status !== 'completed';
    state.conversation = conversation;
    if (last?.job) {
      if (!state.selected || last.job.id !== previous?.turns.at(-1)?.job?.id) state.selected = last.job.id;
      if (last.job.outputs?.length && last.job.status === 'completed' && previous?.turns.at(-1)?.job?.status !== 'completed') baseOn(last.job, 0);
    }
    if (JSON.stringify(previous) !== JSON.stringify(conversation)) {
      renderStage();
      if (follow && completedImage && state.view === 'studio') $('.chat-turn:last-child .assistant-output')?.scrollIntoView({ block: 'start' });
    }
  }
  renderHistory(); updateControls();
}
async function selectConversation(id, selection = null) {
  if (!closeResultEditor()) return;
  closeHistory(); state.conversationId = id; state.conversation = null; state.selected = null; state.view = 'studio'; rememberConversation(id);
  state.references = []; state.parent = null; clearEdit(); render();
  try {
    const conversation = await api(`/api/conversations/${id}`);
    if (state.conversationId !== id) return;
    updateConversation(conversation);
    const last = conversation.turns.at(-1);
    if (last) restoreSettings(last.settings);
    if (selection?.job) { state.selected = selection.job.id; baseOn(selection.job, selection.index); }
    else if (last?.job?.outputs?.length) { state.selected = last.job.id; baseOn(last.job, 0); }
    else if (last) { state.references = last.references.map(ref => ({ ...ref })); state.parent = last.parent; state.edit = last.edit; }
    render(); $('#stage').scrollTop = $('#stage').scrollHeight;
    if (chatActive(conversation)) watchConversation(id);
  } catch (error) { toast(error.message); }
}
function watchConversation(id) {
  if (state.chatSource?.id === id) return;
  state.chatSource?.close(); let closed = false, timer;
  const source = { id, close() { closed = true; clearTimeout(timer); } }; state.chatSource = source;
  const poll = async () => {
    try {
      const conversation = await api(`/api/conversations/${id}`); if (closed) return;
      updateConversation(conversation);
      if (!chatActive(conversation)) { source.close(); if (state.chatSource === source) state.chatSource = null; renderReferences(); return; }
    } catch { /* Reconnect by reading persisted turns, never by replaying work. */ }
    if (!closed) timer = setTimeout(poll, 900);
  }; void poll();
}
async function startTurn(input) {
  const signature = JSON.stringify(input);
  let pending = state.pendingSubmission;
  if (pending && (pending.signature !== signature || (state.conversationId && pending.conversationId !== state.conversationId))) {
    try {
      const recovered = await api(`/api/conversations/${pending.conversationId}`);
      updateConversation(recovered);
      if (pending.signature === signature && recovered.turns.some(turn => turn.requestId === pending.requestId)) {
        rememberPending(null); await selectConversation(recovered.id); $('#prompt').value = ''; updateControls(); return recovered;
      }
      if (chatActive(recovered)) { watchConversation(recovered.id); throw new Error('上一条消息正在处理，请等待完成。'); }
    } catch (error) { if (error.status !== 404) throw error; }
    rememberPending(null); pending = null;
  }
  const conversationId = pending?.conversationId || state.conversationId || crypto.randomUUID();
  pending ||= { conversationId, requestId: crypto.randomUUID(), signature, input };
  rememberPending(pending); rememberConversation(conversationId);
  let conversation;
  try { conversation = await post(`/api/conversations/${conversationId}/messages`, { ...input, requestId: pending.requestId }); }
  catch (error) {
    // The POST may have reached the server even if the response was lost.
    try {
      const recovered = await api(`/api/conversations/${conversationId}`);
      if (recovered.turns.some(turn => turn.requestId === pending.requestId)) conversation = recovered;
    } catch {}
    if (!conversation) {
      if (error.status && error.status < 500) rememberPending(null);
      throw error;
    }
  }
  rememberPending(null);
  if (state.editingResult) referenceEditor.dismiss();
  state.conversationId = conversationId; state.view = 'studio';
  $('#prompt').value = ''; toggleSettings(false);
  updateConversation(conversation); render(); watchConversation(conversationId);
  $('#stage').scrollTop = $('#stage').scrollHeight;
  return conversation;
}
function closeHistory() { if ($('#history-popover').matches(':popover-open')) $('#history-popover').hidePopover(); }
function positionHistory() {
  const popover = $('#history-popover'), anchor = $('#history-button').getBoundingClientRect(), width = Math.min(360, innerWidth - 24), top = anchor.bottom + 8;
  popover.style.width = `${width}px`; popover.style.left = `${Math.max(12, Math.min(anchor.right - width, innerWidth - width - 12))}px`; popover.style.top = `${top}px`; popover.style.maxHeight = `${Math.max(0, Math.min(440, innerHeight - top - 12))}px`;
}
function renderHistory() {
  const root = $('#history'), focus = root.contains(document.activeElement) ? document.activeElement.dataset.jobId : null, scrollTop = root.scrollTop; root.replaceChildren();
  $('#gallery-count').textContent = state.jobs.filter(j => !j.deletedAt).reduce((n,j) => n + outputs(j).length, 0);
  const entries = [...state.conversations.map(conversation => ({ conversation, date: conversation.updatedAt })), ...state.jobs.filter(j => !j.deletedAt && !j.conversationId).map(job => ({ job, date: job.createdAt }))].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  if (!entries.length) root.append(el('p', 'history-empty', '从一个想法开始聊聊。'));
  entries.forEach(({ job, conversation }) => {
    if (conversation) {
      const row = button('', () => { void selectConversation(conversation.id); }, `history-item${state.conversationId === conversation.id && state.view === 'studio' ? ' selected' : ''}`);
      row.dataset.jobId = `conversation:${conversation.id}`; row.title = conversation.title;
      row.append(conversation.preview ? imageElement(conversation.preview) : el('span', `history-symbol${chatActive(conversation) ? ' spinning' : ''}`, '✧'));
      const text = el('span', 'history-text'); text.append(el('strong', '', conversation.title), el('small', '', chatActive(conversation) ? conversation.status === 'thinking' ? '正在回复' : '正在生成图片' : conversation.status === 'failed' ? '本轮未完成' : '继续对话')); row.append(text); root.append(row);
      return;
    }
    const row = button('', () => selectJob(job), `history-item${state.selected === job.id && state.view === 'studio' ? ' selected' : ''}`); row.dataset.jobId = job.id; row.title = title(job);
    row.append(outputs(job)[0] ? imageElement(outputs(job)[0]) : el('span', `history-symbol${active(job) ? ' spinning' : ''}`, active(job) ? '◌' : '✧'));
    const text = el('span', 'history-text'); text.append(el('strong', '', title(job)), el('small', '', `${labels[job.status]}${outputs(job).length > 1 ? ` · ${outputs(job).length} 个方案` : ''}`)); row.append(text); root.append(row);
  });
  root.scrollTop = scrollTop; if (focus) [...root.children].find(node => node.dataset.jobId === focus)?.focus({ preventScroll: true });
}
function welcome() {
  const root = el('div', 'welcome');
  root.append(el('div', 'welcome-badge', '✦  A LITTLE IDEA. A NEW WORLD.'), el('h1', '', '把脑海里的画面，\n变成眼前的作品。'), el('p', 'welcome-copy', '想法明确，就直接画出来；还没想好，我们一起聊聊。'));
  const suggestions = el('div', 'suggestions');
  const samples = [
    { label: '品牌与产品', title: '让日常，变得不寻常', prompt: '为一瓶透明玻璃香水制作极简商业摄影，水面倒影、柔和晨光、浅蓝色背景，不要文字。', kind: 'product', symbol: '◒', tag: 'PRODUCT' },
    { label: '海报与视觉', title: '把一句话，变成视觉', prompt: '设计一张现代爵士音乐节海报，以巨大的抽象萨克斯轮廓、克莱因蓝和奶油色为主，标题文字为「夜色即兴」。', kind: 'poster', symbol: '≋', tag: 'POSTER' },
    { label: '插画与想象', title: '去一个，还不存在的地方', prompt: '画一座漂浮在云海中的玻璃温室，里面生长着巨大的橙色花朵，远处有一颗蓝色星球，细腻的梦幻插画。', kind: 'dream', symbol: '✳', tag: 'IMAGINATION' },
  ];
  samples.forEach(sample => {
    const button = el('button', `suggestion ${sample.kind}`);
    const art = el('div', 'sample-art'); art.append(el('span', 'sample-tag', sample.tag), el('span', 'sample-symbol', sample.symbol), el('span', 'sample-arrow', '↗'));
    const caption = el('div', 'sample-caption'); caption.append(el('small', '', sample.label), el('strong', '', sample.title));
    button.append(art, caption); button.onclick = () => { $('#prompt').value = sample.prompt; $('#prompt').focus(); updateControls(); };
    suggestions.append(button);
  });
  root.append(suggestions, el('p', 'welcome-footnote', '从一点灵感开始，或试试上面的创作方向。'));
  return root;
}
function promptDetails(job) {
  const details = el('details', 'prompt-details'); details.open = job.status === 'prepared';
  const summary = el('summary'); summary.append(el('span', '', '✧ 生图提示词'), el('small', '', job.conversationId ? '根据对话整理' : job.optimize === false ? '直接使用你的提示词' : `${job.model} 整理`));
  const textarea = el('textarea', 'refined-prompt'); textarea.value = job.refinedPrompt; textarea.rows = 5; textarea.maxLength = 16000; textarea.setAttribute('aria-label', '编辑生图提示词');
  const actions = el('div', 'prompt-detail-actions');
  actions.append(button('复制提示词', () => { if (!navigator.clipboard) { toast('请选中文字后手动复制'); return; } void navigator.clipboard.writeText(textarea.value).then(() => toast('提示词已复制')).catch(() => toast('请选中文字后手动复制')); }, 'text-button'));
  const generate = button(job.status === 'prepared' ? '用这个提示词生成 ↗' : '按原设置再生成', () => submit('generate', job.prompt, textarea.value, job), 'primary-button'); generate.disabled = busy() || !state.config?.ready; actions.append(generate);
  details.append(summary, textarea, actions); return details;
}
function family(job) { return state.jobs.filter(j => j.rootId === job.rootId && outputs(j).length && !j.deletedAt).sort((a,b) => a.createdAt.localeCompare(b.createdAt)); }
function renderVersions(job) {
  const relatives = family(job); if (!relatives.length) return null;
  const section = el('section', 'versions'); section.append(el('h3', '', '编辑版本'));
  const row = el('div', 'version-list');
  relatives.forEach((relative, version) => outputs(relative).forEach((asset,index) => {
    const card = button('', () => selectJob(relative,index), `version-card${relative.id === job.id && index === state.outputIndex ? ' selected' : ''}`);
    card.append(imageElement(asset), el('span','',`V${version + 1}${outputs(relative).length > 1 ? ` · 方案${index + 1}` : ''}`));
    card.title = `${title(relative)}${relative.parent ? ' · 基于历史版本修改' : ' · 初始版本'}`; row.append(card);
  }));
  section.append(row, el('p','version-note','选择任意版本可回到那张图继续创作，原版本会保留。')); return section;
}
function openCompare(job, index) {
  const choices = new Map();
  for (const [i, ref] of (job.references || []).entries()) choices.set(ref.asset.id, { asset: ref.asset, label: `参考图${i + 1} · ${ref.asset.name}` });
  family(job).forEach((relative,version) => outputs(relative).forEach((asset,i) => choices.set(asset.id, { asset, label: `V${version + 1} · 方案${i + 1} · ${title(relative).slice(0,25)}` })));
  if (choices.size < 2) { toast('生成第二个方案，或基于这张图修改后，即可比较版本。'); return; }
  const before = $('#compare-before'), after = $('#compare-after'); before.replaceChildren(); after.replaceChildren();
  for (const [id, entry] of choices) { for (const select of [before,after]) { const option = el('option','',entry.label); option.value = id; select.append(option); } }
  after.value = outputs(job)[index].id;
  before.value = job.parent?.assetId || job.references?.[0]?.assetId || [...choices.keys()].find(id => id !== after.value);
  const draw = () => { const a = choices.get(before.value).asset, b = choices.get(after.value).asset; setImage($('#compare-before-image'),a); setImage($('#compare-after-image'),b); $('.compare-canvas').style.aspectRatio = `${b.width}/${b.height}`; };
  before.onchange = after.onchange = draw; $('#compare-slider').value = '50'; $('.compare-canvas').style.setProperty('--split','50%'); draw(); $('#compare-dialog').showModal();
}
async function manageJob(job, changes) {
  const next = await api(`/api/jobs/${job.id}`, { method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes) });
  if (changes.deleted && state.editingResult?.jobId === job.id) referenceEditor.dismiss();
  updateJob(next);
  if (next.conversationId) updateConversation(await api(`/api/conversations/${next.conversationId}`));
  if (changes.deleted && state.parent?.jobId === job.id) { state.parent = null; state.references = []; clearEdit(); renderReferences(); }
  return next;
}
function openManage(job) {
  state.managing = job.id; $('#work-title').value = title(job); $('#work-tags').value = (job.tags || []).join('，'); $('#work-favorite').checked = !!job.favorite;
  $('#trash-work').textContent = job.deletedAt ? '恢复作品' : '移入回收站'; $('#manage-dialog').showModal();
}
function renderGallery() {
  const wrap = el('div','gallery-content');
  const heading = el('div','gallery-heading'); heading.append(el('span','eyebrow','YOUR COLLECTION'),el('h1','','灵感留下的样子。'));
  const tools = el('div','gallery-tools');
  const search = el('input','gallery-search'); search.type = 'search'; search.placeholder = '搜索作品、提示词或标签'; search.value = state.search; search.setAttribute('aria-label','搜索作品');
  const filters = el('div','gallery-filters');
  for (const [value,name] of [['all','全部作品'],['favorites','已收藏'],['trash','回收站']]) {
    const filter = button(name, () => { state.galleryFilter = value; for (const sibling of filters.children) sibling.classList.toggle('selected',sibling === filter); draw(); },`tool-button${state.galleryFilter === value ? ' selected' : ''}`); filters.append(filter);
  }
  const grid = el('div','gallery-grid');
  function draw() {
    grid.replaceChildren();
    const query = state.search.trim().toLowerCase();
    const filtered = state.jobs.filter(job => outputs(job).length && (state.galleryFilter === 'trash' ? !!job.deletedAt : !job.deletedAt) && (state.galleryFilter !== 'favorites' || job.favorite) && (!query || [title(job),job.prompt,...job.tags || []].join(' ').toLowerCase().includes(query)));
    if (!filtered.length) { grid.append(el('p','gallery-empty',query ? '没有找到匹配的作品。' : state.galleryFilter === 'trash' ? '回收站为空。删除的作品可以在这里恢复。' : state.galleryFilter === 'favorites' ? '点击作品旁的星标，收藏喜欢的作品。' : '还没有作品，开始你的第一张创作吧。')); return; }
    filtered.forEach(job => outputs(job).forEach((asset,index) => {
      const card = el('article','gallery-item');
      const picture = button('',() => job.deletedAt ? preview(asset) : selectJob(job,index),'gallery-card');
      picture.append(imageElement(asset,title(job)),el('strong','',`${title(job)}${outputs(job).length > 1 ? ` · ${index + 1}` : ''}`),el('small','',`${asset.width} × ${asset.height} · ${asset.format.toUpperCase()}`));
      const meta = el('div','gallery-item-actions');
      const star = button(job.favorite ? '★' : '☆',async () => { try { await manageJob(job,{favorite:!job.favorite}); } catch(error) { toast(error.message); } }); star.setAttribute('aria-label',job.favorite ? '取消收藏' : '收藏作品');
      meta.append(star,button(job.deletedAt ? '恢复 / 管理' : '管理',()=>openManage(job)),downloadLink(asset));
      if (job.tags?.length) { const tags = el('div','work-tags'); job.tags.forEach(tag => tags.append(el('span','',tag))); card.append(tags); }
      card.prepend(picture,meta); grid.append(card);
    }));
  }
  search.oninput = () => { state.search = search.value; draw(); };
  tools.append(search,filters); heading.append(tools); wrap.append(heading,grid); draw(); return wrap;
}
function renderStage() {
  const stage = $('#stage'), scrollTop = stage.scrollTop, follow = stage.scrollHeight - stage.clientHeight - scrollTop < 80;
  stage.replaceChildren(); stage.classList.toggle('gallery-stage',state.view === 'gallery'); $('#composer-area').hidden = state.view === 'gallery';
  if (state.view === 'gallery') { stage.append(renderGallery()); return; }
  if (state.conversationId) {
    if (state.conversation) stage.append(renderConversation(state.conversation));
    else stage.append(el('p', 'chat-status', '正在读取对话…'));
    stage.scrollTop = follow ? stage.scrollHeight : scrollTop; updateElapsed(); return;
  }
  const job = current(); if (!job) { stage.append(welcome()); return; }
  const conversation = el('div','conversation');
  if (job.references?.length) {
    const inputs = el('div','input-references message-references'); job.references.forEach((ref,i) => { const b = button('',()=>referenceEditor.open(ref,{readOnly:true}),'input-reference'); b.setAttribute('aria-label',`查看消息参考图${i + 1}`); b.append(imageElement(ref.asset)); inputs.append(b); }); conversation.append(inputs);
  }
  conversation.append(el('div','user-message',[job.prompt, commentMessage(job.references)].filter(Boolean).join('\n\n')));
  conversation.append(renderJobOutput(job)); stage.append(conversation); updateElapsed();
}
function renderJobOutput(job) {
  const outputIndex = state.selected === job.id ? state.outputIndex : 0;
  const output = el('div',`assistant-output${outputs(job).length > 1 ? ' multiple-output' : ''}`), status = el('div','output-status'); status.setAttribute('role','status');
  status.append(el('span',`spark${active(job) ? ' spinning' : ''}`,'✦'),el('strong','',`${labels[job.status]}${job.status === 'completed' ? ` · ${outputs(job).length} 个方案` : ''}`));
  if (active(job)) { const time = el('span','elapsed'); time.dataset.elapsed = job.createdAt; status.append(time); } output.append(status);
  if (active(job)) {
    const loading = el('div','generation-placeholder'), note = el('div','loading-note'); note.append(el('span','loading-orbit','✦'),el('strong','',job.status === 'refining' ? '理解图片与创作意图' : '让想象慢慢显影'),el('small','',job.status === 'refining' ? '正在整理参考图用途与画面细节' : `已完成 ${outputs(job).length}/${job.count || 1} 个方案，正在继续生成`)); loading.append(note); output.append(loading);
    if(outputs(job).length){const finished=el('div','input-references');outputs(job).forEach((asset,index)=>{const item=button('',()=>preview(asset),'input-reference');item.append(imageElement(asset),el('span','',`方案${index+1} 已保存`));finished.append(item);});output.append(finished);}
  } else if (outputs(job).length) {
    const grid = el('div',outputs(job).length > 1 ? 'result-grid' : 'single-result');
    outputs(job).forEach((asset,index) => {
      const item = el('div',`result-option${index === outputIndex ? ' selected' : ''}`);
      const picture = button('',()=>preview(asset),'result-image'); picture.setAttribute('aria-label',`放大查看方案${index + 1}`); picture.append(imageElement(asset,job.prompt));
      const pictureFrame = el('div', 'result-picture');
      pictureFrame.style.maxWidth = `${Math.min(outputs(job).length > 1 ? 400 : 640, asset.width / asset.height * (outputs(job).length > 1 ? 290 : 640))}px`;
      const editImage = button('编辑', () => { void openResultEditor(job, index); }, 'result-edit-button');
      editImage.setAttribute('aria-label', `编辑方案${index + 1}`); editImage.disabled = busy() || !!job.deletedAt;
      pictureFrame.append(picture, editImage);
      const tools = el('div','result-tools'); tools.append(el('span','result-meta',`${outputs(job).length > 1 ? `方案 ${index + 1} · ` : ''}${asset.width} × ${asset.height} · ${asset.format.toUpperCase()}`),downloadLink(asset));
      item.append(pictureFrame,tools);
      if (outputs(job).length > 1) { const use = button(state.parent?.assetId === asset.id ? '✓ 当前编辑方案' : '使用这个方案',()=>{void openResultEditor(job,index);}); use.disabled = busy() || !!job.deletedAt; item.append(use); }
      grid.append(item);
    }); output.append(grid);
    if (job.warning) output.append(el('p','job-warning',job.warning));
    if (job.error) output.append(el('p','job-warning',job.error));
    const actions = el('div','result-action-row');
    actions.append(button('对比版本',()=>openCompare(job,outputIndex)),button('管理作品',()=>openManage(job))); output.append(actions);
    const versions = state.selected === job.id ? renderVersions(job) : null; if (versions) output.append(versions);
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    const notice = el('div',`job-notice ${job.status}`); notice.append(el('p','',job.error || '已停止本地等待。上游可能仍会完成生成并计费。'),button('恢复这次创作的输入 →',()=>{selectJob(job); $('#prompt').value = job.prompt; $('#prompt').focus(); updateControls();},'text-button')); output.append(notice);
  } else if (job.status === 'prepared') output.append(el('p','prepared-note','提示词已就绪。可以修改后生成，参考图和选区会一起保留。'));
  if (job.refinedPrompt && !active(job)) output.append(promptDetails(job)); return output;
}
function renderConversation(conversation) {
  const root = el('div', 'conversation chat-conversation'); root.setAttribute('aria-label', '创作对话');
  for (const turn of conversation.turns) {
    const section = el('section', 'chat-turn'); section.dataset.turnId = turn.id;
    if (turn.references.length) {
      const images = el('div', 'input-references message-references');
      turn.references.forEach((ref, index) => { const thumb = button('', () => referenceEditor.open(ref, { readOnly: true }), 'input-reference'); thumb.setAttribute('aria-label', `查看消息参考图${index + 1}`); thumb.append(imageElement(ref.asset)); images.append(thumb); });
      section.append(images);
    }
    if (turn.prompt || commentMessage(turn.references)) section.append(el('div', 'user-message', [turn.prompt, commentMessage(turn.references)].filter(Boolean).join('\n\n')));
    if (turn.assistant) section.append(el('div', 'chat-reply', turn.assistant));
    if (turn.status === 'thinking') { const status = el('div', 'chat-status', turn.assistant ? '正在回复…' : '正在思考…'); status.setAttribute('role', 'status'); section.append(status); }
    if (turn.job) section.append(renderJobOutput(turn.job));
    else if (turn.imageUnavailable) section.append(el('p', 'chat-status', '这张作品已移入回收站。'));
    else if (turn.status === 'failed' || turn.status === 'cancelled') {
      const notice = el('div', 'job-notice');
      notice.append(el('p', '', turn.error || '已停止本轮回复。'), button('恢复这条消息', () => {
        $('#prompt').value = turn.prompt; state.references = turn.references.map(ref => ({ ...ref })); state.parent = turn.parent; state.edit = turn.edit;
        restoreSettings(turn.settings); renderReferences(); updateControls(); $('#prompt').focus();
      }, 'text-button')); section.append(notice);
    }
    root.append(section);
  }
  return root;
}
function updateElapsed() { document.querySelectorAll('[data-elapsed]').forEach(node=>{const seconds=Math.max(0,Math.floor((Date.now()-new Date(node.dataset.elapsed))/1000));node.textContent=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;}); }
function commentMessage(references = []) {
  return references.flatMap((ref, index) => ref.comments?.length ? [`图像 ${index + 1}：\n${ref.comments.map((comment, i) => `${i + 1}. (x: ${Number((comment.x * 100).toFixed(1))}%, y: ${Number((comment.y * 100).toFixed(1))}%) ${comment.text}`).join('\n')}`] : []).join('\n\n');
}
function resizeComposer() {
  if ($('#composer-area').hidden) return;
  const composer = $('#composer'), prompt = $('#prompt');
  // Measure the compact row first so wrapping never oscillates between layouts.
  composer.classList.remove('expanded'); prompt.style.height = '28px';
  composer.classList.toggle('expanded', !$('#reference-list').hidden || prompt.scrollHeight > 28);
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.max(28, Math.min(prompt.scrollHeight, 168, innerHeight * .22))}px`;
}
function toggleSettings(open = $('#generation-settings').hidden) {
  $('#generation-settings').hidden = !open;
  $('#settings-button').setAttribute('aria-expanded', String(open));
  if (open) $('#size').focus();
  resizeComposer();
}
function updateControls() {
  const pending = state.advancedOpen || referenceEditor?.hasPendingChanges();
  const hasInput=$('#prompt').value.trim()||state.references.some(ref=>ref.comments?.length||ref.assetId!==state.parent?.assetId);
  const running=state.jobs.some(active)||state.conversations.some(chatActive), disabled=busy()||pending||!hasInput;
  $('#generate').disabled=disabled||!state.config?.promptReady; $('#refine').disabled=disabled||!state.config?.promptReady; $('#generate').hidden=running; $('#stop').hidden=!running; $('#stop').disabled=false;
  $('#upload-reference').disabled=busy()||state.advancedOpen||state.references.length>=16;
  $('#reference-list').setAttribute('aria-busy',String(state.uploading));
  $('#composer-status').textContent=state.uploading?'正在添加参考图片…':state.config?`${state.config.channelName} · ${state.config.imageModel}`:'正在读取配置…';
  document.querySelectorAll('.reference-remove').forEach(control=>{control.disabled=busy();});
  for(const id of ['size','quality','count','format','background','compression','use-vision']) $(`#${id}`).disabled=busy();
  referenceEditor?.setBusy(busy());
  resizeComposer();
}
function render() {
  renderHistory(); renderStage(); renderReferences(); updateControls();
  for(const view of ['studio','gallery']) { const selected=state.view===view, tab=$(`#${view}-nav`);tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1; }
  $('#stage').setAttribute('aria-labelledby',`${state.view}-nav`);
}
function submission(job) {
  if(job) return { ...Object.fromEntries(['size','quality','count','format','compression','background','optimize','useVision','action'].map(key=>[key,job[key]])),references:(job.references||[]).map(({assetId,role,note,comments})=>({assetId,role,note,comments})),parent:job.parent,edit:draftEdit(job) };
  return { ...settings(),references:state.references.map(({assetId,role,note,comments})=>({assetId,role,note,comments})),parent:state.parent,edit:state.edit };
}
async function startCreation(input) {
  if (input.mode === 'refine' && !state.config?.promptReady) throw new Error('提示词优化不可用，请检查 Codex 配置。');
  if (state.config && !state.config.promptReady) input = { ...input, optimize: false };
  return startTurn(input);
}
async function submit(mode='auto',prompt=$('#prompt').value.trim(),refinedPrompt='',snapshot=null) {
  if(busy() || state.advancedOpen || referenceEditor?.hasPendingChanges()) return;
  const input=submission(snapshot);
  if(input.action!=='none'&&!input.references.length){toast('请先上传或选择要编辑的图片');return;}
  state.sending=true; updateControls();
  try { return await (mode === 'auto' ? startTurn({...input,prompt,mode}) : startCreation({...input,prompt,refinedPrompt,mode})); }
  catch(error){toast(error.message);} finally{state.sending=false;renderReferences();updateControls();}
}
async function refreshConfig() {
  try {
    await configPanel.refresh();
  }catch(error){$('#connection-label').textContent='服务未连接';toast(error.message);}
}
function newImage(){if(!closeResultEditor())return;closeHistory();state.conversationId=null;state.conversation=null;rememberConversation(null);state.selected=null;state.outputIndex=0;state.view='studio';state.references=[];state.parent=null;clearEdit();$('#prompt').value='';toggleSettings(false);render();$('#prompt').focus();}
const editor=createEditor({imageSource,upload,notify:toast,onApply:edit=>{
  state.edit=edit;renderReferences();if(!$('#prompt').value.trim())$('#prompt').value=edit.type==='outpaint'?'自然补全画布的透明区域，与原图场景、光线和透视保持一致。':'';
  queueMicrotask(()=>{if(matchMedia('(max-width:680px)').matches)referenceEditor.close();$('#prompt').focus();updateControls();});
},onClose:()=>{state.advancedOpen=false;referenceEditor?.finishAdvanced();updateControls();}});
async function transformReference(ref, { prompt, action = 'none', edit = null, signal }) {
  if (busy()) throw new Error('请等待当前操作结束。');
  signal.throwIfAborted(); state.sending = true; updateControls();
  let job;
  const cancel = () => { if (job) void post(`/api/jobs/${job.id}/cancel`, {}).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    job = await post('/api/jobs', { prompt, action, edit, references: [{ assetId: ref.assetId, role: 'base' }], optimize: false, count: 1, format: 'png', quality: $('#quality').value, background: action === 'remove-background' ? 'transparent' : 'auto' });
    updateJob(job); if (signal.aborted) cancel();
    while (active(job)) {
      await new Promise(resolve => setTimeout(resolve, 700));
      job = await api(`/api/jobs/${job.id}`); updateJob(job);
    }
    signal.throwIfAborted();
    if (job.status !== 'completed' || !job.outputs?.length) throw new Error(job.error || '图片处理已取消。');
    if (job.warning) toast(job.warning);
    return job.outputs[0];
  } catch (error) {
    if (job && active(job)) watch(job);
    throw error;
  } finally { signal.removeEventListener('abort', cancel); state.sending = false; updateControls(); }
}
referenceEditor = createReferenceEditor({
  imageSource, upload, downloadLink, notify: toast, transform: transformReference,
  onStateChange: updateControls,
  onClose() { editor.close(); state.editingResult = null; state.advancedOpen = false; renderReferences(); updateControls(); },
  onAdvanced(ref, type, container) {
    if (busy() || !state.references.includes(ref)) { referenceEditor.finishAdvanced(); return; }
    state.advancedOpen = true; updateControls(); void editor.open(ref.asset, type, { container });
  },
  async onGenerate(ref, { prompt, action }) {
    if (busy()) throw new Error('请等待当前操作结束。');
    if (!state.config?.ready) throw new Error('请先检查模型连接配置。');
    if (!state.references.includes(ref)) throw new Error('附件已移除，请重新添加图片。');
    state.sending = true; updateControls();
    try {
      return await startCreation({
        mode: 'generate', prompt, action,
        references: [{ assetId: ref.assetId, role: 'general' }],
        parent: state.parent?.assetId === ref.assetId ? state.parent : null,
        optimize: false, size: 'auto', quality: $('#quality').value, count: 1,
        format: 'png', background: 'transparent',
      });
    } finally { state.sending = false; renderReferences(); updateControls(); }
  },
  onComments(ref, comments) {
    if (!state.references.includes(ref) || busy()) throw new Error('当前图片不可修改，请重新打开附件。');
    const length = state.references.reduce((total, item) => total + (item === ref ? comments : item.comments || []).reduce((n, comment) => n + comment.text.length, 0), 0);
    if (length > 8000) throw new Error('图片评论总计不得超过 8000 字。');
    ref.comments = comments.map(comment => ({ ...comment })); renderReferences(); updateControls();
  },
  onReplace(ref, asset, comments) {
    if (!state.references.includes(ref)) throw new Error('附件已移除，请重新添加图片。');
    if (state.parent?.assetId === ref.assetId) state.parent = null;
    if (state.edit?.sourceId === ref.assetId) clearEdit();
    ref.assetId = asset.id; ref.asset = asset; ref.role = 'general'; ref.note = '';
    if (comments) ref.comments = comments;
    renderReferences(); updateControls();
  },
  onSend() { if (!state.config?.promptReady) { toast('请先检查聊天模型连接配置。'); return; } void submit(); },
});
$('#new-image').onclick=newImage;
$('#studio-nav').onclick=()=>{closeHistory();state.view='studio';render();};$('#gallery-nav').onclick=()=>{if(!closeResultEditor())return;closeHistory();state.view='gallery';render();};
$('.view-tabs').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const view=event.key==='Home'?'studio':event.key==='End'?'gallery':state.view==='studio'?'gallery':'studio';$(`#${view}-nav`).click();$(`#${view}-nav`).focus();};
$('#history-popover').addEventListener('beforetoggle',event=>{$('#history-button').setAttribute('aria-expanded',String(event.newState==='open'));if(event.newState==='open')positionHistory();});
$('#history-popover').addEventListener('toggle',event=>{if(event.newState==='open'){positionHistory();($('#history .selected')||$('#history button'))?.focus({preventScroll:true});}});
window.addEventListener('resize',()=>{if($('#history-popover').matches(':popover-open'))positionHistory();resizeComposer();});
$('#return-codex').hidden=!embed||!!mcp;$('#return-codex').onclick=()=>{if(embed&&!mcp&&window.parent!==window)window.parent.postMessage({type:'codex-imageboard-close'},'*');};
$('#composer').onsubmit=event=>{event.preventDefault();if(!$('#generate').disabled)void submit();};$('#refine').onclick=()=>submit('refine');
// MCP frames can disallow native form submission; use the same explicit action as Enter.
$('#generate').onclick=event=>{event.preventDefault();if(!$('#generate').disabled)void submit();};
$('#prompt').oninput=updateControls;$('#prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('#generate').disabled)void submit();}};
$('#stop').onclick=async()=>{
  const conversation=state.conversations.find(c=>c.id===state.conversationId&&chatActive(c))||state.conversations.find(chatActive), job=state.jobs.find(active);
  if(!conversation&&!job)return;$('#stop').disabled=true;
  try{if(conversation){updateConversation(await post(`/api/conversations/${conversation.id}/cancel`,{}));watchConversation(conversation.id);}else await post(`/api/jobs/${job.id}/cancel`,{});}catch(error){toast(error.message);$('#stop').disabled=false;}
};
$('#upload-reference').onclick=()=>$('#reference-input').click();$('#reference-input').onchange=event=>{const files=[...event.target.files];event.target.value='';void uploadFiles(files);};
$('#settings-button').onclick=()=>toggleSettings();
$('#composer').addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#generation-settings').hidden){event.preventDefault();toggleSettings(false);$('#settings-button').focus();}});
for(const id of ['format','background','compression'])$(`#${id}`).oninput=syncOutputOptions;
$('#connection').onclick=()=>{closeHistory();void configPanel.open();};
$('#close-preview').onclick=()=>$('#preview-dialog').close();$('#close-compare').onclick=()=>$('#compare-dialog').close();$('#compare-slider').oninput=event=>$('.compare-canvas').style.setProperty('--split',`${event.target.value}%`);
$('#close-manage').onclick=()=>$('#manage-dialog').close();
$('#manage-form').onsubmit=async event=>{event.preventDefault();const job=state.jobs.find(j=>j.id===state.managing);if(!job)return;try{await manageJob(job,{title:$('#work-title').value,tags:$('#work-tags').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),favorite:$('#work-favorite').checked});$('#manage-dialog').close();toast('作品信息已保存');}catch(error){toast(error.message);}};
$('#trash-work').onclick=async()=>{const job=state.jobs.find(j=>j.id===state.managing);if(!job)return;try{const deleted=!job.deletedAt;await manageJob(job,{deleted});$('#manage-dialog').close();if(deleted&&state.selected===job.id)newImage();toast(deleted?'已移入回收站，可在「我的作品」恢复':'作品已恢复');}catch(error){toast(error.message);}};
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog:modal')){event.preventDefault();newImage();}});
document.addEventListener('paste',event=>{if(document.querySelector('dialog:modal'))return;const files=[...event.clipboardData?.items||[]].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();void uploadFiles(files);}});
let dragDepth=0;
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')&&!document.querySelector('dialog:modal')){event.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drop-overlay').hidden=true;});
document.addEventListener('drop',event=>{dragDepth=0;$('#drop-overlay').hidden=true;if(event.dataTransfer?.files.length){event.preventDefault();if(!document.querySelector('dialog:modal'))void uploadFiles(event.dataTransfer.files);}});
window.addEventListener('beforeunload',()=>{state.source?.close();state.chatSource?.close();for(const cached of imageCache.values())void cached.then(image=>URL.revokeObjectURL(image.url)).catch(()=>{});});
setInterval(updateElapsed,1000);render();await refreshConfig();
try {
  [state.jobs,state.conversations]=await Promise.all([api('/api/jobs'),api('/api/conversations')]);
  let remembered;
  try { remembered=localStorage.getItem('imageboard-conversation');const pending=JSON.parse(localStorage.getItem('imageboard-pending-message')||'null');if(pending?.conversationId&&pending?.requestId&&pending?.input)state.pendingSubmission=pending; } catch {}
  const runningConversation=state.conversations.find(chatActive);
  const selected=runningConversation?.id||(state.conversations.some(c=>c.id===remembered)?remembered:state.conversations[0]?.id);
  if(selected) await selectConversation(selected);
  if(state.pendingSubmission){
    const pending=state.pendingSubmission;
    let recovered=state.conversation?.id===pending.conversationId?state.conversation:null;
    if(!recovered){try{recovered=await api(`/api/conversations/${pending.conversationId}`);}catch{}}
    if(recovered?.turns.some(t=>t.requestId===pending.requestId)){rememberPending(null);updateConversation(recovered);if(chatActive(recovered))watchConversation(recovered.id);}
    else {$('#prompt').value=pending.input.prompt||'';restoreSettings(pending.input);state.references=await Promise.all((pending.input.references||[]).map(async ref=>({...ref,asset:await api(`/api/assets/${ref.assetId}?meta=1`)})));state.parent=pending.input.parent;state.edit=pending.input.edit;}
  }
  const running=state.jobs.find(job=>active(job)&&!job.conversationId);
  if(running){state.selected=running.id;restoreSettings(running);state.references=(running.references||[]).map(ref=>({...ref}));state.parent=running.parent;state.edit=draftEdit(running);watch(running);}
  render();
}catch(error){toast(error.message);}
if(!mcp&&window.parent!==window)window.parent.postMessage({type:'codex-imageboard-ready'},'*');
