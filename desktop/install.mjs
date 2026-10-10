import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';

const BEGIN = '# BEGIN Imageboard native MCP (managed)', END = '# END Imageboard native MCP';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export function mcpConfiguration({ executable, root, directory }) {
  if (![executable, root, directory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('安装路径必须为绝对路径。');
  const quote = JSON.stringify;
  return `${BEGIN}\n[mcp_servers.imageboard]\ncommand = ${quote(executable)}\nargs = [${quote(path.join(root, 'server/mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n\n[mcp_servers.imageboard.env]\nELECTRON_RUN_AS_NODE = "1"\nIMAGEBOARD_DATA_DIR = ${quote(directory)}\nIMAGEBOARD_INSTALLATION = "native-v1"\nIMAGEBOARD_VERSION = ${quote(version)}\n${END}\n`;
}
export function updateConfiguration(text, settings, remove = false) {
  const current = parse(text || '');
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Imageboard 配置块不完整，请先修复 config.toml。');
  if (start < 0 && current.mcp_servers?.imageboard) throw new Error('已有名为 imageboard 的手动 MCP 配置，请先在 Codex 设置中移除该条目。');
  const rest = start >= 0 ? text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, '') : text;
  const result = remove ? rest : `${rest.replace(/\s*$/, '')}\n\n${mcpConfiguration(settings)}`.replace(/^\n+/, '');
  parse(result); return result;
}
export async function installNative(settings, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), remove = false } = {}) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const file = path.join(codexHome, 'config.toml');
  const original = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const updated = updateConfiguration(original, settings, remove);
  if (updated === original) return { file, changed: false };
  const backupDirectory = path.join(codexHome, 'imageboard-backups');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if (original) await writeFile(path.join(backupDirectory, `config-${Date.now()}-${randomUUID()}.toml`), original, { mode: 0o600 });
  const latest = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (latest !== original) throw new Error('Codex 配置正在变化，请重新运行安装。');
  const temporary = `${file}.imageboard-${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { mode: 0o600 }); await rename(temporary, file);
  return { file, changed: true };
}
