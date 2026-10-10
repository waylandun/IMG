import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { configureCertificateTrust, connectionErrorMessage } from '../server/network.mjs';
import { requestProvider } from '../server/provider.mjs';

test('OS trust fixes HTTPS without accepting untrusted certificates or mismatched hostnames', async t => {
  const [key, cert] = await Promise.all(['localhost-test-key.pem', 'localhost-test-cert.pem'].map(file => readFile(new URL(`fixtures/${file}`, import.meta.url))));
  let requests = 0;
  const server = https.createServer({ key, cert }, (_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = tls.getCACertificates('default');
  t.after(async () => { tls.setDefaultCACertificates(original); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const config = { baseUrl: `https://localhost:${server.address().port}`, headers: {} };
  await assert.rejects(requestProvider(config, 'responses', {}), /证书/);
  assert.equal(requests, 0);
  // A private test-only root stands in for a certificate already trusted by the OS.
  configureCertificateTrust({ getCACertificates: type => type === 'system' ? [cert.toString()] : original, setDefaultCACertificates: tls.setDefaultCACertificates });
  assert.ok(original.every(certificate => tls.getCACertificates('default').includes(certificate)));
  const response = await requestProvider(config, 'responses', {});
  assert.equal(response.status, 200); await response.body.cancel();
  config.baseUrl = config.baseUrl.replace('localhost', '127.0.0.1');
  await assert.rejects(requestProvider(config, 'responses', {}), /证书/);
  assert.equal(requests, 1);
});

test('connection errors distinguish network failures without exposing upstream messages', () => {
  for (const [code, expected] of [['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /证书/], ['ENOTFOUND', /解析/], ['ECONNREFUSED', /拒绝连接/], ['UND_ERR_CONNECT_TIMEOUT', /超时/]]) {
    const message = connectionErrorMessage(new TypeError('fetch failed', { cause: Object.assign(new Error('Bearer secret-value https://private.example'), { code }) }));
    assert.match(message, expected); assert.doesNotMatch(message, /secret-value|private\.example/);
  }
});
