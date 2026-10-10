import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from './index.mjs';
import { dataDirectory } from './runtime.mjs';
import { isActive } from './jobs.mjs';

const directory = dataDirectory(), token = randomBytes(32).toString('hex');
const { server, jobs } = await createServer({ directory, accessToken: token });
let lastRequest = Date.now(), closing = false;
server.on('request', () => { lastRequest = Date.now(); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const runtimePath = path.join(directory, 'native-runtime.json');
const tempPath = `${runtimePath}.${process.pid}.tmp`;
await writeFile(tempPath, JSON.stringify({ pid: process.pid, origin: `http://127.0.0.1:${server.address().port}`, token }), { mode: 0o600 });
await rename(tempPath, runtimePath);
async function close() {
  if (closing) return; closing = true; clearInterval(idle);
  await unlink(runtimePath).catch(() => {});
  jobs.close(); server.closeAllConnections(); server.close();
}
const idle = setInterval(() => {
  if (Date.now() - lastRequest > 5 * 60_000 && !jobs.list().some(isActive)) void close();
}, 15_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
