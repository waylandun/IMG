import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, IMAGE_MODEL } from '../server/config.mjs';

async function fixture(t, config, auth = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'imageboard-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'config.toml'), config);
  await writeFile(path.join(home, 'auth.json'), JSON.stringify(auth));
  return home;
}

test('reads the selected provider and keeps credentials out of public config', async t => {
  const home = await fixture(t, 'model="my-default-model"\nmodel_provider="gateway"\n[model_providers.gateway]\nbase_url="https://example.test/v1"\nexperimental_bearer_token="private-test-key"');
  const config = await loadConfig({ env: { CODEX_HOME: home } });
  assert.equal(config.model, 'my-default-model');
  assert.equal(config.imageModel, IMAGE_MODEL);
  assert.equal(config.headers.Authorization, 'Bearer private-test-key');
  assert.equal(config.public.ready, true);
  assert.ok(!JSON.stringify(config.public).includes('private-test-key'));
});

test('explicit env_key does not silently fall back to another provider credential', async t => {
  const home = await fixture(t, 'model="m"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="https://example.test"\nenv_key="MY_KEY"\nrequires_openai_auth=true', { OPENAI_API_KEY: 'wrong-provider-secret' });
  const config = await loadConfig({ env: { CODEX_HOME: home, OPENAI_API_KEY: 'also-wrong' } });
  assert.equal(config.public.ready, false);
  assert.equal(config.headers.Authorization, undefined);
  assert.match(config.error, /MY_KEY/);
});

test('does not turn ChatGPT OAuth tokens into Images API keys', async t => {
  const home = await fixture(t, 'model="m"', { auth_mode: 'chatgpt', tokens: { access_token: 'oauth-secret' } });
  const config = await loadConfig({ env: { CODEX_HOME: home } });
  assert.equal(config.public.ready, false);
  assert.ok(!JSON.stringify(config).includes('oauth-secret'));
});

test('standalone profile overrides the default model and uses its provider', async t => {
  const home = await fixture(t, 'model="base"\nmodel_provider="openai"');
  await writeFile(path.join(home, 'studio.config.toml'), 'model="profile-model"\nmodel_provider="local"\n[model_providers.local]\nbase_url="http://127.0.0.1:9999/v1"\nenv_key="LOCAL_KEY"\nwire_api="chat"');
  const config = await loadConfig({ env: { CODEX_HOME: home, IMAGEBOARD_CODEX_PROFILE: 'studio', LOCAL_KEY: 'secret' } });
  assert.equal(config.model, 'profile-model');
  assert.equal(config.wireApi, 'chat');
  assert.equal(config.headers.Authorization, 'Bearer secret');
});

test('rejects credentials embedded in URLs and malformed TOML without leaking secrets', async t => {
  const home = await fixture(t, 'model="m"\nopenai_base_url="https://username:secret@example.test/v1"');
  await assert.rejects(loadConfig({ env: { CODEX_HOME: home } }), error => !error.message.includes('secret'));
  await writeFile(path.join(home, 'config.toml'), 'broken secret token = [');
  await assert.rejects(loadConfig({ env: { CODEX_HOME: home } }), /无法读取 config.toml/);
});
