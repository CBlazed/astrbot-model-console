# 更新日志

本项目版本号取自 `package.json` 的 `version`。

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
