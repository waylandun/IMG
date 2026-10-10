import { build, Platform, Arch } from 'electron-builder';
import { readFile, writeFile, mkdir, cp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('./build-ui.mjs');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(process.env.IMAGEBOARD_RELEASE_DIR || path.join(root, 'dist'));
const requested = process.argv[2] || 'all';
const choices = {
  'mac-arm64': ['darwin', 'arm64'], 'mac-x64': ['darwin', 'x64'], 'win-x64': ['win32', 'x64'],
};
const targets = requested === 'all' ? Object.keys(choices) : requested === 'mac' ? ['mac-arm64', 'mac-x64'] : requested === 'win' ? ['win-x64'] : [requested];
if (targets.some(target => !choices[target])) throw new Error('目标应为 mac、win、mac-arm64、mac-x64、win-x64 或 all。');

const iconDir = path.join(root, 'desktop/icons');
await mkdir(iconDir, { recursive: true });
await mkdir(output, { recursive: true });
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="52" y="52" width="920" height="920" rx="220" fill="#242b3b"/><rect x="215" y="266" width="580" height="480" rx="80" fill="none" stroke="#e5edff" stroke-width="36"/><circle cx="376" cy="412" r="48" fill="#a4beff"/><path d="m230 640 175-172 169 159 104-99 104 104" fill="none" stroke="#e5edff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/><path d="m772 130 22 59 62 22-62 24-22 62-22-62-61-24 61-22z" fill="#a4beff"/></svg>`;
await sharp(Buffer.from(iconSvg)).png().toFile(path.join(iconDir, 'icon.png'));
const sizes = [16, 32, 48, 256];
const pngs = await Promise.all(sizes.map(size => sharp(Buffer.from(iconSvg)).resize(size).png().toBuffer()));
const icoHeader = Buffer.alloc(6 + 16 * sizes.length); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(sizes.length, 4);
let offset = icoHeader.length;
pngs.forEach((png, index) => {
  const start = 6 + index * 16, size = sizes[index]; icoHeader[start] = size === 256 ? 0 : size; icoHeader[start + 1] = icoHeader[start];
  icoHeader.writeUInt16LE(1, start + 4); icoHeader.writeUInt16LE(32, start + 6); icoHeader.writeUInt32LE(png.length, start + 8); icoHeader.writeUInt32LE(offset, start + 12); offset += png.length;
});
await writeFile(path.join(iconDir, 'icon.ico'), Buffer.concat([icoHeader, ...pngs]));
if (process.platform === 'darwin') {
  const iconset = path.join(root, 'work/desktop-icon.iconset'); await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) await sharp(Buffer.from(iconSvg)).resize(size * scale).png().toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  }
  await run('iconutil', ['-c', 'icns', iconset, '-o', path.join(iconDir, 'icon.icns')]);
}

for (const target of targets) {
  const [platform, architecture] = choices[target];
  const stage = path.join(root, 'work/desktop-build', target);
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  // This allowlist deliberately excludes .data, work, Codex profiles and all user config.
  for (const directory of ['server', 'web', 'inject', 'scripts', 'desktop']) await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
  console.log(`准备 ${target} 的独立运行依赖…`);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npmCommand, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${architecture}`], { cwd: stage, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' });
  const electronVersion = manifest.devDependencies.electron.replace(/^[^0-9]*/, '');
  const arch = architecture === 'arm64' ? Arch.arm64 : Arch.x64;
  const builderTargets = platform === 'darwin' ? Platform.MAC.createTarget(['zip'], arch) : Platform.WINDOWS.createTarget(['nsis', 'zip'], arch);
  const files = await build({
    projectDir: stage, targets: builderTargets,
    config: {
      appId: 'com.codeximageboard.desktop', productName: 'Imageboard', electronVersion,
      ...(process.env.IMAGEBOARD_ELECTRON_DIST ? { electronDist: path.resolve(process.env.IMAGEBOARD_ELECTRON_DIST) } : {}),
      asar: false, npmRebuild: false, buildDependenciesFromSource: false,
      directories: { output: path.join(output, target), buildResources: path.join(stage, 'desktop/icons') },
      files: ['package.json', 'server/**/*', 'web/**/*', 'desktop/**/*', 'node_modules/**/*', '!web/mcp-client.src.js', '!desktop/icons/tray*', '!desktop/icons/*.iconset/**/*'],
      artifactName: 'Imageboard-${version}-${os}-${arch}.${ext}',
      mac: { category: 'public.app-category.graphics-design', icon: path.join(iconDir, 'icon.icns'), identity: '-', hardenedRuntime: false, gatekeeperAssess: false, extendInfo: { LSUIElement: true } },
      win: { icon: path.join(iconDir, 'icon.ico'), signAndEditExecutable: false },
      nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'Imageboard', deleteAppDataOnUninstall: false, installerLanguages: ['en_US', 'zh_CN'] },
      publish: null,
    },
  });
  if (platform === 'darwin') {
    const appDirectory = architecture === 'arm64' ? 'mac-arm64' : 'mac';
    const bundle = path.join(output, target, appDirectory, 'Imageboard.app');
    const layout = path.join(root, 'work/dmg-layout', target);
    await rm(layout, { recursive: true, force: true }); await mkdir(layout, { recursive: true });
    await run('ditto', [bundle, path.join(layout, 'Imageboard.app')]);
    await symlink('/Applications', path.join(layout, 'Applications'));
    const dmg = path.join(output, target, `Imageboard-${manifest.version}-mac-${architecture}.dmg`);
    await run('hdiutil', ['create', '-volname', 'Imageboard', '-srcfolder', layout, '-ov', '-format', 'UDZO', dmg], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    files.push(dmg);
  }
  console.log(`${target} 构建完成：\n${files.join('\n')}`);
}
