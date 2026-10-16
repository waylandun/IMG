import { randomUUID } from 'node:crypto';
import { ensureRuntime, dataDirectory } from './runtime.mjs';

export const CHUNK_SIZE = 256 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const UUID = '[a-f0-9-]{36}';
export function allowedRequest(method, route) {
  if (typeof route !== 'string') return false;
  if (method === 'GET') return new RegExp(`^/api/(config|jobs(?:/${UUID})?|assets/${UUID}(?:\\?(?:meta|download)=1)?|images/${UUID}\\.png(?:\\?download=1)?)$`).test(route);
  if (method === 'POST') return new RegExp(`^/api/(jobs(?:/${UUID}/cancel)?|channels(?:/models)?)$`).test(route);
  if (method === 'PATCH') return new RegExp(`^/api/(jobs/${UUID}|channels/(?:codex|${UUID})|config/default-channel)$`).test(route);
  return method === 'DELETE' && new RegExp(`^/api/channels/(?:codex|${UUID})$`).test(route);
}
export function createBridge({ directory = dataDirectory(), runtimeLoader = () => ensureRuntime(directory) } = {}) {
  const uploads = new Map(), downloads = new Map();
  const prune = () => { for (const map of [uploads, downloads]) for (const [id, entry] of map) if (Date.now() - entry.updated > 120_000) map.delete(id); };
  async function request(route, options = {}) {
    const runtime = await runtimeLoader();
    return fetch(`${runtime.origin}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
  }
  async function result(response) {
    const type = response.headers.get('content-type') || 'application/octet-stream';
    if (type.includes('application/json')) return { status: response.status, json: await response.json() };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 64 * 1024 * 1024) throw new Error('图片过大，无法在面板内传输。');
    prune();
    // Bound binary caches even if an app closes without releasing its download.
    while (downloads.size && [...downloads.values()].reduce((sum, x) => sum + x.bytes.length, 0) + bytes.length > 64 * 1024 * 1024) downloads.delete(downloads.keys().next().value);
    const id = randomUUID(); downloads.set(id, { bytes, updated: Date.now() });
    return { status: response.status, binary: { id, size: bytes.length, type } };
  }
  return {
    async request(args) {
      const { method = 'GET', route, body } = args;
      if (!allowedRequest(method, route)) throw new Error('不支持的 Imageboard 请求。');
      if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 128_000)) throw new Error('请求内容无效。');
      return result(await request(route, { method, ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : {}) }));
    },
    async transfer(args) {
      prune();
      if (args.action === 'begin_upload') {
        if (uploads.size >= 2) throw new Error('请等待当前上传完成。');
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(args.type) || !Number.isInteger(args.size) || args.size < 1 || args.size > MAX_IMAGE) throw new Error('请选择 20 MB 以内的 PNG、JPEG 或 WebP。');
        const id = randomUUID(); uploads.set(id, { chunks: [], length: 0, size: args.size, type: args.type, name: String(args.name || '参考图').slice(0, 200), mask: args.mask === true, updated: Date.now() });
        return { id };
      }
      if (args.action === 'upload_chunk') {
        const entry = uploads.get(args.id);
        if (!entry || args.offset !== entry.length || typeof args.data !== 'string' || args.data.length > Math.ceil(CHUNK_SIZE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data)) throw new Error('上传片段无效，请重新上传。');
        const bytes = Buffer.from(args.data, 'base64');
        if (!bytes.length || bytes.length > CHUNK_SIZE || bytes.length + entry.length > entry.size) throw new Error('上传大小不匹配。');
        entry.chunks.push(bytes); entry.length += bytes.length; entry.updated = Date.now(); return { offset: entry.length };
      }
      if (args.action === 'finish_upload') {
        const entry = uploads.get(args.id);
        if (!entry || entry.length !== entry.size) throw new Error('图片尚未上传完整。');
        uploads.delete(args.id);
        return result(await request(`/api/assets${entry.mask ? '?mask=1' : ''}`, { method: 'POST', headers: { 'Content-Type': entry.type, 'X-Imageboard-Filename': encodeURIComponent(entry.name) }, body: Buffer.concat(entry.chunks) }));
      }
      if (args.action === 'read_chunk') {
        const entry = downloads.get(args.id);
        if (!entry || !Number.isInteger(args.offset) || args.offset < 0 || args.offset >= entry.bytes.length) throw new Error('图片传输已过期，请重新打开。');
        entry.updated = Date.now(); const bytes = entry.bytes.subarray(args.offset, args.offset + CHUNK_SIZE);
        return { data: bytes.toString('base64'), nextOffset: args.offset + bytes.length };
      }
      if (args.action === 'release') { uploads.delete(args.id); downloads.delete(args.id); return {}; }
      throw new Error('不支持的图片传输操作。');
    },
  };
}
