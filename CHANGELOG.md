# 更新日志

本项目版本号取自 `package.json` 的 `version`。

## 0.2.2 — 2026-10-30

### 变更

- 仓库与文档维护整理；界面截图不再入库（README 已说明），`§9.4` 测试保留 DOM 契约。
- `src/identity.mjs` 的类别标签统一由平台 `type` 派生，身份相关测试数据改为通用示例。
- `test/epic2-integration.test.mjs` 的真实值扫描只读取显式 `ASTRBOT_DATA`，未设置时跳过。

### 测试

- 332 项全绿。

## 0.2.1 — 2026-10-30

### 修复

- Key 输入框不再在每次输入时重建卡片：输入不会丢焦点/滚动页面；新增「确认添加/替换 Key」按钮，Key 改动必须显式确认后才进入待应用变更。
- 备份表、远程设备表改为独立横向滚动 + `table-layout:auto`，修复窄列把「操作/选择恢复」挤成竖排文字的问题；新增 ≤1150px 时右侧变更面板下移的断点。
- 模型原生搜索的「测试」按钮：新增 `POST /search-native-test`，用真实 Responses `web_search` 请求验证所选模型是否真的会联网搜索（官方说明：DeepSeek 仅 `deepseek-v4-pro` 支持 Responses `web_search`，`deepseek-flash` 会被忽略）。
- 「测试 Key」对 DeepSeek 按官方文档口径提示错误：401 指向 `platform.deepseek.com` 检查或重建 Key，402 提示余额不足，429 提示 QPS 限制；成功时附带本次测试查询返回的结果条数；Key 行增加 DeepSeek 搜索 API 官方文档链接。

### 新增

- 「搜索使用模型」：在模型原生搜索下可指定固定搜索模型（写入 profile 的 `provider_settings.websearch_native_provider_id`，空=跟随当前聊天模型）；插件已同步升级到 v0.2.0 读取该字段。
- 发布流程：新增 `.github/workflows/release.yml`（推 `v*` tag 即在 windows-latest 上跑测试、构建便携包并发布 Release）与 `scripts/release-notes.mjs`（按「上一个 tag → 本次版本」从 CHANGELOG 生成发布说明）；发布说明缺失时构建失败，不发出空 Release。
- 测试 **330 项**（新增搜索模型字段、原生搜索测试客户端、Key 确认交互契约、DeepSeek Key 测试文案等）。

## 0.2.0 — 2026-10-30

### 新增

- 网页搜索设置支持编辑内置提供商的 **API Key**：9 个内置提供商按当前选择的提供商动态显示；多 Key 提供商支持每行一个（最多 20 个），Baidu 为单行 Key；支持「清空现有 Key」。
- 新增「测试 Key」按钮：调用 `POST /search-key-test`，服务端用填写的 Key（留空则用该档案已保存的 Key）向固定官方端点发一次最小搜索请求，返回成功/鉴权失败/额度限制/超时等脱敏结果；同一进程限制 20 次/分钟。
- 安全：快照、预览、草稿、冲突 diff、备份差异都不回显 Key 明文；快照仅返回 `configured/count`；测试结果不包含 Key；审计不记录 Key。
- 测试 **327 项**（新增 secret 字段、脱敏、Key 写入/清空、测试端点客户端等用例）。

### 修复

- 之前 0.1.4 里启动时 stale lock 的端口探测修复继续保留（锁记录端口 5 秒后仍不监听按 stale 清理）。

## 0.1.4 — 2026-10-30

### 新增

- 「AstrBot 本体」每个 profile 卡片新增**网页搜索**设置组：「启用网页搜索」开关 + 「网页搜索提供商」下拉；选中提供商会自动打开开关，两个字段在同一个预览/同一次保存中提交。
- 提供商下拉内置 AstrBot 的 9 个搜索提供商；只有读取到并启用 `astrbot_plugin_model_websearch` 时才追加「跟随当前聊天模型（模型原生搜索）」。
- 插件检测与安全降级：未安装/插件列表不可读时只显示内置提供商；已安装未启用时该选项置灰；后端 `plan()` 重新校验插件状态，拒绝不可用的 `model_native`。
- 引擎新增 setting 字段类型：布尔值写入前转真 boolean，枚举值按检测结果校验；恢复差异把布尔值统一成文本口径。
- 修复启动时 stale `instance.lock` 被 Windows pid 复用/EPERM 误判为“仍在运行”：当锁里的 pid 阶段存活、但记录的端口已不再监听且锁已超过 5 秒时，按 stale 清理；新增端口探测逻辑与测试。
- 测试 **313 项**（新增网页搜索设置、插件检测、降级、bool 转换、stale 锁端口探测等用例）。

## 0.1.3 — 2026-10-29

### 修复

- 「确认应用修改」对话框不再把引擎的固定免责声明渲染成红色错误框：apply 改为中性中文说明（多资源按顺序保存、保存+回读不等于模型生成），红色只保留给恢复（整对象覆盖）的破坏性警告。
- 新增 `planWarning()` 展示映射；测试 297 项。

## 0.1.2 — 2026-10-29

### 修复

- `--open` 自动打开浏览器不再依赖 `%TEMP%`：改为直接通过 PowerShell `Start-Process` 打开 URL。此前在受限环境（安全软件/HIPS 拦截程序写 `%TEMP%`）里，URL 交接文件写不进去，浏览器不弹出，看起来像“启动失败”——实际服务已启动。
- 启动窗口仍会打印带令牌的 URL；自动打开失败时的提示保留。

## 0.1.1 — 2026-10-29

### 修复

- 启动失败不再只打印 `Startup failed; verify local paths and Node version.`：现在输出真实错误码与信息（如 `EPERM`、`STATE_DIR_NOT_WRITABLE`、`LOCK_UNAVAILABLE`），并提示检查状态目录写权限。
- 状态目录启动预检与自动回退：默认 `%LOCALAPPDATA%\AstrBotModelConsole\state` 不可写时（安全软件/工作区策略拦截 `node.exe` 写 AppData、便携盘策略等），自动改用**程序目录下的 `state\`** 并打印警告；显式 `MODEL_CONSOLE_STATE` 不可写时报 `STATE_DIR_NOT_WRITABLE`，不静默改路径。
- 残留 `instance.lock` 清理增加重试（杀软/索引服务短暂占用）；仍失败报 `LOCK_UNAVAILABLE` 并提示手动删除，不再抛裸 `EPERM`。
- 新增 6 项测试（状态目录回退、显式目录失败、锁路径不可用、`start()` 回退集成），共 **296 项**。

### 已知限制

- 回退到程序目录 `state/` 后，升级替换目录会连带旧状态；升级前先备份 `state/`。

## 0.1.0 — 2026-10-29

首个可用版本。

### 功能

- 模型绑定总览：核心 profile 的 6 类绑定（主对话/压缩/视觉/STT/TTS/长期记忆图片描述）与 4 个插件的 15 个字段。
- 模型库：共享 provider、引用关系、推理强度（按后端能力目录放行，不从模型名猜测）。
- 安全编辑：草稿 → 预览 → 逐资源应用；revision 双重校验；冲突 diff；写前备份、写后回读。
- 备份与恢复：文件 SHA-256 + SQLite `quick_check`；保留份数与总大小上限；备份列表/清理/差异/恢复（整对象回写）。
- 审计与诊断：`audit.jsonl`、1 MiB 滚动诊断（脱敏、可导出、120 次/分钟限流）。
- 远程设备：HTTP（OpenAPI Key）、SSH（本机隧道 + 端口自动发现）、Agent（一次性配对码）；HTTP/SSH 只读。
- Agent 远程写入：目标机本地备份/审计、`hotLoad` 证据；Hub 侧统一脱敏。
- 安全：仅监听 127.0.0.1、随机端口、会话令牌、Host/Origin 校验、CSP、DPAPI 加密设备凭据。
- 便携包：内置 `node.exe`、单 `start.cmd`、逐文件 `SHA256SUMS.txt`、`--zip` 构建；无安装器、无自动更新。
- 可访问性：skip link、键盘操作、对比度与字号约束、语义化错误提示。
- 290 项 `node:test` 测试，Windows CI。

### 已知限制

见 [README 的「已知限制」](README.md#已知限制请按原文理解) 与 [HANDOVER 第 14 节](docs/HANDOVER.zh-CN.md)。
