import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Imageboard', version: '0.3.1' }, {}, { autoResize: false });
function hostTheme(theme) {
  if (theme === 'light' || theme === 'dark') window.dispatchEvent(new CustomEvent('imageboard-host-theme', { detail: { theme } }));
}
app.onhostcontextchanged = context => hostTheme(context.theme);
const ready = app.connect().then(() => hostTheme(app.getHostContext()?.theme));
const chunkSize = 256 * 1024;
async function call(name, args) {
  await ready;
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(x => x.type === 'text')?.text || 'Imageboard 请求失败。');
  return result.structuredContent;
}
function base64(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
async function response(result) {
  if (!result.binary) return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  const { id, size, type } = result.binary, chunks = []; let offset = 0;
  try {
    while (offset < size) {
      const part = await call('imageboard_transfer', { action: 'read_chunk', id, offset });
      if (part.nextOffset <= offset || part.nextOffset > size) throw new Error('图片传输异常。');
      chunks.push(Uint8Array.from(atob(part.data), x => x.charCodeAt(0))); offset = part.nextOffset;
    }
    return new Response(new Blob(chunks, { type }), { status: result.status, headers: { 'Content-Type': type } });
  } finally { void call('imageboard_transfer', { action: 'release', id }).catch(() => {}); }
}
window.__IMAGEBOARD_MCP__ = {
  async download(blob, name) {
    await ready;
    if (!app.getHostCapabilities()?.downloadFile) return false;
    await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: blob.type, blob: base64(new Uint8Array(await blob.arrayBuffer())) } }] });
    return true;
  },
  async fetch(route, options = {}) {
    if (route.startsWith('/api/assets') && options.method === 'POST') {
      const blob = options.body, headers = new Headers(options.headers);
      const { id } = await call('imageboard_transfer', { action: 'begin_upload', size: blob.size, type: headers.get('content-type'), name: decodeURIComponent(headers.get('x-imageboard-filename') || '参考图'), mask: route.endsWith('?mask=1') });
      try {
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
          const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
          await call('imageboard_transfer', { action: 'upload_chunk', id, offset, data: base64(bytes) });
        }
        return response(await call('imageboard_transfer', { action: 'finish_upload', id }));
      } finally { void call('imageboard_transfer', { action: 'release', id }).catch(() => {}); }
    }
    return response(await call('imageboard_request', { route, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) }));
  },
};
