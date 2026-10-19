> 复原说明：本页为 2026-10-14 S0 记录的原文复原（来源提交 bd16535）。2026-10-20 已在 DSH 44.7.0 上复核并据此把状态由「提议」改为「采用」，依据见 [S0 复核记录](../s0-reverification-20261019.md) 第 8 节；正文中标注「尚未验证」的子项仍按原样保留，不得当作已验证。

# ADR-002：成对确认的单写原子性（storageDomain 写入边界）

- 日期：2026-10-14
- 状态：采用（Accepted，2026-10-20 复核）
- 状态依据：2026-10-20 重跑 `packages/core/experiments/storage-domain-atomicity.mjs`，**25/25 checks passed**（故障注入/并发/重启/损坏保护）；同时 `pnpm -r run test` 中 paired-confirmation、concurrency、restart、version-chain 等用例全绿（见 [复核记录第 8 节](../s0-reverification-20261019.md)）。
- 决策范围：`packages/core`（S0-W2），影响全部正式内容保存路径
- 来源规则：SAVE-01…10、OBJ-05…07、REC-01…06、APP-01…08、F06-R07、F07-R02/R06、F08-R02/R06/R07、F09-R03/R04/R06

## 1. 要解决的问题

SAVE-02/F06-R07 要求 taskRecord+taskSummary、projectRecord+projectOverview「同屏预览，一次确认保存」，并明确「不能记录成功但汇总失败仍显示成功」、「默认读取不得使用不一致的新结果」。REC-01/SAVE-06 又要求失败时「保持旧一致结果」、连点与重试「只形成一个有效结果」。

问题因此分成两问：

1. **宿主存储的原子性边界到底在哪里？** 一次 `put` 是原子的，但「一次确认 = 两个对象」是否等于两次 `put`？如果是，则必然存在半生效窗口，SAVE-02 不可能被满足。
2. 在此边界下，成对确认、幂等、基线核对与「概况待核对」保存门槛应当如何构造，才能既满足规则又不引入全局锁（F08-R06 明确禁止「用整项目长时间锁替代记录级独立活动」）。

## 2. 可选方案

| # | 方案 | 说明 |
| --- | --- | --- |
| A | 两个 `put`（记录一条、概况一条），失败重试补偿 | 跨表各自写入，用重试/补偿收敛 |
| B | 单条 confirmation 记录先写两对象新版本，再原子替换当前指针 | 任务描述中的建议方案 |
| C | **把一对成员（含新版本条目、当前指针、适用性修正）全部放进同一条 scope head 记录，一次 `put` 提交** | 一次确认 = 一次 `put` |
| D | 依赖 `storageDomain` 提供的事务 / 批次写 | 需要宿主扩展能力 |

## 3. 原子性边界的实测结论（本 ADR 的事实基础）

**结论：一次 `put`（`KvTable.put` / `KvTable.update`）恰好发布一个文档，且该发布是原子的；两次 `put` 永远不是一次事务。`layout` 不改变这个边界。**「一次确认 = 一次原子写」只能通过把整对内容放进同一条记录来达成。

依据一（源码，权威）：

- `DomainSpec.layout`（`@deepseek-ai/dsh-storage-domain/lib/types/spec.d.ts:36-43`）：`single`（默认）把整个 unit 存成一个文档；`per-record` 把每条记录存成自己的文档。
- `SingleJsonUnit.putRecord`（`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`）改内存后 `publish()`；`publish`（同文件 265-270）调用 `writeAtomic(this.path, serialize(name, state))`，即**每次 put 重写整个 unit 文件**。
- `writeAtomic`（同文件 25-41）：同目录临时文件 → `handle.sync()` → `rename()` 覆盖目标（Windows 为 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`）→ 父目录 fsync。因此单文档替换是崩溃安全的。
- `PerRecordJsonUnit.putRecord` → `writeDocument`（同文件 461-465、512-520）：每条记录一个 `<root>/<name>/<table>/<key>.json`，一次 put 只替换那一个文件。
- `DomainImpl`（`@deepseek-ai/dsh-storage-domain/lib/index.js:118-125、221-229、257-287`）：**每个 domain 一条写链**，所有写串行；`put` 先等后端持久化成功、再改内存，因此失败的写不会让读取看到未持久化的值；`update(key, fn)` 的 `fn` 在自己的队列槽位对**当时**的记录求值，缺键则以 `missing-key` 拒绝。

依据二（对真实包的实测，非推断）：`packages/core/experiments/storage-domain-atomicity.mjs` 直接驱动已安装的 `dsh-storage-domain` + `dsh-storage-json`（不 mock、不重写），25/25 通过。关键观测：

- E1：`single` 布局下 unit 只有 `<root>/<name>.json` 一个文件，一次 put 会重写整个文档（含其它表全部记录）；`per-record` 下每条记录一个文件，改动一条不触碰其它文件。两种布局「一次 put = 恰好一个原子发布的文档」。
- E2：**在两次 put 之间模拟崩溃，两种布局都会在介质上留下半生效状态**（`alpha.pair={value:2}`、`beta.pair=undefined`）。这是方案 A/B 被否决的直接证据。
- E3：注入写失败后，内存读取与介质都停留在旧值；写链在失败后继续可用。
- E4：`update()` 的 transform 在队列槽位求值，24 个并发读改写得到 24；两个同基线提交只有一个生效；**失败方无法从返回值判断自己失败**（`update` 返回的是「已存储的记录」），因此提交判定必须放在 transform 内部或依赖自身写入的身份标记——本实现采用前者，并在实现中同时写入可自证身份的版本号。
- E5：`single` 布局下损坏的文档会让 open 以 `malformed-medium` 失败；`per-record` 布局下损坏的记录文档会被**静默当作不存在**；`invalidRecords:'backup-and-skip'` 在 `single` 布局下无效（该 unit 没有 `backupRecord`）。

## 4. 采用方案与理由

**采用方案 C，并把布局固定为 `layout: 'single'`。**

1. **一次确认 = 一次 `put`。** 域只开两张表：`scope_state`（每个 task/project 一条 head 记录）与 `drafts`。一条 head 记录同时承载：两成员的新版本条目、各自独立的版本链、当前指针、适用性修正链、待核对标记与归属链接。因此「记录成功但概况失败」在结构上不可能出现：两者要么都在，要么都不在。
2. **布局选 `single`。** 边界相同，但 `single` 在损坏时**失败得响亮**（open 拒绝），符合 REC-05「数据读取/恢复损坏不当空项目覆盖」；`per-record` 会把损坏的概况读成「不存在」，正好违反该条。同时 `single` 不受 `SAFE_KEY_RE` 限制（键仍被统一编码，见第 6 节）。不声明 `invalidRecords`：它只适用于「可丢弃的派生数据」。
3. **幂等用身份 + 基线，不用锁。** 确认身份 `updateId` 同时决定版本号（`versionId` 由 `updateId+objectKind+objectId` 确定性派生）与草稿归属；正式提交时在**同一个** `update` transform 内一次性完成：查同 `updateId` 是否已生效（已生效 → 返回原结果，不产生第二版本）、核对 `revision`/`applicabilityRevision`/各成员基线版本、核对「概况待核对」保存门槛、对两成员分类变更、构造下一条 head 记录。
4. **门槛与标记分开表达。**「待确认结论」是内容状态（APP-02，可正式保存，不阻断）；「概况待核对/总览待核对」是一致性门槛（OBJ-06，阻断正式保存）；「记录更新状态」（整理中/待确认/已放弃…）是草稿状态。三者分别存储、分别读取。
5. **`update` 的返回值不能当作提交判定。** 实测（E4）失败方拿到的也是赢家的记录；实现因此在 transform 内捕获判定结果，并在提交记录里写入可自证身份的 `lastCommittedUpdateId` 与版本号。

## 5. 影响功能

- **SAVE-02/06、F06-R07、F08-R06/R07**：成对一致生效、连点/重试/双窗口只生效一次、失败保持旧一致结果——由单写结构直接保证。
- **SAVE-04/05、F07-R02/R05/R06、F08-R02**：基线核对覆盖正文版本 + 适用性修订 + 各成员基线；「概况待核对」在提交的同一 transform 内阻断；手动核对（`clearRecheck`）不产生版本、不推进版本号；异稿竞争只标记受影响的汇总，从不丢弃任何草稿。
- **SAVE-08/09、F10-R04**：四类对象各自独立、只增不改的版本链；恢复历史正文以新版本追加，不删后续版本；已确认的否定/替代不会因恢复正文而复活（适用性修正存活在 scope 级修正链上，优先级高于正文措辞），重新采用须显式 `reconfirmApplicability` 并在同一次写内生效。
- **APP-01…07、F09-R02/R03/R04/R06**：修正与正文同次生效；修正按 scope（当前任务/项目）隔离，同字样的别的任务不受影响；读取携带状态、范围、必要修正来源与替代内容；`readToken` 覆盖正文版本与有效结论状态，因此「修正变化可判断发送/读取是否更新，即使正文没有增加版本」。
- **REC-01/03/04/05/06**：失败不改正式内容、重启后版本链/指针/草稿一致、竞争不丢草稿、损坏不读成空、非 AI 路径（手动核对、手改、放弃）完全可用。
- **OBJ-03/07**：草稿槽位即键，天然「每对话/每任务最多一份活动草稿」，不设任务级全局锁；归属固定，改绑被拒绝。

## 6. 约束与代价

1. **写放大（最大代价）**：`single` 布局下每次提交重写整个 unit 文档，历史越长文件越大。这是为换取「一次原子写 + 损坏即报错 + REC-05」付出的代价。缓解路径：当历史规模成为问题时，把只增不改的历史链拆到第二个 domain 并改用 `per-record`（每条版本一个文档，正是该布局的官方适用场景），head 记录仍保持单写；或按项目分 domain。**正确性不依赖该优化**。
2. **一个 scope 一次只能有一个写者排队**：`storageDomain` 每 domain 一条写链。这不是本 ADR 引入的锁（不跨读、不跨 AI 工作、不阻止无关记录独立整理），但同域写是串行的。
3. **归属唯一性检查是 O(任务数) 扫描**：固定归属存放在各 scope head 内，「同一对话不得改绑到别的任务」（OBJ-03）需要扫描全部 head 记录。关联是低频用户动作，扫描是内存内的同步遍历；若任务量级增长，可加一张 `conversation → task` 的专用表，代价是关联变成两次写（关联本身幂等，REC-02 允许重试）。
4. **scope head 必须在首次确认前存在**：确认不会惰性创建 scope（惰性 `put` 空记录会覆盖并发的提交）。宿主需在创建任务/项目时调用 `ensureScope`；缺失时确认以 `unknown-scope` 明确拒绝，而不是猜测位置（REC-05）。
5. **`no-change` 不做线性化点**：无变化结论来自预检快照，**不产生任何写入**（实测断言 0 次写）。代价是并发的另一窗口可能在之后改变汇总，使「无需更新」的结论变旧；因为不提交任何内容，这是安全的，符合 SAVE-10「不靠制造空版本推进处理位置」。
6. **提交失败方会有一次冗余写**：同基线并发提交中，失败方的 transform 返回原记录不变，端口仍会发布一次字节相同的记录（实测 E4：2 次 putRecord、1 次生效）。不产生版本、不改变内容。
7. **被阻断的确认最多写一次**：只写「待核对」标记，绝不写正式内容（测试断言 revision 不变、无新版本、journal 中只有 head 记录的 update）。
8. **`single` 布局不使用 `invalidRecords:'backup-and-skip'`**：该策略在 `single` 下无效，且语义上面向可丢弃的派生数据，用于正式内容会掩盖损坏。

## 7. 验证证据

- 源码依据：第 3 节列出的行号（`dsh-storage-domain` / `dsh-storage-json` / `dsh-storage` 已安装副本）。
- 实测（真实包，非 mock）：`node packages/core/experiments/storage-domain-atomicity.mjs` → **25/25 checks passed**（E1 布局与文档数、E2 两次 put 的半生效、E3 失败写入不污染、E4 写链/`update` 语义与 CAS、E5 损坏与非法记录）。
- 单元/集成测试：`pnpm --filter @aikanban/core run test`（`vitest run`）→ **7 个文件、35 个测试全部通过**，覆盖：单写即成对（断言恰好 1 次 scope_state 写）、故障注入后半生效不存在且重启仍一致、**反向对照**（两次写的朴素方案确实半生效）、连点/超时重试 24 次并发只产生 1 个版本、两个不同更新竞争同一汇总（1 成一阻、双方草稿都在、只标记受影响汇总）、重启后链条/指针/草稿一致且未确认内容不成事实、清空 vs 无需更新、版本链只增不改（逐版本快照复比）、恢复为新版本与适用性不复活、修正按 scope 隔离、修正与文案同一次写、损坏记录被 domain 校验拒绝。
- 类型检查：`pnpm --filter @aikanban/core run typecheck`（`tsc -p tsconfig.test.json`，继承根 `tsconfig.base.json` 的 strict/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`）→ 退出码 0。
- 构建：`tsc -p tsconfig.json`（composite，供根 `tsc -b`）→ 退出码 0。

## 8. 公开语义未变

本决策不改变任何产品语义：成对保存、固定归属、历史隔离、人工修正、AI 不自行确认等规则均按有效 PRD 执行；ADR 只选择实现载体（哪条记录承载一次确认）。若将来需要改变这些语义，应先更新有效 PRD 与决策来源。

## 9. 被替代关系

- 取代：无（本目录此前无技术决策记录）。
- 被取代条件：若 `storageDomain` 未来提供跨记录事务/批次提交（方案 D），或宿主改为单文档事务型存储，可重新评估方案 C 的写放大取舍；届时本 ADR 应由新记录替代，而不是修改本文。
- 与 ADR-001（会话派发与整理执行载体）、ADR-003（项目/工作范围映射与默认背景注入）的关系：本 ADR 只定义「正式内容如何原子落地」，不涉及派发与背景注入；ADR-001/003 的结论不得绕过 SAVE-02 的成对一致性。
