const { app, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

app.setName('Imageboard');
if (process.platform === 'win32') app.setAppUserModelId('com.codeximageboard.desktop');
const selfTest = process.argv.includes('--self-test');
const primary = selfTest || app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (!primary) return;
  if (selfTest) {
    const reportIndex = process.argv.indexOf('--report');
    const child = spawn(process.execPath, [path.join(app.getAppPath(), 'desktop/self-test.mjs'), reportIndex >= 0 ? process.argv[reportIndex + 1] || '' : ''], {
      cwd: app.getAppPath(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', () => app.exit(1)); child.on('exit', code => app.exit(code || 0)); return;
  }
  // Codex now owns the MCP process lifecycle; remove the old login launcher.
  if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--background'] });
  const { installNative } = await import('./install.mjs');
  const { dataDirectory } = await import('../server/runtime.mjs');
  const directory = dataDirectory();
  const remove = process.argv.includes('--uninstall');
  await installNative({ executable: process.execPath, root: app.getAppPath(), directory }, { remove });
  if (!process.argv.includes('--silent')) {
    const result = await dialog.showMessageBox({
      type: 'info', title: 'Imageboard', message: remove ? 'Imageboard 侧栏入口已移除' : 'Imageboard 已安装到 Codex',
      detail: remove ? '重新打开 Codex 后生效。已有作品保留。' : '重新打开 Codex，在左侧「更多」中找到 Imageboard 并固定。以后直接点击左侧图标即可使用。\n\n无需先运行 Imageboard，也无需系统托盘或登录自启动。请保留本应用，Codex 会使用其中的运行环境。',
      buttons: ['完成', '打开作品目录'], defaultId: 0,
    });
    if (result.response === 1) await shell.openPath(directory);
  }
  app.quit();
}).catch(error => { dialog.showErrorBox('Imageboard 安装未完成', error.message); app.exit(1); });
