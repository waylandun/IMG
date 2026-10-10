# Codex Imageboard

复用 Codex 配置的本地生图工作室。默认模型负责理解需求与参考图，固定使用 `gpt-image-2.5-flare` 生成或编辑图片。顶部单行导航提供创作、作品、历史和新建入口。界面使用统一黑白灰明暗主题：内嵌时跟随 Codex，独立页面跟随系统，并实时响应主题变化。

## 创作与编辑

- **参考图**：选择文件、拖拽或粘贴图片，最多 16 张，每张 20 MB，支持静态 PNG / JPEG / WebP。图片会校正 EXIF 方向并移除元数据；支持排序、预览、移除，以及编辑原图、主体、风格、构图、配色、背景等用途和补充说明。
- **连续修改**：选择作品或生成结果中的某个方案，它会作为真实图片加入下一次编辑请求。历史版本保留，可从任意版本继续形成分支。点击新建或移除原图可以开始独立创作。
- **局部重绘**：画笔、框选、擦除选区、撤销、清空；应用选区后输入修改要求。蒙版透明区域发送到 Images Edits API，输出再与原图合成，使未选中的像素保留原图。JPEG 等有损导出仍会产生压缩误差。
- **扩图**：按四个方向的百分比扩展画布，实时预览。服务端创建同尺寸底图和蒙版，在生成后恢复原图区域。扩展受模型画布尺寸限制，小画布由 API 自动确定生成尺寸后合成。
- **快捷编辑**：在「参数」中选择风格转换、改色、文字修改、翻译、草图转实景、去背景或换背景。选择后可以自行补充准确要求；这些操作依赖模型效果，并非传统图像处理的确定性变换。
- **看图优化**：默认模型接收参考图和用途说明。可关闭「生成前优化提示词」直接生成，或关闭「结合参考图理解需求」仅优化文字；后一种情况仍会把原始参考图发送给生图模型。
- **多方案与输出**：一次 1 / 2 / 4 张；PNG / JPEG / WebP，透明 / 不透明 / 自动背景，JPEG / WebP 压缩质量。透明背景不使用 JPEG。为兼容忽略 `n>1` 的网关，每个方案分别发起一次请求，逐张保存并展示完成数量；后续失败或取消时保留已完成方案，不自动重试失败请求。
- **版本与作品管理**：版本缩略图、滑杆对比、名称、标签、搜索、收藏、回收站和恢复。删除仅标记记录，不永久删除图片，也不级联删除子版本。

上传图和新结果存入 `.data/assets/`，任务与版本关系保存在 `.data/jobs.json`。旧版历史首次升级时自动迁移，原记录备份至 `.data/backups/jobs-before-v2.json`，原 PNG 保留。

## 启动

普通用户使用桌面安装包，参见 [安装说明](INSTALL.md)。安装版注册原生 MCP 侧栏入口，内置运行环境；日常直接打开 Codex，点击 Imageboard 使用。下列 npm 命令用于源码开发。

需要 Node.js 22 或以上。

```sh
npm install
npm start
```

打开 http://127.0.0.1:47824 。服务只监听本机，图片与任务记录默认保存在项目 `.data/`，不进入 Git。

## Codex 原生侧栏入口

```sh
npm run codex
```

这个命令只在用户的 Codex 配置中注册 `imageboard` MCP 服务。重新打开 Codex，在左侧「更多」中找到 **Imageboard** 并固定一次，此后固定状态由 Codex 保存。需要支持本地 MCP Apps 全局入口的 Codex 版本。

- Codex 启动轻量 stdio MCP 进程，读取带 `openai/ui.entrypoints: [{type: "global"}]` 的工具定义。
- 点击入口后加载独立 HTML 工作室，首次界面请求才启动图片服务。发现入口和读取 HTML 均不会启动图片服务或调用生图接口。
- 界面使用 MCP Apps SDK 与 Codex 通信，API 请求由仅供界面调用的工具转发；图片以 256 KiB 分片上传/读取。HTML 不含 API Key、本地连接令牌或 HTTP 服务地址。
- 多个窗口共用同一个按需启动的本地服务；随机回环端口要求进程私有令牌。退出界面不打断正在生成的任务，空闲五分钟后服务自动退出，下次点击恢复。
- 不启动 Codex，不创建独立 profile，不需要 CDP 或菜单栏常驻，不修改 Codex 应用包。初次安装或升级后需要重新打开 Codex，让它加载新 MCP 配置。

源码注册后需要保留仓库及 Node 路径；普通用户应使用内置运行环境的安装包。取消注册：`node scripts/codex.mjs --uninstall`，作品保留。

## 配置复用

读取 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）：

- `model`：提示词转换模型，始终沿用配置，不硬编码替代模型。
- `model_provider` 与 `model_providers.<id>.base_url`：请求发送到用户现有提供方。
- `wire_api = "responses"` 使用 Responses API；`"chat"` 使用 Chat Completions。
- 凭据优先级：provider 的 `experimental_bearer_token` → 明确配置的 `env_key`。只有 OpenAI provider 或声明 `requires_openai_auth` 的 provider 才回退到 `OPENAI_API_KEY` / Codex `auth.json` 中的 API Key。
- 支持 provider 的 `http_headers` 与 `env_http_headers`。自定义动态 `auth` 解析器暂不支持。
- 可选 `IMAGEBOARD_CODEX_PROFILE` 或配置的 `profile`，支持同目录 `<profile>.config.toml` 及旧式 `[profiles.<name>]`。仅读取用户级配置，不读取项目配置里的 provider 或凭据，也不读取某个聊天窗口临时选择的模型。

安装版使用运行时默认 CA 与系统已信任证书的合集，保留 HTTPS 证书链和域名校验。证书、DNS、拒绝连接及超时会提供对应提示。

API Key 和认证头只存在于后端内存中；前端配置接口只返回模型、服务地址和凭据来源，不返回密钥。仅有 ChatGPT OAuth 登录不等于拥有 Images API 访问权限，本项目不会把 ChatGPT OAuth token 当作 API Key 转发。你的网关须支持这两个模型，以及相应文本接口和 `/images/generations`；模型列表可见不保证生成权限或余额。

调用会直接使用配置中的 base URL。如它只包含域名且根路由返回 404/405，则尝试 `/v1/` 前缀；不会对超时、5xx 或余额不足自动重发付费生图请求。无参考图时调用 `/images/generations`，有参考图时用 multipart 调用 `/images/edits`，原图文件直接发送到生图模型；图片响应需包含 base64 数据。默认模型需支持视觉才能看图优化，关闭「结合参考图理解需求」可使用仅支持文本的默认模型。

界面展示「理解需求 → 正在创建图像 → 已完成」和实际耗时，不编造生成百分比。停止会中断本地请求，无法保证撤销上游计费。当前一次只运行一个任务；服务重启后，中断的任务标记为失败，避免自动重复付费。

| 环境变量 | 用途 |
| --- | --- |
| `IMAGEBOARD_PORT` | 本地 HTTP 端口，默认 `47824` |
| `IMAGEBOARD_DATA_DIR` | 自定义图片和历史存储目录 |
| `CODEX_HOME` | Codex 用户配置目录 |
| `IMAGEBOARD_CODEX_PROFILE` | 指定读取的 Codex profile |

## 验证

```sh
npm test
```

测试使用本地模拟网关，不消耗真实额度。覆盖凭据读取、文本串流、真实图片上传与格式校验、多图 multipart、视觉输入、蒙版方向与原图保护、扩图、多方案、版本分支、收藏与回收站、历史迁移、取消和跨站请求限制。

接口依据：[GPT-Image-2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)、[Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)。
