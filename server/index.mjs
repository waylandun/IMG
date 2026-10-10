import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { Jobs, isActive } from './jobs.mjs';
import { ProviderError } from './provider.mjs';
import { embeddedDocument } from './embed.mjs';
import { ASSET_LIMIT } from './assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function readBody(req, limit = 128_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new ProviderError('请求过大。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ProviderError('需要 JSON 请求。', 415);
  const bytes = await readBody(req);
  try { const result = JSON.parse(bytes); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new ProviderError('JSON 格式无效。', 400); }
}

export async function createServer({ directory = process.env.IMAGEBOARD_DATA_DIR || path.join(root, '.data'), configLoader = loadConfig, refine, generate, accessToken } = {}) {
  const capability = randomBytes(32).toString('hex');
  const jobs = new Jobs({ directory, configLoader, refine, generate });
  await jobs.init();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'");
    const expectedPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`];
    if (!allowedHosts.includes(req.headers.host)) { json(res, 403, { error: '仅支持本机访问。' }); return; }
    if (accessToken) {
      const received = req.headers.authorization || '';
      const expected = `Bearer ${accessToken}`;
      if (Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
        json(res, 403, { error: '需要 Imageboard 本地连接授权。' }); return;
      }
    }
    const origin = `http://${req.headers.host}`;
    const receivedCapability = req.headers['x-imageboard-embed'];
    const embedded = req.headers.origin === 'null'
      && typeof receivedCapability === 'string'
      && Buffer.byteLength(receivedCapability) === Buffer.byteLength(capability)
      && timingSafeEqual(Buffer.from(receivedCapability), Buffer.from(capability));
    const embeddedRoute = /^\/api\/(config|jobs(?:\/[a-f0-9-]{36}(?:\/cancel)?)?|assets(?:\/[a-f0-9-]{36})?|images\/[a-f0-9-]{36}\.png)(?:\?.*)?$/.test(req.url);
    if (req.method === 'OPTIONS' && req.headers.origin === 'null' && embeddedRoute) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'GET, POST, PATCH', 'Access-Control-Allow-Headers': 'content-type, x-imageboard-embed, x-imageboard-filename', 'Access-Control-Max-Age': '300', Vary: 'Origin' });
      res.end(); return;
    }
    if (embedded && embeddedRoute) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Vary', 'Origin');
    } else if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      // Top-level Codex embedding is allowed; API access remains same-origin.
      if (req.url.startsWith('/api/') || req.method !== 'GET') { json(res, 403, { error: '跨站请求被拒绝。' }); return; }
    }
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { app: 'codex-imageboard', version: '0.3.2', native: !!accessToken }); return; }
      if (req.method === 'GET' && url.pathname === '/api/embed-document') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await embeddedDocument(root, origin, capability)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        try { json(res, 200, (await configLoader()).public); }
        catch (error) { json(res, 200, { ready: false, error: error.message }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') { json(res, 200, jobs.list()); return; }
      if (req.method === 'POST' && url.pathname === '/api/jobs') { json(res, 202, await jobs.create(await body(req))); return; }
      if (req.method === 'POST' && url.pathname === '/api/assets') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(req.headers['content-type']?.split(';')[0])) throw new ProviderError('请选择 PNG、JPEG 或 WebP 图片。', 415);
        let name = '参考图';
        try { name = decodeURIComponent(req.headers['x-imageboard-filename'] || name); } catch {}
        const asset = await jobs.assets.save(await readBody(req, ASSET_LIMIT), { name, mask: url.searchParams.get('mask') === '1' });
        json(res, 201, asset); return;
      }
      const assetMatch = url.pathname.match(/^\/api\/assets\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && assetMatch) {
        if (url.searchParams.has('meta')) { json(res, 200, await jobs.assets.get(assetMatch[1])); return; }
        const asset = await jobs.assets.bytes(assetMatch[1]);
        res.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=86400', ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="imageboard-${asset.id.slice(0, 8)}.${asset.format}"` } : {}) });
        res.end(asset.bytes); return;
      }
      const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(events|cancel))?$/);
      if (match) {
        const [, id, action] = match;
        const job = jobs.get(id);
        if (!job) throw new ProviderError('找不到该任务。', 404);
        if (req.method === 'PATCH' && !action) { json(res, 200, await jobs.manage(id, await body(req))); return; }
        if (req.method === 'POST' && action === 'cancel') { await body(req); json(res, 200, jobs.cancel(id)); return; }
        if (req.method === 'GET' && action === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const send = updated => {
            if (updated.id !== id) return;
            res.write(`data: ${JSON.stringify(updated)}\n\n`);
            if (!isActive(updated)) res.end();
          };
          const timer = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
          jobs.on('change', send);
          req.on('close', () => { jobs.off('change', send); clearInterval(timer); });
          send(job);
          return;
        }
        if (req.method === 'GET' && !action) { json(res, 200, job); return; }
      }
      const image = url.pathname.match(/^\/api\/images\/([a-f0-9-]{36})\.png$/);
      if (req.method === 'GET' && image) {
        if (jobs.get(image[1])?.status !== 'completed' || jobs.get(image[1])?.deletedAt) throw new ProviderError('图片不存在。', 404);
        const bytes = await readFile(path.join(directory, 'images', `${image[1]}.png`));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="imageboard-${image[1].slice(0,8)}.png"` } : {}) });
        res.end(bytes); return;
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/editor.js': ['editor.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        res.end(await readFile(path.join(root, 'web', file))); return;
      }
      json(res, 404, { error: '页面不存在。' });
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof ProviderError ? error.status : 500, { error: error instanceof ProviderError ? error.message : '本地服务处理失败。' });
      else res.end();
    }
  });
  server.on('close', () => jobs.close());
  return { server, jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, jobs } = await createServer();
  const port = Number(process.env.IMAGEBOARD_PORT || 47824);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : '本地服务启动失败。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Imageboard 已就绪：http://127.0.0.1:${port}`));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { jobs.close(); server.close(); server.closeAllConnections(); });
}
