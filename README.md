# AstrBot 模型控制台（Model Console）

[![ci](https://github.com/CBlazed/astrbot-model-console/actions/workflows/ci.yml/badge.svg)](https://github.com/CBlazed/astrbot-model-console/actions/workflows/ci.yml)
[![release](https://github.com/CBlazed/astrbot-model-console/actions/workflows/release.yml/badge.svg)](https://github.com/CBlazed/astrbot-model-console/actions/workflows/release.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**下载**：[Releases 便携包](https://github.com/CBlazed/astrbot-model-console/releases/latest) · [使用说明](docs/USAGE.zh-CN.md) · [FAQ](docs/FAQ.zh-CN.md)

在浏览器里集中查看和切换 AstrBot 的模型绑定：核心配置、机器人实例、插件、模型库；改完先预览、再备份、再写入，支持 HTTP / SSH / Agent 远程设备。

Windows 便携包解压即用，**不需要安装 Node.js、没有安装器、没有自动更新**；源码零第三方运行依赖。

![控制台首页](docs/assets/e2e-home-2026-10-29.png)

> 界面截图来自真实浏览器（Chrome headless）加载控制台 + 模拟 AstrBot 数据；不是设计稿。

## 为什么需要它

AstrBot 的模型配置分散在三个地方：profile 配置（主对话、压缩、视觉、语音）、插件配置（每个插件各有一套 provider 字段）、全局 provider 定义。改一个模型往往要跨多个 JSON 和多个页面，改错一个字段就可能让某个插件静默失效。

这个工具把这些绑定聚合到一张界面里，并且只开放**已审查过的字段**：

- 只改白名单字段，其余字段原样保留；
- 写入前强制备份（JSON 逐文件 SHA-256 + SQLite `quick_check`）；
- 保存后回读比对，成功/失败都记审计；
- 不做模型生成、不代理请求、不管理 QQ 协议端。

## 功能

### 模型绑定总览

- 核心配置每个 profile 的 6 类绑定：主对话、压缩、图片描述、STT、TTS、长期记忆图片描述。
- 15 个插件字段，覆盖 4 个插件：`group_chat_plus`、`livingmemory`、`self_learning`、`meme_manager`（LLM / vision / embedding / rerank）。
- 模型库：共享 provider 定义、已登记引用、推理强度（`reasoning_effort`）。
- **网页搜索设置**（AstrBot 本体-网页搜索提供商）：启用开关 + 提供商下拉；内置 9 项，只有检测到并启用 `astrbot_plugin_model_websearch` 时才出现「跟随当前聊天模型（模型原生搜索）」；插件缺失/未启用/插件列表不可读时自动退回内置提供商。
- **内置搜索 API Key**：按所选内置提供商显示 Key 编辑行，支持多 Key（每行一个）、清空与「测试 Key」；已保存的 Key 永远不回显，只显示「已配置 N 个」。Key 改动需点「确认添加/替换」才会进入待应用变更。
- **模型原生搜索**：可额外指定「搜索使用模型」（空=跟随当前聊天模型），并提供「测试模型原生搜索」按钮，用真实 `web_search` 请求验证所选模型是否真的会联网。

### 安全编辑

- **草稿 → 预览 → 逐资源应用**：不点应用不会写盘，计划只存在内存里，重启即失效。
- **revision 双重校验**：计划创建、应用前、备份后各核对一次版本；外部改动会得到 `CONCURRENT_CHANGE` 和可视差异。
- **冲突 diff**：显示「本地草稿 / 最新服务端值」，可一键以最新值重新编辑。
- **写前备份 + 写后回读**：备份失败直接阻断写入；回读不一致返回 `VERIFY_FAILED`，不会假装成功。
- **审计**：`audit.jsonl` 记录 apply-start / applied / apply-failed，不含完整配置与凭证。

### 备份、恢复与诊断

- 备份保留策略：默认 10 份 + 总大小上限（默认 2048 MB），超限删最旧并写诊断。
- 备份列表、占用统计、清理、恢复前差异（只列已审查字段）。
- 恢复是**整对象回写**：先看 diff → 生成恢复计划 → 预览 → 应用，仍然走备份与版本校验。
- 诊断日志 1 MiB 滚动保留 3 份，脱敏后可导出。

### 远程设备

| 类型 | 接入方式 | 读写 |
|---|---|---|
| HTTP | AstrBot OpenAPI Key（`abk_`） | 只读 |
| SSH | 本机 `ssh -N -L` 隧道 + 远端日志自动发现 dashboard 端口 | 只读 |
| Agent | 目标机运行同一个 `node src/agent.mjs`，8 位一次性配对码 | 默认只读；加 `--enable-writes` 后可远程计划/应用/备份 |

远程写入只在目标 Agent 本地做备份与审计，返回 `hotLoad` 证据；`hotLoad.verified:true` 只代表日志出现重载标记，不代表模型生成成功。

### 安全模型

- 只监听 `127.0.0.1`，端口默认随机；不提供公网监听开关。
- 会话令牌 + Host/Origin 校验 + CSP；AstrBot JWT 与上游 API Key 只在后端使用，不进入页面。
- 设备凭据用 Windows DPAPI 加密存 `dpapi:`；DPAPI 不可用时降级明文并在诊断里留痕。
- 静态资源白名单，不暴露源码、状态目录与备份。

### 便携分发

- 内置 `node.exe`，解压双击 `start.cmd`（编辑模式，保存仍需预览 + Apply）。
- 产物带逐文件 `SHA256SUMS.txt`；升级 = 替换整个目录，用户数据不在包内。
- 构建脚本零依赖：`node scripts/build-package.mjs --zip`。

## 快速开始

### 方式一：便携包（推荐）

1. 下载 Release 里的 `AstrBotModelConsole-<版本>-win-x64.zip`；
2. 解压到普通用户目录（不要放 `C:\Program Files`）；
3. 双击 `start.cmd`，浏览器会自动打开控制台。

目标机器不需要预装 Node.js。首次启动会自动扫描 AstrBot 的 data 目录；扫描不到时按窗口提示设置：

```powershell
$env:ASTRBOT_DATA = 'C:\Users\<你>\.astrbot_launcher\instances\<实例>\core\data'
.\start.cmd
```

### 方式二：源码运行

```powershell
git clone <本仓库地址>
cd model-console
node --version          # 需要 >= 24.22
.\start-console-edit.cmd   # 编辑模式（依赖 PATH 里的 node）
# 临时只读查看
node src/server.mjs --open
```

### 首次启动会发生什么

1. 在状态目录（默认 `%LOCALAPPDATA%\AstrBotModelConsole\state`）获取单实例锁；
2. 读取 AstrBot 最新启动日志里的 dashboard 端口，用 `jwt_secret` 在内存里签 JWT；
3. 监听随机回环端口，打印带一次性令牌的 URL；
4. 首启向导引导确认 AstrBot data 目录与读写模式。

状态目录包含备份、审计、设备凭据与诊断日志，**不要分享、不要提交**。

若默认状态目录不可写（安全软件拦截、便携盘/工作区策略禁止程序写 `%LOCALAPPDATA%`），启动会自动回退到**程序目录下的 `state/`** 并打印警告；可用 `MODEL_CONSOLE_STATE` 固定位置。回退后升级替换目录会连带旧 `state/`，升级前请先备份。

## 支持的 AstrBot 版本

在 AstrBot **4.29.3** 上实测；依赖 dashboard `/api/v1/*` 的实际返回结构。升级 AstrBot 后如果接口变化，工具会在读取阶段报错而不是猜测字段。

## 已知限制（请按原文理解）

- 保存并回读成功 ≠ 热加载成功 ≠ 模型可生成；工具不验证后两者。
- 只解析平台级路由视图；存在会话级/通配符路由时界面会提示，不声称是最终配置。
- profile / 人格显示名不是机器人身份；实例标识不是 QQ 昵称。
- 插件隐藏 schema、数组字段覆盖不完整；未审查字段一律只读。
- 网页搜索的「模型原生」选项依赖插件检测：远程 HTTP 设备读不到插件列表时只显示内置提供商，属于安全降级。
- 网页搜索的 API Key 不回显；「测试 Key」会对对应官方搜索端点发一次真实请求（留空则测试该档案已保存的 Key），有少量额度消耗。
- 「测试模型原生搜索」也会真实调用一次模型；模型是否支持以实测为准（DeepSeek 官方目前仅 `deepseek-v4-pro` 支持 Responses `web_search`，`deepseek-flash` 会被忽略）。
- 向量 / 重排序模型不能通过本工具完成迁移（会明确拒绝）。
- 没有跨资源原子事务；恢复也是整对象回写，靠 revision 双检缩小竞态窗口。
- 远程写仅限 Agent 设备；HTTP / SSH 永远只读。
- DPAPI 不可用（非 Windows、域策略、受限环境）时设备密钥降级明文。
- 便携包只提供 Windows x64；其他系统只能源码运行且未经验证。
- 默认状态目录不可写时会回退到程序目录 `state/`；这时升级=替换目录会丢旧备份，升级前请先备份。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | 用户手册：界面导览、典型任务、环境变量、故障排查 |
| [docs/FAQ.zh-CN.md](docs/FAQ.zh-CN.md) | 32 条常见问题 |
| [docs/HANDOVER.zh-CN.md](docs/HANDOVER.zh-CN.md) | 设计与维护交接（开发者入口） |
| [docs/BUILD.zh-CN.md](docs/BUILD.zh-CN.md) | 便携包构建、校验、升级 |
| [docs/history/](docs/history/README.md) | 2026-10-29 评审 / 审计 / 多设备设计归档（历史快照，仅仓库内，便携包不含） |

## 开发与测试

```powershell
node --test --test-isolation=none     # 290 项测试（受限沙箱里 node --test 可能 spawn EPERM，用这个兜底）
node scripts/build-package.mjs        # 构建便携包到 dist/
node scripts/build-package.mjs --zip  # 另生成 zip
```

零第三方运行依赖、无前端构建步骤：`src/` 是 ESM 后端，`public/` 是原生 JS/CSS 前端，`test/` 是 `node:test` 测试。

### 目录结构

```
model-console/
├─ src/            后端模块
├─ public/         界面
├─ test/           测试
├─ scripts/        构建脚本
├─ docs/           文档（history/ 为历史归档）
├─ start-console-edit.cmd
└─ package.json
```

## 贡献

这是一个个人自用工具，按需迭代。提交前请确保：

1. `node --test --test-isolation=none` 全绿；
2. 改动后端后重启控制台，改动前端刷新即可；
3. 不提交 `state/`、`dist/`、任何 token / API Key / 备份。

## 许可

[MIT](LICENSE)。可自由使用、修改、分发，保留版权与许可声明即可。
