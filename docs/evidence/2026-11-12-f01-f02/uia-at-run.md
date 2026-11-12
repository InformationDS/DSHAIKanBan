# F01/F02 真实 GUI 验收执行记录（2026-11-12/13）

执行人：Lead。环境：DSH desktop 0.2.2-rc.1 / Electron 44.7.0 / node v24.21.0 / Windows；真实 `desktop` profile；GUI `http://127.0.0.1:6369`。测试项目：`pluginInstall`（`bee90684-17b6-42f1-95c1-bdf7b6f36b24`）。

> 2026-11-13 重启后的补充见文末；前文“拖拽/键盘未执行”只描述 2026-11-12 当轮。

## 方法与限制

- 没有 CDP/remote-debugging；使用 Windows UI Automation（UIA）串行操作主窗口（handle 1708004），辅助脚本为同目录 `uia-lib.ps1`。
- 当前前台是全屏游戏，光标被锁定；`SetCursorPos` 返回 False，合成鼠标拖拽和真实键盘输入不能送达 DSH。因此本轮只使用 UIA 的 InvokePattern / ValuePattern / ExpandCollapsePattern；**拖拽与仅键盘路径未执行**，不能把菜单等价路径冒充拖拽/键盘证据。
- 截图：`at01-empty-board.png`（空看板）、`at01-blank-title.png`（空标题拒绝）、`at01-created-once.png`（创建后一项）、`board-selected.png`（真实 AIKanBan 项目基线）。运行数据摘要：`storage-summary.json`（从 `%USERPROFILE%\.dsh\storages\aikanban_core.json` 抽取的两个测试任务，不含其他项目数据）。

## AT-01 / AT-01 补充

1. 空看板点“新建任务”，标题留空（仅空白）后点“创建任务”；表单保留并显示 `任务标题不能为空（只有空白字符同样无效）。`。
2. 输入标题 `AT-01 收口-2026-11-12`、目标 `验收：空项目创建、连点、无 AI 副作用`，初始状态保持默认“未开始”。用 UIA `InvokePattern` 连续调用“创建任务”两次（间隔 30ms）：第 1 次成功；第 2 次因表单已卸载返回 `无法识别的错误`。最终看板只有 1 项，提示 `已创建任务：「AT-01 收口-2026-11-12」`。
3. storage 中第一个任务 `t82ce5472e6c70a3982d22609b99a4f8e`：status `todo`，fieldsRevision `0`，activity 仅 `task-created`，`pendingFieldDraft=null`，`links.conversations={}`；项目 activity 仅 `project-registered`。
4. 再次用同一标题创建第二个任务；看板出现两个同名独立卡片。storage 第二个任务 `t11e8f75da2b33f6c11e6b8c6dd77ef13`，status `todo`，fieldsRevision `0`。
5. 本任务的重启步骤**未执行**；本节不能记为 AT-01 整体通过。

## AT-02 S1（项目隔离与字段）

1. 在 `pluginInstall` 打开第二个任务“查看详情”→“编辑目标”，输入 `AT-01 补充任务（同标题）` 并点“保存修改”；提示 `已保存：任务目标`，卡片显示新目标。storage：`fieldsRevision=1`，activity 新增 `task-goal-changed`（`from=""`，`to="AT-01 补充任务（同标题）"`，requestId `op-mwdilkc3-9`）。
2. 活动区“活动历史”按钮反复打开/关闭 3 次，UIA 树中始终只有 1 个同名按钮；未复现重复按钮。
3. 点“切换项目”选择 `AIKanBan`：只显示既有 `测试1`、`1`（均 blocked），不显示 `pluginInstall` 的 AT-01 任务；再切回 `pluginInstall`，两个 AT-01 任务、第二个任务的目标与看板位置仍在。
4. 项目概况/总览属于 F03，未实现；AT-02 S1 只能部分执行。

## AT-03 / F02 状态与卡片（菜单路径）

以下操作均通过任务卡上的状态 ComboBox（菜单）完成，不是拖拽：

1. 第一个任务 `t82ce…`：未开始 → 进行中；提示 `已保存：状态为「进行中」`，卡片进入“进行中”列并出现“撤销该状态修改”。
2. 进行中 → 已阻塞：弹出 `进入「已阻塞」需要原因`；原因为空时显示 `原因不能为空，状态未改变。`；点 `取消（保持原状态）` 后仍为进行中。
3. 再次选已阻塞，填 `AT-03 验收阻塞原因`，点 `确认进入已阻塞`；卡显示 `阻塞原因：AT-03 验收阻塞原因`，提示 `已保存：状态为「已阻塞」`。点“撤销该状态修改”回到进行中。
4. 进行中 → 已完成，提示 `已保存：状态为「已完成」`；已完成 → 未开始（重开），提示 `已保存：状态为「未开始」`。
5. 未开始 → 已取消：已取消列显示 `已取消 1 项` 和 `已收起（1 项，状态为「已取消」的任务仍在看板中）`，卡片隐藏；“展开”按钮存在。
6. storage：第一个任务 status `cancelled`，`statusRevision=6`，activity 共 7 条，依次为 `task-created`、`task-status-changed(todo→doing)`、`task-blocked`、`task-undone`、`task-status-changed(doing→done)`、`task-reopened(done→todo)`、`task-status-changed(todo→cancelled)`。第二个任务保持 `todo`、`fieldsRevision=1`。
7. AT-03 的拖拽入口、保存失败注入、后续修改竞争分支未执行；AT-109 的仅键盘路径未执行。二者只能记 `部分执行`。

## 未执行/不能声称

- DSH 重启后本 AT-01 任务仍在：未执行（既有的“测试1”跨重启保留只是旁证，不是本 AT 证据）。
- 真实鼠标拖拽：受前台全屏程序锁定，未执行。
- 真实键盘：同上，未执行。
- 故障注入：当前没有已登记注入开关，未执行。
- 项目概况/总览（F03）、联合 AT 依赖功能：未实现，不能执行。


## 2026-11-13 重启后补测（更新）

2026-11-13 用户重启 DSH 后，GUI 为 `http://127.0.0.1:10526`（activation `mwdm0bh2-1`，pid 4336），主窗口 handle 1902338；真实鼠标与键盘均已可用。前文第 8、36、40-43 行的“未执行”只描述 2026-11-12 当轮。

- 重启持久化：t82 仍为 cancelled（statusRevision=6、activity 7 条），t11 仍为 todo（fieldsRevision=1、activity 2 条）；选中 `pluginInstall` 后看板显示 t11 在未开始、已取消折叠 1 项 t82。证据：`at01-post-restart-state.txt`。
- AT-03 真实拖拽：t11 todo→doing 成功（`已保存：状态为「进行中」`）；doing→blocked 弹出原因对话框，空原因取消后仍 doing；再次拖入并填 `AT-03 拖拽验收阻塞原因`，确认后 blocked、原因可见（`已保存：状态为「已阻塞」`）。截图：`at03-blocked-dialog.png`。
- AT-109 真实键盘：UIA `SetFocus` 到 t11 状态 ComboBox，真实 `SendKeys('{DOWN}')` → done（`已保存：状态为「已完成」`）；`SetFocus` 到“展开”+真实 `{ENTER}` 展开已取消列；`SetFocus` 到“查看详情”+真实 `{ENTER}` 打开详情，`SetFocus` 到“返回看板”+真实 `{ENTER}` 返回，t11 仍在已完成列、已取消列保持展开。截图：`at03-at109-after.png`；快照：`at03-at109-state.txt`。
- 结论：AT-03 的真实拖拽分支已通过，但故障注入/后续修改竞争未执行，仍记 `部分执行`；AT-109 记 `通过（真实操作）`；AT-01 重启持久化已观察，但连续两次提交的真实幂等路径仍不成立，仍记 `部分执行`。
