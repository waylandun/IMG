import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNative } from '../desktop/install.mjs';
import { dataDirectory } from '../server/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await installNative({ executable: process.execPath, root, directory: dataDirectory() }, { remove: process.argv.includes('--uninstall') });
if (result.skill.warning) console.warn(result.skill.warning);
console.log(process.argv.includes('--uninstall')
  ? '已移除 Imageboard MCP 配置及未修改的配套 Skill，作品保留。'
  : '已注册 Imageboard 聊天生图工具及侧栏应用。重新打开 Codex 后可说“用 Imageboard 生成一张图片”，也可在左侧「更多」中固定工作室。');
