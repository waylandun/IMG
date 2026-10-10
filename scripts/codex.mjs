import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNative } from '../desktop/install.mjs';
import { dataDirectory } from '../server/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await installNative({ executable: process.execPath, root, directory: dataDirectory() }, { remove: process.argv.includes('--uninstall') });
console.log(process.argv.includes('--uninstall')
  ? '已移除 Imageboard MCP 配置，作品保留。'
  : '已注册 Imageboard 原生侧栏应用。重新打开 Codex，在左侧「更多」中固定 Imageboard。无需先启动 Imageboard。');
