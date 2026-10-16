import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { Channels, listModels } from '../server/channels.mjs';
import { loadConfig } from '../server/config.mjs';
import { createServer } from '../server/index.mjs';
import { createBridge, allowedRequest } from '../server/mcp-bridge.mjs';
import { isActive } from '../server/jobs.mjs';

const PNG = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#aaccee' } }).png().toBuffer();
const draft = { name: '测试渠道', baseUrl: 'https://gateway.example/v1/', apiKey: 'custom-secret', imageModel: 'custom-image' };
const codex = { model: 'codex-text', imageModel: 'codex-image', baseUrl: 'https://codex.example/v1', headers: { Authorization: 'Bearer codex-secret' }, error: '', public: { ready: true, provider: 'Codex provider', credentialSource: '测试凭据' } };
async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'imageboard-channels-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function store(t, configLoader = async () => codex) {
  const dir = await directory(t), channels = new Channels({ directory: dir, configLoader });
  await channels.init(); return { dir, channels };
}
async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function app(t, options = {}) {
  const dir = await directory(t);
  const { server, jobs } = await createServer({ directory: dir, configLoader: async () => codex, refine: async () => 'refined', generate: async () => ({ image: PNG }), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { jobs.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await jobs.writeQueue; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, method = 'GET', body, headers = {}) => fetch(origin + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { dir, origin, jobs, request };
}
async function terminal(jobs, id) {
  const deadline = Date.now() + 3000;
  while (isActive(jobs.get(id)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(isActive(jobs.get(id)), false);
  return jobs.get(id);
}

test('channels persist private credentials and defaults; edits retain keys; deleting default restores Codex', async t => {
  const { channels, dir } = await store(t);
  assert.equal((await channels.resolve()).public.defaultChannelId, 'codex');
  const channel = await channels.create(draft);
  assert.equal(channel.baseUrl, 'https://gateway.example/v1');
  assert.ok(!JSON.stringify(channel).includes(draft.apiKey));
  assert.equal((await channels.resolve()).public.defaultChannelId, 'codex');
  await channels.setDefault(channel.id);
  await Promise.all([channels.update(channel.id, { name: '改名', apiKey: '' }), channels.update(channel.id, { imageModel: 'new-image' })]);
  const restored = new Channels({ directory: dir, configLoader: async () => codex }); await restored.init();
  const resolved = await restored.resolve();
  assert.equal(resolved.imageConfig.headers.Authorization, 'Bearer custom-secret');
  assert.equal(resolved.imageConfig.imageModel, 'new-image');
  assert.equal(resolved.public.channelName, '改名');
  assert.equal(resolved.public.model, 'codex-text');
  assert.doesNotMatch(JSON.stringify(resolved.public), /custom-secret|codex-secret/);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'channels.json'))).mode & 0o777, 0o600);
  await restored.update(channel.id, { apiKey: 'replacement-secret' });
  assert.equal((await restored.resolve()).imageConfig.headers.Authorization, 'Bearer replacement-secret');
  await restored.remove(channel.id);
  assert.equal((await restored.resolve()).public.defaultChannelId, 'codex');
  assert.doesNotMatch(await readFile(path.join(dir, 'channels.json'), 'utf8'), /replacement-secret/);
});

test('scanned configuration is immutable and rereading does not override the saved default', async t => {
  const dir = await directory(t), home = path.join(dir, 'codex'); await mkdir(home);
  const source = 'model="scan-text"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="https://codex.example/v1"\nexperimental_bearer_token="scan-secret"\n';
  await writeFile(path.join(home, 'config.toml'), source);
  const channels = new Channels({ directory: dir, configLoader: () => loadConfig({ env: { CODEX_HOME: home } }) }); await channels.init();
  const channel = await channels.create(draft); await channels.setDefault(channel.id);
  await assert.rejects(channels.update('codex', draft), /只读/);
  await assert.rejects(channels.remove('codex'), /只读/);
  assert.equal((await channels.resolve()).public.defaultChannelId, channel.id);
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), source);
  await writeFile(path.join(home, 'config.toml'), source.replace('scan-text', 'new-text'));
  assert.equal((await channels.resolve()).public.model, 'new-text');
  assert.equal((await channels.resolve()).public.defaultChannelId, channel.id);
});

test('invalid channel input cannot change the saved configuration or leak credentials', async t => {
  const { channels, dir } = await store(t);
  const channel = await channels.create(draft);
  const before = await readFile(path.join(dir, 'channels.json'), 'utf8');
  for (const patch of [{ baseUrl: 'https://user:private-secret@example.com' }, { baseUrl: 'file:///tmp/config' }, { baseUrl: 'https://example.com?key=private-secret' }, { apiKey: 'private-secret\nInjected: value' }, { name: '' }, { imageModel: '' }]) {
    await assert.rejects(channels.update(channel.id, patch), e => e.status === 400 && !e.message.includes('private-secret'));
  }
  await assert.rejects(channels.setDefault('unknown'), /找不到/);
  assert.equal(await readFile(path.join(dir, 'channels.json'), 'utf8'), before);
  await writeFile(path.join(dir, 'channels.json'), '{broken-private-secret');
  await assert.rejects(new Channels({ directory: dir, configLoader: async () => codex }).init(), e => !e.message.includes('private-secret'));
});

test('model discovery uses GET and saved credentials, deduplicates IDs, and only falls back for missing root routes', async t => {
  const calls = [];
  const origin = await upstream(t, (req, res) => {
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    if (req.url === '/models') { res.writeHead(404); res.end(); return; }
    res.end(JSON.stringify({ data: [{ id: 'image-b' }, { id: 'image-a' }, { id: 'image-b' }, {}, { id: 1 }] }));
  });
  const { channels } = await store(t);
  const channel = await channels.create({ ...draft, baseUrl: origin });
  assert.deepEqual((await channels.models({ channelId: channel.id, apiKey: '' })).models, ['image-a', 'image-b']);
  assert.deepEqual(calls.map(c => c.url), ['/models', '/v1/models']);
  assert.ok(calls.every(c => c.method === 'GET' && c.auth === 'Bearer custom-secret'));
  calls.length = 0;
  await channels.models({ baseUrl: `${origin}/v1/`, apiKey: 'new-secret' });
  assert.deepEqual(calls, [{ url: '/v1/models', method: 'GET', auth: 'Bearer new-secret' }]);
});

test('model errors, timeouts, oversized payloads and redirects are bounded and sanitized', async t => {
  let calls = 0;
  const origin = await upstream(t, (req, res) => {
    calls++;
    if (req.url.startsWith('/timeout/')) return;
    if (req.url.startsWith('/auth/')) { res.writeHead(401); res.end('private-secret'); return; }
    if (req.url.startsWith('/large/')) { res.end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    if (req.url.startsWith('/redirect/')) { res.writeHead(302, { Location: '/auth/models' }); res.end(); return; }
    res.end('private-secret');
  });
  for (const route of ['auth', 'large', 'redirect', 'invalid', 'timeout']) {
    const before = calls;
    await assert.rejects(listModels({ baseUrl: `${origin}/${route}`, headers: { Authorization: 'Bearer private-secret' } }, { signal: AbortSignal.timeout(route === 'timeout' ? 30 : 2000) }), e => !e.message.includes('private-secret'));
    assert.equal(calls - before, 1);
  }
});

test('generation snapshots the image channel across edits, switches and deletion while text uses Codex', async t => {
  let release, refining;
  const started = new Promise(resolve => { refining = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const received = [];
  const { request, jobs, dir } = await app(t, {
    refine: async config => { assert.equal(config.headers.Authorization, 'Bearer codex-secret'); assert.equal(config.model, 'codex-text'); refining(); await gate; return 'refined'; },
    generate: async config => { received.push({ model: config.imageModel, auth: config.headers.Authorization }); return { image: PNG }; },
  });
  const channel = await (await request('/api/channels', 'POST', draft)).json();
  await request('/api/config/default-channel', 'PATCH', { channelId: channel.id });
  const first = await (await request('/api/jobs', 'POST', { prompt: 'test', count: 2 })).json();
  await started;
  await request(`/api/channels/${channel.id}`, 'PATCH', { imageModel: 'edited-image', apiKey: 'edited-secret' });
  await request(`/api/channels/${channel.id}`, 'DELETE');
  release();
  assert.equal((await terminal(jobs, first.id)).status, 'completed');
  assert.deepEqual(received, Array(2).fill({ model: 'custom-image', auth: 'Bearer custom-secret' }));
  const next = await (await request('/api/jobs', 'POST', { prompt: 'edit', optimize: false, parent: { jobId: first.id, outputIndex: 0 } })).json();
  assert.equal((await terminal(jobs, next.id)).status, 'completed');
  assert.deepEqual(received[2], { model: 'codex-image', auth: 'Bearer codex-secret' });
  assert.doesNotMatch(await readFile(path.join(dir, 'jobs.json'), 'utf8'), /custom-secret|codex-secret|edited-secret/);
});

test('missing Codex allows custom direct generation; prompt preview and image readiness are independent', async t => {
  const { request, jobs } = await app(t, { configLoader: async () => { throw new Error('无法读取 config.toml，请检查文件格式。'); } });
  const initial = await (await request('/api/config')).json(); assert.equal(initial.promptReady, false);
  const channel = await (await request('/api/channels', 'POST', draft)).json();
  await request('/api/config/default-channel', 'PATCH', { channelId: channel.id });
  const config = await (await request('/api/config')).json();
  assert.equal(config.ready, true); assert.equal(config.promptReady, false);
  assert.equal((await request('/api/jobs', 'POST', { prompt: 'direct', mode: 'refine' })).status, 422);
  assert.equal((await request('/api/jobs', 'POST', { prompt: 'direct', optimize: true })).status, 422);
  const job = await (await request('/api/jobs', 'POST', { prompt: 'direct', optimize: false })).json();
  assert.equal((await terminal(jobs, job.id)).status, 'completed');
  await request(`/api/channels/${channel.id}`, 'DELETE');
  assert.equal((await (await request('/api/config')).json()).ready, false);
  const other = await app(t, { configLoader: async () => ({ ...codex, promptError: '', imageError: '图片配置不可用' }) });
  const preview = await (await other.request('/api/jobs', 'POST', { prompt: 'idea', mode: 'refine' })).json();
  assert.equal((await terminal(other.jobs, preview.id)).status, 'prepared');
});

test('actual provider requests send Codex text and custom generation/edit models to their own gateways', async t => {
  const calls = [];
  const imageOrigin = await upstream(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const multipart = req.headers['content-type'].startsWith('multipart/');
    const data = multipart ? await new Request('http://local.test', { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: bytes }).formData() : JSON.parse(bytes);
    calls.push({ route: req.url, model: multipart ? data.get('model') : data.model, auth: req.headers.authorization });
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  const textOrigin = await upstream(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    calls.push({ route: req.url, model: data.model, auth: req.headers.authorization });
    res.end(JSON.stringify({ output_text: 'optimized by Codex' }));
  });
  const { request, jobs } = await app(t, { configLoader: async () => ({ ...codex, baseUrl: textOrigin }), refine: undefined, generate: undefined });
  const channel = await (await request('/api/channels', 'POST', { ...draft, baseUrl: imageOrigin })).json();
  await request('/api/config/default-channel', 'PATCH', { channelId: channel.id });
  const first = await (await request('/api/jobs', 'POST', { prompt: 'idea' })).json();
  assert.equal((await terminal(jobs, first.id)).status, 'completed');
  const edit = await (await request('/api/jobs', 'POST', { prompt: 'edit', optimize: false, parent: { jobId: first.id, outputIndex: 0 }, action: 'remove-background' })).json();
  assert.equal((await terminal(jobs, edit.id)).status, 'completed');
  assert.deepEqual(calls, [
    { route: '/responses', model: 'codex-text', auth: 'Bearer codex-secret' },
    { route: '/images/generations', model: 'custom-image', auth: 'Bearer custom-secret' },
    { route: '/images/edits', model: 'custom-image', auth: 'Bearer custom-secret' },
  ]);
});

test('HTTP and MCP protect channel mutations, expose no secrets and support the isolated iframe', async t => {
  const { request, origin } = await app(t, { accessToken: 'local-token' });
  const bridge = createBridge({ runtimeLoader: async () => ({ origin, token: 'local-token' }) });
  assert.equal((await fetch(origin + '/api/channels', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/channels', 'POST', draft, { Origin: 'https://evil.example' })).status, 403);
  const document = await (await request('/api/embed-document')).text();
  assert.ok(document.includes('function createConfigPanel'));
  const { capability } = JSON.parse(document.match(/window\.__IMAGEBOARD_EMBED__=(\{[^\n]+?\});/)[1]);
  const headers = { Origin: 'null', 'X-Imageboard-Embed': capability };
  const created = await request('/api/channels', 'POST', draft, headers);
  assert.equal(created.headers.get('access-control-allow-origin'), 'null');
  const channel = await created.json();
  assert.doesNotMatch(JSON.stringify(channel), /custom-secret/);
  assert.equal((await bridge.request({ method: 'PATCH', route: `/api/channels/${channel.id}`, body: { name: 'MCP channel' } })).status, 200);
  assert.equal((await bridge.request({ method: 'PATCH', route: '/api/config/default-channel', body: { channelId: channel.id } })).status, 200);
  assert.equal((await bridge.request({ method: 'PATCH', route: '/api/channels/codex', body: draft })).status, 403);
  assert.equal((await bridge.request({ method: 'DELETE', route: '/api/channels/codex' })).status, 403);
  const preflight = await request(`/api/channels/${channel.id}`, 'OPTIONS', undefined, { Origin: 'null' });
  assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  assert.equal((await request(`/api/channels/${channel.id}`, 'DELETE', undefined, { Origin: 'null' })).status, 403);
  assert.equal((await bridge.request({ method: 'DELETE', route: `/api/channels/${channel.id}` })).json.defaultChannelId, 'codex');
  assert.equal(allowedRequest('POST', '/api/channels/models'), true);
  for (const route of ['/api/channels/../config', '/api/channels?secret=1', '/api/channels/models?url=https://evil.example']) assert.equal(allowedRequest('POST', route), false);
});
