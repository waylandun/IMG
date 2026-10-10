import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../server/index.mjs';
import { createBridge, CHUNK_SIZE, allowedRequest } from '../server/mcp-bridge.mjs';
import { ensureRuntime } from '../server/runtime.mjs';

test('MCP discovery and resource loading do not start the image service or expose API credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.mjs'], env: { ...process.env, IMAGEBOARD_DATA_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const entry = tools.find(x => x.name === 'open_imageboard');
  assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  assert.ok(tools.filter(x => x !== entry).every(x => x._meta.ui.visibility.join() === 'app'));
  const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.contents[0].text.includes('__IMAGEBOARD_MCP__'));
  assert.ok(resource.contents[0].text.includes('function createEditor'));
  assert.equal((resource.contents[0].text.match(/<script\b/g) || []).length, 1);
  assert.equal((resource.contents[0].text.match(/<\/script>/g) || []).length, 1);
  assert.ok(!resource.contents[0].text.includes('127.0.0.1:'));
  await client.callTool({ name: entry.name, arguments: {} });
  await assert.rejects(access(path.join(directory, 'native-runtime.json')));
  await assert.rejects(access(path.join(directory, 'jobs.json')));
});

test('MCP bridge transfers real images in bounded chunks and reuses existing image operations', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-bridge-'));
  const png = await sharp(randomBytes(384 * 384 * 3), { raw: { width: 384, height: 384, channels: 3 } }).png().toBuffer();
  const { server, jobs } = await createServer({ directory, accessToken: 'test-token', configLoader: async () => ({ public: { ready: true } }), generate: async () => ({ images: [png] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`${origin}/api/jobs`)).status, 403);
  const bridge = createBridge({ runtimeLoader: async () => ({ origin, token: 'test-token' }) });
  assert.equal((await bridge.request({ route: '/api/config' })).json.ready, true);
  assert.ok(png.length > CHUNK_SIZE);
  const upload = await bridge.transfer({ action: 'begin_upload', type: 'image/png', size: png.length, name: 'reference.png' });
  await assert.rejects(bridge.transfer({ action: 'finish_upload', id: upload.id }), /完整/);
  await assert.rejects(bridge.transfer({ action: 'upload_chunk', id: upload.id, offset: 1, data: png.toString('base64') }), /片段/);
  for (let offset = 0; offset < png.length; offset += CHUNK_SIZE) await bridge.transfer({ action: 'upload_chunk', id: upload.id, offset, data: png.subarray(offset, offset + CHUNK_SIZE).toString('base64') });
  const asset = (await bridge.transfer({ action: 'finish_upload', id: upload.id })).json;
  const binary = (await bridge.request({ route: asset.url })).binary;
  let offset = 0; const chunks = [];
  while (offset < binary.size) {
    const part = await bridge.transfer({ action: 'read_chunk', id: binary.id, offset });
    chunks.push(Buffer.from(part.data, 'base64')); assert.ok(part.nextOffset > offset); offset = part.nextOffset;
  }
  assert.equal((await sharp(Buffer.concat(chunks)).metadata()).width, 384);
  await bridge.transfer({ action: 'release', id: binary.id });
  await assert.rejects(bridge.transfer({ action: 'read_chunk', id: binary.id, offset: 0 }), /过期/);
  const job = (await bridge.request({ method: 'POST', route: '/api/jobs', body: { prompt: 'test', optimize: false, references: [{ assetId: asset.id }] } })).json;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && ['refining', 'generating'].includes(jobs.get(job.id)?.status)) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(jobs.get(job.id).status, 'completed');
  assert.equal((await bridge.request({ method: 'PATCH', route: `/api/jobs/${job.id}`, body: { title: 'Saved work' } })).json.title, 'Saved work');
  for (const route of ['https://example.test', '/api/embed-document', '/api/health', '/api/../config', '//example.test', '/api/jobs?secret=1']) assert.equal(allowedRequest('GET', route), false);
});

test('simultaneous native clients share a single lazy authenticated service', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-runtime-')); let runtime;
  t.after(async () => { if (runtime) process.kill(runtime.pid, 'SIGTERM'); await rm(directory, { recursive: true, force: true }); });
  const clients = await Promise.all([ensureRuntime(directory), ensureRuntime(directory), ensureRuntime(directory)]);
  runtime = clients[0]; assert.ok(clients.every(x => x.pid === runtime.pid && x.origin === runtime.origin));
  assert.equal((await fetch(`${runtime.origin}/api/health`)).status, 403);
  const health = await fetch(`${runtime.origin}/api/health`, { headers: { Authorization: `Bearer ${runtime.token}` } }).then(r => r.json());
  assert.equal(health.native, true);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'native-runtime.json'))).pid, runtime.pid);
});
