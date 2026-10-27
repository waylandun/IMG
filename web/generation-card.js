const transport = window.__IMAGEBOARD_MCP__;
const byId = id => document.getElementById(id);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job?.status);
const labels = { refining: '正在理解需求', generating: '正在创建图像', completed: '图片已生成', failed: '生成失败', cancelled: '已停止' };
let job, jobId, epoch = 0, pollTimer, elapsedTimer, polling = false, disposed = false, retries = 0;
let blob, objectUrl, loadedId, loadingId, pendingInput, viewerMode = false, fullscreenRequested = false;

function hostContext(context = {}) {
  if (['dark', 'light'].includes(context.theme)) document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
  if (context.availableDisplayModes) document.documentElement.dataset.availableDisplayModes = context.availableDisplayModes.join(',');
  if (viewerMode && fullscreenRequested && context.displayMode && context.displayMode !== 'fullscreen') {
    fullscreenRequested = false; setViewerMode(false);
  }
}
const darkPreference = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.dataset.theme = darkPreference.matches ? 'dark' : 'light';
window.addEventListener('imageboard-host-context', event => hostContext(event.detail));

function elapsed() {
  const start = Date.parse(job?.createdAt);
  const end = terminal(job) ? Date.parse(job.completedAt || job.updatedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  byId('elapsed').textContent = Number.isFinite(seconds) ? seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : '';
}
function setViewerMode(active) {
  viewerMode = active;
  document.querySelector('.generation-card').classList.toggle('viewer-mode', active);
  byId('close-viewer').hidden = !active;
  byId('view-image').setAttribute('aria-label', active ? '退出原图查看' : '查看原图');
  if (active) byId('note').textContent = '原图查看 · 点击返回卡片';
}
function releaseImage() {
  setViewerMode(false); fullscreenRequested = false;
  byId('result-image').removeAttribute('src');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  blob = objectUrl = loadedId = loadingId = undefined;
  byId('download').hidden = true;
}
function issue(message, { retry = false, title = '暂时无法读取图片' } = {}) {
  byId('note').textContent = message;
  byId('retry').hidden = !retry;
  if (!loadedId) {
    byId('stage').className = 'stage issue';
    byId('stage').setAttribute('aria-busy', 'false');
    byId('placeholder').hidden = false; byId('result').hidden = true;
    byId('placeholder-title').textContent = title;
    byId('placeholder-detail').textContent = message;
  }
}
async function loadImage(data, token) {
  const asset = data.images?.[0];
  if (!asset || !uuid.test(asset.assetId)) { issue('任务没有返回可读取的图片。'); return; }
  if (loadedId === asset.assetId || loadingId === asset.assetId) return;
  loadingId = asset.assetId;
  let url;
  try {
    byId('placeholder-detail').textContent = '图片已生成，正在读取原图';
    const response = await transport.fetch(`/api/assets/${asset.assetId}`);
    if (!response.ok) throw new Error('原图暂时无法读取，请稍后重试。');
    const nextBlob = await response.blob();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(nextBlob.type) || !nextBlob.size || nextBlob.size > 20 * 1024 * 1024) throw new Error('返回的图片格式或大小无效。');
    url = URL.createObjectURL(nextBlob);
    const decoded = new Image(); decoded.src = url; await decoded.decode();
    if (disposed || epoch !== token) { URL.revokeObjectURL(url); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = url; blob = nextBlob; loadedId = asset.assetId;
    byId('result-image').src = url;
    byId('stage').className = 'stage complete'; byId('stage').setAttribute('aria-busy', 'false');
    byId('placeholder').hidden = true; byId('result').hidden = false;
    byId('download').hidden = false; byId('retry').hidden = true;
    byId('note').textContent = data.warning || '原图已保存 · 点击图片放大';
  } catch (error) {
    if (url && url !== objectUrl) URL.revokeObjectURL(url);
    if (!disposed && epoch === token) issue(error.message || '图片暂时无法显示，请重新读取。', { retry: true });
  } finally { if (epoch === token) loadingId = undefined; }
}
function render(data) {
  byId('status-label').textContent = data.display?.label || labels[data.status] || '正在读取任务';
  byId('status-icon').textContent = ['failed', 'cancelled'].includes(data.status) ? '○' : '✦';
  clearInterval(elapsedTimer); elapsed();
  if (!terminal(data)) {
    elapsedTimer = setInterval(elapsed, 1000);
    byId('stage').className = 'stage pending'; byId('stage').setAttribute('aria-busy', 'true');
    byId('placeholder').hidden = false; byId('result').hidden = true; byId('download').hidden = true;
    byId('placeholder-title').textContent = '让想象慢慢显影';
    byId('placeholder-detail').textContent = `已完成 ${data.images?.length || 0}/1 个方案，正在继续生成`;
    byId('note').textContent = ''; byId('retry').hidden = true;
  } else {
    clearTimeout(pollTimer);
    if (data.images?.length) void loadImage(data, epoch);
    else issue(data.error || (data.status === 'cancelled' ? '本次创作已停止。' : '本次任务没有返回图片。'), { title: data.status === 'completed' ? '图片结果不可用' : labels[data.status] });
  }
}
function accept(data) {
  if (!data || !uuid.test(data.jobId || '')) return;
  if (jobId !== data.jobId) {
    epoch++; clearTimeout(pollTimer); releaseImage(); job = undefined; retries = 0;
    jobId = data.jobId;
  }
  // Tool notifications and polling can arrive in either order.
  if (terminal(job) && !terminal(data)) return;
  if (job && Date.parse(data.updatedAt) < Date.parse(job.updatedAt)) return;
  job = data; render(data);
  if (!terminal(job) && !polling) void refresh();
}
async function refresh() {
  if (!jobId || disposed || polling) return;
  const token = epoch, requestedId = jobId;
  polling = true; clearTimeout(pollTimer);
  try {
    const result = await transport.getGeneration(requestedId, 20);
    if (disposed || epoch !== token) return;
    retries = 0; accept(result);
  } catch (error) {
    if (disposed || epoch !== token) return;
    const canRetry = ![400, 404].includes(error.statusCode) && retries < 3;
    retries++;
    issue(error.message || '连接暂时中断，图片任务仍会继续。', { retry: true, title: '正在恢复连接' });
    if (canRetry) pollTimer = setTimeout(refresh, Math.min(8000, 1000 * 2 ** retries));
  } finally {
    polling = false;
    if (!disposed && epoch !== token) { if (jobId && !terminal(job)) void refresh(); }
    else if (!disposed && !terminal(job) && !retries) pollTimer = setTimeout(refresh, 500);
  }
}
window.addEventListener('imageboard-tool-input', event => {
  const id = event.detail?.requestId;
  if (uuid.test(id || '')) pendingInput = id;
});
window.addEventListener('imageboard-tool-result', event => {
  const result = event.detail, data = result?.structuredContent;
  if (result?.isError) {
    byId('status-label').textContent = '图片任务暂时不可用';
    issue(data?.error || '无法读取本次创作，请查看聊天中的提示。');
    return;
  }
  if (data?.jobId && (!pendingInput || data.jobId === pendingInput)) accept(data);
});
byId('retry').addEventListener('click', () => {
  retries = 0; byId('retry').hidden = true;
  if (terminal(job) && job.images?.length) void loadImage(job, epoch);
  else void refresh();
});
async function openViewer() {
  if (!loadedId) return;
  if (viewerMode) { await closeViewer(); return; }
  const context = transport.getHostContext?.() || {};
  const modes = Array.isArray(context.availableDisplayModes) ? context.availableDisplayModes : [];
  if (modes.includes('fullscreen') && transport.requestDisplayMode) {
    try {
      const result = await transport.requestDisplayMode('fullscreen');
      if (result?.mode === 'fullscreen') fullscreenRequested = true;
    } catch { /* Fall back to the responsive card view. */ }
  }
  setViewerMode(true);
}
async function closeViewer() {
  if (fullscreenRequested && transport.requestDisplayMode) {
    try { await transport.requestDisplayMode('inline'); } catch { /* The host may already have left fullscreen. */ }
  }
  fullscreenRequested = false; setViewerMode(false);
}
byId('view-image').addEventListener('click', () => { void openViewer(); });
byId('close-viewer').addEventListener('click', () => { void closeViewer(); });
byId('download').addEventListener('click', async () => {
  if (!blob || !loadedId) return;
  byId('download').disabled = true;
  try {
    const format = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
    if (!await transport.download(blob, `imageboard-${loadedId}.${format}`)) byId('note').textContent = '当前窗口暂不支持下载，可从聊天回复中的图片保存原图。';
  } catch { byId('note').textContent = '下载未完成，请重试。'; }
  finally { byId('download').disabled = false; }
});
window.addEventListener('pagehide', () => {
  disposed = true; epoch++; clearTimeout(pollTimer); clearInterval(elapsedTimer); setViewerMode(false); releaseImage();
});
transport.ready.then(() => hostContext(transport.getHostContext())).catch(() => issue('无法连接图片服务，请重新打开这张创作卡片。'));
