# Sprint A/B/C 接口契约（2026-10-29）

实现者必须遵守本文件的字段/状态/路由约定；改契约先改本文件并在工作记录留痕。

## 1. 状态与语义

- `binding.status` 新增 `field-missing`：配置里**不存在**该路径（区别于“存在但为空”的 `empty-semantics-unverified`）。
- 快照新增字段 `routing`：`{total:number, platformLevel:number, granular:number}`；`granular>0` 表示存在非 `platform_id::` 精确路由，UI 必须提示“卡片仅代表平台级视图”。
- `/health` 响应扩展：`{status:'ok', version, dataPath, stateDir, readOnly, startedAt}`；仍需要 token。
- 下载/备份错误码：`BACKUP_*`、`RESTORE_*` 保持大写字母+下划线。

## 2. 控制台 API 增量

### GET /backups
```json
{
  "backups": [{"id":"uuid","createdAt":"ISO","bytes":123,"files":8,"sqlite":"ok"}],
  "stats": {"count":3,"bytes":12345},
  "limits": {"keep":10,"maxBytes":2147483648}
}
```
按 `createdAt` 倒序；只返回含 `manifest.json` 的 UUID 目录。

### POST /backups/prune
请求 `{ "keep": 5 }`（可省略，默认 env/10）。响应 `{ "removed": ["uuid"], "stats": {...} }`。不需要 `--enable-writes`，但必须 token + 同源校验。

### POST /restore-plans
请求 `{ "backupId": "uuid", "resource": {"kind":"profile|plugin|provider","id":"..."}, "expectedRevision": "..." }`  
响应与 `/plans` 同形状，额外：
```json
{ "mode":"restore", "backupId":"uuid", "changes":[{"path":"...","before":"...","value":"...","capability":"llm"}] }
```
`changes` 仅列已审查字段的差异；应用仍走 `POST /apply {id}`。恢复会覆盖该资源的完整对象，`warning` 必须写明。

### GET /backups/:id/diff?kind=profile&id=default
响应 `{ "backupId":"...", "resource":{...}, "changes":[...], "currentRevision":"..." }`；只读，不创建计划。

### GET /info（可选，若 /health 已含信息可不加）
返回与 `/health` 相同的非敏感信息。

## 3. 备份模块

- `backupStats(dest)` → `{count,bytes,items:[{id,bytes,createdAt}]}`。
- `pruneBackups(dest,{keep,protect})` 返回值增加 `bytes`。
- `listBackups(dest)` → 按时间倒序数组，元素含 `id,createdAt,bytes,files,sqlite`。
- `readBackupResource(dest,backupId,resource)` → `{config,file}`；找不到抛 `RESTORE_BACKUP_NOT_FOUND`，解析失败抛 `RESTORE_BACKUP_INVALID`。
- `backupState(...,{env,onWarning})`：`onWarning(code,details)` 用于清理失败/超限告警，不得抛给调用方。

## 4. 诊断日志

- 文件：`<state>/diagnostics.jsonl`；单文件 1 MiB，保留 3 个滚动文件（`diagnostics.1.jsonl`…）。
- 事件：`{time,level,event,code?,path?,status?,device?,detail?}`；**不得**包含 token、key、请求体、绝对路径、配置值。
- `logDiagnostic(stateDir,event)` 失败静默（不能影响主流程）。

## 5. 前端状态映射

- `field-missing` → 状态胶囊文案“字段不存在”，样式 `bad`。
- `routing.granular>0` → 顶部/本体区提示条（只提示，不阻止编辑）。
- 首启向导：仅当 `/health` 成功且本地无 `localStorage/sessionStorage` 的向导完成标记时显示；可跳过；不阻塞只读使用。
- 恢复入口：备份列表 → 选资源 → 看 diff → 生成计划 → 现有预览/确认/应用流程。

## 6. 文件写作用域（防冲突）

| Worker | 独占文件 |
|---|---|
| gateway-cache | `src/gateway.mjs`、`test/gateway.test.mjs` |
| engine-restore | `src/engine.mjs`、`src/backup.mjs`、`test/engine.test.mjs`、`test/backup.test.mjs` |
| server-diag | `src/server.mjs`、`src/diagnostics.mjs`、`test/server-ui.test.mjs`、`test/diagnostics.test.mjs` |
| frontend | `public/*`、`test/ui.test.mjs`、`test/a11y.test.mjs` |
| packaging（第二波） | `scripts/*`、`.gitignore`、`docs/BUILD.zh-CN.md` |
| devices（第二波） | `src/devices.mjs`、`src/http-adapter.mjs`、`test/devices.test.mjs`、`test/http-adapter.test.mjs` |

Lead 负责：`README.md`、`docs/HANDOVER.zh-CN.md`、`docs/BACKLOG-2026-10-29.zh-CN.md`、工作记录、集成测试。
