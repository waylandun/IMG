import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const script = await readFile(new URL('../inject/imageboard.js', import.meta.url), 'utf8');

function createHost() {
  const events = new Map();
  const nodes = [];
  const element = tag => {
    const node = {
      tag, children: [], hidden: false, contentWindow: tag === 'iframe' ? {} : undefined,
      style: { setProperty() {} },
      setAttribute() {}, removeAttribute() {},
      append(...children) { this.children.push(...children); },
      remove() { this.removed = true; },
    };
    nodes.push(node);
    return node;
  };
  const document = {
    readyState: 'complete', body: element('body'), documentElement: {},
    querySelector: () => null, querySelectorAll: () => [], createElement: element,
    addEventListener() {}, removeEventListener() {},
  };
  const window = {
    addEventListener(type, callback) { events.set(type, callback); },
    removeEventListener(type) { events.delete(type); },
  };
  vm.runInNewContext(script, {
    document, window, crypto: { randomUUID },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout,
  });
  window.__codexImageboard__.open();
  return { window, nodes, message: event => events.get('message')(event), frame: nodes.find(node => node.tag === 'iframe'), panel: nodes.find(node => node.tag === 'section') };
}

test('only the owned opaque-origin iframe can mark ready or close the panel', () => {
  const host = createHost();
  for (const event of [
    { source: {}, origin: 'null' },
    { source: host.frame.contentWindow, origin: 'https://other.example' },
    { source: null, origin: 'null' },
  ]) {
    host.message({ ...event, data: { type: 'codex-imageboard-ready' } });
    assert.equal(host.window.__codexImageboard__.ready, false);
    host.message({ ...event, data: { type: 'codex-imageboard-close' } });
    assert.equal(host.panel.hidden, false);
  }
  host.message({ source: host.frame.contentWindow, origin: 'null', data: { type: 'codex-imageboard-ready' } });
  assert.equal(host.window.__codexImageboard__.ready, true);
  host.message({ source: host.frame.contentWindow, origin: 'null', data: { type: 'codex-imageboard-close' } });
  assert.equal(host.panel.hidden, true);
  host.window.__codexImageboard__.open();
  assert.equal(host.panel.hidden, false);
  host.window.__codexImageboard__.destroy();
});
