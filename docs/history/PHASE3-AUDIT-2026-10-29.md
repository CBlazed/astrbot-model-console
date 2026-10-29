# 第二阶段独立审计报告（远程写 / DPAPI / 真实浏览器）

- 审计角色：独立审计 worker（task-26），未参与第二阶段实现
- 仓库：`model-console`
- 审计对象：SPRINT-CONTRACT §9（Agent 写端点、Hub 远程写、DPAPI secrets、真实浏览器）与相关实现
- 日期：2026-10-29（UTC+08:00）
- 产出：更新 `test/sprint-integration.test.mjs`、`test/epic2-integration.test.mjs`；新建 `test/phase3-integration.test.mjs`（6 项：5 pass + 1 skip）与
  `docs/PHASE3-AUDIT-2026-10-29.md`
- 未改动：`src/`、`public/`、其他测试（含 `test/shutdown.test.mjs`）、`state/`；无 git commit
- 结论：**PASS，无 FAIL**；2 个 SKIP 均为本沙箱 DPAPI 管道限制（真实 DPAPI 已由 lead 在 full-access 下实测通过）；RISK-11 已通过 DPAPI 修复，遗留 4 项 RISK/文档偏差见 §6。

## 0. 最终数字

```powershell
cd "model-console"
node --test --test-isolation=none test/sprint-integration.test.mjs test/epic2-integration.test.mjs
# ℹ tests 30  ℹ pass 30  ℹ fail 0
node --test --test-isolation=none test/phase3-integration.test.mjs
# ℹ tests 6  ℹ pass 5  ℹ fail 0  ℹ skipped 1
node --test --test-isolation=none
# ℹ tests 290  ℹ pass 288  ℹ fail 0  ℹ skipped 2  ℹ duration_ms 3460.4479
```

- 全量 **290 tests / 288 pass / 0 fail / 2 skip**；2 个 SKIP 都是“真实 DPAPI 需要 Node→PowerShell 管道”，本沙箱被拒（`SECURE_STORE_UNAVAILABLE`），不是代码失败：
  1) 本报告新增的 `§9.3 真实 DPAPI…（本沙箱 Node→PowerShell 管道被拒）`；
  2) 既有 `test/secure-store.test.mjs` 的 `real DPAPI CurrentUser round-trips …`（# sandbox blocks Node→PowerShell piped stdio）。
- 审计起点全量 284（1 处失败=本审计旧断言 `/devices readOnly`），更新后全绿。

## 1. 旧断言更新（按 §9.2/§9.3）

1. `test/sprint-integration.test.mjs` Epic-1 `/devices`：
   - `readOnly:false` 对 **http 设备现强制 true**（§9.2 只有 agent 允许可写），断言改为 `writable.device.readOnly===true`；
   - `secrets.json` 改为兼容两种形态：解析后若所有值以 `dpapi:` 开头 → 断言文件不含明文 apiKey；否则按“DPAPI 不可用降级明文”断言存在 apiKey（响应/`devices.json` 仍不得含明文）。
2. `test/epic2-integration.test.mjs`：
   - SSH 设备 secrets 同样按 `dpapi:` / 明文降级分支；
   - Agent 配对：`secrets.json` 若为 `dpapi:` 密文则只校验密文形态 + `agent.json` 的 `tokenHash` 合法（无法在不解密时比对），明文降级时仍校验 `sha256(token)===agent.json.tokenHash`；两种分支都断言 `devices.json`/agent state 不含明文 token/pairingCode。
3. 未改动 `test/server-devices.test.mjs`（属 backend worker 的写作用域）。

## 2. 远程写端到端（独立验证 + lead 证据）

本审计 `test/phase3-integration.test.mjs` 用真实链路（真实 `startAgent({writeEnabled:true})` + 真实 `createServer` + 真实 `AgentAdapter` + 真实 `Engine` + 有状态 fake AstrBot gateway）：

```
POST /devices {kind:'agent', readOnly:false} + 真实 pairingCode → 200（device.readOnly=false, hasSecret=true，无 token/pairingCode）
GET  /snapshot?device=<id>        → writeEnabled=true, configVersion='4.29.3', device.kind='agent'
POST /plans?device=<id>           → 200 plan.id=UUID, changes=[{path, before:null, value:'llm-b', capability:null}], warning 非空、无路径
POST /apply?device=<id>           → 200 status='saved-and-readback-verified', backupId=UUID,
                                    hotLoad={verified:true, checked:true, marker:'[path]'（路径已脱敏）}
GET  /backups?device=<id>         → 200 {backups:[UUID],stats:{count,bytes},limits:{keep,maxBytes}}，无 internal/路径
本机无 device 的 /plans、/apply、/backups → 仍走 hub 自身 engine，不受远程写影响
```

交叉证据：fake AstrBot gateway 的 `writes.length===1` 且配置变为 `llm-b`（真实 Engine apply 写入+回读校验）；agent 侧 `backups.length===1` 且 audit 有 `applied`（backupId 绝对路径仅在 agent 本地审计）；agent `agent.json` 只有 hash（配对码不落库）。

lead 提供的真实 E2E 证据（与上述互补）：
- 真实 agent `--enable-writes` + 真实 hub + 有状态假 AstrBot：配对 → snapshot `writeEnabled:true` → `/plans?device` 200 → `/apply?device` 200（fake AstrBot 收到 PUT、`backupId` UUID、`hotLoad={verified:false,checked:true}`、agent 本地备份 1 份）→ `/backups?device` 200；
- hub `secrets.json` 为 `dpapi:`、无明文 token；agent `agent.json` 仅 hash。
- 说明：`hotLoad.verified` 取决于 agent 本机日志是否出现 reload 标记；本审计构造了含 `hot reload` 的日志故 `verified:true`，lead 的 fake 日志无标记故 `verified:false,checked:true`——两者都符合“不得无证据声称热加载”的契约口径。

## 3. 只读/权限矩阵（全部独立断言）

| 场景 | `/plans?device` | `/apply?device` | `/backups?device` | 证据 |
|---|---|---|---|---|
| http 设备（即使 POST `readOnly:false`） | 403 `DEVICE_READ_ONLY` | 403 `DEVICE_READ_ONLY` | 403 `DEVICE_READ_ONLY` | `src/server.mjs:373-384,476-484,513-522,548`；测试矩阵 |
| ssh 设备（同上） | 403 `DEVICE_READ_ONLY` | 403 `DEVICE_READ_ONLY` | 403 `DEVICE_READ_ONLY` | 同上 |
| agent 设备但 hub `readOnly:true` | 403 `DEVICE_READ_ONLY` | 403 `DEVICE_READ_ONLY` | **200**（是否开放由 agent 决定） | `src/server.mjs:379-384` 只要求 `kind==='agent'`；worker 测试与实现一致 |
| agent 进程无 `--enable-writes`（设备 `readOnly:false`） | 403 `AGENT_READ_ONLY` | 403 `AGENT_READ_ONLY` | 403 `AGENT_READ_ONLY` | `src/agent.mjs:235,245,257`；`src/agent-adapter.mjs:59-74`；hub `src/server.mjs:43-47` |
| 未知设备 | 404 `DEVICE_NOT_FOUND` | 404 `DEVICE_NOT_FOUND` | 404 `DEVICE_NOT_FOUND` | `src/server.mjs:373,379` |
| 本机（不带 device） | 200（本机 engine） | 200（本机 engine） | 200（本机 engine + warnings） | 独立测试“本机路径不变” |

说明：task-26 文字写“只读 agent/http/ssh 设备 /plans /apply /backups 403 DEVICE_READ_ONLY”。实测与契约 §9.2 更细：**hub 侧 readOnly 只限制 /plans 与 /apply；/backups 只限制“非 agent 类型”**，所以 hub-readOnly 的 agent 在有写权限的 agent 上仍可列备份；只有 agent 进程本身只读时 `/backups` 才 403 `AGENT_READ_ONLY`。本报告按契约/实现记录，建议契约补一句口径（见 DOC-01）。

## 4. DPAPI / secrets v2（§9.3）

实现：`src/secure-store.mjs`（`protect/unprotect`、`defaultRunner`、`isProtected`、`PROTECTED_PREFIX='dpapi:'`；值和密文只走 stdin/stdout base64，`src/secure-store.mjs:14-73`）；`src/devices.mjs`（`SECRETS_VERSION=2`、`setSecret` 失败降级、`getSecret` 兼容明文/密文、`migrateSecrets` 失败保留明文，`src/devices.mjs:148-196`）；server 启动时 `migrateDeviceSecrets` 自动迁移并写诊断（`src/server.mjs:625-637,660`）。

独立测试（`test/phase3-integration.test.mjs` 第 3 项）：
- fake runner：`protect('abk_secret_value') → dpapi:<base64>`（不含明文），`unprotect` 真往返；非字符串/非 dpapi blob fail-closed；
- `devices` v2：`setSecret` 写 `{version:2,secrets:{id:'dpapi:...'}}`，文件无明文；`getSecret` 用同一 runner 解密回明文；
- 迁移：旧明文 `{version:1}` → `migrateSecrets` 后 `migrated:['legacy']`、`plaintextRemaining:0`、文件为 `dpapi:`；runner 失败时 `failed:[{code:SECURE_STORE_UNAVAILABLE}]`、**旧明文保留**；
- 真实 DPAPI：本沙箱 `SECURE_STORE_UNAVAILABLE` → SKIP（原因见 §0）。lead 在 full-access 会话实测：`protect` → `dpapi:AQAA…`（334 chars，无明文）、`unprotect` 往返一致。

## 5. 真实浏览器证据（§9.4）

- 文件：`docs/assets/e2e-home-2026-10-29.png`
  - `95,859 bytes`；PNG 签名 `89504e470d0a1a0a`；`1440x1000`；`sha256=d52574aa8a9370d30445e5527a942506733fce04693f201ee043ea15334108e3`（本审计复算）。
  - `read_image` 目视确认：页面为真实“模型工作台”，含左侧导航（配置总览/AstrBot 本体/插件模型/模型库）、“快速开始”首启向导（控制台版本 0.1.0、数据目录/状态目录）、统计卡片（可用模型/配置资源/模型绑定/异常引用）、设备选择器（本机）、配置版本 <N>、核心配置卡片（onebot/bot1/全局默认配置）。
- lead 提供的 Chrome headless（非沙箱）DOM 检查：`title / overview / core / plugins / models / device-select / wizard / configVersion / fakeModel` 全部 true，`errorText` false。
- 本审计补充静态核对：`public/index.html` 存在 `id="overview|core|plugins|models|device-select|wizard|config-version"` 与“模型工作台”标题；`public/app.mjs` 含远程只读判定 `isRemoteSnapshot`。
- 局限：本审计**没有**重跑浏览器（沙箱 Chromium IPC 被拒，见 §8），只做文件/像素尺寸/视觉与 DOM 静态佐证；headless 结论以 lead 实测为准。

## 6. 优雅退出证据（不修改该测试）

现有 `test/shutdown.test.mjs`（不属于本审计写作用域，未改动）：真实子进程 `start()` → `process.emit('SIGINT')` → 断言退出码 0、`instance.lock` 已删除、`diagnostics.jsonl` 不含测试用 jwt secret。本轮全量运行中该用例通过（非 skip）。仍不能替代真实 Ctrl+C/任务管理器结束的验证（见 §8）。

## 7. RISK 状态与新增观察

| 编号 | 状态 | 说明/证据 |
|---|---|---|
| **RISK-11（原 P2）** | **已修** | `secure-store.mjs` + `devices.mjs` v2：`secrets.json` 优先 DPAPI，失败才降级明文并报告；迁移失败不删旧明文；真实 DPAPI 由 lead full-access 实测通过 |
| 02/03/04/05/06/07/08/09/10 | 已修（延续） | 见 `docs/EPIC2-AUDIT-2026-10-29.md` §3；本轮全量回归未回退 |
| NEW-RISK-01（P2） | 新增观察 | DPAPI 不可用时的**明文降级对 Hub 调用方是静默的**：`setSecret` 返回 `{protected:false,code:SECURE_STORE_UNAVAILABLE}`，但 `addDevice` 丢弃该报告，`/devices` 响应/UI 不提示；仅文件内明文 + 启动迁移诊断可见。建议在首启/设备列表显示“凭据未加密（DPAPI 不可用）” |
| NEW-RISK-02（P3） | 新增观察 | agent 的 `hotLoadEvidence.marker` 在 agent→hub 一跳是**未脱敏的原始日志行**（可能含本机路径）；hub 在 `publicHotLoad` 才做路径脱敏再给浏览器。持有 agent token 的本机进程仍可读到原始 marker；属本机信任边界内，建议 agent 侧也先脱敏 |
| NEW-RISK-03（P3） | 新增观察 | `/backups?device=<hub-readOnly agent>` 返回 200（由 agent 决定），与 task 文字“只读 agent `/backups` 403 DEVICE_READ_ONLY”不一致；实现/契约/worker 测试一致，属文字口径问题（见 DOC-01） |
| NEW-RISK-04（P3） | 新增观察 | `agent.mjs` 的写端点只在 `writeEnabled` 时开放（含 `/agent/v1/backups`），因此**只读 agent 完全无法列出本机备份**；契约 §9.1 标题即“仅 --enable-writes 时开放”，属预期口径，但用户可能期望只读也能看备份，建议文档明确 |

## 8. 与 BACKLOG / 文档的偏差（RISK，非代码 FAIL）

| ID | 级别 | 偏差 | 证据 |
|---|---|---|---|
| DOC-01 | P2 | `docs/BACKLOG-2026-10-29.zh-CN.md` 仍是第一阶段口径（21:44 版）：基线写 253/253；“未做”仍写“Epic-1/2 写侧未做、远程只读、RISK-11 明文未修、真实浏览器受沙箱限制、SIGINT 未验证”；与第二阶段实际（远程写已做、DPAPI 已修、真实浏览器 headless 通过、shutdown 测试通过）不符 | BACKLOG :190,:223-228；实测 290 tests、`docs/assets/e2e-home-2026-10-29.png` |
| DOC-02 | P3 | 真实浏览器与真实 DPAPI 的 E2E 证据由 lead 掌握，尚未落 repo 文档（`docs/EPIC3-AUDIT-2026-10-29.md` 不存在）；本报告 §4/§5 只是转述 + 静态/截图佐证 | `Test-Path docs/EPIC3-AUDIT-2026-10-29.md` = False |
| DOC-03 | P3 | task-26 对 `/backups?device` 与只读 agent 的 403 口径比契约 §9.2 更严，需在契约补一句“/backups 仅限制非 agent 类型；agent 自身只读时由 agent 返回 AGENT_READ_ONLY” | `src/server.mjs:379-384`、`src/agent.mjs:255-258`；worker 测试 `server-devices.test.mjs` §“writable agent routes” |
| DOC-04 | P3 | HANDOVER/README 对第二阶段（agent 写、DPAPI、远程写 UI）的描述仍极少（HANDOVER 仅 1 处、README 2 处相关词） | `docs/HANDOVER.zh-CN.md` 21:44 版；grep DPAPI/远程写 命中 1 |
| DOC-05 | P3 | git 基线仍无法从本进程核对（`dubious ownership`），阶段二 commit 状态需 lead 自查 | 本会话 `git status/log` 报 fatal dubious ownership |

## 9. 未覆盖边界（本审计未验证）

1. **真实浏览器**：本会话未重跑（沙箱 Chromium IPC/命名管道被拒）；§5 结论含 lead 的 headless 实测转述 + 截图/静态佐证。
2. **真实 SSH / 第二台 Windows 远端**：ssh 隧道仍只用注入 fake；未在真实网络/真实 ssh.exe/真实远端 dashboard 上验证隧道、端口发现、断线重连。
3. **干净 Windows 便携包启动**：未在无 Node 机器解压启动；`--zip` 未在本轮重建（Epic-3 静态/目录构建已由前轮审计覆盖）。
4. **SIGINT 真实人工中断**：`test/shutdown.test.mjs` 用 `process.emit('SIGINT')` 子进程验证通过；未验证真实 Ctrl+C/关闭控制台窗口/任务管理器结束的锁释放。
5. **DPAPI 真实用户环境**：本沙箱 SKIP；lead full-access 单点通过，未覆盖不同用户账户/漫游配置/服务账户/域环境。
6. **真实 AstrBot 写**：全程 fake AstrBot gateway（有状态但非真实 dashboard）；未触发真实 AstrBot `PUT`/热加载。
7. **并发/长时间**：未压测并发远程写、agent 重连、DPAPI 批量迁移、诊断/备份告警长期表现。
8. **git commit**：见 DOC-05。

## 10. 复审建议

1. lead 更新 BACKLOG §7/未做列表与 HANDOVER/README（DOC-01/DOC-04），并补 `docs/EPIC3-AUDIT-2026-10-29.md` 或工作记录承载真实浏览器/DPAPI E2E（DOC-02）。
2. 契约补 `/backups?device` 与只读 agent 的 403 口径（DOC-03）；若坚持“只读 agent 的 /backups 也 403”，需改 `agentBackupsDevice` 并同步 worker 测试。
3. 在 UI/设备列表提示“凭据未加密（DPAPI 不可用）”（NEW-RISK-01）；agent 侧对 `hotLoad.marker` 先脱敏（NEW-RISK-02）。
4. 真实 SSH/第二台 Windows 与干净 Windows 启动留作下一阶段验证；SIGINT 建议人工 Ctrl+C 一次留证。

## 11. 最终结论

- **远程写（Agent --enable-writes + Hub /plans /apply /backups by device）：PASS**，真实链路 E2E 通过；只读/权限矩阵与未知设备映射符合契约；本机路径不受影响。
- **DPAPI / secrets v2 / 迁移：PASS**（fake runner 全分支 + 真实 DPAPI lead full-access 实测；本沙箱 1 项 SKIP 已在报告标明原因）。
- **真实浏览器关键 UI：PASS（证据由 lead headless 提供 + 截图/静态佐证）**；本审计未独立重跑浏览器。
- **FAIL：0**。遗留 RISK 4 项（P2×1、P3×3）与文档偏差 5 项已在 §7/§8 列明；RISK-11 已关闭。
- 本报告与测试文件未改动 `src/`、`public/`、其他测试（含 `shutdown.test.mjs`）、`state/`；未执行 git commit。
