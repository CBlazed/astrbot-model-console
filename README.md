# AstrBot 模型切换器（Model Console）

独立运行的本机模型管理工具。Node.js 24.22+、零第三方运行依赖、ESM + JSDoc，不使用 Python。已包含 JSON 后端和浏览器 UI。

**接手入口：[设计与维护交接文档](docs/HANDOVER.zh-CN.md)。** 该文档统一记录当前实现、维护流程、身份来源、API、测试、故障定位和已知限制；更新架构或行为时一起维护。

**2026-10-29 评审、P0 修复与改造提案：** [设计缺陷评审](docs/REVIEW-2026-10-29.zh-CN.md)（含 P0 修复状态）、[P0 独立审计](docs/P0-AUDIT-2026-10-29.md)、[P1/P2 待修复清单](docs/BACKLOG-2026-10-29.zh-CN.md)、[多设备与可分发改造设计](docs/DESIGN-multi-device-2026-10-29.zh-CN.md)（未实施）。

## 启动

```powershell
cd 'model-console'
node --test --test-isolation=none   # 受限沙箱里 node --test 可能因 spawn EPERM 失败，用这个兜底
.\start-console.cmd
# 需要编辑配置时使用：
.\start-console-edit.cmd
```

`ASTRBOT_DATA` 不再写死在脚本里：优先用环境变量，否则自动扫描 `%USERPROFILE%\.astrbot_launcher\instances\*\core\data` 与 `%USERPROFILE%\.astrbot\data`，唯一命中才自动使用；多个/零个会给出可读提示。默认随机端口，仅监听 127.0.0.1。状态目录（备份/审计/锁）默认在 `%LOCALAPPDATA%\AstrBotModelConsole\state`，可用 `MODEL_CONSOLE_STATE` 覆盖；项目内旧 `state/` 只提示、不迁移。启动脚本会打开带本次工具会话令牌的浏览器地址，前端读取后清除 URL 片段，令牌存 `sessionStorage`（刷新存活、关标签失效）。不要分享带令牌的链接或启动日志。

## 当前能力

- 总览、本体/插件卡片、模型库、待应用面板与应用前确认。
- 从真实AstrBot实例/路由读取身份信息；机器人实例与配置档案分开。
- 使用default的bot独立显示；闲置profile仅在未使用配置档案组出现。
- 核心与插件已审查字段的读取、能力校验、单资源修改、备份、API保存与回读。
- 前台自动同步、后台暂停刷新、草稿保留、冲突检查和脱敏审计。
- 共享provider推理强度能力查询；不从模型名猜支持级别。
- 单实例锁；同一状态目录只允许一个控制台进程。
- 备份默认保留最近 10 份（`MODEL_CONSOLE_BACKUP_KEEP` 可调）。

## 必须保留的边界

- 保存/回读成功不等于热加载或模型生成成功。
- 仅当前平台级路由视图；不完整解析任意会话/通配符路由。
- profile/人格显示名不是机器人身份；实例标识不等于QQ昵称。
- 插件隐藏schema、动态调用和数组字段覆盖不完整，不能宣称所有选项均已支持。
- 向量/重排序切换需单独迁移；没有一键回滚或跨资源原子事务。
- AstrBot无原子CAS，版本检查无法消除最后瞬间的外部竞态。
- 真实模型配置是用户可变状态，不按历史对话强制恢复模型或强度。

## API 与源码

| 路径 | 用途 |
|---|---|
| GET /health | 本工具健康检查 |
| GET /snapshot | 去密钥后的模型、资源、绑定和revision |
| GET /capabilities?provider_id=... | 推理级别与核实状态 |
| POST /plans | 修改预览计划 |
| POST /apply | 显式开启编辑模式后应用 |

静态资源之外所有路由需要本次工具令牌，并受Host/Origin校验。AstrBot JWT与上游密钥只在后端使用。

后端位于src/，界面位于public/，测试位于test/。state/包含敏感备份、审计、令牌启动日志，不可发布、上传或提交。详细模块和维护步骤见交接文档。
