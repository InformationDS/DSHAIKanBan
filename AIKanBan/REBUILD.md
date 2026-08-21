# AIKanBan for DSH — 新会话重建指引

> **部署形态判定（先看再选路径）**：插件源码以 package 形态维护在 `AikanBan/aikanban-package/`。
> - 若当前 DSH 部署已通过 bundle patch 嵌入持久组合（`~/.dsh/profiles/<profile>/cordis.patch.yml` 含 `@omdsh-dev/dsh-aikanban` 条目），则该 profile 的**宿主组合已全局注册本插件的工具与 `/aikanban-api`**——此时不要走动态重建：`cordis_define` + `cordis_run` 会在 host 半报 `tool "kanban_view" is already registered`（全局注册冲突，无法用 cordis_stop 解除）。正确路径 = **把改动后的 `lib/index.js` / `lib/client.js` 同步到该 profile 的 `node_modules/@omdsh-dev/dsh-aikanban/lib/`**（先备份旧副本），然后**重启该 profile 的 DSH 进程**使组合重新装载。
> - 仅当部署没有嵌入组合版（`Tool.listTools` 中看不到 kanban_*）时才用下方动态重建路径。

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

v4 能力验证（可选，冒烟）：`curl.exe -s -X POST http://127.0.0.1:3080/aikanban-api -H "content-type: application/json" -d '{"method":"dispatchMemoryGeneration","args":{"kind":"task","workItemId":"<wid>","sessionId":"<当前会话id>"}}'` 应返回 `{ok:true,dispatched:true}` 且聊天中 agent 开始起草；`injectHandoff` 同理（返回 `{ok:true,injected:true}`，目标会话首条消息即交接上下文）。工作项/会话 id 从 `kanban_view` 取得。

## 历史源码（v2，已存档）

旧单文件形态的 v2 源码已归档至 `AikanBan/legacy/`（`.host-v2.js` / `.client-check.js`），已被 `aikanban-package/lib/` 取代，仅供对照，不用于重建。

## 数据契约

- 数据文件：工作区根目录 `.dsh-kanban.json`（schemaVersion 1；v3 载入时自动 normalize 对话绑定字段，不升级 schema；v4 零迁移，不加字段）。
- 工具：kanban_view / kanban_create_work_item / kanban_update_work_item / kanban_start_memory_proposal / kanban_submit_memory_proposal / kanban_manual_edit_memory / kanban_get_handoff_context / kanban_bind_conversation / kanban_unbind_conversation。
- v4 RPC（HTTP `/aikanban-api`）：dispatchMemoryGeneration / injectHandoff（看板内一键生成记忆建议、新建对话自动注入交接上下文；不新增 agent 工具）。
- 核心原则：记忆建议经用户在看板 diff 审核确认后才成正式记忆；状态由用户最终决定；同一范围同时一条活动建议；未确认内容不进交接上下文。

## 需求事实源

- `AikanBan/PRD.md` — Codex 原版需求
- `AikanBan/DSH-PRD.md` — DSH 契约（v4，含自动注入交接上下文、一键生成记忆建议、RPC、验证清单）
- `AikanBan/PLAN.md` — v3 执行方案（实现路径与验收清单）
- `AikanBan/PLAN-v4.md` — v4 执行方案（机制核实、改动清单、验收用例）