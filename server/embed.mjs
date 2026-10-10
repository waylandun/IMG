import { readFile } from 'node:fs/promises';
import path from 'node:path';

// A sandboxed about:blank document avoids Electron's prohibition on HTTP frames.
// Only the local, short-lived capability goes into this document; never provider credentials.
export async function embeddedDocument(root, origin, capability) {
  const [html, css, app, editor, theme] = await Promise.all([
    readFile(path.join(root, 'web/index.html'), 'utf8'),
    readFile(path.join(root, 'web/style.css'), 'utf8'),
    readFile(path.join(root, 'web/app.js'), 'utf8'),
    readFile(path.join(root, 'web/editor.js'), 'utf8'),
    readFile(path.join(root, 'web/theme.js'), 'utf8'),
  ]);
  const js = `${theme.replace('export function initTheme', 'function initTheme')}\n${editor.replace('export function createEditor', 'function createEditor')}\n${app.replace("import { createEditor } from './editor.js';", '').replace("import { initTheme } from './theme.js';", '')}`;
  const bootstrap = JSON.stringify({ origin, capability }).replace(/</g, '\\u003c');
  return html
    .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">window.__IMAGEBOARD_EMBED__=${bootstrap};\n${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

export async function mcpDocument(root) {
  const [html, css, app, editor, bridge, theme] = await Promise.all(['web/index.html', 'web/style.css', 'web/app.js', 'web/editor.js', 'web/mcp-client.js', 'web/theme.js'].map(file => readFile(path.join(root, file), 'utf8')));
  const js = `${bridge}\n${theme.replace('export function initTheme', 'function initTheme')}\n${editor.replace('export function createEditor', 'function createEditor')}\n${app.replace("import { createEditor } from './editor.js';", '').replace("import { initTheme } from './theme.js';", '')}`;
  return html.replace('<link rel="stylesheet" href="/style.css">', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}
