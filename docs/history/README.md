# 历史文档（只读归档）

这里归档 2026-10-29 当天评审、修复、审计过程中产生的过程性文档。它们记录**当时的判断与证据**，不是当前行为说明；其中提到的文件路径、测试数量（41 → 92 → 192 → 253 → 290）、启动脚本名称（`start-console.cmd` 已移除）可能已经过时。

当前有效的文档在上一级目录：

| 文档 | 用途 |
|---|---|
| [USAGE.zh-CN.md](../USAGE.zh-CN.md) | 用户使用手册 |
| [FAQ.zh-CN.md](../FAQ.zh-CN.md) | 常见问题 |
| [HANDOVER.zh-CN.md](../HANDOVER.zh-CN.md) | 设计与维护交接（开发者入口） |
| [BUILD.zh-CN.md](../BUILD.zh-CN.md) | 便携包构建与分发 |

## 归档清单

| 文件 | 内容 | 归档理由 |
|---|---|---|
| [REVIEW-2026-10-29.zh-CN.md](REVIEW-2026-10-29.zh-CN.md) | 初始设计缺陷评审（UI/UX + 模型切换器） | 评审结论已落地为 P0 修复，文档只保留原始判断 |
| [P0-AUDIT-2026-10-29.md](P0-AUDIT-2026-10-29.md) | P0 修复的独立审计报告 | 验收证据，非现行规范 |
| [SPRINT-CONTRACT.zh-CN.md](SPRINT-CONTRACT.zh-CN.md) | Sprint A/B/C 的交付合同与验收口径 | 合同已完成 |
| [SPRINT-AUDIT-2026-10-29.md](SPRINT-AUDIT-2026-10-29.md) | Sprint A/B/C 审计 | 同上 |
| [EPIC2-AUDIT-2026-10-29.md](EPIC2-AUDIT-2026-10-29.md) | Epic-2（SSH/Agent）与 Epic-3（便携包）审计 | 同上 |
| [PHASE3-AUDIT-2026-10-29.md](PHASE3-AUDIT-2026-10-29.md) | 远程写、DPAPI、浏览器 E2E 审计 | 同上 |
| [BACKLOG-2026-10-29.zh-CN.md](BACKLOG-2026-10-29.zh-CN.md) | P1/P2 待办与风险清单（当时快照） | 待办已大部分关闭，保留风险编号来源 |
| [DESIGN-multi-device-2026-10-29.zh-CN.md](DESIGN-multi-device-2026-10-29.zh-CN.md) | 多设备/远程写设计提案 | 其中安装器与自动更新方案已废弃（Epic-3 改为便携 node 包），正文不再代表实现 |

> 这些文件之间的相对链接仍按归档前路径书写，可能失效；需要追溯时以文件名和正文为准。
