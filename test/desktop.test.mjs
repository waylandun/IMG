import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { updateConfiguration, installNative } from '../desktop/install.mjs';
import { parse } from 'smol-toml';
import data from '../desktop/data.cjs';

const settings = { executable: path.resolve('App Space/Imageboard'), root: path.resolve('App Space/resources/app'), directory: path.resolve('User Space/data') };
test('native install preserves provider secrets and comments, is repeatable, and removes only its own block', () => {
  const original = '# my config\nmodel = "my-model"\n[model_providers.gateway]\nbase_url = "https://example.test" # keep\nexperimental_bearer_token = "fake-secret"\n';
  const once = updateConfiguration(original, settings);
  assert.ok(once.startsWith(original));
  assert.equal(updateConfiguration(once, settings), once);
  const configured = parse(once);
  assert.equal(configured.model_providers.gateway.experimental_bearer_token, 'fake-secret');
  assert.equal(configured.mcp_servers.imageboard.command, settings.executable);
  assert.deepEqual(configured.mcp_servers.imageboard.args, [path.join(settings.root, 'server/mcp.mjs')]);
  assert.equal(configured.mcp_servers.imageboard.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(parse(updateConfiguration(once, settings, true)), parse(original));
  assert.throws(() => updateConfiguration('[mcp_servers.imageboard]\ncommand="custom"', settings), /手动/);
  assert.throws(() => updateConfiguration('# BEGIN Imageboard native MCP (managed)\n', settings), /不完整/);
});
test('native install backs up and writes valid user configuration without touching works', async t => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'imageboard-install-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  await writeFile(path.join(codexHome, 'config.toml'), 'model="test"\n');
  assert.equal((await installNative(settings, { codexHome })).changed, true);
  assert.equal((await installNative(settings, { codexHome })).changed, false);
  assert.equal(parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).model, 'test');
  await installNative(settings, { codexHome, remove: true });
  assert.equal(parse(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).mcp_servers, undefined);
});

test('development import preserves works and excludes config, profiles and symlinks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imageboard-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'dest'), id = randomUUID();
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await mkdir(path.join(source, 'codex-profile')); await writeFile(path.join(source, 'codex-profile/private.txt'), 'do not copy');
  await writeFile(path.join(source, 'auth.json'), 'do not copy');
  await writeFile(path.join(source, 'jobs.json'), JSON.stringify([{ id, prompt: 'test' }]));
  await writeFile(path.join(source, 'assets', `${id}.png`), 'test bytes');
  if (process.platform !== 'win32') await symlink(path.join(source, 'auth.json'), path.join(source, 'assets', 'secret.json'));
  assert.equal(await data.importDevelopmentData(source, destination), 1);
  assert.equal(await readFile(path.join(destination, 'assets', `${id}.png`), 'utf8'), 'test bytes');
  await assert.rejects(access(path.join(destination, 'auth.json')));
  await assert.rejects(access(path.join(destination, 'codex-profile')));
  await assert.rejects(access(path.join(destination, 'assets', 'secret.json')));
  await assert.rejects(data.importDevelopmentData(source, destination), /已有作品/);
  assert.equal(JSON.parse(await readFile(path.join(source, 'jobs.json'), 'utf8'))[0].id, id);
});
