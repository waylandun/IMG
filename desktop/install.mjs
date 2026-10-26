import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { installChatSkill } from './skill.mjs';

const BEGIN = '# BEGIN Imageboard native MCP (managed)', END = '# END Imageboard native MCP';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
function managedSections(text) {
  const headers = [], begins = [], ends = [];
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const trimmed = line.trim();
    if (trimmed === BEGIN || trimmed === END || /^\[.*\]\s*(?:#.*)?$/.test(trimmed)) {
      // A header/marker-looking line inside a multiline string or array is
      // data, not a TOML boundary. Only a complete prefix ends a statement.
      let boundary = true;
      try { parse(text.slice(0, offset)); } catch { boundary = false; }
      if (boundary) {
        if (trimmed === BEGIN) begins.push({ start: offset, end: offset + line.length });
        else if (trimmed === END) ends.push({ start: offset, end: offset + line.length });
        else {
          const table = parse(`${line}\n__imageboard_section_probe__ = true\n`);
          headers.push({ start: offset, owned: !!table.mcp_servers?.imageboard });
        }
      }
    }
    offset += line.length;
  }
  if (begins.length !== ends.length || begins.length > 1 || (begins.length && ends[0].start < begins[0].start)) throw new Error('Imageboard 配置块不完整，请先修复 config.toml。');
  if (!begins.length) return null;
  // Codex may insert other MCP tables between our marker comments. Remove
  // only Imageboard's actual tables, never the entire comment-delimited span.
  const ranges = [...begins, ...ends, ...headers.flatMap((header, index) => header.owned ? [{ start: header.start, end: headers[index + 1]?.start ?? text.length }] : [])].sort((a, b) => a.start - b.start);
  let result = '', cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) result += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  return result + text.slice(cursor);
}
export function mcpConfiguration({ executable, root, directory }) {
  if (![executable, root, directory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('安装路径必须为绝对路径。');
  const quote = JSON.stringify;
  return `${BEGIN}\n[mcp_servers.imageboard]\ncommand = ${quote(executable)}\nargs = [${quote(path.join(root, 'server/mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n\n[mcp_servers.imageboard.env]\nELECTRON_RUN_AS_NODE = "1"\nIMAGEBOARD_DATA_DIR = ${quote(directory)}\nIMAGEBOARD_INSTALLATION = "native-v1"\nIMAGEBOARD_VERSION = ${quote(version)}\n${END}\n`;
}
export function updateConfiguration(text, settings, remove = false) {
  const current = parse(text || '');
  const managed = managedSections(text);
  if (managed === null && current.mcp_servers?.imageboard) throw new Error('已有名为 imageboard 的手动 MCP 配置，请先在 Codex 设置中移除该条目。');
  const rest = managed ?? text;
  const result = remove ? rest : `${rest.replace(/\s*$/, '')}\n\n${mcpConfiguration(settings)}`.replace(/^\n+/, '');
  parse(result); return result;
}
export async function installNative(settings, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), remove = false } = {}) {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const file = path.join(codexHome, 'config.toml');
  const original = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const updated = updateConfiguration(original, settings, remove);
  if (updated === original) return { file, changed: false, skill: await installChatSkill(codexHome, { remove }) };
  const backupDirectory = path.join(codexHome, 'imageboard-backups');
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if (original) await writeFile(path.join(backupDirectory, `config-${Date.now()}-${randomUUID()}.toml`), original, { mode: 0o600 });
  const latest = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (latest !== original) throw new Error('Codex 配置正在变化，请重新运行安装。');
  const temporary = `${file}.imageboard-${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { mode: 0o600 }); await rename(temporary, file);
  return { file, changed: true, skill: await installChatSkill(codexHome, { remove }) };
}
