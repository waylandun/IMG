import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { createServer } from '../server/index.mjs';
import { isActive } from '../server/jobs.mjs';

const PNG = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#598dba' } }).png().toBuffer();
const config = { model: 'default-model', imageModel: 'gpt-image-2.5-flare', headers: { Authorization: 'Bearer private-key' }, error: '', public: { ready: true, model: 'default-model', imageModel: 'gpt-image-2.5-flare' } };
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-test-'));
  const { server, jobs } = await createServer({ directory, configLoader: async () => config, refine: async () => 'refined prompt', generate: async () => ({ image: PNG }), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { jobs.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await jobs.writeQueue; await rm(directory, { recursive: true, force: true }); });
  const post = (route, body, headers = {}) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { origin, post, jobs, directory };
}
async function terminal(jobs, id) {
  if (!isActive(jobs.get(id))) return jobs.get(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test job timed out')), 3000);
    function change(job) { if (job.id === id && !isActive(job)) { clearTimeout(timer); jobs.off('change', change); resolve(job); } }
    jobs.on('change', change);
  });
}

test('full lifecycle persists a picture, supports download and never stores credentials', async t => {
  const { origin, post, jobs, directory } = await setup(t);
  const created = await post('/api/jobs', { prompt: 'blue building', size: '1024x1024', quality: 'low' });
  assert.equal(created.status, 202);
  const job = await terminal(jobs, (await created.json()).id);
  assert.equal(job.status, 'completed');
  const image = await fetch(origin + job.imageUrl + '?download=1');
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const saved = await readFile(path.join(directory, 'jobs.json'), 'utf8');
  assert.ok(!saved.includes('private-key'));
  const publicConfig = await (await fetch(origin + '/api/config')).text();
  assert.ok(!publicConfig.includes('private-key'));
  const stream = await (await fetch(`${origin}/api/jobs/${job.id}/events`)).text();
  assert.match(stream, /completed/);
});

test('prompt preview does not call image API; edited prompt bypasses text model', async t => {
  let refinements = 0, images = 0;
  const { post, jobs } = await setup(t, { refine: async () => { refinements++; return 'preview'; }, generate: async (_config, prompt) => { images++; assert.equal(prompt, 'my edit'); return { image: PNG }; } });
  const first = await (await post('/api/jobs', { prompt: 'idea', mode: 'refine' })).json();
  assert.equal((await terminal(jobs, first.id)).status, 'prepared');
  assert.equal(images, 0);
  const second = await (await post('/api/jobs', { prompt: 'idea', refinedPrompt: 'my edit' })).json();
  assert.equal((await terminal(jobs, second.id)).status, 'completed');
  assert.equal(refinements, 1); assert.equal(images, 1);
});

test('cancelling prompt conversion prevents image generation and rejects concurrent tasks', async t => {
  let images = 0;
  const { post, jobs } = await setup(t, {
    refine: (_config, _prompt, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    generate: async () => { images++; return { image: PNG }; },
  });
  const job = await (await post('/api/jobs', { prompt: 'slow' })).json();
  assert.equal((await post('/api/jobs', { prompt: 'second' })).status, 409);
  await post(`/api/jobs/${job.id}/cancel`, {});
  assert.equal((await terminal(jobs, job.id)).status, 'cancelled');
  assert.equal(images, 0);
});

test('blocks cross-site requests, DNS rebinding and invalid parameters', async t => {
  const { post, origin } = await setup(t);
  assert.equal((await post('/api/jobs', { prompt: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/config', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await post('/api/jobs', { prompt: 'x', size: '999999x999999' })).status, 400);
  assert.equal((await post('/api/jobs', { prompt: '' })).status, 400);
});

test('restarting marks interrupted generations failed rather than resubmitting', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imageboard-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'jobs.json'), JSON.stringify([{ id: 'old-job', createdAt: new Date().toISOString(), status: 'generating' }]));
  const { jobs } = await createServer({ directory, configLoader: async () => config });
  assert.equal(jobs.get('old-job').status, 'failed');
  assert.match(jobs.get('old-job').error, /中断/);
});

test('isolated embedded document is self-contained and requires its capability for API access', async t => {
  const { origin, post, jobs } = await setup(t);
  const document = await (await fetch(origin + '/api/embed-document')).text();
  assert.ok(document.includes('<style>'));
  assert.ok(!document.includes('src="/app.js"'));
  assert.ok(!document.includes('href="/style.css"'));
  assert.ok(!document.includes('private-key'));
  const match = document.match(/window\.__IMAGEBOARD_EMBED__=(\{[^\n]+?\});/);
  assert.ok(match);
  const { capability } = JSON.parse(match[1]);
  const headers = { Origin: 'null', 'X-Imageboard-Embed': capability };
  const allowed = await fetch(origin + '/api/config', { headers });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'null');
  assert.equal((await fetch(origin + '/api/config', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await fetch(origin + '/api/config', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/api/embed-document', { headers })).status, 403);
  const preflight = await fetch(origin + '/api/jobs', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'content-type,x-imageboard-embed' } });
  assert.equal(preflight.status, 204);
  const created = await (await post('/api/jobs', { prompt: 'embedded image' }, headers)).json();
  const finished = await terminal(jobs, created.id);
  assert.equal(finished.status, 'completed');
  assert.equal((await fetch(origin + finished.imageUrl, { headers })).status, 200);
});

test('uploads binary references from the isolated frame and protects metadata writes', async t => {
  const { origin, jobs } = await setup(t);
  const document = await (await fetch(origin + '/api/embed-document')).text();
  const { capability } = JSON.parse(document.match(/window\.__IMAGEBOARD_EMBED__=(\{[^\n]+?\});/)[1]);
  const headers = { Origin: 'null', 'X-Imageboard-Embed': capability, 'Content-Type': 'image/png', 'X-Imageboard-Filename': encodeURIComponent('参考图.png') };
  const uploaded = await fetch(origin + '/api/assets', { method: 'POST', headers, body: PNG });
  assert.equal(uploaded.status, 201); assert.equal(uploaded.headers.get('access-control-allow-origin'), 'null');
  const asset = await uploaded.json(); assert.equal(asset.name, '参考图.png'); assert.equal(asset.width, 16);
  const forged = await fetch(origin + '/api/assets', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: PNG });
  assert.equal(forged.status, 403);
  const job = await jobs.create({ prompt: 'test', optimize: false }); await terminal(jobs, job.id);
  const updated = await fetch(`${origin}/api/jobs/${job.id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '新名称', favorite: true }) });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).favorite, true);
  const noToken = await fetch(`${origin}/api/jobs/${job.id}`, { method: 'PATCH', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'bad' }) });
  assert.equal(noToken.status, 403);
});
