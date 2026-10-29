# AstrBot 模型切换器（Model Console）

本机优先的 AstrBot 模型管理工具，支持 HTTP/SSH/Agent 远程设备只读查看，可打包分发给其他用户（便携 node 包，无安装器）。Node.js 24.22+、零第三方运行依赖、ESM + JSDoc，不使用 Python。

**接手入口：[设计与维护交接文档](docs/HANDOVER.zh-CN.md)。** 该文档统一记录当前实现、维护流程、身份来源、API、测试、故障定位和已知限制。

**2026-10-29 文档：** [设计缺陷评审](docs/REVIEW-2026-10-29.zh-CN.md)、[P0 审计](docs/P0-AUDIT-2026-10-29.md)、[P1/P2 清单](docs/BACKLOG-2026-10-29.zh-CN.md)、[Sprint 审计](docs/SPRINT-AUDIT-2026-10-29.md)、[Epic-2/3 审计](docs/EPIC2-AUDIT-2026-10-29.md)、[第二阶段审计（远程写/DPAPI/浏览器）](docs/PHASE3-AUDIT-2026-10-29.md)、[多设备设计](docs/DESIGN-multi-device-2026-10-29.zh-CN.md)、[便携包构建](docs/BUILD.zh-CN.md)。

## 启动与构建

```powershell
cd 'model-console'
node --test --test-isolation=none   # 受限沙箱里 node --test 可能因 spawn EPERM 失败，用这个兜底
.\start-console.cmd                  # 只读
.\start-console-edit.cmd             # 允许保存（仍需预览+确认）

node scripts/build-package.mjs       # 便携包（含 node.exe + SHA256SUMS）
node scripts/build-package.mjs --zip # 另生成 zip
```

`ASTRBOT_DATA` 不再写死在脚本里：优先用环境变量，否则自动扫描 `%USERPROFILE%\.astrbot_launcher\instances\*\core\data` 与 `%USERPROFILE%\.astrbot\data`，唯一命中才自动使用。默认随机端口，仅监听 127.0.0.1。状态目录（备份/审计/锁/设备/诊断）默认在 `%LOCALAPPDATA%\AstrBotModelConsole\state`，可用 `MODEL_CONSOLE_STATE` 覆盖；项目内旧 `state/` 只提示、不迁移。令牌存 `sessionStorage`（刷新存活、关标签失效），URL 片段读取后清除。

## 当前能力

- 总览、本体/插件卡片、模型库、待应用面板、预览与确认、单资源保存与回读。
- 身份只来自 AstrBot 实例与平台级路由；default 是合法配置目标；闲置 profile 单独分组。
- 前台自动同步、草稿保留、冲突 diff 与“以最新值重新编辑”、只读/可写状态、脱敏审计。
- 推理强度按后端能力目录放行，不从模型名猜。
- 单实例锁；同一状态目录只允许一个控制台进程。
- 备份保留（默认 10 份，`MODEL_CONSOLE_BACKUP_KEEP`）+ 总大小上限（`MODEL_CONSOLE_BACKUP_MAX_MB`，默认 2048MB）+ 备份列表/清理/恢复入口（恢复会覆盖该资源完整对象）。
- 诊断日志 `diagnostics.jsonl`（1 MiB 滚动、保留 3 份、脱敏）。
- 远程设备：HTTP（OpenAPI Key）、SSH（本机 ssh 隧道 + 远端日志自动发现端口）、Agent（同程序 `node src/agent.mjs` 配对）。
- **Agent 远程写**（需目标 Agent `--enable-writes` 且设备勾选“允许远程写入”）：`/plans?device=`、`/apply?device=`、`/backups?device=` 代理到 Agent；备份/审计在目标机本地完成；apply 返回 `hotLoad` 证据（只有日志出现重载标记才 verified）。HTTP/SSH 保持只读。
- 设备凭据：Hub 侧 `secrets.json` 用 Windows DPAPI 加密（`dpapi:`），DPAPI 不可用时降级明文并在诊断留痕；Agent 只存 token/配对码哈希。
- 首启向导、设备选择器、远程设备健康徽标、配置版本；`/health` 返回控制台版本/数据目录/状态目录/读写模式。
- 真实浏览器验收截图：[docs/assets/e2e-home-2026-10-29.png](docs/assets/e2e-home-2026-10-29.png)（Chrome headless，fake AstrBot 数据）。
- 便携打包：内置 node.exe、SHA256SUMS、`--zip`；解压双击 `start.cmd`，无安装器、无自动更新（升级=替换目录）。

## 必须保留的边界

- 保存/回读成功不等于热加载或模型生成成功。
- 仅当前平台级路由视图；不完整解析会话/通配符路由（界面会提示 granular>0）。
- profile/人格显示名不是机器人身份；实例标识不等于 QQ 昵称。
- 插件隐藏 schema、动态调用和数组字段覆盖不完整。
- 向量/重排序切换需单独迁移；没有跨资源原子事务，恢复也是整对象回写。
- AstrBot 无原子 CAS；版本检查只能缩小竞态窗口。
- 远程写仅限 Agent（目标机本地备份与审计，热加载只能给证据、不保证）；HTTP/SSH 永远只读。
- DPAPI 不可用（非 Windows/域策略/环境限制）时设备密钥降级明文，只在用户目录权限下保护；分发时需知悉。
- 真实模型配置是用户可变状态，不按历史对话强制恢复。

## API 与源码

| 路径 | 用途 |
|---|---|
| GET /health | 健康 + version/dataPath/stateDir/readOnly |
| GET /snapshot[?device=] | 去密钥后的模型、资源、绑定、revision、routing |
| GET /capabilities?provider_id=... | 推理级别与核实状态 |
| POST /plans / POST /restore-plans | 修改/恢复预览计划 |
| POST /apply | 显式开启编辑模式后应用 |
| GET /backups、POST /backups/prune | 备份列表与清理 |
| GET /backups/:id/diff | 恢复前差异（已审查字段） |
| GET/POST/DELETE /devices、GET /devices/:id/health | 远程设备注册表 |
| GET /diagnostics/export | 诊断事件导出 |

静态资源之外所有路由需要本次工具令牌，并受 Host/Origin 校验。AstrBot JWT、OpenAPI Key 与上游密钥只在后端使用。

后端位于 `src/`，界面位于 `public/`，测试位于 `test/`，构建脚本位于 `scripts/`。状态目录含敏感备份/密钥，不可发布、上传或提交。
