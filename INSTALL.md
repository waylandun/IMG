# Imageboard 安装与使用

Imageboard 0.3.1 使用 Codex 原生 MCP Apps 侧栏入口。日常流程：**打开 Codex → 点击左侧 Imageboard → 开始创作**。无需先开 Imageboard，无需系统托盘、自启动或调试端口。

## 安装前

- 使用支持本地 MCP Apps 全局入口的 Codex / ChatGPT 桌面版本。
- 在 Codex 用户配置中设置默认模型、API base URL 和 API Key / Bearer 凭据。
- 网关需要支持默认文本模型及 `gpt-image-2.5-flare` 的 Images Generations / Edits 接口。ChatGPT 登录态不能替代 API 凭据。

## macOS

1. M 系列芯片选择 arm64 安装包；Intel Mac 选择 x64。
2. 打开 DMG，将 **Imageboard.app** 拖入「应用程序」。
3. 首次运行 Imageboard，安装器会注册 MCP 入口，然后退出。
4. 重新打开 Codex，在左侧 **「更多」→ Imageboard → 固定**。只需固定一次。
5. 以后直接从 Codex 左侧打开 Imageboard。保留 Imageboard.app，Codex 会使用其中的运行环境。

## Windows

1. 运行 Windows x64 `.exe` 安装器并完成当前用户安装。
2. 首次打开 Imageboard，完成 MCP 入口注册。
3. 重新打开 Codex，从左侧「更多」固定 Imageboard 一次。
4. 以后直接从 Codex 左侧使用；无需保持安装器或托盘运行。

原生集成不再需要识别 Codex.exe 或 Microsoft Store 应用路径，也不会创建第二个 Codex 实例。旧版 Codex 如不显示入口，应更新到支持本地 MCP Apps 全局入口的版本；安装器不会尝试用独立调试窗口替代。

## 从 0.2 升级

先退出旧版 Imageboard 托盘程序，再覆盖安装 0.3。新安装器会关闭旧的 Imageboard 登录自启动设置。安装完成后，将原先两个 Codex 实例都正常退出，再从原来的 Codex 图标打开一次。

旧独立 profile 不会被删除，作品目录保持原位。新的启动器不再运行 CDP 注入。正在进行的创作应完成后再退出旧程序。

## 作品和配置

- macOS：`~/Library/Application Support/Imageboard/data`
- Windows：`%APPDATA%\Imageboard\data`

安装器只维护 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）中带 Imageboard 标记的 MCP 配置块，修改前备份到同目录 `imageboard-backups/`。保留已有模型、provider、凭据及其他 MCP 配置。

界面会自动适配明暗主题，Codex 内优先跟随宿主主题，独立页面跟随系统设置。

API Key 只在本地后端读取，不进入页面或安装包。HTTPS 沿用系统已信任的证书，同时保留运行时 CA 与严格校验。后台服务按需启动，多个 Codex 窗口共用；空闲五分钟且没有生成任务时自动退出。日志在作品目录中的 `native-service.log`。

仅在终端临时设置的环境变量可能无法由桌面 Codex 读取。使用 provider `env_key` 时，需要让 Codex 启动的进程能够取得相应变量。

开发版作品仍保留在仓库 `.data/`。切换前可设置 `IMAGEBOARD_DATA_DIR` 指向既有目录；切勿同时让开发服务和安装服务操作同一个目录。

## 移除入口

macOS：

```sh
/Applications/Imageboard.app/Contents/MacOS/Imageboard --uninstall
```

Windows：运行安装目录中的 `Imageboard.exe --uninstall`。此操作仅移除入口配置，重新打开 Codex 后生效，作品保留。随后可按系统正常方式卸载应用。

## 分发与验证

macOS 使用 ad-hoc 签名，尚无 Developer ID 公证；Windows 暂无 Authenticode 签名。正式公众分发前应配置相应签名。

已覆盖 MCP 发现、按需启动、重复安装、配置保留、单服务复用、真实图片分片传输及原有生图流程的模拟测试。macOS 安装包可在当前机器运行验证；Windows 仍需实机验证 Codex 侧栏、安装和卸载。

## 源码构建

需要 Node.js 22+；macOS 安装包需在 Mac 构建。

```sh
npm ci
npm run build:ui
npm test
npm run app:build:mac
npm run app:build:win
```

产物位于 `dist/`。安装包只包含程序和运行时，不包含作品、用户配置或任何 API 凭据。
