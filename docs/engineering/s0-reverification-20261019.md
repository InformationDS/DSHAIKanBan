# S0 资产复核记录（2026-10-19，DSH 44.7.0）

> 本页是一次隔离复核的工程记录，**不是产品验收**，也不改变任何 ADR 的状态：五份 ADR 仍为「提议」（见[技术决策索引](decisions/README.md)）。
> 复核对象是提交 `bd16535` 的 S0/S1 工程记录与代码；复核当时仓库只有工程文档与 `tools/`，`packages/` 代码于同日按第 7 节处置结果回收至分支 `s1-recover`。

## 1. 环境与隔离方式

| 项 | 内容 |
| --- | --- |
| 宿主 | DSH 44.7.0（nightly 通道） |
| Node / pnpm | node v24.21.0 / pnpm 11.7.0 |
| 工作副本 | `C:\Users\InformationDS\aikanban-s0`，detached at `bd16535`，位于**同步盘之外** |
| 依赖安装 | `pnpm install --frozen-lockfile` 成功：89 包，3.2s |
| 隔离边界 | 未触碰正在运行的用户 GUI；未读写 `~/.dsh` |
| 补丁文件 | `C:\Users\InformationDS\aikanban-s0-s1-baseline.patch`（753 字节；复核时 untracked、不在本仓库内，现已按第 7 节回收入库，该文件不再需要） |

复核分两个状态：**状态 A** = `bd16535` 原样未修改；**状态 B** = 只补一处 3 行空值守卫（见第 3 节）。

## 2. 状态 A：`bd16535` 原样（未修改）

| 命令 | 实际结果 |
| --- | --- |
| `pnpm run typecheck`（`tsc -b`） | **FAIL，退出码 2**。唯一错误：`packages/plugin-client/src/channel-source.ts(186,24): error TS2322: Type 'BoardSnapshotValue \| null' is not assignable to type 'BoardSnapshot'` |
| `pnpm run build` | **FAIL，退出码 2**。`build = tsc -b && pnpm -C packages/plugin run build:bundle`，被 `tsc -b` 挡下；只跑 tsdown 打包本身成功：`lib/index.js` 21.4KB、`lib/client.js` 28.4KB |
| `pnpm -r --if-present run test` | **不全绿**：缺少构建产物 `lib/client.js` 时 `packages/plugin` 19 个失败 |
| `node tools\verify-host-import.mjs` | **11/11 PASS**，含「`apply()` 可激活」「导出 `aikanban_status` 工具」 |
| `node tools\probe-host.mjs` | **PROBE OK 4/4**：合成树含 `aikanban` 行 / 从 profile 解析并激活 / 宿主发布 `window.__DSH_BOOT__` 行并返回 200 的 `client.js` 26904B / 宿主内发布 `aikanban:activation` |

激活载荷注意点：本次探针观察到的激活载荷为 `tools=false`、`systemPrompt=false`，即**未观察到**状态工具与系统提示词的注册（见第 5 节 (c)）。

## 3. 状态 B：只补一处 3 行空值守卫

补丁（原文，位置 `channel-source.ts:183` 一带）：

```diff
@@ channel-source.ts:183
     if (value === null) {
       return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
     }
+    if (value.snapshot === null) {
+      return { ok: false, code: 'unknown-result', message: `${MALFORMED_RESPONSE_MESSAGE}请先核对当前正式状态。` }
+    }
     return { ok: true, snapshot: value.snapshot, undoable: value.undoable }
```

根因：`parseBoardWriteValue` 的返回类型里 `snapshot` 合法可为 `null`（`raw === null` 时），而写入路径把它当成非空 `BoardSnapshot` 返回；补上该守卫后类型收窄成立。

同一台机、同一 DSH 44.7.0、同一 node v24.21.0 / pnpm 11.7.0 下的实测：

| 命令 | 实际结果 |
| --- | --- |
| `pnpm run typecheck` | **EXIT 0** |
| `pnpm run build` | **EXIT 0**（`lib/index.js` 21.4KB、`lib/client.js` 28.4KB） |
| `pnpm -r --if-present run test` | **149 全绿**：core 66（11 文件）、plugin 38（3 文件）、plugin-client 45（3 文件） |
| `node tools\verify-host-import.mjs` | **OK（11/11）** |
| `node tools\probe-host.mjs` | **PROBE OK 4/4**（`client.js` 200 / 26923B） |

`tools=false`、`systemPrompt=false` 在状态 B 下同样属于**未观察项**，不因门禁转绿而改变。

## 4. 旧声称 vs 实测 vs 结论

下表逐条对照旧记录的说法与本次实测；两者不一致处正是上一轮「记录与实现状态互相矛盾」的同类问题，本页只写实测，不沿用旧数字。

| 旧记录声称 | 本次实测 | 结论 |
| --- | --- | --- |
| `typecheck` EXIT 0 | 状态 A：EXIT 2（唯一错误 `channel-source.ts:186` TS2322）；状态 B：EXIT 0 | 对原样代码**不成立**；补 3 行空值守卫后成立 |
| `build` 成功 | 状态 A：EXIT 2（被 `tsc -b` 挡下）；状态 B：EXIT 0 | 附条件成立：需先补该空值守卫 |
| 「68 用例」「88 用例」通过 | 实测 **149 通过**（core 66 / plugin 38 / plugin-client 45，共 17 个测试文件）；状态 A 下因缺 `lib/client.js`，`packages/plugin` 19 个失败 | **与实际不符**（用例数与文件数均不同） |
| `verify-host-import` 11/11 | 11/11 PASS（A/B 一致） | 成立 |
| `probe-host` PROBE OK 4/4 | 4/4（A：`client.js` 26904B；B：`client.js` 200 / 26923B） | 加载链成立 |
| 状态工具与系统提示词注册（旧记录未涉及该项） | 激活载荷 `tools=false`、`systemPrompt=false` | **未观察到 → 未验证/待查**（不得当作已注册） |
| 装到真实 profile 并生效（旧记录：未执行） | 未执行 | 未复核（需写盘并重启 `desktop` profile） |
| 客户端半实际渲染（旧记录：未验证） | 未观察 | 未复核 |
| 真实模型的 `assistant` 回复与真实多步（旧记录：未验证） | 未执行（隔离环境刻意不含凭据） | 未复核 |
| 存储原子性 25/25、宿主集成 20/20 | 本次未重跑 | 未复核（沿用旧结论须注明来源与日期） |
| `check_docs.py` PASS | 本次复原后重跑 PASS | 成立（仅文档结构层） |

## 5. 三项必须明确的结论

- **(a) 加载链在 44.7.0 上仍然成立**：`verify-host-import` 11/11 与隔离宿主 `probe-host` 4/4 两次独立复现，包含 profile 解析与激活、宿主发布 `window.__DSH_BOOT__` 并返回 200 的 `client.js`、以及宿主内发布 `aikanban:activation`。
- **(b) 旧声称「typecheck EXIT 0」不成立，但不是「代码不可构建」**：`bd16535` 原样代码在 DSH 44.7.0 上类型检查 EXIT 2，唯一错误是 `channel-source.ts:186` 的单点空值收窄；只补第 3 节那 3 行守卫后 typecheck / build / 149 用例 / 两个探针全部门禁转绿。因此结论按状态分别成立，不把状态 A 的失败写成普遍结论。
- **(c) `tools=false`、`systemPrompt=false` 属未验证项**：探针只观察到激活载荷的这两个字段为 false，**没有观察到**状态工具与系统提示词的注册；需要单独验证后才能写为已注册。

## 6. 仍未复核的部分

- **20 步宿主集成 spike**：HOST-01/03/04/05/06/07/08 的完整语义（本次只复核加载链与门禁命令，未重跑该集成探针）。
- **装到真实 profile**：`desktop` profile 由 Electron 应用独占管理，安装需要写盘并重启进程，未执行。
- **客户端半实际渲染与交互**：未打开界面观察（见[宿主能力合同](host-capabilities.md)）。
- **真实模型路径**：真实 `assistant` 回复与真实多步（含工具调用）未执行，原因是隔离 home 刻意不含真实凭据。
- `tools=false` / `systemPrompt=false` 的工具与提示词注册（第 5 节 (c)）。

## 7. 代码去留建议

**回收代码成本极低（仅 3 行空值守卫），建议回收并采用该补丁作为 S1 基线起点。**

**处置结果（2026-10-19）**：已按本建议回收至分支 `s1-recover`（提交 `ed6b151`）：`packages/`（63 个文件）与根构建配置 8 个自 `bd16535` 逐字节复原，并采用该 3 行空值守卫；原先写在仓库外的补丁文件不再需要，改动已入库。

理由：状态 B 下 `typecheck` / `build` / 149 用例 / `verify-host-import` / `probe-host` 全部门禁在同一台机、同一 DSH 44.7.0 上转绿；修复点是单点空值收窄，不涉及产品语义。

配套约束：

1. 回收起点为 `bd16535` + 上述 3 行守卫；回收已完成（分支 `s1-recover`，提交 `ed6b151`），仓库外的补丁文件 `C:\Users\InformationDS\aikanban-s0-s1-baseline.patch` 不再需要。
2. 回收后仍**先跑完整门禁**再进基线；不得沿用本次部分复核的结论替代功能验收。
3. 第 6 节列出的未复核项不得写成已验证；五份 ADR 的「提议」状态在各自复核完成前不变。

本页只记录 2026-10-19 这一次隔离复核的观察，不替代[交付状态](../delivery/status.md)与[功能验收](../prd/mapping/acceptance.csv)。
