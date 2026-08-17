# AIKanBan for DSH — 新会话重建指引

动态插件随进程/会话生命周期存在，新 DSH 会话中需要重建一次（数据不受影响，始终在 `.dsh-kanban.json`）。

## 步骤

1. 让新会话的 agent 读取以下两个源码文件（均经 `node --check` 校验）：
   - `.host-v2.js` — Host 半（去掉首行 `async function __b() {` 与末尾 `}` `__b` 两行包装）
   - `.client-check.js` — Client 半（同样的包装规则）
2. `cordis_define`：kind `new`、idPrefix `kanbn`（任意 3-6 位小写字母前缀均可），name/purpose 自定，把上面两个函数体分别作为 `code.host` / `code.client`。
3. `cordis_run` 并请用户在页面批准运行。
4. 验证：`kanban_view` 应返回 workspace、工作项、对话与建议；`kanban_get_handoff_context` 返回完整交接上下文（或直接读 `HANDOFF.md`）。
5. 之后该会话的看板操作会自动把本会话登记为工作项的「参与对话」，时间线上即出现第二段对话。

## 数据契约

- 数据文件：工作区根目录 `.dsh-kanban.json`（schemaVersion 1）。
- 工具：kanban_view / kanban_create_work_item / kanban_update_work_item / kanban_start_memory_proposal / kanban_submit_memory_proposal / kanban_manual_edit_memory / kanban_get_handoff_context。
- 核心原则：记忆建议经用户在看板 diff 审核确认后才成正式记忆；状态由用户最终决定；同一范围同时一条活动建议。

## 需求事实源

- `PRD.md` — Codex 原版需求
- `DSH-PRD.md` — DSH v2 契约（含 UI 结构、对话建模、验证清单）
