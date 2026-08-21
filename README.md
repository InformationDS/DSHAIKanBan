# AIKanBan for DSH

Trello 式项目看板插件：任务不分配给「人」，而分配给「对话」（DSH 会话）来完成。一个任务可由多条对话串行接力或并行探索，跨会话交接由用户确认过的版本化记忆承载。

所有 AIKanBan 相关文档、源码与产物已整理至 [`AikanBan/`](AikanBan/)。

## 核心概念

| 工作看板概念 | 本插件对应 |
| --- | --- |
| 成员（干活的人） | DSH 对话（会话），卡片挂「对话工作记录」，每条对话有独立详情页 |
| 卡片（任务） | 工作项：标题、目标、进度、下一步、阻塞原因，5 状态 |
| 列 | 状态流：未开始 / 进行中 / 已阻塞 / 已完成 / 已取消 |
| 交接文档 | 任务记忆（6 分区）+ 项目记忆（5 分区），用户确认后才生效，版本化 |
| 工作流规则 | 状态由用户最终决定；AI 只提建议，diff 审核后生效 |

## 产品形态

DSH 会话头部与「聊天」并列的**「📋 看板」全宽视图 Tab**（`conversation.view` 槽位）：5 列状态看板、卡片拖拽流转、工作项详情（对话时间线）、对话详情页、建议审核队列、项目记忆页、交接上下文生成。

v4 起：看板内可直接点「✨ 生成任务/项目记忆建议」，由当前会话 agent 起草并提交审核；工作项内「＋ 新建对话」会自动把最新交接上下文注入新会话作为首条消息（失败有降级提示 + 对话行手动「注入上下文」按钮兜底）。

## 核心原则（用户确认优先）

1. AI 生成内容永远是建议：agent 起草 → 用户在看板看 diff、编辑、确认或放弃 → 才成为正式记忆。
2. 未确认内容不进入交接上下文。
3. 同一范围（任务 = 同一工作项；项目 = 全局）同时只允许一条活动建议；基础版本被取代后旧建议自动过期。
4. 数据落盘工作区根目录 `.dsh-kanban.json`（单文件，gitignore，每台机器独立），跨会话、跨重启复用。

## 目录结构

```
AikanBan/
├── PRD.md                Codex 原版需求（AIKanBan MVP）
├── DSH-PRD.md            DSH 需求契约（v4：一键生成记忆建议、新建对话自动注入交接上下文）
├── PLAN.md               v3 执行方案（实现路径与验收清单）
├── PLAN-v4.md            v4 执行方案（机制核实、改动清单、验收用例）
├── REBUILD.md            新 DSH 会话重建插件指引
├── HANDOFF.md            跨会话交接上下文示例（由 kanban_get_handoff_context 生成）
├── aikanban-package/     插件源码包（package.json / cordis.patch.yml / lib/index.js(Host) / lib/client.js(Client)）
├── legacy/               v2 旧源码存档（.host-v2.js / .client-check.js，已被 aikanban-package 取代）
└── viz/                  产品形态交互模拟（mockup）
```

## 模型工具（9 个 kanban_*）

`kanban_view` / `kanban_create_work_item` / `kanban_update_work_item` / `kanban_start_memory_proposal` / `kanban_submit_memory_proposal` / `kanban_manual_edit_memory` / `kanban_get_handoff_context` / `kanban_bind_conversation` / `kanban_unbind_conversation`

## 使用方式

1. 在任意 DSH 会话（工作区 = 本仓库目录）中让 agent 按 [`AikanBan/REBUILD.md`](AikanBan/REBUILD.md) 重建插件并批准运行。
2. 会话头部出现「📋 看板」Tab；在聊天中让 agent 起草记忆建议，在看板审核确认。
3. 新会话继续同一工作项：让 agent 读 [`AikanBan/HANDOFF.md`](AikanBan/HANDOFF.md) 或直接调用 `kanban_get_handoff_context`，对话时间线自动出现新对话；v4 起在工作项内点「＋ 新建对话」会自动绑定并注入交接上下文，无需手动取数。