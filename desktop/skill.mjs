import { readFile, mkdir, writeFile, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const files = ['SKILL.md', 'agents/openai.yaml'];
const digest = content => createHash('sha256').update(content).digest('hex');
const read = file => readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
const absent = error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; };

export async function installChatSkill(codexHome, { remove = false } = {}) {
  const directory = path.join(codexHome, 'skills', 'imageboard');
  const marker = path.join(directory, '.imageboard-managed.json');
  const preserved = () => ({ status: 'preserved', path: directory, warning: '已有自定义 Imageboard Skill，已保留；可对照安装目录的 skills/imageboard 手动更新。' });
  for (const relative of ['', 'agents', ...files, '.imageboard-managed.json']) {
    const stat = await lstat(path.join(directory, relative)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) return preserved();
  }
  let previous;
  try { previous = JSON.parse(await read(marker) || 'null'); } catch { return preserved(); }
  if (previous && previous.owner !== 'codex-imageboard') return preserved();
  if (remove) {
    if (!previous) return { status: 'unchanged', path: directory };
    let edited = false;
    for (const file of files) {
      const current = await read(path.join(directory, file));
      if (current === null) continue;
      if (digest(current) === previous.files?.[file]) await unlink(path.join(directory, file));
      else edited = true;
    }
    await unlink(marker);
    await rmdir(path.join(directory, 'agents')).catch(absent);
    await rmdir(directory).catch(absent);
    return edited ? preserved() : { status: 'removed', path: directory };
  }
  const contents = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(new URL(`../skills/imageboard/${file}`, import.meta.url), 'utf8')])));
  const hashes = Object.fromEntries(files.map(file => [file, digest(contents[file])]));
  let changed = !previous || files.some(file => previous.files?.[file] !== hashes[file]);
  for (const file of files) {
    const current = await read(path.join(directory, file));
    if (current !== null && digest(current) !== hashes[file] && digest(current) !== previous?.files?.[file]) return preserved();
    if (current !== contents[file]) changed = true;
  }
  if (!changed) return { status: 'unchanged', path: directory };
  await mkdir(path.join(directory, 'agents'), { recursive: true });
  for (const [file, content] of Object.entries({ ...contents, '.imageboard-managed.json': JSON.stringify({ owner: 'codex-imageboard', files: hashes }) })) {
    const destination = path.join(directory, file), temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(absent); }
  }
  return { status: 'installed', path: directory };
}
