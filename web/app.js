import { createEditor } from './editor.js';
import { initTheme } from './theme.js';

initTheme();

const $ = selector => document.querySelector(selector);
const mcp = window.__IMAGEBOARD_MCP__, embed = window.__IMAGEBOARD_EMBED__ || (mcp ? { mcp: true } : null), imageCache = new Map();
const state = { config: null, jobs: [], selected: null, outputIndex: 0, view: 'studio', references: [], parent: null, edit: null, source: null, sending: false, uploading: false, galleryFilter: 'all', search: '', managing: null };
const ROLES = { base: '编辑原图', subject: '主体外观', style: '视觉风格', composition: '画面构图', color: '色彩搭配', background: '背景场景', general: '综合参考' };
const labels = { refining: '理解你的想法', generating: '正在创建图像', completed: '已完成', prepared: '提示词已就绪', failed: '生成失败', cancelled: '已停止' };
const active = job => job && ['refining', 'generating'].includes(job.status);
const busy = () => state.sending || state.uploading || state.jobs.some(active);
const current = () => state.jobs.find(job => job.id === state.selected);
const outputs = job => job.outputs || [];
const title = job => job.title || job.prompt;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, callback, className = 'tool-button') => { const b = el('button', className, text); b.type = 'button'; b.onclick = callback; return b; };
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function localFetch(url, options = {}) { if (mcp) return mcp.fetch(url, options); return fetch(embed ? new URL(url, embed.origin) : url, { ...options, ...(embed ? { credentials: 'omit', headers: { ...options.headers, 'X-Imageboard-Embed': embed.capability } } : {}) }); }
async function api(url, options) {
  let response; try { response = await localFetch(url, options); } catch (error) { throw new Error(mcp ? error.message || '连接中断，请在 Codex 中重新加载 Imageboard。' : '本地服务连接中断，请确认 Imageboard 仍在运行。'); }
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败，请重试。'); return data;
}
const post = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
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
function imageElement(asset, alt = '') { const img = el('img'); img.alt = alt; img.loading = 'lazy'; setImage(img, asset); return img; }
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
  if (busy()) { toast('请等待当前操作结束后再添加图片。'); return; }
  const list = [...files]; if (!list.length) return;
  if (state.references.length + list.length > 16) { toast('包括编辑原图在内，最多添加 16 张参考图。'); return; }
  if (state.view === 'gallery') newImage();
  state.uploading = true; updateControls();
  try {
    for (const file of list) { const asset = await upload(file, file.name); state.references.push({ assetId: asset.id, asset, role: state.references.length ? 'general' : 'base', note: '' }); renderReferences(); }
    toast(`已添加 ${list.length} 张参考图`);
  } catch (error) { toast(error.message); }
  finally { state.uploading = false; renderReferences(); updateControls(); }
}
function clearEdit() { state.edit = null; }
function removeReference(index) {
  const ref = state.references[index];
  if (state.parent?.assetId === ref.assetId) state.parent = null;
  if (index === 0) clearEdit(); state.references.splice(index, 1); renderReferences(); updateControls();
}
function moveReference(from, to) {
  if (to < 0 || to >= state.references.length || from === to) return;
  if (state.parent && (from === 0 || to === 0)) { toast('连续编辑的原图固定在图1；移除它后可自由排序。'); return; }
  const [ref] = state.references.splice(from, 1); state.references.splice(to, 0, ref); clearEdit(); renderReferences();
}
function renderReferences() {
  const root = $('#reference-list'); root.replaceChildren(); root.hidden = !state.references.length;
  state.references.forEach((ref, index) => {
    const card = el('div', 'reference-card'); card.draggable = !busy();
    card.ondragstart = event => { event.dataTransfer.setData('application/x-imageboard-reference', String(index)); event.dataTransfer.effectAllowed = 'move'; };
    card.ondragover = event => { if (event.dataTransfer.types.includes('application/x-imageboard-reference')) event.preventDefault(); };
    card.ondrop = event => { const from = event.dataTransfer.getData('application/x-imageboard-reference'); if (from !== '') { event.preventDefault(); event.stopPropagation(); moveReference(Number(from), index); } };
    const thumb = button('', () => preview(ref.asset), 'reference-thumb'); thumb.setAttribute('aria-label', `查看参考图${index + 1}`); thumb.append(imageElement(ref.asset));
    const info = el('div', 'reference-info'); info.append(el('strong', '', `图${index + 1} · ${ref.asset.name}`));
    const role = el('select'); role.setAttribute('aria-label', `图${index + 1}用途`);
    Object.entries(ROLES).forEach(([value, text]) => { const option = el('option', '', text); option.value = value; role.append(option); }); role.value = ref.role;
    role.disabled = busy() || (index === 0 && !!state.parent); role.onchange = () => { ref.role = role.value; };
    const note = el('input'); note.placeholder = '补充说明，例如保留人物衣服'; note.maxLength = 300; note.value = ref.note; note.setAttribute('aria-label', `图${index + 1}说明`); note.disabled = busy(); note.oninput = () => { ref.note = note.value; };
    const controls = el('div', 'reference-actions');
    for (const [label, action, disabled] of [['←', () => moveReference(index, index - 1), index === 0], ['→', () => moveReference(index, index + 1), index === state.references.length - 1], ['×', () => removeReference(index), false]]) {
      const control = button(label, action); control.disabled = disabled || busy(); control.setAttribute('aria-label', `${label === '×' ? '移除' : label === '←' ? '前移' : '后移'}参考图${index + 1}`); controls.append(control);
    }
    info.append(role, note); card.append(thumb, info, controls); root.append(card);
  });
  const context = $('#edit-context'); context.replaceChildren(); context.hidden = !state.parent && !state.edit;
  if (state.parent) context.append(el('span', '', `正在编辑「${title(state.jobs.find(j => j.id === state.parent.jobId) || { prompt: '历史版本' })}」的方案 ${state.parent.outputIndex + 1}`));
  if (state.edit) {
    context.append(el('span', 'edit-badge', state.edit.type === 'inpaint' ? '已设置局部选区' : '已设置扩图画布'));
    const reset = button('取消选区', () => { clearEdit(); renderReferences(); }, 'text-button'); reset.disabled = busy(); context.append(reset);
  }
  $('#reference-hint').textContent = state.uploading ? '正在上传…' : state.references.length ? `${state.references.length}/16 张 · 可拖动排序` : '支持拖入或粘贴图片';
}
function settings() { return { size: $('#size').value, quality: $('#quality').value, count: Number($('#count').value), format: $('#format').value, compression: Number($('#compression').value), background: $('#background').value, action: $('#action').value, optimize: $('#optimize').checked, useVision: $('#use-vision').checked }; }
function restoreSettings(job) {
  for (const [name, fallback] of [['size','auto'],['quality','auto'],['count',1],['format','png'],['compression',90],['background','auto'],['action','none']]) $(`#${name}`).value = job[name] ?? fallback;
  $('#optimize').checked = job.optimize !== false; $('#use-vision').checked = job.useVision !== false; syncOutputOptions();
}
function syncOutputOptions() {
  if ($('#action').value === 'remove-background') $('#background').value = 'transparent';
  if ($('#background').value === 'transparent' && $('#format').value === 'jpeg') { $('#format').value = 'png'; toast('透明背景已使用 PNG 格式'); }
  $('#compression-control').hidden = $('#format').value === 'png'; $('#compression-value').textContent = $('#compression').value;
}
function draftEdit(job) { return job.edit ? job.edit.type === 'inpaint' ? { type: 'inpaint', maskId: job.edit.mask.id, sourceId: job.references[0].assetId } : { type: 'outpaint', margins: job.edit.margins, sourceId: job.references[0].assetId } : null; }
function baseOn(job, index = 0) {
  const asset = outputs(job)[index]; if (!asset) return;
  state.outputIndex = index; state.parent = { jobId: job.id, outputIndex: index, assetId: asset.id }; state.edit = null;
  state.references = [{ assetId: asset.id, asset, role: 'base', note: '保留未要求修改的内容' }, ...(job.references || []).filter(ref => ref.role !== 'base' && ref.role !== 'general' && ref.assetId !== asset.id).slice(0,15).map(ref => ({ ...ref }))];
  $('#action').value = 'none'; renderReferences(); updateControls();
}
function selectJob(job, index = 0) {
  closeHistory(); state.selected = job.id; state.outputIndex = index; state.view = 'studio'; restoreSettings(job);
  if (job.status === 'completed' && !job.deletedAt) baseOn(job, index);
  else { state.references = (job.references || []).map(ref => ({ ...ref })); state.parent = job.parent || null; state.edit = draftEdit(job); }
  render();
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
function closeHistory() { if ($('#history-popover').matches(':popover-open')) $('#history-popover').hidePopover(); }
function positionHistory() {
  const popover = $('#history-popover'), anchor = $('#history-button').getBoundingClientRect(), width = Math.min(360, innerWidth - 24), top = anchor.bottom + 8;
  popover.style.width = `${width}px`; popover.style.left = `${Math.max(12, Math.min(anchor.right - width, innerWidth - width - 12))}px`; popover.style.top = `${top}px`; popover.style.maxHeight = `${Math.max(0, Math.min(440, innerHeight - top - 12))}px`;
}
function renderHistory() {
  const root = $('#history'), focus = root.contains(document.activeElement) ? document.activeElement.dataset.jobId : null, scrollTop = root.scrollTop; root.replaceChildren();
  $('#gallery-count').textContent = state.jobs.filter(j => !j.deletedAt).reduce((n,j) => n + outputs(j).length, 0);
  const jobs = state.jobs.filter(j => !j.deletedAt).slice(0,60);
  if (!jobs.length) root.append(el('p', 'history-empty', '第一张作品，从一个想法开始。'));
  jobs.forEach(job => {
    const row = button('', () => selectJob(job), `history-item${state.selected === job.id && state.view === 'studio' ? ' selected' : ''}`); row.dataset.jobId = job.id; row.title = title(job);
    row.append(outputs(job)[0] ? imageElement(outputs(job)[0]) : el('span', `history-symbol${active(job) ? ' spinning' : ''}`, active(job) ? '◌' : '✧'));
    const text = el('span', 'history-text'); text.append(el('strong', '', title(job)), el('small', '', `${labels[job.status]}${outputs(job).length > 1 ? ` · ${outputs(job).length} 个方案` : ''}`)); row.append(text); root.append(row);
  });
  root.scrollTop = scrollTop; if (focus) [...root.children].find(node => node.dataset.jobId === focus)?.focus({ preventScroll: true });
}
function welcome() {
  const root = el('div', 'welcome');
  root.append(el('div', 'welcome-badge', '✦  A LITTLE IDEA. A NEW WORLD.'), el('h1', '', '把脑海里的画面，\n变成眼前的作品。'), el('p', 'welcome-copy', '用自然语言描述，AI 为你梳理灵感、打磨细节，再让画面发生。'));
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
  const summary = el('summary'); summary.append(el('span', '', '✧ 生图提示词'), el('small', '', job.optimize === false ? '直接使用你的提示词' : `${job.model} 整理`));
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
  updateJob(next);
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
  const stage = $('#stage'); stage.replaceChildren(); stage.classList.toggle('gallery-stage',state.view === 'gallery'); $('#composer-area').hidden = state.view === 'gallery';
  if (state.view === 'gallery') { stage.append(renderGallery()); return; }
  const job = current(); if (!job) { stage.append(welcome()); return; }
  const conversation = el('div','conversation'); conversation.append(el('div','user-message',job.prompt));
  if (job.references?.length) {
    const inputs = el('div','input-references'); job.references.forEach((ref,i) => { const b = button('',()=>preview(ref.asset),'input-reference'); b.append(imageElement(ref.asset),el('span','',`图${i + 1} · ${ROLES[ref.role]}`)); inputs.append(b); }); conversation.append(inputs);
  }
  const output = el('div',`assistant-output${outputs(job).length > 1 ? ' multiple-output' : ''}`), status = el('div','output-status'); status.setAttribute('role','status');
  status.append(el('span',`spark${active(job) ? ' spinning' : ''}`,'✦'),el('strong','',`${labels[job.status]}${job.status === 'completed' ? ` · ${outputs(job).length} 个方案` : ''}`));
  if (active(job)) { const time = el('span','elapsed'); time.dataset.elapsed = job.createdAt; status.append(time); } output.append(status);
  if (active(job)) {
    const loading = el('div','generation-placeholder'), note = el('div','loading-note'); note.append(el('span','loading-orbit','✦'),el('strong','',job.status === 'refining' ? '理解图片与创作意图' : '让想象慢慢显影'),el('small','',job.status === 'refining' ? '正在整理参考图用途与画面细节' : `已完成 ${outputs(job).length}/${job.count || 1} 个方案，正在继续生成`)); loading.append(note); output.append(loading);
    if(outputs(job).length){const finished=el('div','input-references');outputs(job).forEach((asset,index)=>{const item=button('',()=>preview(asset),'input-reference');item.append(imageElement(asset),el('span','',`方案${index+1} 已保存`));finished.append(item);});output.append(finished);}
  } else if (outputs(job).length) {
    const grid = el('div',outputs(job).length > 1 ? 'result-grid' : 'single-result');
    outputs(job).forEach((asset,index) => {
      const item = el('div',`result-option${index === state.outputIndex ? ' selected' : ''}`);
      const picture = button('',()=>preview(asset),'result-image'); picture.setAttribute('aria-label',`放大查看方案${index + 1}`); picture.append(imageElement(asset,job.prompt));
      const tools = el('div','result-tools'); tools.append(el('span','result-meta',`${outputs(job).length > 1 ? `方案 ${index + 1} · ` : ''}${asset.width} × ${asset.height} · ${asset.format.toUpperCase()}`),downloadLink(asset));
      const use = button(index === state.outputIndex ? '✓ 当前编辑方案' : '使用这个方案',()=>{baseOn(job,index); renderStage(); $('#prompt').focus();}); use.disabled = busy() || !!job.deletedAt;
      item.append(picture,tools,use); grid.append(item);
    }); output.append(grid);
    if (job.warning) output.append(el('p','job-warning',job.warning));
    if (job.error) output.append(el('p','job-warning',job.error));
    const actions = el('div','result-action-row');
    const edit = button('继续修改',()=>{baseOn(job,state.outputIndex); $('#prompt').focus();}); edit.disabled = busy() || !!job.deletedAt;
    const mask = button('局部重绘',()=>{baseOn(job,state.outputIndex); void editor.open(state.references[0].asset,'inpaint');}); mask.disabled = busy() || !!job.deletedAt;
    const expand = button('扩图',()=>{baseOn(job,state.outputIndex); void editor.open(state.references[0].asset,'outpaint');}); expand.disabled = busy() || !!job.deletedAt;
    actions.append(edit,mask,expand,button('对比版本',()=>openCompare(job,state.outputIndex)),button('管理作品',()=>openManage(job))); output.append(actions);
    const versions = renderVersions(job); if (versions) output.append(versions);
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    const notice = el('div',`job-notice ${job.status}`); notice.append(el('p','',job.error || '已停止本地等待。上游可能仍会完成生成并计费。'),button('恢复这次创作的输入 →',()=>{selectJob(job); $('#prompt').value = job.prompt; $('#prompt').focus(); updateControls();},'text-button')); output.append(notice);
  } else if (job.status === 'prepared') output.append(el('p','prepared-note','提示词已就绪。可以修改后生成，参考图和选区会一起保留。'));
  if (job.refinedPrompt && !active(job)) output.append(promptDetails(job)); conversation.append(output); stage.append(conversation); updateElapsed();
}
function updateElapsed() { document.querySelectorAll('[data-elapsed]').forEach(node=>{const seconds=Math.max(0,Math.floor((Date.now()-new Date(node.dataset.elapsed))/1000));node.textContent=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;}); }
function updateControls() {
  const running=state.jobs.some(active), disabled=busy()||!state.config?.ready||!$('#prompt').value.trim();
  $('#generate').disabled=disabled; $('#refine').disabled=disabled; $('#generate').hidden=running; $('#stop').hidden=!running; $('#stop').disabled=false;
  $('#upload-reference').disabled=busy()||state.references.length>=16; $('#inpaint').disabled=$('#outpaint').disabled=busy()||!state.references.length;
  for(const id of ['size','quality','count','action','format','background','compression','optimize','use-vision']) $(`#${id}`).disabled=busy();
}
function render() {
  renderHistory(); renderStage(); renderReferences(); updateControls();
  for(const view of ['studio','gallery']) { const selected=state.view===view, tab=$(`#${view}-nav`);tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1; }
  $('#stage').setAttribute('aria-labelledby',`${state.view}-nav`);
}
function submission(job) {
  if(job) return { ...Object.fromEntries(['size','quality','count','format','compression','background','optimize','useVision','action'].map(key=>[key,job[key]])),references:(job.references||[]).map(({assetId,role,note})=>({assetId,role,note})),parent:job.parent,edit:draftEdit(job) };
  return { ...settings(),references:state.references.map(({assetId,role,note})=>({assetId,role,note})),parent:state.parent,edit:state.edit };
}
async function submit(mode='generate',prompt=$('#prompt').value.trim(),refinedPrompt='',snapshot=null) {
  if(busy()) return;
  const input=submission(snapshot);
  if(input.action!=='none'&&!input.references.length){toast('请先上传或选择要编辑的图片');return;}
  state.sending=true; updateControls();
  try { const job=await post('/api/jobs',{...input,prompt,refinedPrompt,mode});state.selected=job.id;state.outputIndex=0;state.view='studio';updateJob(job);render();watch(job);$('#prompt').value='';$('#stage').scrollTop=0; }
  catch(error){toast(error.message);} finally{state.sending=false;renderReferences();updateControls();}
}
async function refreshConfig() {
  try {
    state.config=await api('/api/config');const config=state.config;
    $('#connection-label').textContent=config.ready?'已读取 Codex 配置':'配置需要检查';$('#connection').classList.toggle('not-ready',!config.ready);$('#config-warning').hidden=config.ready;$('#config-warning').textContent=config.error||'';
    $('#config-details').replaceChildren();
    for(const [label,value] of [['提示词模型',config.model],['生图模型',config.imageModel],['服务提供方',config.provider],['API 地址',config.baseUrl],['凭据来源',config.credentialSource],['Profile',config.profile||'默认']]) $('#config-details').append(el('dt','',label),el('dd','',value||'—'));
    updateControls();
  }catch(error){$('#connection-label').textContent='服务未连接';toast(error.message);}
}
function newImage(){closeHistory();state.selected=null;state.outputIndex=0;state.view='studio';state.references=[];state.parent=null;clearEdit();$('#prompt').value='';$('#action').value='none';render();$('#prompt').focus();}
const editor=createEditor({imageSource,upload,notify:toast,onApply:edit=>{state.edit=edit;renderReferences();if(!$('#prompt').value.trim())$('#prompt').value=edit.type==='outpaint'?'自然补全画布的透明区域，与原图场景、光线和透视保持一致。':'';$('#prompt').focus();updateControls();}});
$('#new-image').onclick=newImage;
$('#studio-nav').onclick=()=>{closeHistory();state.view='studio';render();};$('#gallery-nav').onclick=()=>{closeHistory();state.view='gallery';render();};
$('.view-tabs').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const view=event.key==='Home'?'studio':event.key==='End'?'gallery':state.view==='studio'?'gallery':'studio';$(`#${view}-nav`).click();$(`#${view}-nav`).focus();};
$('#history-popover').addEventListener('beforetoggle',event=>{$('#history-button').setAttribute('aria-expanded',String(event.newState==='open'));if(event.newState==='open')positionHistory();});
$('#history-popover').addEventListener('toggle',event=>{if(event.newState==='open'){positionHistory();($('#history .selected')||$('#history button'))?.focus({preventScroll:true});}});
window.addEventListener('resize',()=>{if($('#history-popover').matches(':popover-open'))positionHistory();});
$('#return-codex').hidden=!embed||!!mcp;$('#return-codex').onclick=()=>{if(embed&&!mcp&&window.parent!==window)window.parent.postMessage({type:'codex-imageboard-close'},'*');};
$('#composer').onsubmit=event=>{event.preventDefault();if(!$('#generate').disabled)void submit();};$('#refine').onclick=()=>submit('refine');
$('#prompt').oninput=updateControls;$('#prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('#generate').disabled)void submit();}};
$('#stop').onclick=async()=>{const job=state.jobs.find(active);if(!job)return;$('#stop').disabled=true;try{await post(`/api/jobs/${job.id}/cancel`,{});}catch(error){toast(error.message);$('#stop').disabled=false;}};
$('#upload-reference').onclick=()=>$('#reference-input').click();$('#reference-input').onchange=event=>{const files=[...event.target.files];event.target.value='';void uploadFiles(files);};
$('#inpaint').onclick=()=>editor.open(state.references[0].asset,'inpaint');$('#outpaint').onclick=()=>editor.open(state.references[0].asset,'outpaint');
$('#settings-button').onclick=()=>{const open=$('#generation-settings').hidden;$('#generation-settings').hidden=!open;$('#settings-button').setAttribute('aria-expanded',String(open));};
for(const id of ['format','background','compression'])$(`#${id}`).oninput=syncOutputOptions;
$('#action').onchange=()=>{syncOutputOptions();const hints={style:'把参考图转换成水彩插画风格，保留主体和构图。',recolor:'把参考图中主体的颜色改为蓝色，其他部分保持不变。',text:'将图片中的文字替换为「在这里输入文案」，保留其他排版。',translate:'将图片中的文字翻译成中文，保留原来的排版。',sketch:'将这张草图转为真实感摄影，保持布局、比例和透视。','remove-background':'移除图片背景，保留主体和自然边缘，输出透明背景。','replace-background':'将背景替换为简洁的浅灰色摄影棚，保持主体不变。'};if(!$('#prompt').value.trim()&&hints[$('#action').value])$('#prompt').value=hints[$('#action').value];updateControls();};
$('#connection').onclick=()=>{closeHistory();$('#config-dialog').showModal();};$('#close-config').onclick=()=>$('#config-dialog').close();$('#refresh-config').onclick=async()=>{await refreshConfig();toast('已重新读取配置');};
$('#close-preview').onclick=()=>$('#preview-dialog').close();$('#close-compare').onclick=()=>$('#compare-dialog').close();$('#compare-slider').oninput=event=>$('.compare-canvas').style.setProperty('--split',`${event.target.value}%`);
$('#close-manage').onclick=()=>$('#manage-dialog').close();
$('#manage-form').onsubmit=async event=>{event.preventDefault();const job=state.jobs.find(j=>j.id===state.managing);if(!job)return;try{await manageJob(job,{title:$('#work-title').value,tags:$('#work-tags').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),favorite:$('#work-favorite').checked});$('#manage-dialog').close();toast('作品信息已保存');}catch(error){toast(error.message);}};
$('#trash-work').onclick=async()=>{const job=state.jobs.find(j=>j.id===state.managing);if(!job)return;try{const deleted=!job.deletedAt;await manageJob(job,{deleted});$('#manage-dialog').close();if(deleted&&state.selected===job.id)newImage();toast(deleted?'已移入回收站，可在「我的作品」恢复':'作品已恢复');}catch(error){toast(error.message);}};
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('dialog[open]')){event.preventDefault();newImage();}});
document.addEventListener('paste',event=>{if(document.querySelector('dialog[open]'))return;const files=[...event.clipboardData?.items||[]].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();void uploadFiles(files);}});
let dragDepth=0;
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')&&!document.querySelector('dialog[open]')){event.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#drop-overlay').hidden=true;});
document.addEventListener('drop',event=>{dragDepth=0;$('#drop-overlay').hidden=true;if(event.dataTransfer?.files.length){event.preventDefault();if(!document.querySelector('dialog[open]'))void uploadFiles(event.dataTransfer.files);}});
window.addEventListener('beforeunload',()=>{state.source?.close();for(const cached of imageCache.values())void cached.then(image=>URL.revokeObjectURL(image.url)).catch(()=>{});});
setInterval(updateElapsed,1000);render();await refreshConfig();
try{state.jobs=await api('/api/jobs');const running=state.jobs.find(active);if(running){state.selected=running.id;restoreSettings(running);state.references=(running.references||[]).map(ref=>({...ref}));state.parent=running.parent;state.edit=draftEdit(running);watch(running);}render();}catch(error){toast(error.message);}
if(!mcp&&window.parent!==window)window.parent.postMessage({type:'codex-imageboard-ready'},'*');
