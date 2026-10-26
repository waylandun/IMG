import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../server/index.mjs';
import { createBridge } from '../server/mcp-bridge.mjs';
import { createChatTools } from '../server/mcp-chat.mjs';
import { ProviderError } from '../server/provider.mjs';

const PNG = await sharp({ create: { width: 1280, height: 720, channels: 4, background: '#8cb7db' } }).png().toBuffer();
const config = { model: 'unused-text', imageModel: 'test-image', headers: { Authorization: 'Bearer private-test-secret' }, error: '', public: { ready: true } };
const draft = () => ({ requestId: randomUUID(), prompt: '咖啡店开业海报，标题：今天见', size: '1536x864', quality: 'high' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await delay(5);
  assert.ok(check(), 'condition timed out');
}
async function setup(t, options = {}) {
  const directory = options.directory || await mkdtemp(path.join(os.tmpdir(), 'imageboard-chat-'));
  const token = randomBytes(32).toString('hex');
  const app = await createServer({ directory, accessToken: token, configLoader: async () => config,
    generate: async () => ({ image: PNG }), refine: async () => { throw new Error('Chat must not invoke prompt model'); }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const runtime = { origin, token, pid: process.pid };
  await writeFile(path.join(directory, 'native-runtime.json'), JSON.stringify(runtime));
  const bridge = createBridge({ runtimeLoader: async () => runtime });
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    app.conversations.close(); app.jobs.close(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await until(() => app.jobs.controllers.size === 0);
    await app.jobs.writeQueue; await app.conversations.writeQueue;
  };
  t.after(async () => { await stop(); if (!options.directory) await rm(directory, { recursive: true, force: true }); });
  return { ...app, directory, origin, token, bridge, chat: createChatTools({ bridge }), stop };
}
async function client(t, directory) {
  const client = new Client({ name: 'imageboard-chat-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['server/mcp.mjs'], env: { ...process.env, IMAGEBOARD_DATA_DIR: directory }, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

test('stdio chat tools generate through the image API once, display a bounded preview, and save original work', async t => {
  let requests = 0;
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.url, '/images/generations');
    assert.equal(req.headers.authorization, 'Bearer private-test-secret');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    assert.equal(input.model, 'test-image'); assert.equal(input.quality, 'high'); assert.equal(input.n, 1);
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const app = await setup(t, { generate: undefined, configLoader: async () => ({ ...config, promptError: 'No text API', baseUrl: `http://127.0.0.1:${gateway.address().port}` }) });
  const first = await client(t, app.directory), second = await client(t, app.directory), input = draft();
  const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).callTool({ name: 'generate_image', arguments: input })));
  assert.ok(replies.every(r => !r.isError && r.structuredContent.jobId === input.requestId));
  const finished = await first.callTool({ name: 'get_generation', arguments: { jobId: input.requestId, waitSeconds: 20 } });
  assert.equal(finished.structuredContent.status, 'completed'); assert.equal(requests, 1);
  const image = finished.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/webp');
  const preview = await sharp(Buffer.from(image.data, 'base64')).metadata();
  assert.equal(preview.width, 1024); assert.equal(preview.height, 576);
  const asset = finished.structuredContent.images[0];
  assert.ok(path.isAbsolute(asset.path)); assert.equal((await sharp(await readFile(asset.path)).metadata()).width, 1280);
  const saved = JSON.parse(await readFile(path.join(app.directory, 'jobs.json')));
  assert.equal(saved.length, 1); assert.equal(saved[0].id, input.requestId); assert.equal(saved[0].source, 'codex-chat');
  assert.equal(saved[0].outputs[0].id, asset.assetId); assert.equal(saved[0].channelId, 'codex');
  assert.equal(saved[0].imageModel, 'test-image'); assert.equal(saved[0].size, input.size);
  const library = (await app.bridge.request({ route: '/api/jobs' })).json;
  assert.equal(library[0].id, input.requestId);
  const metadata = await second.callTool({ name: 'get_generation', arguments: { jobId: input.requestId, includeImage: false } });
  assert.equal(metadata.content.length, 1); assert.equal(metadata.structuredContent.images[0].assetId, asset.assetId);
  assert.doesNotMatch(JSON.stringify([finished, saved, metadata]), /private-test-secret|Authorization/);
  assert.equal((await first.callTool({ name: 'generate_image', arguments: { ...input, format: 'png', background: 'auto' } })).structuredContent.jobId, input.requestId);
  assert.equal(requests, 1);
});

test('lost creation response recovers using the original request ID without another generation', async t => {
  let generated = 0;
  const app = await setup(t, { generate: async () => { generated++; return { image: PNG }; } });
  const chat = createChatTools({ bridge: { ...app.bridge, request: async args => { await app.bridge.request(args); throw new Error('Connection lost after server accepted'); } } });
  const input = draft(), lost = await chat.generate(input);
  assert.equal(lost.isError, true); assert.equal(lost.structuredContent.jobId, input.requestId);
  const recovered = await app.chat.get({ jobId: input.requestId });
  assert.equal(recovered.structuredContent.status, 'completed');
  assert.equal((await app.chat.generate(input)).structuredContent.jobId, input.requestId);
  assert.equal(generated, 1);
});

test('idempotency survives restart, changed defaults, and interrupted job recovery', async t => {
  let generated = 0;
  const first = await setup(t, { generate: async () => { generated++; return { image: PNG }; } });
  const input = draft(); await first.chat.generate(input);
  const finished = (await first.chat.get({ jobId: input.requestId })).structuredContent;
  await first.stop();
  const restarted = await setup(t, { directory: first.directory, configLoader: async () => ({ error: 'Changed or unavailable config' }), generate: async () => { generated++; throw new Error('Must not regenerate'); } });
  const replay = await restarted.chat.generate(input);
  assert.equal(replay.structuredContent.status, 'completed');
  assert.deepEqual(replay.structuredContent.images, finished.images); assert.equal(generated, 1);
  await restarted.stop();
  const records = JSON.parse(await readFile(path.join(first.directory, 'jobs.json')));
  records[0].status = 'generating'; records[0].outputs = []; delete records[0].imageUrl;
  await writeFile(path.join(first.directory, 'jobs.json'), JSON.stringify(records));
  const interrupted = await setup(t, { directory: first.directory, generate: async () => { generated++; throw new Error('Must not retry'); } });
  const failed = await interrupted.chat.generate(input);
  assert.equal(failed.structuredContent.status, 'failed'); assert.match(failed.structuredContent.error, /服务已重启/);
  assert.equal(generated, 1);
  await interrupted.stop();
});

test('validation, conflicting IDs, missing jobs and trashed works never create replacement images', async t => {
  let generated = 0;
  const app = await setup(t, { generate: async () => { generated++; return { image: PNG }; } });
  const input = draft();
  for (const invalid of [{ ...input, requestId: '../config' }, { ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(8001) }, { ...input, size: null }, { ...input, quality: 'invalid' }, { ...input, format: 'jpeg', background: 'transparent' }, { ...input, baseUrl: 'https://example.test' }, { ...input, references: [] }]) {
    assert.equal((await app.chat.generate(invalid)).isError, true);
  }
  assert.equal(generated, 0); assert.equal(app.jobs.list().length, 0);
  assert.equal((await app.chat.get({ jobId: input.requestId, waitSeconds: 21 })).isError, true);
  assert.equal((await app.chat.get({ jobId: input.requestId })).structuredContent.statusCode, 404);
  await app.chat.generate(input); await app.chat.get({ jobId: input.requestId });
  const conflict = await app.chat.generate({ ...input, prompt: '另一张图片' });
  assert.equal(conflict.structuredContent.statusCode, 409);
  await app.jobs.manage(input.requestId, { deleted: true });
  assert.equal((await app.chat.generate(input)).structuredContent.statusCode, 404);
  assert.equal((await app.chat.get({ jobId: input.requestId })).structuredContent.statusCode, 404);
  assert.equal(generated, 1);
  const studio = await app.jobs.create({ prompt: 'studio', optimize: false });
  await until(() => app.jobs.controllers.size === 0);
  assert.equal((await app.chat.generate({ ...input, requestId: studio.id })).structuredContent.statusCode, 409);
  assert.equal((await app.chat.get({ jobId: studio.id })).structuredContent.statusCode, 404);
});

test('failed generation keeps its error and cannot be restarted by replaying the request', async t => {
  let attempts = 0;
  const app = await setup(t, { generate: async () => { attempts++; throw new ProviderError('测试图片渠道不可用', 502); } });
  const input = draft(); await app.chat.generate(input);
  const result = await app.chat.get({ jobId: input.requestId });
  assert.equal(result.structuredContent.status, 'failed'); assert.match(result.structuredContent.error, /渠道不可用/);
  assert.equal((await app.chat.generate(input)).structuredContent.status, 'failed'); assert.equal(attempts, 1);
});

test('busy service rejects new work while long polling is bounded and disconnects cleanly', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const app = await setup(t, { generate: (_config, _prompt, { signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ image: PNG }); started();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const input = draft(); await app.chat.generate(input); await entered;
  assert.equal((await app.chat.generate(draft())).structuredContent.statusCode, 409);
  assert.equal((await app.chat.generate(input)).structuredContent.jobId, input.requestId);
  const beginning = Date.now();
  const waiting = await app.chat.get({ jobId: input.requestId, waitSeconds: 1 });
  assert.equal(waiting.structuredContent.status, 'generating'); assert.ok(Date.now() - beginning < 3000);
  const baseline = app.jobs.listenerCount('change'), controller = new AbortController();
  const disconnected = fetch(`${app.origin}/api/chat/generations/${input.requestId}?waitSeconds=20`, { headers: { Authorization: `Bearer ${app.token}` }, signal: controller.signal }).catch(error => error);
  await until(() => app.jobs.listenerCount('change') > baseline);
  controller.abort(); await disconnected;
  await until(() => app.jobs.listenerCount('change') === baseline);
  const completion = app.chat.get({ jobId: input.requestId });
  release(); assert.equal((await completion).structuredContent.status, 'completed');
});

test('failed durable acceptance starts no paid work and permits an unchanged retry', async t => {
  let generated = 0;
  const app = await setup(t, { generate: async () => { generated++; return { image: PNG }; } });
  const persist = app.jobs.persist.bind(app.jobs), input = draft();
  app.jobs.persist = async () => { throw new Error('Disk full'); };
  assert.equal((await app.chat.generate(input)).structuredContent.statusCode, 500);
  assert.equal(generated, 0); assert.equal(app.jobs.get(input.requestId), undefined);
  app.jobs.persist = persist;
  assert.equal((await app.chat.generate(input)).structuredContent.jobId, input.requestId);
  assert.equal((await app.chat.get({ jobId: input.requestId })).structuredContent.status, 'completed');
  assert.equal(generated, 1);
});

test('preview read failure preserves the completed result and original path', async t => {
  const app = await setup(t), input = draft();
  await app.chat.generate(input); await app.chat.get({ jobId: input.requestId, includeImage: false });
  const chat = createChatTools({ bridge: { ...app.bridge, request: args => {
    if (args.route.startsWith('/api/assets/')) throw new Error('Temporary transfer failure');
    return app.bridge.request(args);
  } } });
  const result = await chat.get({ jobId: input.requestId });
  assert.equal(result.structuredContent.status, 'completed'); assert.ok(result.structuredContent.previewError);
  assert.ok((await readFile(result.structuredContent.images[0].path)).length > 0);
  assert.equal((await app.chat.get({ jobId: input.requestId })).content[1].type, 'image');
});

test('an old runtime asks for an upgrade instead of reporting a missing generation', async () => {
  let requests = 0;
  const chat = createChatTools({ bridge: { request: async () => { requests++; return { status: 404, json: { error: '页面不存在。' } }; } } });
  const input = draft();
  for (const result of [await chat.generate(input), await chat.get({ jobId: input.requestId })]) {
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, 'service_upgrade_required');
  }
  assert.equal(requests, 2);
});
