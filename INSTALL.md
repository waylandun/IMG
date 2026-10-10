# Imageboard 安装、升级与卸载

适用版本：**0.3.2**。日常使用流程是：**打开 Codex → 点击左侧 Imageboard → 开始创作**。Imageboard 安装程序只负责首次注册；Codex 会启动其内置 MCP 运行环境，图片服务按需加载。

开发者请先阅读 [README](README.md) 和[开发指南](docs/development.md)。

## 安装前准备

- 已安装支持本地 MCP Apps 全局入口的 Codex 桌面应用。若旧版只支持 MCP 工具、不显示应用入口，需要更新 Codex；本项目未确定所有发行渠道的最低兼容版本。
- 已配置可用的 Codex 默认模型、API 服务地址及 API 凭据。
- 同一个网关支持默认文本模型和 `gpt-image-2.5-flare`，提供 `/images/generations` 与 `/images/edits`，图片返回 `b64_json`。
- 看图优化还要求默认文本模型支持视觉输入；不支持时关闭「结合参考图理解需求」。

普通用户不需要 Node.js、npm 或独立 Codex CLI。ChatGPT 账号登录态不能代替上述 API 凭据。

## 选择安装包

向维护者取得安装包，或按[开发指南](docs/development.md#构建安装包)自行构建。目前没有在本文中指定公开下载地址。

| 设备 | 文件 |
| --- | --- |
| macOS Apple Silicon（M 系列） | `Imageboard-0.3.2-mac-arm64.dmg` |
| macOS Intel | `Imageboard-0.3.2-mac-x64.dmg` |
| Windows x64 | `Imageboard-0.3.2-win-x64.exe` |

macOS 可在「关于本机」查看芯片类型。Windows 可在「设置 → 系统 → 系统信息」查看系统类型。目前不提供原生 Windows ARM64 安装包。

## macOS 安装

1. 打开对应 DMG，把 **Imageboard.app** 拖入「应用程序」。先复制到固定位置，再运行；不要直接从 DMG 注册。
2. 首次运行 `/Applications/Imageboard.app`。出现「Imageboard 已安装到 Codex」后，安装程序退出。
3. 退出并重新打开 Codex，让它加载 MCP 配置。
4. 在左侧「更多」中找到 **Imageboard**，固定到侧栏。只需固定一次。
5. 点击图标打开工作室，检查右上角配置状态，再开始创作。

保留 `/Applications/Imageboard.app`；Codex 的 MCP 配置会引用其中的可执行文件和脚本。移动应用后，应在新位置重新运行它以更新注册路径。

## Windows 安装

1. 运行 `Imageboard-0.3.2-win-x64.exe`，完成当前用户安装，可自行选择固定安装目录。
2. 从开始菜单或桌面打开 **Imageboard**，完成 MCP 注册。若安装器结束时已启动 Imageboard，则不必重复打开。
3. 退出并重新打开 Codex。
4. 在左侧「更多」中固定 **Imageboard**，以后直接从该图标进入。

保留安装目录中的完整应用文件。原生集成无需识别 Codex 的安装目录或 Microsoft Store 包路径，也不会额外启动 Codex 实例。

当前 Windows 包已完成构建和静态检查，尚未通过 Windows 实机安装、侧栏及图片操作验收。

## 准备 Codex API 配置

已在 Codex 中配置好 Provider 的用户，继续使用原配置即可。配置文件位置：

| 系统 | 默认位置 |
| --- | --- |
| macOS | `~/.codex/config.toml` |
| Windows | `%USERPROFILE%\.codex\config.toml` |
| 自定义目录 | `CODEX_HOME` 指向的目录内的 `config.toml` |

下面仅演示配置结构。替换占位内容，并合并到已有配置中，避免重复定义同名 TOML 表；真实密钥仅保存在自己的用户配置中。

```toml
model = "你的默认文本模型名称"
model_provider = "my_gateway"

[model_providers.my_gateway]
name = "My gateway"
base_url = "https://your-gateway.example/v1"
wire_api = "responses"
experimental_bearer_token = "替换为你已有的 API 凭据"
```

如果网关文本接口使用 Chat Completions，将 `wire_api` 改为 `"chat"`。生图模型由 Imageboard 固定为 `gpt-image-2.5-flare`，不需要把 Codex 的默认 `model` 改成生图模型。

也支持 Provider 的 `env_key`、认证请求头，以及满足条件时的 Codex `auth.json` API Key，详见[配置读取规则](README.md#配置读取规则)。如果使用 `env_key`，相应变量必须对 **Codex 启动的进程**可见；终端里临时设置的变量不一定传给从桌面启动的 Codex。变量缺失时，页面会指出名称。

界面的「已读取 Codex 配置」表示字段和凭据来源可解析，不代表网络、模型权限或余额已验证。图片生成与提示词优化使用网关的 API 额度。

## 确认安装成功

- Codex 的 MCP 设置中有启用的 `imageboard` 条目，命令路径指向当前安装目录。
- 左侧「更多」里可以找到 Imageboard，固定后重新打开 Codex仍保留入口。
- 打开工作室可以读取配置；已有用户能看到历史记录和图片。
- 不需要系统托盘常驻，也不需要先打开 Imageboard 再打开 Codex。

如果还安装了 Codex CLI，可选执行 `codex mcp get imageboard` 检查注册信息；安装和日常使用不依赖这个命令。

## 升级

### 从 0.3.x 升级

1. 等待当前创作结束，备份需要保留的作品。
2. 关闭 Imageboard 页面并退出 Codex。图片服务独立运行，需等其空闲退出（约五分钟）后再替换应用文件。
3. macOS 覆盖「应用程序」中的 Imageboard.app；Windows 运行新版安装器，选择原安装位置。
4. 运行新版 Imageboard 一次，更新注册信息和 `IMAGEBOARD_VERSION`。
5. 重新打开 Codex。若仍看到旧页面，右键左侧 Imageboard，选择「刷新」。

不要在图片仍生成时覆盖运行环境。源码版与安装版同时指向同一数据目录时，也需要先停止另一服务。

### 从 0.2 托盘版本升级

先退出旧 Imageboard 托盘程序，再按上面的流程覆盖安装。新安装程序会尝试移除旧的登录自启动；若系统仍显示该项，可在系统登录项设置中移除。

把旧版产生的两个 Codex 实例正常退出，再从原 Codex 图标打开。旧独立 profile 和作品目录不会被删除；新版本使用原生 MCP 入口，不再使用 CDP 注入。

## 数据、备份与日志

| 系统 / 运行方式 | 默认作品目录 |
| --- | --- |
| macOS 安装版 / 源码 MCP | `~/Library/Application Support/Imageboard/data` |
| Windows 安装版 / 源码 MCP | `%APPDATA%\Imageboard\data` |
| 源码浏览器模式 | 项目 `.data/` |

备份或迁移时，在服务停止后复制 `jobs.json`、`assets/`、`images/` 和 `backups/`（如存在）。这些文件应成套保留，单独复制 `jobs.json` 无法恢复图片。不要把 `native-runtime.json`、`native-start.lock` 或旧 Codex profile 当作作品迁移到另一台电脑。

`native-service.log` 位于作品目录。原生图片服务使用随机回环端口和临时令牌，多个 MCP 客户端复用一个服务；关闭页面不会主动取消运行中的生成，空闲五分钟且没有任务后自动退出。

安装程序只维护用户 `config.toml` 内带 Imageboard 标记的 MCP 配置块，并将修改前配置备份到同目录 `imageboard-backups/`。配置备份可能包含凭据，请仅在本机妥善保存。

开发版可在注册前设置 `IMAGEBOARD_DATA_DIR` 指向自己的作品目录，见[自定义数据目录](docs/development.md#数据目录与环境变量)。安装程序不会自动把仓库 `.data/` 合并到已有作品库。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 左侧没有图标 | 先确认已运行 Imageboard 完成注册；重开 Codex，从「更多」固定；确认 Codex 支持本地 MCP Apps 全局入口 |
| 提示存在手动 `imageboard` MCP 配置 | 在 Codex 设置中核对已有条目，移除冲突项后重新注册；安装程序不会覆盖不属于它的条目 |
| 已读取配置，但网关连接失败 | 查看具体错误；0.3.1 起合并运行时与系统证书信任，并区分证书、DNS、拒绝连接和超时 |
| 已生成，图片却破损 | 升级到 0.3.2 及以上并刷新面板；该版本修复本地图片资源策略和下载流程，无需重新生图 |
| 页面一部分黑、一部分白 | 升级到 0.3.1 及以上并刷新；内嵌界面跟随 Codex，独立页面跟随系统主题 |
| `env_key` 变量缺失 | 让该变量对 Codex 进程可见，或使用已配置的 Provider Bearer；重新启动相关进程后读取配置 |
| HTTP 401 / 403 / 429 | 分别检查 API 凭据、模型权限、网关限额或余额 |
| 更新后仍显示旧页面 | 重新运行安装程序，再重开 Codex或右键入口「刷新」；图片服务代码更新还需旧服务退出 |
| 作品库为空 | 核对数据目录；浏览器开发模式与 MCP 模式的默认目录不同 |

排查记录和复现步骤见 [问题档案](docs/2026-10-11-integration-fixes.md)。

## 卸载

先等待任务结束、关闭面板，再移除入口配置。

macOS 终端：

```sh
/Applications/Imageboard.app/Contents/MacOS/Imageboard --uninstall
```

Windows PowerShell：将路径换成实际安装目录。

```powershell
& "C:\你的安装目录\Imageboard.exe" --uninstall
```

源码注册：在项目根目录运行 `node scripts/codex.mjs --uninstall`。

重新打开 Codex 后入口移除。随后可在 macOS 删除应用，或在 Windows 系统设置中卸载。应先取消 MCP 注册再删除运行环境，避免留下不可执行的 MCP 条目。上述操作保留作品目录；有需要可先备份后自行清理。

## 安装包签名

当前 macOS 包使用 ad-hoc 签名，尚无 Developer ID 公证；Windows 暂无 Authenticode 签名。系统可能显示未识别开发者提示。先确认文件来源及维护者提供的校验值，再按系统界面处理；受组织策略限制的电脑需要管理员协助。

正式发布需要维护者补齐签名、公证和 Windows 实机验收。构建步骤见[开发指南](docs/development.md#构建安装包)。
