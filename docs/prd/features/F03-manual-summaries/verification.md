# F03 手动维护任务概况与项目总览 — 验收记录

> 本文件按[verification 模板](../../templates/verification.md)记录逐条 AT；AT 状态与证据口径见[验收执行规则](../../../engineering/acceptance-execution.md)。进度汇总只在[交付状态](../../../delivery/status.md)维护。

## 1. 基本信息（必填）

| 字段 | 内容 |
| --- | --- |
| 功能编号 | F03 |
| 功能标题 | 手动维护任务概况与项目总览 |
| 执行日期 | 2026-11-13 至 2026-11-14（安装后首次 GUI、重启验证；R02 修复后第三次重启复验；2026-11-14 空项目补 AT-44） |
| 提交号 | 代码 `58c7c69`（R02 修复）；此前 `973ee67`（client UI）、`79e0fa2`（core/wire/host）；文档 `d1758cc`；安装构建 client SHA256 `48661F598484DB35284EA7365B7265BBDDBC6E68738AC96FA9C68E01D33F1433`、83372 B |
| 环境 | DSH desktop 0.2.2-rc.1 / Electron 44.7.0 / node v24.21.0 / Windows；真实 `desktop` profile；首次 F03 GUI `http://127.0.0.1:3640`（activation `mwe9oozd-1`）；第二次重启后 GUI `http://127.0.0.1:1120`（activation `mwecj5mu-1`）；R02 修复后第三次重启 GUI `http://127.0.0.1:14721`（activation `mwedgglm-1`）；2026-11-14 空项目 AT-44 GUI `http://127.0.0.1:5648`（activation `mwg4f8hd-1`） |
| 执行人 / 方式 | Lead，真实 GUI + Windows UI Automation（Invoke/ValuePattern）；四次完全退出并重开 DSH；无 CDP |
| 依赖功能状态 | F01/F02 进行中（部分执行）；F06/F09/F10/F13 未开始；见[交付状态](../../../delivery/status.md) |

## 2. 验收条件执行记录

| AT 编号 | 证据档位 | 前置条件 | 操作步骤 | 预期结果 | 实际结果 | 证据（截图/路径） | 结论 | 归属 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AT-26 / S1 本功能 | 档 1 真实操作 | 任务 `t11e8f75da2b33f6c11e6b8c6dd77ef13`（项目 `pluginInstall`，`bee90684-17b6-42f1-95c1-bdf7b6f36b24`）没有对话/记录，尚未有正式概况；不依赖完成任务 | 打开任务详情，点“编辑概况”，输入三行用户概况，点“预览修改”查看差异，点“确认保存”；退出并重开 DSH 后重新选择项目、打开同一任务，检查概况正文、版本和来源；检查 storage 的 links/records | 用户来源版本保留；重启后仍在；无虚构记录或对话 | 预览显示“旧正式内容 vs 新内容”的新增三行；保存提示 `概况已保存（第 1 版）`，版本历史为 `第 1 版 · 用户手动`。storage：`v1_taskSummary_t11e8f75da2b33f6c11e6b8c6dd77ef13_op-2d-mwe9qbgo-2d-1`，`seq=1`、`origin=user`、`source.generator=manual`、`changeKind=created`、正文为输入的三行；activity `summary-saved`；任务 `links.conversations={}`，没有 taskRecord，项目 activity 无记录/对话。重启后任务卡直接显示概况首行，详情显示同一版本和正文；`概況待核对` 由先前目标变更留下，符合预期。2026-11-13 R02 修复后第三次重启复验：再次编辑并保存第 2 版，未切换项目、未重启，详情顶部与任务卡立即显示新首行；版本 `v1_taskSummary_t11e8f75da2b33f6c11e6b8c6dd77ef13_op-2d-mwedimei-2d-1`，activity 第二条 `summary-saved`，`changeKind=modified`。 | `docs/evidence/2026-11-13-f03/at26-task-summary-saved.png`、`at26-task-summary-after-restart.png`、`at26-at44-after-restart-state.txt`、`at26-r02-immediate.png`、`at26-r02-immediate-state.txt`；运行数据 `%USERPROFILE%\.dsh\storages\aikanban_core.json` 的 `scope1_task_t11e8…` | 通过（真实操作） | 本功能 |
| AT-26 / 联合 F06/F09 | —（未执行） | F06/F09 未开始 | 再形成真实对话记录，与手动概况核对 | 保留人工修正，冲突显示，来源准确 | 未执行；F06/F09 未开始 | 无 | 待执行 | 待联合验收（联合 F06/F09） |
| AT-44 / 本功能 | 档 1 真实操作 | 空项目 `GroupAssignment-integration`（id `0c29208a-6fb6-4712-b79c-b57721c72886`），看板五列全 0，无已完成任务；项目记录/成果为空 | 打开项目总览，编辑目标与约定，预览修改，确认保存；检查版本、来源、项目记录/成果 | 可保存用户版本，无虚构项目成果 | 空项目看板五列均为“暂无任务（可拖入）”；项目总览保存第 1 版，显示 `第 1 版 · 2026-11-14 08:09:51 · 用户手动 · 新建`，正文为目标与约定；storage：`v1_projectOverview_0c29208a-2d-6fb6-2d-4712-2d-b79c-2d-b57721c72886_op-2d-mwg4k1g9-2d-1`，seq=1、origin=user、source.generator=manual、changeKind=created，activity=project-registered,summary-saved；项目 tasks=0、projectRecord 空、outcomeTasks 空，无虚构成果。 | `docs/evidence/2026-11-14-f03/at44-empty-overview.png`、`at44-empty-state.txt` | 通过（真实操作） | 本功能 |
| AT-49 / 本功能 | —（未执行注入） | 关闭 AI；可登记故障注入开关 | 关闭 AI，编辑概况/总览并保存；注入一次失败再重试 | 本地可用；失败输入保留；最终仅一次版本 | 本地保存路径已由 AT-26/AT-44 观察；**未关闭 AI 单独记录，也未执行失败注入/重试**；第 3.1 节当前没有已登记注入开关，故不能声称本 AT 通过 | AT-26/AT-44 证据同上；无注入证据 | 待执行 | 本功能 |
| AT-27 / 联合 F06/F08/F09 | —（未执行） | F06/F08/F09 未开始 | 人工修改后让 AI 提出相反结论 | 差异明确，未经选择不覆盖人工内容 | 未执行 | 无 | 待执行 | 待联合验收（联合 F06/F08/F09） |
| AT-29 / 联合 F06 | —（未执行） | F06 未开始 | 审核记录时修改目标与概况，再确认 | 当前字段保留，汇总按最新基线核对 | 未执行 | 无 | 待执行 | 待联合验收（联合 F06） |
| AT-45 / 联合 F10/F13 | —（未执行） | F10/F13 未开始 | 直接修正已有总览并查看版本来源 | 用户来源和历史准确，不回写聊天、不改状态 | 未执行 | 无 | 待执行 | 待联合验收（联合 F10/F13） |
| AT-67 / 联合 F09 | —（未执行） | F09 未开始 | 先仅删摘要句，再明确否定对应来源片段并保存 | 第一步不撤销结论，第二步修正与适用性一致生效 | 未执行 | 无 | 待执行 | 待联合验收（联合 F09） |

## 3. 结论与局限

| 项 | 内容 |
| --- | --- |
| 本功能验收结论（汇总口径） | `部分执行`：AT-26 S1、AT-44 通过（真实操作）；AT-49、AT-26 联合、AT-27、AT-29、AT-45、AT-67 待执行 |
| 通过（真实操作）项 | AT-26 S1、AT-44 |
| 通过（含故障注入）项 | 无 |
| 失败 / 需核对项 | 无。原 R02 UI 刷新缺陷（保存后卡片/详情顶部不即时更新）已于 2026-11-13 修复并由真实 GUI 复验：保存后不切项目、不重启，卡片和详情顶部立即更新；代码 `58c7c69`，回归见 `at26-r02-immediate.png`/`at26-r02-immediate-state.txt`。 |
| 未执行项 | AT-49 的关闭 AI + 失败注入/重试；AT-26 联合、AT-27、AT-29、AT-45、AT-67 |
| 跨功能待联合验收 | AT-26 联合（F06/F09）、AT-27（F06/F08/F09）、AT-29（F06）、AT-45（F10/F13）、AT-67（F09） |
| 局限 | 重启与真实 GUI 验证了任务概况与项目总览的保存/版本/重启保留和 R02 即时刷新；AT-44 空项目前置条件已于 2026-11-14 补测并通过；AT-49/联合 AT 未执行；草稿自动保存/关闭丢弃、`summary/draft.discard`、F10 历史恢复、F06/F13 联合行为未实现或未执行；`tools/verify-rpc-roundtrip.mjs` 已覆盖 11 端点/9 码（`7db9794`，p6c 37/37），包含 F03 三端点；仍不证明浏览器半/真实 profile。 |
| 与上次记录的差异 | 2026-11-13 首次建立 F03 verification：AT-26 S1 通过；AT-44 部分执行；AT-49 及联合 AT 待执行；发现并记录保存后卡片不即时刷新的 R02 缺陷。同日晚补记：`58c7c69` 修复 R02，第三次重启真实 GUI 复验通过。2026-11-14：用空项目 `GroupAssignment-integration` 补 AT-44 前置条件并保存第 1 版，AT-44 改为通过；AT-49/联合 AT 仍未执行，功能级仍 `部分执行`。 |

## 4. 变更历史（只追加，不覆盖）

| 日期 | 提交号 | 变更 |
| --- | --- | --- |
| 2026-11-13 | `973ee67` / `a42a9a2` | 首次安装 F03 构建、执行 AT-26/44 的保存与重启验证；建立本文；AT-26 S1 通过，AT-44 部分执行，其余待执行 |
| 2026-11-13 | `58c7c69` / `d1758cc` | 修复 R02 保存后卡片/详情不即时刷新的缺陷；第三次重启真实 GUI 保存第 2 版，未切项目/未重启即更新；补 `at26-r02-immediate.png` 与状态快照 |
| 2026-11-14 | `58c7c69` / `87f0443` | 用空项目 `GroupAssignment-integration` 补 AT-44 前置条件，保存第 1 版用户总览（无任务/记录/成果）；AT-44 改为 `通过（真实操作）`；AT-26 仍通过，AT-49/联合 AT 待执行 |
