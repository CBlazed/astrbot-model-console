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

## 5.1 设备（Epic-1 读侧）

- `GET /devices` → `{devices:[{id:'local',name:'本机',kind:'local',readOnly:boolean,hasSecret:false}, {id,name,kind:'http',baseUrl,readOnly,hasSecret:true}]}`；任何响应/日志都不含 apiKey。
- `POST /devices` body `{name,baseUrl,apiKey,readOnly?}` → `{device:{...}}`；`DEVICE_INVALID`/`DEVICE_SECRET_REQUIRED` → 400，`DEVICE_EXISTS` → 409。
- `DELETE /devices/:id` → `{removed:true}`；未知 id → 404 `DEVICE_NOT_FOUND`。
- `GET /devices/:id/health` → `{reachable,latencyMs?,error?}`；local 恒 `{reachable:true}`。
- `GET /snapshot?device=<id>`：无参数/local 返回本机快照；http 设备返回远程快照，并带 `device:{id,name,kind}`；远程快照只读、按设备缓存 5 秒；`DEVICE_UNREACHABLE`/`DEVICE_AUTH_FAILED`/`DEVICE_FORBIDDEN` → 409（details 白名单）。
- 前端：设备选择器选择状态存 `sessionStorage['model-console.device']`；远程只读时禁用编辑；快照缺 `device` 字段按本机处理。

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

## 7. Epic-2 契约（SSH / Agent，只读）

### 7.1 设备类型扩展

`kind` 取值 `http` | `ssh` | `agent`（另有内置 `local`）。

- **http**：`{name,baseUrl,apiKey}`（现有）。
- **ssh**：
  ```json
  {"name":"云主机","kind":"ssh","baseUrl":"http://127.0.0.1:6185",
   "apiKey":"abk_...","ssh":{"host":"1.2.3.4","port":22,"user":"Administrator","keyPath":"C:\\keys\\id_ed25519","dataPath":"C:\\AstrBot\\data"}}
  ```
  - `baseUrl` 写远端 dashboard 的 loopback 地址（端口可任意占位）；server 建 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` 隧道，用 `http://127.0.0.1:<local>` 调 API。
  - 给了 `ssh.dataPath` 时，用 ssh 执行 PowerShell 读远端 `logs/astrbot.log` 最后一条 `Starting WebUI at` 自动发现端口；发现失败报 `DEVICE_PORT_UNKNOWN`。
  - 隧道错误：`DEVICE_SSH_UNAVAILABLE`（本机无 ssh）、`DEVICE_SSH_FAILED`（握手/转发失败）。
- **agent**：`{name,kind:'agent',baseUrl:'http://127.0.0.1:PORT',pairingCode:'12345678'}` → Hub 调 `POST /agent/v1/pair` 换设备 token；token 只进 secrets.json，pairingCode 不落库。后续请求 `Authorization: Bearer <token>`。

### 7.2 Agent 进程

`node src/agent.mjs [--port=0] [--state=<dir>] [--enable-writes]`
- 默认只监听 `127.0.0.1`；启动打印 `{"url":"http://127.0.0.1:PORT","pairingCode":"...","expiresAt":"ISO"}`。
- 一次性配对码 8 位数字，10 分钟有效，配对成功即失效；配对失败限频 5 次/分钟。
- 端点：
  - `GET /agent/v1/health`（无需 auth）→ `{status:'ok',version}`
  - `POST /agent/v1/pair` `{code}` → `{token}`（64 hex）
  - `GET /agent/v1/snapshot`（Bearer）→ 本机 Engine 快照
- 状态文件 `<state>/agent.json` 只存 token 的 sha256 与配对码哈希/过期时间；不存明文 token。

### 7.3 Hub 行为

- `POST /devices`：按 kind 校验；ssh 需要 `ssh.host`/`ssh.user`；agent 需要 `pairingCode` 且会立即配对。
- `GET /devices/:id/health`：仅返回 `{reachable,latencyMs?,error?}`（不再附带设备字段）。
- `DELETE /devices/:id` → `{removed:true}`；关闭 ssh 隧道/清缓存。
- `GET /snapshot?device=`：ssh 走隧道 + HttpGatewayAdapter；agent 走 `/agent/v1/snapshot`；两者 `writeEnabled` 强制 false。
- 重复设备：同 kind + 规范化 baseUrl 已存在 → 409 `DEVICE_EXISTS`。

### 7.4 剩余 RISK 处理口径

| RISK | 口径 |
|---|---|
| 02 | `DELETE /devices` 返回 `{removed:true}` |
| 03 | 重复设备按 kind+baseUrl 409 |
| 04 | 诊断限频（120 events/min）；前端设置页加“导出诊断”按钮（GET /diagnostics/export） |
| 05 | 快照新增 `configVersion`（default 配置的 config_version）；UI 显示“配置版本” |
| 06 | `/health.version` 是控制台版本；UI 文案改为“控制台版本”，不要标成 AstrBot 版本 |
| 07 | `/backups` 返回 `warnings:[{code,time,message}]`（最近 5 条 BACKUP_* 诊断）；UI 展示 |
| 08 | `/restore-plans` 响应只回白名单顶层字段 |
| 09 | 远程快照 `writeEnabled` 强制 false |
| 10 | `/devices/:id/health` 只回 reachable/latencyMs/error |
| 11 | 不修，文档记录 secrets.json 明文风险（分发前提示） |

## 8. 本轮写作用域（Epic-2）

| Worker | 独占文件 |
|---|---|
| gateway-cache | `src/ssh-tunnel.mjs`（新建）、`test/ssh-tunnel.test.mjs` |
| server-diag | `src/agent.mjs`、`src/agent-adapter.mjs`（新建）、`test/agent.test.mjs`、`test/agent-adapter.test.mjs` |
| backend-platform | `src/devices.mjs`、`src/server.mjs`、`src/engine.mjs`、`test/devices.test.mjs`、`test/server-ui.test.mjs`、`test/server-devices.test.mjs`、`test/engine.test.mjs` |
| frontend-token | `public/*`、`test/ui.test.mjs`、`test/a11y.test.mjs` |
| frontend-a11y | `scripts/build-package.mjs`、`docs/BUILD.zh-CN.md`、`installer/`（删除）、`.gitignore` |
| auditor-p0 | `test/epic2-integration.test.mjs`、`docs/EPIC2-AUDIT-2026-10-29.md` |

Lead：契约、README/HANDOVER/BACKLOG、真实浏览器/冒烟/SIGINT 验证、工作记录、git 提交。
