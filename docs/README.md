# Graph Vibe OpenCode — 文档索引与规则

> **单一入口**。写新文档前先看这里「放哪」；完成的及时归档。目的：防止文档越堆越多、无法维护。
> 最后更新：2026-06-27

## 文档地图

**活文档（持续更新，唯一来源）**
- [`STATUS.md`](./STATUS.md) — 现状 / 进度 / 环境搭建 / 路径速查（**唯一进度入口**）
- [`UPSTREAM-DIVERGENCE.md`](./UPSTREAM-DIVERGENCE.md) — 上游同步追踪 +「扩展不修改」总则 + merge 流程
- [`graph-port-principles.md`](./graph-port-principles.md) — 图移植 6 条治理原则（所有子项目受其约束）

**概念参考（稳定，少改）**
- [`graph-vibe/`](./graph-vibe/README.md) — 图核心抽象：README（总览）/ data-model / domain / workflow

**设计 spec（每子项目一份，活跃）**
- [`specs/2026-06-27-graph-storage.md`](./specs/2026-06-27-graph-storage.md) — 子项目 1：图存储地基

**实施计划（每子项目一份，活跃）**
- [`plans/`](./plans/) — writing-plans 产出放这（暂空）

**归档（已完成 / 过期）**
- [`archive/`](./archive/) — rename 的 spec + plan（已完成）

## 新文档放哪（规则）

| 类型 | 位置 | 何时产生 |
|---|---|---|
| 设计 spec | `specs/YYYY-MM-DD-<topic>.md` | brainstorm 产出 |
| 实施计划 | `plans/YYYY-MM-DD-<topic>.md` | writing-plans 产出 |
| 图 / 领域概念参考 | `graph-vibe/` | 稳定抽象、跨子项目复用 |
| 现状 / 进度 / 环境 | 直接改 `STATUS.md`（**不要新建**） | 每次进展 |
| 上游同步 / 分叉 | 直接改 `UPSTREAM-DIVERGENCE.md` | 动 opencode 原文件 / merge 上游时 |
| 已完成子项目 | `archive/` | 子项目上线后整体移入 |

## 维护纪律（防堆积）

1. **`STATUS.md` 是唯一进度入口**——别新建 status/progress 类文档，直接更新它。
2. **一子项目 = 一 spec + 一 plan**，文件名带日期，不另起散文件。
3. **完成即归档**：子项目上线后，把它的 spec + plan 移到 `archive/`，并在 `STATUS.md` 标记完成。
4. **概念只进 `graph-vibe/`**：跨子项目复用的抽象写进参考目录，不在各 spec 里重复散落。
5. **命名**：`YYYY-MM-DD-<kebab-topic>.md`；正文可中文，文件名用英文 kebab-case。
6. **定期修剪**：每次 merge 上游或阶段收官时，过一遍本索引——归档过期、合并重复、删失效链接。
7. **新增文档同时在本文档地图登记**一行，保证索引不脱节。
