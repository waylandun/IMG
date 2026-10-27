import { readFile } from 'node:fs/promises';
import path from 'node:path';

// A sandboxed about:blank document avoids Electron's prohibition on HTTP frames.
// Only the local, short-lived capability goes into this document; never provider credentials.
export async function embeddedDocument(root, origin, capability) {
  const [html, css, app, editor, theme, referenceEditor, configPanel] = await Promise.all([
    readFile(path.join(root, 'web/index.html'), 'utf8'),
    readFile(path.join(root, 'web/style.css'), 'utf8'),
    readFile(path.join(root, 'web/app.js'), 'utf8'),
    readFile(path.join(root, 'web/editor.js'), 'utf8'),
    readFile(path.join(root, 'web/theme.js'), 'utf8'),
    readFile(path.join(root, 'web/reference-editor.js'), 'utf8'),
    readFile(path.join(root, 'web/config-panel.js'), 'utf8'),
  ]);
  const js = `${theme.replace('export function initTheme', 'function initTheme')}\n${editor.replace('export function createEditor', 'function createEditor')}\n${referenceEditor.replace('export function createReferenceEditor', 'function createReferenceEditor')}\n${configPanel.replace('export function createConfigPanel', 'function createConfigPanel')}\n${app.replace("import { createEditor } from './editor.js';", '').replace("import { initTheme } from './theme.js';", '').replace("import { createReferenceEditor } from './reference-editor.js';", '').replace("import { createConfigPanel } from './config-panel.js';", '')}`;
  const bootstrap = JSON.stringify({ origin, capability }).replace(/</g, '\\u003c');
  return html
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">window.__IMAGEBOARD_EMBED__=${bootstrap};\n${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

export async function mcpDocument(root) {
  const [html, css, app, editor, bridge, theme, referenceEditor, configPanel] = await Promise.all(['web/index.html', 'web/style.css', 'web/app.js', 'web/editor.js', 'web/mcp-client.js', 'web/theme.js', 'web/reference-editor.js', 'web/config-panel.js'].map(file => readFile(path.join(root, file), 'utf8')));
  const js = `${bridge}\n${theme.replace('export function initTheme', 'function initTheme')}\n${editor.replace('export function createEditor', 'function createEditor')}\n${referenceEditor.replace('export function createReferenceEditor', 'function createReferenceEditor')}\n${configPanel.replace('export function createConfigPanel', 'function createConfigPanel')}\n${app.replace("import { createEditor } from './editor.js';", '').replace("import { initTheme } from './theme.js';", '').replace("import { createReferenceEditor } from './reference-editor.js';", '').replace("import { createConfigPanel } from './config-panel.js';", '')}`;
  return html.replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

export async function generationDocument(root) {
  const [html, css, bridge, card] = await Promise.all(['web/generation-card.html', 'web/generation-card.css', 'web/mcp-client.js', 'web/generation-card.js'].map(file => readFile(path.join(root, file), 'utf8')));
  const js = `window.__IMAGEBOARD_VIEW__='generation';\n${bridge}\n${card}`;
  return html.replace('<link rel="stylesheet" href="/generation-card.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="/generation-card.js"></script>', () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}
