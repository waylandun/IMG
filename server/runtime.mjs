import { spawn } from 'node:child_process';
import { readFile, mkdir, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function dataDirectory(env = process.env, platform = process.platform) {
  if (env.IMAGEBOARD_DATA_DIR) return path.resolve(env.IMAGEBOARD_DATA_DIR);
  const base = platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
    : platform === 'win32' ? env.APPDATA || path.join(os.homedir(), 'AppData/Roaming') : env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(base, 'Imageboard', 'data');
}
export const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
export async function readRuntime(directory) {
  try {
    const runtime = JSON.parse(await readFile(path.join(directory, 'native-runtime.json'), 'utf8'));
    const url = new URL(runtime.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !url.port || !/^[a-f0-9]{64}$/.test(runtime.token) || !alive(runtime.pid)) return null;
    const response = await fetch(`${runtime.origin}/api/health`, { headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    return response.ok && health.app === 'codex-imageboard' && health.native === true ? runtime : null;
  } catch { return null; }
}
export async function ensureRuntime(directory = dataDirectory()) {
  let runtime = await readRuntime(directory);
  if (runtime) return runtime;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'native-start.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const record = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
    const age = await stat(lockPath).then(s => Date.now() - s.mtimeMs).catch(() => 0);
    if ((!record && age > 30_000) || (record && !alive(record.pid))) { await unlink(lockPath).catch(() => {}); return ensureRuntime(directory); }
  }
  try {
    if (lock) {
      runtime = await readRuntime(directory);
      if (runtime) return runtime;
      const log = await open(path.join(directory, 'native-service.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [path.join(root, 'server/native-service.mjs')], {
          cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, IMAGEBOARD_DATA_DIR: directory },
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { await log.close(); }
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      runtime = await readRuntime(directory);
      if (runtime) return runtime;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Imageboard 服务启动超时，请查看作品目录中的 native-service.log。');
  } finally { if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); } }
}
