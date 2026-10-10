const fs = require('node:fs/promises');
const path = require('node:path');

async function importDevelopmentData(source, destination) {
  if (path.resolve(source) === path.resolve(destination)) throw new Error('源目录和目标目录不能相同。');
  let existing = [];
  try { existing = JSON.parse(await fs.readFile(path.join(destination, 'jobs.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.length) throw new Error('安装版已有作品，为避免覆盖，不执行导入。');
  const records = JSON.parse(await fs.readFile(path.join(source, 'jobs.json'), 'utf8'));
  if (!Array.isArray(records) || records.some(job => !/^[a-f0-9-]{36}$/.test(job.id))) throw new Error('所选目录不是有效的 Imageboard 数据目录。');
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const directory of ['assets', 'images', 'backups']) {
    const from = path.join(source, directory), to = path.join(destination, directory);
    let entries;
    try { entries = await fs.readdir(from, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await fs.mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-zA-Z0-9._-]+\.(png|jpeg|jpg|webp|json)$/.test(entry.name)) continue;
      await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name), fs.constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
  }
  await fs.writeFile(path.join(destination, 'jobs.json'), JSON.stringify(records, null, 2), { mode: 0o600 });
  return records.length;
}

module.exports = { importDevelopmentData };
