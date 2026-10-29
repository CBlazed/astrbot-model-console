# AstrBot 模型控制台 · FAQ

一句话：这里回答“它能不能做、为什么这样、报错怎么自查”。答案只写代码和文档能支撑的内容；不确定的地方给出**自查方法**，不替程序猜结论。

> 配套阅读：`docs/USAGE.zh-CN.md`（完整使用说明）、`README.md`（能力与边界）、`docs/HANDOVER.zh-CN.md`（实现细节）。
> 通用免责：保存成功只代表“写入 + 回读一致”，不代表 AstrBot 已热加载，也不代表模型调用成功。

---

## 一、安装与启动

### Q1. 用便携包还要装 Node.js 吗？支持哪些系统？

**便携包不需要安装 Node.js**：包内自带 `node.exe`，双击 `start.cmd` 即可运行（`docs/BUILD.zh-CN.md`）。

| 使用方式 | 系统 | Node.js | 说明 |
|---|---|---|---|
| 便携包 | Windows x64 | 不需要（自带） | 解压即用，推荐普通用户 |
| 源码 | 开发基线是 Windows | `>=24.22`（`package.json` 的 `engines`） | 零第三方依赖，不需要 `npm install` |

便携包只提供 Windows 版本；源码虽为 Node ESM，但未在 macOS/Linux 做过完整验证，且设备凭据加密依赖 Windows DPAPI，其他系统会降级明文保存。

### Q2. 需要管理员权限或安装器吗？有自动更新吗？

都不需要，也没有。

- 便携包解压到普通用户目录直接用，不要放 `C:\Program Files` 这类需要管理员权限的位置；
- 没有安装器、没有自动更新、没有后台服务；
- 升级 = 关闭窗口后替换整个程序目录；
- 用户数据（备份/审计/设备凭据）不在程序目录里，替换程序不会丢。

### Q3. `start.cmd` 和 `start-console-edit.cmd` 有什么区别？怎么只读查看？

| 脚本 | 来源 | 等价命令 | 用途 |
|---|---|---|---|
| `start.cmd` | 便携包构建时生成 | `node.exe src\server.mjs --enable-writes --open` | 便携包唯一入口，编辑模式 |
| `start-console-edit.cmd` | 源码仓库 | `node src/server.mjs --enable-writes --open` | 源码开发入口，编辑模式 |

两者的“编辑模式”都**不会自动保存**：保存仍要在网页里预览并勾选确认。

只想看、不想误改时用只读模式：

```powershell
cd <model-console 源码目录>
node src/server.mjs --open
```

只读模式下保存与恢复被禁用，但可以浏览配置、切换设备、导出诊断。

### Q4. 每次端口都不一样，能固定吗？

默认 `MODEL_CONSOLE_PORT=0`，由操作系统分配随机回环端口（只监听 `127.0.0.1`），这是刻意设计。

需要固定时，在启动前设置环境变量：

```powershell
$env:MODEL_CONSOLE_PORT = '6185'
.\start-console-edit.cmd
```

若端口已被占用，启动会失败；删掉变量改回随机端口即可。

### Q5. 启动窗口里的 token 是什么？需要填 AstrBot 的密钥吗？

它是**本次工具会话令牌**，只用于浏览器访问这个控制台；不需要填 AstrBot 的 JWT / OpenAPI Key。

- 令牌存在浏览器 `sessionStorage`：同一标签页刷新仍在，**关闭标签失效**；
- URL 里的 `#token=...` 读取后会立即清除；
- 从不写入 `localStorage`，也不写日志；
- 不要分享启动窗口里的 URL/令牌——拿着它就能操作本机控制台。

---

## 二、使用与保存

### Q6. 改了模型并保存成功，为什么 AstrBot 行为没变？

因为“保存成功”只代表两件事：写入了 AstrBot 配置接口，并且回读结果与预期一致。它**不保证**热加载，也**不保证**模型可调用。

自查顺序：

1. 看页面提示：是“已保存并回读 N 个配置资源”，还是报错；
2. 如果你用的是远程 **Agent**，看返回的 `hotLoad` 证据：
   - `verified:true`：Agent 在本机 `logs/astrbot.log` 尾部发现了重载标记；
   - `verified:false, checked:true`：检查过日志但没发现标记；
   - `checked:false`：没有检查（例如未提供数据目录）。
3. 看 AstrBot 自己的日志是否出现重载记录；
4. 仍不生效时，重启 AstrBot（本工具不会重启它）。

> `hotLoad.verified:true` 也只是“日志证据”，不等于模型生成成功；`verified:false` 也不等于失败，可能只是日志还没出现标记。

### Q7. 能一次改多个资源吗？是原子操作吗？

可以暂存多处修改，右侧“待应用变更”里会按资源分组，预览后**按资源顺序逐个保存**。

但**不是原子事务**：

- 任何一处失败就停止后续保存；
- 已保存的资源不会自动回滚；
- AstrBot 也没有原子 CAS，版本双检只能缩小并发窗口；
- 恢复操作同样是“整对象回写”，不是事务。

### Q8. 哪些能改、哪些不能改？能新增 provider 或改 API Key 吗？

工具只开放**已审查**字段（`src/registry.mjs`），其余只读：

| 对象 | 能改 | 不能改 |
|---|---|---|
| profile（全局/账号配置） | 主对话、压缩、图片描述、语音识别/合成、记忆图片描述等已登记绑定；网页搜索开关与提供商（含模型原生，需检测到并启用对应插件）；内置搜索提供商的 API Key（永不回显，支持清空与测试） | 未审查字段、动态 schema、数组字段 |
| 插件配置 | 已登记的任务模型绑定（群图片识别、记忆向量/重排序、学习过滤/精炼/强化等） | 未审查字段；向量/重排序切换需单独索引迁移，工具只拦截 |
| 共享 provider | 仅 `custom_extra_body.reasoning_effort`（推理强度，按后端能力目录放行） | 密钥、地址、模型名等其它字段 |

工具**不创建/删除 profile 或 provider，不编辑人格（persona）**，也不改 provider 凭证。

### Q9. 备份里有什么？能从备份恢复数据库吗？

每次应用前会备份：

- `cmd_config.json`；
- `data/config` 下全部 JSON；
- `data_v4.db` 的在线拷贝；
- `manifest.json`（逐文件 SHA-256 + SQLite `quick_check` 结果）。

但**恢复流程只回写被恢复资源的 JSON 配置**，不会把 SQLite 文件覆盖到运行中的 AstrBot。插件自己的数据库（如自学习 `messages.db`）、图片、向量索引也不在备份范围。

### Q10. 恢复会不会覆盖别人刚做的修改？能撤销吗？

有风险。恢复是**整对象回写**：备份里的配置会整体覆盖目标资源，只有列出的已审查字段差异经过校验。

- 工具在计划创建、应用前、写前备份后做版本双检，但这不是原子事务，仍有外部并发修改的窗口；
- 恢复前请先看“查看差异”，并在预览里确认“会覆盖完整对象”的警告；
- **没有自动回滚**；需要撤销时，只能再用更早的备份生成一次恢复计划。

### Q11. 能让多个控制台同时开吗？

同一个状态目录只允许**一个**实例（`instance.lock` 单实例锁），第二个启动会报 `ANOTHER_INSTANCE_RUNNING` 并以退出码 1 结束。

给不同实例设置不同的 `MODEL_CONSOLE_STATE` 技术上能同时运行，但它们可能同时对同一个 AstrBot 写入，冲突风险由使用者承担，不建议这样做。

---

## 三、远程设备

### Q12. 远程设备能写入吗？需要什么条件？

**HTTP 和 SSH 永远只读**。只有 **Agent 设备**可能可写，并且要同时满足：

1. Agent 端以 `--enable-writes` 启动；
2. Hub 添加设备时勾选“允许远程写入”；
3. 快照返回 `writeEnabled:true`（Hub 还会再校验一次）。

任一条件不满足，写请求会被拒绝（`DEVICE_READ_ONLY` / `AGENT_READ_ONLY`）。

### Q13. 连接 HTTP 设备需要准备什么？

- 远端 AstrBot 已启动，dashboard 地址可达（例如 `http://192.168.1.20:6185`）；
- 一个 AstrBot **OpenAPI Key**（通常以 `abk_` 开头），且具备读取配置/实例所需 scope。

常见错误与处理：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `DEVICE_UNREACHABLE` | 地址不通/远端没开 | 在 Hub 机器上确认目标 AstrBot 与 dashboard 可访问 |
| `DEVICE_AUTH_FAILED` | Key 错或已被撤销 | 重新生成/更新 OpenAPI Key |
| `DEVICE_FORBIDDEN` | Key 缺少所需 scope | 检查 Key 的授权范围 |

HTTP 设备的快照会按设备缓存约 5 秒，且始终只读。

### Q14. SSH 设备连不上？能用密码登录吗？

**不能用密码**。程序以 `ssh -N -L ... -o BatchMode=yes` 运行，不会弹出密码提示，因此目标机必须已配置**免交互的公钥登录**（密钥或 ssh-agent）。

自查：

```powershell
# 在本机确认 ssh 可用、可以免密登录
ssh -p 22 -i C:\Users\你\.ssh\id_ed25519 用户名@主机 "echo ok"
```

| 错误码 | 含义 | 处理 |
|---|---|---|
| `DEVICE_SSH_UNAVAILABLE` | 本机找不到 `ssh` 命令 | 启用 Windows 可选功能“OpenSSH 客户端” |
| `DEVICE_SSH_FAILED` | 握手/转发失败 | 检查主机、端口、用户、私钥路径与合作方 sshd 配置 |
| `DEVICE_PORT_UNKNOWN` | 无法从远端日志发现 dashboard 端口 | 填写“远端数据目录”让程序从 `Starting WebUI at` 发现，或在地址里直接写对端口 |

### Q15. Agent 设备和 HTTP 设备有什么区别？配对码怎么用？

| 维度 | HTTP / SSH 设备 | Agent 设备 |
|---|---|---|
| 对端程序 | 远端 AstrBot dashboard | 远端另跑本程序的 `node src/agent.mjs` |
| 认证 | AstrBot OpenAPI Key | 一次性配对码换设备 token |
| 写入 | 永远只读 | 两侧都开启后可用 |
| 热加载证据 | 无 | apply 返回 `hotLoad` 日志证据 |

在目标机器启动 Agent：

```powershell
# 默认只读；加 --enable-writes 才允许远程保存
node src/agent.mjs --port=0 --state D:\AstrBotModelConsole-agent
```

启动窗口会打印 `{"url":"http://127.0.0.1:PORT","pairingCode":"12345678","expiresAt":"..."}`。

配对码规则（`src/agent.mjs`）：

- 8 位数字、**10 分钟有效、配对成功即失效**；
- 配对失败限频：5 次/分钟，超出返回 429；
- Hub 保存设备 token（DPAPI 加密），Agent 端 `agent.json` 只存 token 哈希与配对码哈希/过期时间，不存明文。

### Q16. 换电脑或换 Windows 用户后，远程设备为什么连不上了？

设备凭据用**当前 Windows 用户的 DPAPI** 加密（`dpapi:<base64>`）。把状态目录搬到另一个用户/另一台机器后，通常无法解密原凭据，设备会表现为认证失败或不可用。

处理：删除该设备并重新添加（HTTP 重新填 OpenAPI Key，Agent 重新配对）。如果 DPAPI 不可用，程序会降级明文保存并在诊断里留痕。

---

## 四、安全与隐私

### Q17. 工具会把配置或密钥上传到网上吗？

工具本身不访问外网：

- 读取本机 AstrBot 的 data 目录，调用本机 dashboard API（从 `logs/astrbot.log` 的 `Starting WebUI at` 取得端口）；
- 浏览器只与本机 `127.0.0.1` 通信（CSP `connect-src 'self'`）；
- 远程设备只连接你手动填写的地址。

是否让远程设备可达，取决于你自己的网络配置。

### Q18. 状态目录能分享给别人吗？`secrets.json` 是明文吗？

**不能分享**。状态目录里有备份（含配置内容）、审计、诊断、设备清单、设备凭据。

`secrets.json` 在 Windows 正常环境下是 `dpapi:<base64>` 密文；只有 DPAPI 不可用时才降级明文（非 Windows、域策略限制等），程序会在诊断里留痕。看到明文说明当前环境 DPAPI 不可用，请把状态目录放在受保护的用户目录，并在可用环境中重新保存设备以重新加密。

### Q19. 为什么杀毒软件会对 `.cmd` 报警？

便携包/构建脚本会调用 `node.exe` 和 Windows 自带的 PowerShell（如 `Compress-Archive`），这类“脚本启动本地程序”的组合有时会被启发式规则误判。

自查：

```powershell
# 在解压目录按 SHA256SUMS.txt 校验（脚本见 docs/BUILD.zh-CN.md）
Get-Content SHA256SUMS.txt | Select-Object -First 3
```

只从可信来源获取分发包；本工具没有隐藏窗口、提权、停止进程之类的脚本。

---

## 五、报错与处理

### Q20. 页面提示 `ACCESS_DENIED` 怎么办？

说明请求没有通过鉴权或同源校验。常见原因：

- 用了旧的启动窗口令牌（程序重启后令牌会变）；
- 浏览器残留旧标签页 / 端口已变；
- 请求不是从同源页面发出（跨站请求会被拒绝）。

处理：回到最新启动窗口，用其中的 URL/令牌重新连接。前端收到 `ACCESS_DENIED` 会自动清掉旧令牌并显示连接表单。

### Q21. 提示 `CONCURRENT_CHANGE` 怎么办？

表示配置在你编辑期间被其他面板/工具改了，或草稿基线已过期。

页面会弹出冲突面板，按“字段 / 我的值 / 服务器当前值”展示差异：

- “稍后处理”暂时收起；
- “以最新值为基线重新编辑”会丢弃**该资源**的旧草稿并重新读取，**其他资源的草稿保留**，然后重新选择并预览。

### Q22. 提示 `VERIFY_FAILED` / `possibly-written` 怎么办？去哪看真相？

| 提示 | 含义 |
|---|---|
| `VERIFY_FAILED` | 写入后回读与预期不一致：可能没写成功，也可能被外部并发改掉 |
| `possibly-written` | 写请求发出后出现异常，**结果不确定** |

处理原则：**先核对，再决定是否重做，不要直接重复提交**。

| 想看什么 | 位置 |
|---|---|
| 写入历史、备份路径 | 状态目录 `audit.jsonl` |
| 每次写入前的快照 | 状态目录 `backups/<uuid>/`（含 `manifest.json`） |
| 脱敏诊断（接口错误等） | 状态目录 `diagnostics.jsonl`，或页面“导出诊断” |
| 启动信息、令牌、错误提示 | 启动窗口（命令行） |
| 单实例锁 | 状态目录 `instance.lock` |

状态目录默认在 `%LOCALAPPDATA%\AstrBotModelConsole\state`，可用 `MODEL_CONSOLE_STATE` 覆盖。

### Q23. 启动报 `ANOTHER_INSTANCE_RUNNING` / `ASTRBOT_DATA_REQUIRED` / 端口被占怎么办？

| 错误 | 原因 | 处理 |
|---|---|---|
| `ANOTHER_INSTANCE_RUNNING` | 同一状态目录已有存活实例 | 复用已打开的窗口，或先关闭旧实例；崩溃残留的锁会按“pid 不存活”在下次启动自动清理 |
| `ASTRBOT_DATA_REQUIRED` | 未设 `ASTRBOT_DATA` 且自动发现到 0 个或多个 data 目录 | 用环境变量指定唯一目录后重启 |
| 固定端口启动失败 | `MODEL_CONSOLE_PORT` 端口被占用 | 删除该变量改用随机端口，或换端口 |
| `INVALID_SESSION_TOKEN` | 手设的 `MODEL_CONSOLE_SESSION_TOKEN` 格式不对 | 删除该变量，或改成 64 位小写 hex |

指定 data 目录：

```powershell
$env:ASTRBOT_DATA = 'C:\Users\你\.astrbot_launcher\instances\<实例ID>\core\data'
.\start-console-edit.cmd
```

`data` 目录里应有 `cmd_config.json`；本工具只读它，不会改写 AstrBot 程序。

### Q24. 提示 `EFFORT_UNVERIFIED_OR_UNSUPPORTED` / `CAPABILITY_UNVERIFIED_OR_MISMATCH` 怎么办？

- `EFFORT_UNVERIFIED_OR_UNSUPPORTED`：该模型不支持所选推理强度，或后端能力目录读不到（工具不按模型名猜档位）。到“模型库”重新查询后选择真实返回的档位。
- `CAPABILITY_UNVERIFIED_OR_MISMATCH`：目标模型能力与任务不匹配（例如把纯文本模型选给图片识别）。换一个能力匹配且已启用的模型。
- 若怀疑模型本身有问题：先到 AstrBot 侧确认模型存在且已启用，再回控制台刷新重试。

### Q25. 升级/卸载后备份和配置会丢吗？

不会，程序目录与用户数据分开：

- 程序目录：`node.exe`、`src/`、`public/`、`start.cmd` 等，升级就是替换它；
- 用户数据：状态目录（备份/审计/诊断/设备凭据）与 AstrBot 的 data 目录，都不在程序目录内；
- 升级不会覆盖用户数据；卸载删除程序目录即可，状态目录是否删除由你决定（里面可能有你想保留的备份）；
- 本工具不修改 AstrBot 安装目录，卸载它不影响 AstrBot 本身。

> 删状态目录前请先确认没有要保留的备份；`secrets.json` 也在其中，删除后远程设备需要重新添加或配对。

---

## 六、自查清单（不是问题，遇到状况照着做）

1. **先看启动窗口**：程序还在运行吗？窗口里有没有 `ANOTHER_INSTANCE_RUNNING`、`ASTRBOT_DATA_REQUIRED`、`INVALID_SESSION_TOKEN` 之类的错误？
2. **再看模式胶囊**：`只读模式` 说明启动时没加 `--enable-writes`；`远程 · 只读` 说明当前选中的是只读设备。
3. **看页面顶部提示**：错误码会显示在消息区；`ACCESS_DENIED` 先重新连接，其他错误码按本文对应条目处理。
4. **看 AstrBot 自身状态**：dashboard 是不是还活着？日志最后一条 `Starting WebUI at` 的端口是否变化？（工具每次刷新会重新读日志；读不到就会显示断线并保留草稿。）
5. **保存类错误先核对再重试**：查 `audit.jsonl` 与 `backups/`，确认“到底写没写进去”，不要直接重复提交。
6. **远程设备先分清类型**：HTTP/SSH 只读是设计如此；要远程写只能是 Agent，并且 Agent 端与 Hub 勾选都要开启。
7. **需要支持材料时**：从页面“导出诊断”下载脱敏事件 JSON；**不要**把 `state/` 整个目录、`secrets.json` 或含 token 的启动 URL 发给别人。
8. **升级前**：关闭窗口，确认状态目录位置；替换程序目录后重新启动，再验证 `/health` 与一次只读刷新是否正常。

如果以上都做完仍然异常，记录“当时点的按钮、页面错误码、启动窗口输出、AstrBot 是否有新日志”，再交给维护者定位——这些信息比反复重启有用。

