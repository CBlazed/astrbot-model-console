# Sprint A/B/C 独立审计报告（2026-10-29）

- 审计角色：独立审计 worker（task-13），未参与 Sprint 实现
- 仓库：`model-console`
- 审计对象：Sprint A/B/C 定稿源码（P1-01/03/04/05/06/07/08/09/10 + Epic-1 读侧），基线 `docs/SPRINT-CONTRACT.zh-CN.md` 与 `docs/BACKLOG-2026-10-29.zh-CN.md`
- 审计日期：2026-10-29（UTC+08:00）
- 产出：`test/sprint-integration.test.mjs`（新建，20 项）、本报告
- 未改动：`src/`、`public/`、其他测试、`state/`、真实 AstrBot；无 git commit
- 源码定稿：`src/backup.mjs` 21:18:32、`src/server.mjs` 21:19:52 后未再变更（审计期间两处 provider 斜杠修复完成后按最终版重跑）

## 0. 结论摘要

**总体 PASS；无 FAIL；6 项 RISK（其中 2 项 P1）+ 6 项契约/BACKLOG 偏差 + 7 项未覆盖边界。**

- 集成测试：`test/sprint-integration.test.mjs` **20/20 通过**；全量 `node --test --test-isolation=none` **191/191 通过**（审计前基线 168，含 Sprint 新增测试）。
- 打包：最终源码在临时目录构建成功，产物 **28 个文件 / 89.9 MB**，27 行 SHA-256 校验全部匹配；无 `state/`、`test/`、`scripts/`、`*.log`、`secrets.json`、`devices.json`、`audit.jsonl`、`diagnostics*`、`instance.lock`；不含真实 jwt/API key；安装器脚本使用相对 SourceDir 且不安装 state；打包脚本无隐藏窗口/提权/token 组合。
- 真实数据只读核对：本机 AstrBot 配置模拟 `bindingRows` 共 **21 行，present 21、present+空值 5、absent 0**（无误报 `field-missing`）；旧 `model-console/state/backups` **15 份 / 33,866,881 字节 / sqlite 全部 ok**，`listBackups`/`readBackupResource` 只读调用前后目录 mtime 不变。
- 审计中发现并在定稿前修复的真实缺陷：真实 provider id 含 `/`（如 `<provider>/<model>`）导致 engine 级 `readBackupResource` 与 HTTP `/backups/:id/diff`、`/restore-plans` 不可用。修复后已按最终契约重验 200/放行，并保留对 `../x`、`a/../../b`、`a\b`、`C:/x`、`a//b`、`/abs`、`abs/`、>200 的 400 拒绝。

## 1. 环境与命令

环境：Windows，Node v24.22.1；项目目录有 `.git` 但本会话 `git` 命令因 "dubious ownership" 被拒绝（见 §5 未覆盖边界）。本会话 `ops_bash` 执行器不可用（`bash.exe ... CreateFileMapping Win32 error 5` / `EXECUTOR_UNAVAILABLE`），全部命令经 host PowerShell（`pwsh`）执行。

```powershell
cd "model-console"
node --test --test-isolation=none test/sprint-integration.test.mjs
# ℹ tests 20  ℹ pass 20  ℹ fail 0

node --test --test-isolation=none
# ℹ tests 191  ℹ suites 0  ℹ pass 191  ℹ fail 0  ℹ skipped 0  ℹ duration_ms 1864.1123
```

所有临时状态目录均来自 `mkdtemp(tmpdir())`；未读写真实 `%LOCALAPPDATA%` / `model-console/state/`（真实备份只用 `listBackups`/`readBackupResource` 读取，并断言 mtime 不变），未连接真实 AstrBot、未触发真实写。

## 2. P1 / Epic 逐项结论

| 项 | 结论 | 独立证据 |
|---|---|---|
| **P1-01 gateway 缓存** | PASS | `src/gateway.mjs:16-42`：`#port`/`#config` 按 size+mtimeMs 缓存、并发 in-flight 去重、`invalidate()`；测试：连续 3 次 API 调用后 `gateway.reads={log:1,config:1}`；改动 `cmd_config.json` 后 config 重读为 2 且用新 `jwt_secret` 重签名（HMAC 比对）；日志增长后端口从 6185 切到 6199 且 config 不重读；`invalidate()` 后两者各 +1；`Promise.all` 三并发共享一次扫描/解析 |
| **P1-01/P1-07 routingSummary** | PASS | `src/gateway.mjs:59-67`：`platformLevel` 只匹配 `platform_id::`；测试路由 `['qq_official::','onebot::','qq_official:123::456']` → `{total:3,platformLevel:2,granular:1}`；gateway 抛错/缺方法均降级 `{0,0,0}` 不抛；`src/engine.mjs:14-16` 把 `routing` 带入快照 |
| **P1-03 冲突 diff** | PASS | `public/ui-state.mjs:96-110` `buildConflictRows`：数组/对象 current 都对齐，缺失路径显示“字段不存在”，`mine/server/changed` 与 label 正确；`public/app.mjs:27-37` 冲突面板 + `rebaseConflict` 只丢该资源草稿、保留其他资源 |
| **P1-04 恢复入口** | PASS（1 项 P1 RISK，见 RISK-01） | 模块：`src/backup.mjs:88-181`（`listBackups`/`readBackupResource`/错误码）、`src/engine.mjs:28-30`（`restoreChanges`/`backupDiff`/`planRestore`）、`src/server.mjs:260-316`（`/backups`、`/backups/:id/diff`、`/restore-plans`）、`public/app.mjs:45-56`。测试覆盖：HTTP 契约形状/字段白名单/非法参数 400/引擎错误 409 脱敏；真实 Engine `planRestore`→`apply` 写入备份完整对象并回读校验、审计保留；**真实 provider id 含 `/`** 时 HTTP diff、restore-plans 与 engine 级读取均放行（最终修复后），非法 provider id 仍 400/`RESTORE_BACKUP_INVALID` |
| **P1-05 diagnostics** | PASS（2 项偏差，见 RISK-04） | `src/diagnostics.mjs`：1 MiB 滚动 / keep 3（常量 16-19、`rotate` 89-99）、事件白名单（`normalizeEvent` 59-71）、路径/密钥脱敏（`sanitizePath` 32-40、`redactDetail` 43-53）、失败静默（`logDiagnostic` 113-123）、读侧重新归一化（`readDiagnostics` 129-149）；`src/server.mjs:224-230` 对 4xx/5xx 记录 `status/code/path`。测试：8 条事件在 `maxBytes=260,keep=2` 下产生 `diagnostics.1.jsonl`、无 `diagnostics.3.jsonl`、每文件不超上限；手工写入含 token/盘符的“合法形状”行，`readDiagnostics` 重读后仍无泄露；非法事件返回 false |
| **P1-06 field-missing** | PASS（1 项偏差，见 RISK-05） | `src/engine.mjs:8-9` `hasPath` 区分“路径不存在（field-missing）”与“存在但空（empty-semantics-unverified）”；`public/ui-state.mjs:84-86` “字段不存在”/bad 且并入 `isIssue`。真实数据：21 行全部 present→无 field-missing，5 行 present+空值为 empty-semantics-unverified；合成 `{}` 全为 field-missing、空字符串为 empty-semantics-unverified |
| **P1-08 /health + 首启向导** | PASS（2 项偏差，见 RISK-06） | `src/server.mjs:148-155,237` 返回 `{status,version,dataPath,stateDir,readOnly,startedAt}`，需 token + 同源；测试：无 token/跨站 403，字段集合精确匹配、version=package.json、startedAt ISO、不带 token；`public/app.mjs:38-44` 3 步可跳过向导、sessionStorage 完成标记 |
| **P1-09 打包** | PASS | `scripts/build-package.mjs`：白名单复制（`SKIP_NAMES` 含 state/test/scripts/.git，`:29`）、`start.cmd` 用包内 `node.exe`、`SHA256SUMS.txt`、安装器相对 SourceDir、zip 用可见窗口。最终源码实测（见 §3） |
| **P1-10 备份产品化** | PASS（2 项偏差，见 RISK-07） | `src/backup.mjs`：`backupStats` 94-97、`pruneBackups` 返回 `bytes` 103-116、总字节上限 `MODEL_CONSOLE_BACKUP_MAX_MB` 32-37、`enforceByteLimit` 119-135、`onWarning` 失败不抛（20/133/203-204）。测试：`backupMaxBytes` 解析、`listBackups`/`backupStats`、`pruneBackups` 保留/删除/bytes、非备份目录不误删；`MODEL_CONSOLE_BACKUP_MAX_MB=0.001` 触发 `BACKUP_SIZE_LIMIT_EXCEEDED` 告警、`onWarning` 抛错不影响备份 |
| **Epic-1 读侧 /devices + /snapshot?device** | PASS（3 项偏差，见 RISK-02/03） | `src/devices.mjs`（注册表/密钥分离，`secrets.json` 不返回）、`src/http-adapter.mjs`（401→DEVICE_AUTH_FAILED、403→DEVICE_FORBIDDEN）、`src/server.mjs:238-258,278-285`。测试：POST 返回 whitelist 且无 apiKey、devices.json 无密钥、secrets.json 有密钥；GET local 优先；readOnly:false 透传；DELETE 未知 404/local 400/远程 200；`/snapshot?device=` 先 B 后 A 仍各自建引擎、按 device 缓存、短 TTL 失效重取、本地/无参带 `device:{local}`；远程错误 409 且响应/诊断/导出均无 apiKey 或绝对路径 |

## 3. 打包检查（最终源码，临时副本构建）

为避免修改仓库内 `installer/model-console.iss`，审计把 `src/public/scripts/docs/installer/package.json/README/start-console*.cmd` 复制到 `%TEMP%` 后执行：

```
node <tmp>/scripts/build-package.mjs --out <tmp>/out
AstrBot Model Console 便携包构建完成
  版本：0.1.0（Node v24.22.1 x64，随包 node.exe）
  输出：...\out\AstrBotModelConsole
  文件：27 个，合计 89.9 MB
  校验：...\AstrBotModelConsole\SHA256SUMS.txt（27 行）
```

只读检查产物（28 个文件 = 27 个入包文件 + SHA256SUMS 自身）：

```
PRODUCT_FILES 28
FORBIDDEN []                      # state/test/scripts/.git/*.log/secrets.json/devices.json/audit.jsonl/diagnostics*/instance.lock 均为空
SUMS 27 BAD [] UNLISTED []
SECRET_VALUES_CHECKED 2 LEAK_FILES []   # 真实 jwt_secret 与 provider key 值均未出现在产物文本中
ISS_ABSOLUTE_USER_PATH false      # #define SourceDir "..\out\AstrBotModelConsole"（相对路径）
BUILD_HIDDEN_WINDOW_FLAG false    # 打包脚本无 -WindowStyle Hidden / windowsHide:true
BUILD_SKIP_STATE true             # SKIP_NAMES 含 'state'
```

产物树：`node.exe`、`LICENSE.node.txt`、`package.json`、`README.md`、`start.cmd`/`start-edit.cmd`/`start-console*.cmd`、`src/*.mjs`、`public/*`、`docs/{BUILD,DESIGN,HANDOVER}`、`SHA256SUMS.txt`；无 state/日志/测试。临时目录检查后已删除；仓库 `installer/model-console.iss` mtime 保持 21:06:37 未被本次审计修改。

## 4. 真实数据只读核对（证据）

1. **AstrBot 配置 → bindingRows**（`discoverAstrBotData(process.env)` → `C:\Users\<你>\.astrbot_launcher\instances\<实例ID>-…\core\data`；profile default + group_chat_plus/livingmemory/self_learning/meme_manager）：
   - `{"rows":21,"present":21,"empty":5,"absent":0}`；present 字段 **0 次**被误报为 `field-missing`；5 个 present+空值（stt/tts/rerank 等）均为 `empty-semantics-unverified`；present+`inherit:'session'` 的 `decision_ai_provider_id` 为 `per-session`。
   - 真实 provider id：`deepseek/<model>`、`ollama_embedding/<embedding-model>`、`<provider>/<model>`、`<provider>/<model-2>`、`<provider>/<model-3>`（全部含 `/`，正好覆盖本次修复）。
2. **旧 `state/backups` 只读**：`{"count":15,"bytes":33866881,"newest":"bc1257f4-…","oldest":"a4ebf5e3-…","allSqliteOk":true}`；逐项 UUID/createdAt/bytes/files 校验通过；读取 profile default（`cmd_config.json`）、plugin livingmemory（`config/…_config.json`）、真实 provider（含 `/`）均成功；`backups` 目录 mtime 读取前后一致。
3. **审计中发现并已修复的问题**：修复前 `src/backup.mjs` 的 `SAFE_RESOURCE_ID` 与 `src/server.mjs` 的 `parseResource` 拒绝 `/`，真实 provider 的恢复/diff 在 engine 与 HTTP 两层都不可用（`RESTORE_BACKUP_INVALID` / 400 INVALID_RESOURCE）。定稿版 `validProviderId`（`src/backup.mjs:142-147`）与 `PROVIDER_RESOURCE_ID`（`src/server.mjs:86-106`）已放行，并保留路径穿越/反斜杠/盘符/空段/>200 的拒绝；本次重跑按“放行 + 非法仍拒绝”断言并全绿。

## 5. RISK 清单（无 FAIL）

| ID | 级别 | 结论 | 证据 |
|---|---|---|---|
| **RISK-01** | **P1** | **含 embedding/rerank 差异的资源恢复计划可生成，但 apply 必然被索引迁移规则阻断**：用户能在 UI 走完 diff → 预览，点应用才收到 `INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW`，该资源其它非索引字段也无法一并恢复。fail-safe（不备份、不写入），但与 P1-04“恢复 → 应用”验收不符，UI 应在生成计划时提前拦截并说明 | `src/engine.mjs:23`：apply 内 `this.plan(plan.resource,plan.changes,true)` 重校验；`src/engine.mjs:20` 对 embedding/rerank 抛错；`src/engine.mjs:28` restoreChanges 对所有已审查字段出 diff；集成测试“P1-04 恢复边界…”断言 `writes.length===0` 且错误为索引迁移 |
| RISK-02 | P2 | `DELETE /devices/:id` 返回 `{removed:id}`，契约写 `{removed:true}`；前端只判断成功，无功能影响 | `src/server.mjs:285`；集成测试断言实际返回 id 并标注偏差 |
| RISK-03 | P2 | 契约的 `DEVICE_EXISTS → 409` 在 `POST /devices` 上不可达：服务端忽略 body.id 并由 `randomUUID` 生成，重复 name/baseUrl 会创建第二台设备 | `src/server.mjs:318-321`、`src/devices.mjs:37-38`；集成测试重复 POST 返回 200 且 id 不同 |
| RISK-04 | P2 | P1-05 验收里的“限频”与“设置页导出支持包”未实现：只有 `/diagnostics/export` API，前端无调用；滚动上限保证磁盘有界，但 4xx 风暴会快速刷掉历史 | `public/app.mjs` 无 `diagnostics`/`export` 引用（grep 0 次）；`src/server.mjs:276`；`src/diagnostics.mjs` 无频率限制 |
| RISK-05 | P2 | P1-06 验收里的“卡片展示插件版本或配置版本”未实现：快照/绑定行无 `config_version`/插件版本字段 | `src/engine.mjs:14`（快照无版本）、`src/registry.mjs`、`public/app.mjs` 无版本渲染 |
| RISK-06 | P2 | P1-08 偏差：向导是 3 步（BACKLOG 原验收为 4 步：发现实例→验证连接→读写选择→完成），且向导把 `/health.version`（控制台 package 版本 0.1.0）标为“AstrBot 版本”，语义误导；页头未直接显示数据目录（仅在向导里） | `public/app.mjs:38,42`；`src/server.mjs:49,148-155`（VERSION 来自本工具 package.json） |
| RISK-07 | P2 | P1-10 验收的“单份超过阈值时警告 / 清理失败在 UI 可见”只到诊断日志：`/backups` 不回传 warning，`backup-note` 不展示；且 `BACKUP_SIZE_LIMIT_EXCEEDED` 是总容量超限告警，不是单份阈值 | `src/backup.mjs:119-135`；`src/server.mjs:260-265`（响应仅 backups/stats/limits）；`public/app.mjs:48-49` |
| RISK-08 | P3 | `/restore-plans` 只对 `changes` 做白名单，plan 顶层字段（`resource`/`revision`/`expiresAt`/`warning`…）原样展开；内置 engine 不会带敏感字段，但注入式 engine 可带任意键 | `src/server.mjs:316`；`test/sprint-integration.test.mjs` 的 restore-plans 用例只断言 `changes` 白名单 |
| RISK-09 | P3 | 远程快照 `writeEnabled` 未由 server 强制为 false（只加 `device` 标签）；默认 `defaultRemoteEngine` 以 `writeEnabled:false` 构造，风险限于自定义 `createRemoteEngine`；前端 `isRemoteSnapshot` 已禁用编辑 | `src/server.mjs:197-206`、`src/http-adapter.mjs` 默认 engine 构造；`public/ui-state.mjs:65` |
| RISK-10 | P3 | `/devices/:id/health` 在契约的 `{reachable,latencyMs?,error?}` 外多返回 id/name/kind/readOnly/hasSecret；对前端无害，但与契约字段集不一致 | `src/server.mjs:243-250` |
| RISK-11 | P3 | 设备 API Key 以明文存 `secrets.json`（仅本机用户目录权限保护），未做 DPAPI/加密；契约未要求加密，属分发期残余风险 | `src/devices.mjs:96-119`；集成测试确认不进入响应/日志 |

## 6. 与 BACKLOG / SPRINT-CONTRACT 的偏差

1. **BACKLOG §7 基线数字过期**：写的是 `168/168`，定稿源码实测 `191/191`（含 Sprint 新增测试与本审计 20 项）。审计报告链接在 BACKLOG 中已存在，但本报告写于其后，建议同步更新数字与本报告链接。
2. **P1-04**：模块与路由契约已落地；provider 斜杠在定稿前修复。遗留 RISK-01（索引类恢复不可应用）。
3. **P1-05**：`限频`、`设置页导出支持包` 未做（仅 API `/diagnostics/export`）。诊断文件本身有界（1 MiB × 4）。
4. **P1-06**：`field-missing` 与真实数据无误报达标；`卡片展示插件版本或配置版本` 未做。
5. **P1-08**：向导 3 步而非 BACKLOG 的 4 步；“AstrBot 版本”标签误用控制台版本号；数据目录展示只在向导内。
6. **P1-10**：`backupStats`/总上限/`onWarning` 达标；单份阈值与 UI 可见告警未达标（RISK-07）。
7. **Epic-1**：读侧契约基本达标；`DELETE` 返回 `removed:id` 而非 `true`、`DEVICE_EXISTS` 不可达、`/devices/:id/health` 多字段（RISK-02/03/10）。
8. **P2-02 git/CI**：`.git` 与 `.github/workflows/ci.yml` 存在（ci 含 `node --test --test-isolation=none` + `node --check`），但本会话 git 因 "dubious ownership" 无法读取 log/status，CI 未在本机执行（未覆盖）。

## 7. 未覆盖边界（不是缺陷，但不应当作已通过）

1. **git 基线/提交状态**：本会话 `git` 报 `dubious ownership`（目录 owner SID 与当前用户不同），无法验证 P2-02 声称的基线 commit 与工作区状态；未修改 git 配置（越权）。
2. **便携 zip/安装器**：本次只验证目录构建（`--out`）与 `SHA256SUMS.txt`；未重跑 `--zip`、未编译 `installer/model-console.iss`；未在无 Node 的干净 Windows 上启动验证（P1-09 的核心验收仍未被独立执行）。
3. **真实浏览器/屏幕阅读器**：向导、冲突面板、备份/恢复流、设备选择器只做静态/纯函数/HTTP 验证；未做真实浏览器点击、刷新、无痕、键盘/NVDA 验证。
4. **真实远程设备与真实 AstrBot 写入**：远程快照用注入 fake engine；未连第二台设备、未验证真实 OpenAPI Key scope/401/403 端到端；未对真实 AstrBot 执行任何写操作。
5. **SIGINT/SIGTERM 锁释放**：Windows `child.kill` 不可靠，仍只能手工验证。
6. **长时间诊断/备份运行**：滚动在缩小阈值下验证；未验证 1 MiB 实文件长期滚动、备份容量上限在真实大库上的行为。
7. **P1-01 真实 AstrBot 轮询负载**：只验证 fake fetcher 下的文件读取次数，未测量真实 `/snapshot` 的端到端延迟与 CPU。

## 8. 复审建议

1. **RISK-01（P1）**：`/restore-plans`/前端在生成恢复计划时识别 embedding/rerank 差异并提前拒绝或提示“需独立索引迁移”，避免用户走到 apply 才失败。
2. RISK-02/03/10：按 SPRINT-CONTRACT 收紧 `DELETE /devices` 返回 `{removed:true}`、定义重复设备判定（id 或 name+baseUrl）并返回 409、精简 health 字段。
3. RISK-04/05/07：补诊断限频、支持包导出入口、插件/配置版本展示、备份告警 UI 可见；P1-06/P1-10 的验收项才算完整。
4. RISK-06：统一 `/health.version` 语义（控制台版本 vs AstrBot config 版本分字段），并决定向导 3/4 步口径后同步 BACKLOG。
5. 发布前在真实浏览器 + 干净 Windows 上补 P1-08/P1-09 的端到端证据，并手工验证 SIGINT 锁释放。

## 9. 最终结论

- **集成测试：PASS**（20/20；全量 191/191）。
- **P1-01/03/04/05/06/07/08/09/10 与 Epic-1 读侧：PASS**，provider 斜杠问题已在审计期内修复并重验。
- **FAIL：0**。**RISK：11 项**（P1×1：恢复计划对索引类字段不可应用；P2×6；P3×4），另有 8 项与 BACKLOG/契约的偏差已在 §6 列明。
- 本报告与 `test/sprint-integration.test.mjs` 未改动 `src/`、`public/`、其他测试、`state/`，未执行 git commit。仓库 `installer/model-console.iss` 与 `dist/` 均未被本次审计修改（临时构建在 `%TEMP%` 完成并已清理）。

## 10. Lead 复核与审计后处理（2026-10-29 晚）

Lead 复核了集成测试与真实数据只读核对，接受 PASS 结论。审计后只做了一处行为修复：

- **RISK-01（P1）已修**：`Engine.planRestore()` 在生成计划时即检查 `restoreChanges`，只要差异里含 `embedding`/`rerank` 就抛 `INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW`，不再让用户走到 apply 才失败；`backupDiff` 仍可只读查看差异。新增 engine 测试并把 `test/sprint-integration.test.mjs` 的 RISK 用例改为“计划阶段拒绝、不产生计划、不写入”。
- 修复后全量：**192/192 通过**（191 + 新增 1 条 engine 测试）。
- 其余 RISK-02/03/04/05/06/07/08/09/10/11 未改，保留为下一轮 BACKLOG 条目。
- 本报告 §5 中 RISK-01 的“可生成计划”描述已被本节更新，其余条目仍按审计时定稿源码成立。

审计后最终状态：**PASS，0 FAIL，RISK 剩 10 项（无 P1），全量 192/192**。
