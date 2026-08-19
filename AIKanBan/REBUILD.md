# AIKanBan for DSH — 新会话重建指引

动态插件随进程/会话生命周期存在，新 DSH 会话中需要重建一次（数据不受影响，始终在 `.dsh-kanban.json`）。

## 步骤（package 形态，现行）

当前插件源码以 package 形态维护在 `AikanBan/aikanban-package/`：

- `AikanBan/aikanban-package/lib/index.js` — Host 半（ES module，`export default plugin`，可直接作为 `code.host`）
- `AikanBan/aikanban-package/lib/client.js` — Client 半（`window.__ModuleLoader__.load` 打包形态，可直接作为 `code.client`）

1. 让新会话的 agent 读取以上两个文件（均经语法校验）作为 `cordis_define` 的 `code.host` / `code.client`。
2. `cordis_define`：kind `new`、idPrefix `kanbn`（任意 3-6 位小写字母前缀均可），name/purpose 自定。
   亦可通过 `AikanBan/aikanban-package/cordis.patch.yml`（bundle patch，插入 `aikanban` 条目）走标准 bundle 加载路径。
3. `cordis_run` 并请用户在页面批准运行。
4. 验证：`kanban_view` 应返回 workspace、工作项、对话（含真实标题与绑定关系）与建议；`kanban_get_handoff_context` 返回完整交接上下文（或直接读 `AikanBan/HANDOFF.md`）。
5. 之后该会话的看板操作会自动把本会话登记为工作项的「参与对话」，时间线上即出现第二段对话。

## 历史源码（v2，已存档）

旧单文件形态的 v2 源码已归档至 `AikanBan/legacy/`（`.host-v2.js` / `.client-check.js`），已被 `aikanban-package/lib/` 取代，仅供对照，不用于重建。

## 数据契约

- 数据文件：工作区根目录 `.dsh-kanban.json`（schemaVersion 1；v3 载入时自动 normalize 对话绑定字段，不升级 schema）。
- 工具：kanban_view / kanban_create_work_item / kanban_update_work_item / kanban_start_memory_proposal / kanban_submit_memory_proposal / kanban_manual_edit_memory / kanban_get_handoff_context / kanban_bind_conversation / kanban_unbind_conversation。
- 核心原则：记忆建议经用户在看板 diff 审核确认后才成正式记忆；状态由用户最终决定；同一范围同时一条活动建议。

## 需求事实源

- `AikanBan/PRD.md` — Codex 原版需求
- `AikanBan/DSH-PRD.md` — DSH 契约（v3，含绑定/解绑、真实标题、工作项内新建对话、UI 结构、对话建模、验证清单）
- `AikanBan/PLAN.md` — v3 执行方案（实现路径与验收清单）