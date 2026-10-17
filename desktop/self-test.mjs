import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { createServer } from '../server/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-packaged-'));
let server, client;
try {
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#aaccec' } }).png().toBuffer();
  let conversationCalls = 0;
  const result = await createServer({ directory, configLoader: async () => ({ model: 'test', imageModel: 'gpt-image-2.5-flare', error: '', public: { ready: true } }), refine: async () => 'test', generate: async () => ({ images: [png] }),
    respond: async () => ++conversationCalls === 1 ? { text: '先聊聊用途。', toolCall: null } : { text: '', toolCall: { id: 'packaged-image-call', name: 'generate_image', arguments: { prompt: 'test conversation image', referenceIds: [], baseImageId: null, size: null, quality: null, count: null, format: null, background: null } } },
  });
  server = result.server; await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upload = await fetch(`${origin}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  if (upload.status !== 201) throw new Error('Packaged image upload failed');
  const asset = await upload.json();
  const created = await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test', optimize: false, count: 2, references: [{ assetId: asset.id }] }) });
  const job = await created.json();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && ['refining', 'generating'].includes(result.jobs.get(job.id)?.status)) await new Promise(resolve => setTimeout(resolve, 50));
  const finished = result.jobs.get(job.id);
  if (finished?.status !== 'completed' || finished.outputs.length !== 2) throw new Error('Packaged generation failed');
  const conversationId = randomUUID();
  for (const prompt of ['先讨论用途', '现在需求已经明确']) {
    const response = await fetch(`${origin}/api/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), prompt }) });
    if (response.status !== 202) throw new Error('Packaged conversation request failed');
    const turnDeadline = Date.now() + 15000;
    while (Date.now() < turnDeadline && result.conversations.isBusy()) await new Promise(resolve => setTimeout(resolve, 25));
    if (result.conversations.isBusy()) throw new Error('Packaged conversation timed out');
  }
  const conversation = result.conversations.get(conversationId);
  if (conversation.turns[0].job || conversation.turns[0].assistant !== '先聊聊用途。' || conversation.turns[1].job?.status !== 'completed') throw new Error('Packaged conversation routing failed');
  const html = await (await fetch(`${origin}/api/embed-document`)).text();
  if (!html.includes('function createEditor')) throw new Error('Packaged UI missing editor');
  client = new Client({ name: 'imageboard-packaged-test', version: '1' });
  const entry = fileURLToPath(new URL('../server/mcp.mjs', import.meta.url));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, IMAGEBOARD_DATA_DIR: directory }, stderr: 'pipe' }));
  const tools = await client.listTools();
  const open = tools.tools.find(tool => tool.name === 'open_imageboard');
  if (open?._meta?.['openai/ui']?.entrypoints?.[0]?.type !== 'global') throw new Error('Packaged native entry missing');
  const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
  if (!resource.contents[0].text.includes('__IMAGEBOARD_MCP__') || !resource.contents[0].text.includes('function renderConversation')) throw new Error('Packaged MCP conversation client missing');
  const health = await (await fetch(`${origin}/api/health`)).json();
  const report = { ok: true, version: health.version, platform: process.platform, arch: process.arch, node: process.versions.node, sharp: sharp.versions.sharp, outputs: finished.outputs.length, conversationTurns: conversation.turns.length, conversationGeneration: true, nativeMcp: true };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (client) await client.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await rm(directory, { recursive: true, force: true }); }
