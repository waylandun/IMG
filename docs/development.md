# 开发与构建指南

以下命令均在本项目根目录执行。安装包用户请阅读 [INSTALL.md](../INSTALL.md)。

## 开发环境

| 项目 | 要求 |
| --- | --- |
| Node.js | 推荐 Node.js 24 LTS，至少 24.5.0；安装包内置 Node 24.21.0 / Electron 44.7.0 |
| npm | 使用 Node.js 随附的版本及仓库 `package-lock.json` |
| 操作系统 | macOS 或 Windows x64；macOS 包需要 macOS 构建工具 |
| Codex | 浏览器开发可独立运行；验证侧栏需要支持本地 MCP Apps 全局入口的 Codex |
| 模型服务 | 真实创作需要用户自己的 API 配置；自动测试使用模拟网关 |

`package.json` 的引擎声明为 Node >=22，但旧 Node 22 小版本可能缺少系统 CA 相关 API，网络回归测试也依赖这些 API。开发与 CI 统一使用上述 Node 24 版本。

获取源码后先执行 `node --version` 和 `npm --version`。Windows PowerShell 若拦截 `npm.ps1`，直接使用下面的 `npm.cmd` 命令。

## 安装依赖与浏览器开发

macOS：

```sh
npm ci
npm run build:ui
npm test
npm run dev
```

Windows PowerShell：

```powershell
npm.cmd ci
npm.cmd run build:ui
npm.cmd test
npm.cmd run dev
```

访问 [http://127.0.0.1:47824](http://127.0.0.1:47824)。`npm run dev` 对 Node 服务启用文件监听；前端文件修改后刷新浏览器。无需监听重启时使用 `npm start`（Windows：`npm.cmd start`）。

按 `Ctrl+C` 停止服务。开发模式重启可能中断当前生成，所以调试 UI 时优先使用已有作品或测试数据。

## 数据目录与环境变量

三种启动方式有不同默认值：

| 方式 | 默认目录 / 行为 |
| --- | --- |
| `npm start` / `npm run dev` | 项目 `.data/`；固定 HTTP 端口默认 `47824` |
| `npm run codex` 注册的源码 MCP | 平台 Imageboard 数据目录；由 Codex 启动 Node |
| 桌面安装版 | 平台 Imageboard 数据目录；由 Codex 启动内置运行环境 |

平台目录为 macOS 的 `~/Library/Application Support/Imageboard/data`，或 Windows 的 `%APPDATA%\Imageboard\data`。

自定义源码开发目录及端口：

macOS：

```sh
export IMAGEBOARD_DATA_DIR="$PWD/.data"
export IMAGEBOARD_PORT=47824
npm run dev
```

Windows PowerShell：

```powershell
$env:IMAGEBOARD_DATA_DIR = Join-Path (Get-Location) '.data'
$env:IMAGEBOARD_PORT = '47824'
npm.cmd run dev
```

这些设置只影响当前终端及其子进程。结束后可新开终端恢复默认环境，或在 macOS 执行 `unset IMAGEBOARD_DATA_DIR IMAGEBOARD_PORT`，Windows 执行 `Remove-Item Env:IMAGEBOARD_DATA_DIR, Env:IMAGEBOARD_PORT -ErrorAction SilentlyContinue`。

`CODEX_HOME` 用于选择 Codex 用户配置目录，`IMAGEBOARD_CODEX_PROFILE` 用于选择其中的 profile。详见 [README 配置读取规则](../README.md#配置读取规则)。自定义 `CODEX_HOME` 应与所运行 Codex 的配置目录一致。

不要同时让浏览器开发服务和原生 MCP 图片服务写同一个目录。若希望二者共享历史，先停止当前服务，再切换运行方式。

## 注册源码版到 Codex

执行：

```sh
npm run codex
```

Windows 使用 `npm.cmd run codex`。命令会构建 `web/mcp-client.js`，再把当前 Node、仓库路径及作品目录写入用户配置中的 `[mcp_servers.imageboard]`。

如果要使用仓库 `.data/`，先按上一节设置 `IMAGEBOARD_DATA_DIR`，再执行注册；该目录会以绝对路径写入 MCP 配置。移动仓库、切换 Node 安装位置或切回桌面安装版后，都应重新注册。

首次注册后重开 Codex，在左侧「更多」中固定 Imageboard。`npm run mcp` 只运行 stdio 协议服务，不会弹出页面，适用于 MCP 客户端调试；诊断日志必须写 stderr，不能污染 stdout 协议流。

取消源码注册：

```sh
node scripts/codex.mjs --uninstall
```

### 修改后如何生效

| 修改内容 | 操作 |
| --- | --- |
| `web/app.js`、`web/editor.js`、`web/theme.js`、`web/style.css`、HTML | 浏览器刷新；Codex 内右键 Imageboard「刷新」重新读取页面资源 |
| `web/mcp-client.src.js` | 先 `npm run build:ui`，再刷新面板；提交源码及生成后的 `web/mcp-client.js` |
| MCP 工具、资源策略、服务注册 | 重启 MCP 连接或重新打开 Codex，让它重新发现工具和资源 |
| 图片后端 | 等待当前任务完成，停止旧服务后重启；原生服务需关闭面板并等待空闲退出 |
| 安装包版本 | 更新版本号、重新构建并运行安装程序注册；版本化资源 URI 和 `IMAGEBOARD_VERSION` 用于更新缓存 |

仅刷新页面不会重载已经在运行的后端模块。原生图片服务独立于 Codex，退出 Codex 后仍可能存活至空闲超时。

`npm run app:dev`（Windows：`npm.cmd run app:dev`）调试的是 **Electron 安装注册流程**，不是网页开发服务器。它会写入所选 `CODEX_HOME` 的配置；隔离测试时先将该变量指向专门的测试目录。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `web/` | 工作室、参考图编辑器、主题、MCP Apps 浏览器桥接 |
| `server/mcp.mjs` | 原生全局入口、工具发现和 UI 资源 |
| `server/ui-policy.mjs` | 本地图片资源策略，禁止页面直接联网 |
| `server/mcp-bridge.mjs` | API 路由白名单及 256 KiB 图片分片传输 |
| `server/runtime.mjs`、`server/native-service.mjs` | 服务复用、启动锁、令牌、空闲退出 |
| `server/index.mjs`、`server/jobs.mjs`、`server/assets.mjs` | HTTP API、任务与历史、图片处理和持久化 |
| `server/config.mjs`、`server/provider.mjs`、`server/network.mjs` | 用户配置、模型协议、系统证书信任和错误分类 |
| `desktop/` | 安装注册、源码数据导入辅助、打包后自检 |
| `scripts/` | UI 构建、源码注册、桌面打包、受限页面验证 |
| `inject/` | 旧版 CDP 注入实现，保留作历史参考；0.3.x 安装包不使用 |
| `test/` | 模拟网关、图片、任务、MCP、配置和 TLS 回归测试 |

## 验证

### 自动测试

```sh
npm run build:ui
npm test
```

Windows 对应 `npm.cmd run build:ui`、`npm.cmd test`。截至 0.3.2 共 40 项测试，覆盖凭据选择、文本串流、多图编辑、选区保护、扩图、任务取消、版本分支、数据迁移、跨站限制、安装配置保留、服务复用、MCP 传输及 TLS 验证。测试使用临时目录和模拟网关，不需要真实 API Key，也不会付费生图。

`test/fixtures/localhost-test-*.pem` 是本地 HTTPS 测试专用证书及测试私钥，不是产品或用户的凭据，不应安装为系统信任证书。测试代码只在自己的进程内临时设置测试信任，结束时恢复。

### 受限页面图片回归

```sh
npm run build:ui
node scripts/verify-mcp-ui.mjs
```

Windows 的第一条命令改为 `npm.cmd run build:ui`。

脚本读取 `IMAGEBOARD_DATA_DIR`；未设置时使用平台 Imageboard 目录。建议先复制一套测试作品数据，在当前终端设置该变量后运行。它转发读取操作，禁止生图、参考图上传和作品修改；后端初始化仍可能进行正常的历史格式迁移。

- [修复策略页面](http://127.0.0.1:47825/)：使用 MCP 资源声明的本地图片策略。
- [旧策略复现页面](http://127.0.0.1:47825/?legacy=1)：故意省略 `blob:`，验证图片加载回归可被检出。

两个页面均使用隔离 iframe，并禁止页面网络连接。进入「我的作品」，检查缩略图，滚动使懒加载图片进入视口，再打开原图和编辑器。不能只检查 API 返回 200；需要确认图片实际解码成功（`naturalWidth > 0`）。

下载按钮通过模拟宿主写出 `work/image-loading/download.png`，便于校验字节和原图是否一致；这是测试脚本的固定文件名。该页面是 MCP 宿主模拟环境，还需要在真实 Codex 中完成最终验收。按 `Ctrl+C` 结束测试入口；按需启动的图片服务会自行空闲退出。

### 安装包自检

macOS Apple Silicon，在项目根目录执行：

```sh
./dist/mac-arm64/mac-arm64/Imageboard.app/Contents/MacOS/Imageboard \
  --self-test --report "$PWD/work/mac-arm64-selftest.json"
```

macOS x64 可在 Intel Mac 直接运行 `dist/mac-x64/mac/Imageboard.app/Contents/MacOS/Imageboard`，或在已安装 Rosetta 的 Apple Silicon Mac 上执行：

```sh
arch -x86_64 ./dist/mac-x64/mac/Imageboard.app/Contents/MacOS/Imageboard \
  --self-test --report "$PWD/work/mac-x64-selftest.json"
```

Windows PowerShell：

```powershell
$report = Join-Path (Get-Location) 'work\win-x64-selftest.json'
$process = Start-Process -FilePath '.\dist\win-x64\win-unpacked\Imageboard.exe' `
  -ArgumentList @('--self-test', '--report', ('"{0}"' -f $report)) `
  -Wait -PassThru
$process.ExitCode
Get-Content $report
```

自检使用临时目录和模拟图片生成，验证内置 sharp、业务流程及 MCP 资源发现。它不注册入口、不改写真实 Codex 配置，也不等于已验证真实 Codex 中的渲染或真实网关生图。

## 构建安装包

构建前安装完整依赖并运行测试。脚本自动生成应用图标、构建 MCP 前端、安装目标系统的生产依赖，再打包 Electron。

macOS 终端：

```sh
npm run app:build:mac
```

生成 arm64、x64 两套 macOS 包。只构建一个架构可执行：

```sh
node scripts/build-desktop.mjs mac-arm64
# Intel 包：node scripts/build-desktop.mjs mac-x64
```

Windows PowerShell：

```powershell
npm.cmd run app:build:win
```

macOS 也可执行 `npm run app:build:win` 交叉构建 Windows 包，但仍需 Windows 实机验证。macOS 打包使用 `iconutil`、`ditto`、`hdiutil`，需要在 macOS 完成。`npm run app:build` 会依次构建所有目标，适合 Mac 构建机；Windows 构建机应使用 `app:build:win`。

产物位置：

| 目标 | 安装 / 分发文件 | 解包应用 |
| --- | --- | --- |
| mac-arm64 | `dist/mac-arm64/Imageboard-<版本>-mac-arm64.dmg`、`.zip` | `dist/mac-arm64/mac-arm64/Imageboard.app` |
| mac-x64 | `dist/mac-x64/Imageboard-<版本>-mac-x64.dmg`、`.zip` | `dist/mac-x64/mac/Imageboard.app` |
| win-x64 | `dist/win-x64/Imageboard-<版本>-win-x64.exe`、`.zip` | `dist/win-x64/win-unpacked/` |

可选构建变量：

| 变量 | 用途 |
| --- | --- |
| `IMAGEBOARD_RELEASE_DIR` | 覆盖产物目录，默认 `dist/` |
| `IMAGEBOARD_ELECTRON_DIST` | 使用已准备好的 Electron 运行时目录或目标架构归档；需匹配构建版本与平台 |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | 可选配置 electron-builder 辅助工具下载镜像 |

首次构建需要联网下载 Electron 和打包工具。应保留原生依赖的目标平台版本，不能直接把 macOS 的 `node_modules` 复制到 Windows。

[GitHub Actions 工作流](../.github/workflows/desktop-build.yml)支持手动触发及 `v*` 标签触发，使用 macOS / Windows runner 上传构建产物。它没有自动创建 Release 或发布到插件目录。

## 发布前检查

1. `npm test` 通过；在目标系统运行安装包自检。
2. 在真实 Codex 验证入口固定、按需启动、明暗主题、图片加载和下载。
3. 验证安装、覆盖升级、取消注册和卸载；确保已有作品保留。
4. 安装包只包含代码和运行时，不包含 `.data/`、`work/`、用户配置、运行令牌或 Codex profile。
5. 补齐版本号、安装说明、校验值、签名及公证后，再按实际渠道发布。

当前构建脚本固定使用 macOS ad-hoc 签名并关闭 Windows 可执行文件签名/资源编辑。正式签名需要调整构建配置，仅设置签名环境变量并不会自动覆盖这些选项。发布前还需明确项目许可证；当前 `package.json` 为 `UNLICENSED`。

截至 2026-10-11，macOS arm64 与 Rosetta 下的 x64 包已运行自检；Windows 仅完成构建及静态校验。详细问题记录见[问题档案](2026-10-11-integration-fixes.md)。
