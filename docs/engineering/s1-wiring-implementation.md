# S1 接线实施记录

> **性质**：本页是切片 A 的工程**实施记录**，不是实现进度声明，也不是验收记录。F01/F02 的 AT 仍全部「待执行」，`docs/prd/mapping/acceptance.csv` 的 `status` 保持「待执行」；本页的测试与探针只能作为档 2/档 3 辅助证据，不能替代验收（见[验收执行规则](acceptance-execution.md)）。
>
> **依据与分工**：[s1-wiring.md](s1-wiring.md) §7.4（S5 分工）与 [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md) §10；按 M6 首次创建，后续追加章节须注明日期与提交号（[vibecoding-task.md](../prd/templates/vibecoding-task.md)）。
>
> **覆盖范围**：P0（基线复现）+ P1（`@aikanban/core` 依赖边与 lockfile）+ §9 的 P2 取证与 P3 host 半接线（`apply()` 打开域、注册 `/aikanban`、快照/诊断事件、探针第 5 项）。仍不含适配器业务逻辑：`packages/plugin/src/board-adapter.ts` **未创建**（P5b），浏览器半（A5–A10）**零改动**，未新增端点，未改 UI 信息架构；AT 全部「待执行」。

## 1. 范围与依赖

| 项 | 内容 |
| --- | --- |
| 本档目标 | 让 host 半在后续档具备 import `@aikanban/core` 的构建条件，且所有既有门禁不退化 |
| 规格依据 | [s1-wiring.md](s1-wiring.md) §5.3（构建依赖边）、§7.3 A-G0（lockfile 回迁）、[ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md) §6 第 4 条 |
| 构建沙盒 | `C:\Users\InformationDS\aikanban-build`（盘外 worktree，detached `83d7247`）；验证沙盒 `C:\Users\InformationDS\aikanban-verify`（盘外 worktree，detached `28c6d5d`） |
| 明确不做 | 不改任何 `src/`；不改 `docs/prd/**` 与 `acceptance.csv`；不执行真实 profile 安装；不新增端点 |

## 2. 实际改动（提交 `28c6d5d`）

提交号：`28c6d5dc63bce75199829b0c991ee0a3e24a8f62`。`git show --stat 28c6d5d`：3 files changed, 5 insertions(+), 1 deletion(-)。

| 文件 | 改动 | 规格锚点 |
| --- | --- | --- |
| `packages/plugin/package.json` | `devDependencies` 增加 `"@aikanban/core": "workspace:*"`（与既有 `@aikanban/plugin-client` 同写法） | s1-wiring §5.3 第 1 条 |
| `packages/plugin/tsconfig.json` | `references` 增加 `{ "path": "../core" }`（排在 `../plugin-client` 前） | s1-wiring §5.3 第 2 条 |
| `pnpm-lock.yaml` | `importers.packages/plugin.devDependencies` 增加 `@aikanban/core`（`specifier: workspace:*`、`version: link:../core`） | s1-wiring §7.3 A-G0 第 4 步 |

未改 `packages/plugin/tsdown.config.ts`：`deps.alwaysBundle: (id) => id.startsWith('@aikanban/')`（`:42`）已覆盖 core（规格 §5.3 第 3 条）。未改 `packages/core`：本档未遇到 TS6305/TS6059，故未采用 §5.3 的兜底修法（见 §3）。

**没有在同步盘内 install**：lockfile 是在盘外沙盒 `C:\Users\InformationDS\aikanban-build` 用**非 frozen** `pnpm install` 生成后 `Copy-Item` 回主仓库的；清单与 lockfile 在同一个提交 `28c6d5d` 内（分两次提交会让中间提交的 lockfile 引用不到 manifest 的依赖声明，`--frozen-lockfile` 基线不成立）。主仓库工作树不含 `node_modules`/`.pnpm-store`。

## 3. 规格「未确认」项取证：`tsc -b` 对 core 源码导出的解析

规格 §5.3 标注未确认：core 的 `exports["."].types` 指向源码（`packages/core/package.json:7-10`），`tsc -b` 经 project reference 解析时可能报 TS6305/TS6059。本档在沙盒里用**一次性临时代码**取证（已还原，未进入任何提交；提交 `28c6d5d` 的 `src/` 与 `83d7247` 完全一致）：

| 实验 | 结果 |
| --- | --- |
| 只加 `import type { ProjectFields } from '@aikanban/core'`（`packages/plugin/src/` 下临时文件）后 `pnpm run typecheck` | **EXIT 0**，无 TS6305/TS6059 |
| 再加真实值导入（host 入口临时 `import { createKanbanCore } ...` + `export const __probeCoreFactory = createKanbanCore`）后 `pnpm run build` | **EXIT 0**；`packages/plugin/lib/index.js` 21.38 kB → **131.86 kB**（core 被内联） |
| 同上状态下 `node tools\verify-host-import.mjs` | **11/11 PASS**；导入图 `1 module(s), only node: builtins`；产物内无 bare specifier（正则扫描 0 命中），且出现 `function createKanbanCore` |

**结论（本档采用的修法）**：**只用 project reference，不用其他修法**——未改 core 的 `exports["."].types` 指向 `./lib/index.d.ts`，未在 plugin 里加 `paths`/别名，未改 tsdown。`tsc -b` 会先构建被引用的 core（`lib/index.d.ts` 就绪）再解析导入，因而源码导出 + project reference 可直接工作。A1 正式在 `src/` 里 import core 时应按同一组命令复验；若届时报 TS6305/TS6059，再按规格 §5.3 的兜底修法处理并在此记录。

## 4. 门禁原始输出

环境：node v24.21.0 / pnpm 11.7.0（DSH 运行时自带，未用本机另一套 11.28.5）；两轮均在**同步盘之外的 worktree** 内执行。以下日志除隔离探针 URL 的临时 token 替换为 `<redacted>` 外逐字保留。

### 4.1 P0 基线（`83d7247`，`C:\Users\InformationDS\aikanban-build`）

```text
AIKanBan P0 baseline gates. cwd=C:\Users\InformationDS\aikanban-build HEAD=83d72477dc3934ca7efaadda907d327b4e754fee

===== P0-INSTALL-FROZEN =====
Scope: all 4 workspace projects
✓ Lockfile passes supply-chain policies (verified 6d ago)
Lockfile is up to date, resolution step is skipped
Packages: +89
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 0, reused 1, downloaded 0, added 0
Progress: resolved 0, reused 89, downloaded 0, added 89, done

Done in 1.6s using pnpm v11.7.0
===== P0-INSTALL-FROZEN EXIT=0 =====

===== P0-TYPECHECK =====
$ tsc -b
===== P0-TYPECHECK EXIT=0 =====

===== P0-BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-build\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      21.38 kB │ gzip:  7.00 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  65.44 kB │ gzip: 18.04 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 86.82 kB
✔ [@aikanban/dsh-aikanban] Build complete in 123ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-build\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 48ms
===== P0-BUILD EXIT=0 =====

===== P0-TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-build/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-build/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 14ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 24ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 11ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 7ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 18ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 22ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 24ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 34ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  22:50:38
packages/plugin-client test:    Duration  3.36s (transform 531ms, setup 0ms, collect 1.09s, tests 44ms, environment 1ms, prepare 2.83s)
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 20ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 24ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 42ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 45ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  22:50:38
packages/core test:    Duration  4.12s (transform 1.38s, setup 0ms, collect 5.98s, tests 290ms, environment 3ms, prepare 11.25s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-build/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 15ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 140ms
packages/plugin test:  ✓ test/host.test.ts (19 tests) 67ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  38 passed (38)
packages/plugin test:    Start at  22:50:44
packages/plugin test:    Duration  1.65s (transform 296ms, setup 0ms, collect 452ms, tests 222ms, environment 1ms, prepare 1.10s)
packages/plugin test: Done
===== P0-TESTS EXIT=0 =====

===== P0-VERIFY-HOST-IMPORT =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (20.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvgmgktx-1 pid=13828
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgmgktx-1, pid 13828, services seen: none)

OK
===== P0-VERIFY-HOST-IMPORT EXIT=0 =====

===== P0-PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-build
  isolated home    C:\Users\InformationDS\aikanban-build\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-build\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-build\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/4] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-build\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/4] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgmglbu-1

[3/4] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:1731/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=15804acaa5f9b315-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/4] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgmgqa4-1 pid=23108 tools=false systemPrompt=false

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-build\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgmglbu-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=15804acaa5f9b315-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgmgqa4-1 pid=23108 tools=false systemPrompt=false

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== P0-PROBE-HOST EXIT=0 =====

===== P0-CHECK-DOCS =====
PASS: 58 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== P0-CHECK-DOCS EXIT=0 =====
ALL DONE
```

### 4.2 P1 门禁（`28c6d5d`，`C:\Users\InformationDS\aikanban-verify`）

```text
AIKanBan P1 final gates (clean worktree). cwd=C:\Users\InformationDS\aikanban-verify HEAD=28c6d5dc63bce75199829b0c991ee0a3e24a8f62

===== P1-INSTALL-FROZEN =====
Scope: all 4 workspace projects
✓ Lockfile passes supply-chain policies (verified 2m ago)
Lockfile is up to date, resolution step is skipped
Packages: +89
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

   ╭──────────────────────────────────────────╮
   │                                          │
   │   Update available! 11.7.0 → 12.14.0.    │
   │   Changelog: https://pnpm.io/v/12.14.0   │
   │     To update, run: pnpm add -g pnpm     │
   │                                          │
   ╰──────────────────────────────────────────╯

Progress: resolved 0, reused 1, downloaded 0, added 0
Progress: resolved 0, reused 89, downloaded 0, added 89
Progress: resolved 0, reused 89, downloaded 0, added 89, done

Done in 2s using pnpm v11.7.0
===== P1-INSTALL-FROZEN EXIT=0 =====

===== P1-TYPECHECK =====
$ tsc -b
===== P1-TYPECHECK EXIT=0 =====

===== P1-BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-verify\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      21.38 kB │ gzip:  7.00 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  65.44 kB │ gzip: 18.04 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 86.82 kB
✔ [@aikanban/dsh-aikanban] Build complete in 114ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-verify\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 63ms
===== P1-BUILD EXIT=0 =====

===== P1-TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-verify/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-verify/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 12ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 22ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 11ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  23:00:04
packages/plugin-client test:    Duration  3.27s (transform 682ms, setup 0ms, collect 1.05s, tests 42ms, environment 1ms, prepare 2.85s)
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 24ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 25ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 22ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 27ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 21ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 24ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 71ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 55ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 77ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  23:00:04
packages/core test:    Duration  4.10s (transform 1.61s, setup 0ms, collect 7.05s, tests 383ms, environment 3ms, prepare 9.65s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-verify/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 17ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 154ms
packages/plugin test:  ✓ test/host.test.ts (19 tests) 14ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  38 passed (38)
packages/plugin test:    Start at  23:00:10
packages/plugin test:    Duration  1.77s (transform 329ms, setup 0ms, collect 500ms, tests 186ms, environment 1ms, prepare 1.11s)
packages/plugin test: Done
===== P1-TESTS EXIT=0 =====

===== P1-VERIFY-HOST-IMPORT =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (20.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvgmsq5s-1 pid=13536
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgmsq5s-1, pid 13536, services seen: none)

OK
===== P1-VERIFY-HOST-IMPORT EXIT=0 =====

===== P1-PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-verify
  isolated home    C:\Users\InformationDS\aikanban-verify\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-verify\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-verify\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/4] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-verify\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/4] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgmsqmw-1

[3/4] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:7017/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=8e5c290959d7b8f9-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/4] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgmswdn-1 pid=856 tools=false systemPrompt=false

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-verify\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgmsqmw-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=8e5c290959d7b8f9-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgmswdn-1 pid=856 tools=false systemPrompt=false

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== P1-PROBE-HOST EXIT=0 =====

===== P1-CHECK-DOCS =====
PASS: 58 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== P1-CHECK-DOCS EXIT=0 =====
ALL DONE
```

## 5. 门禁数字核对

| 门禁 | P0 基线 `83d7247` | P1 后 `28c6d5d` | 判据 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | EXIT 0 | EXIT 0（从该提交新建的干净 worktree） | A-G0 |
| `pnpm run typecheck` | EXIT 0 | EXIT 0 | A-G1 |
| `pnpm run build` | EXIT 0（`lib/index.js` 21.38 kB、`lib/client.js` 28.40 kB） | EXIT 0（产物字节数与基线相同——本档只加依赖边，不改产物） | A-G1 |
| `pnpm -r --if-present run test` | 149：core 66 / plugin 38 / plugin-client 45 | 149：core 66 / plugin 38 / plugin-client 45 | A-G2 |
| `node tools\verify-host-import.mjs` | 11/11 PASS | **11/11 PASS**（`1 module(s), only node: builtins`） | A-G3 不退化 |
| `node tools\probe-host.mjs` | PROBE OK 4/4 | PROBE OK 4/4 | A-G4 |
| `python docs/tools/check_docs.py` | PASS（58 个 Markdown 文件） | PASS（58 个 Markdown 文件；本记录入库后为 59） | 文档门禁 |

## 6. 剩余未确认项（本档未取证，不得写成已验证）

- **A1 正式 import 后**的完整门禁：本档的 core 解析取证用的是沙盒一次性临时代码；`src/` 里尚无 `@aikanban/core` 导入。下一档落地 A1 时必须复跑同一组门禁。
- 规格 §5.2：真实插件上下文里 `ctx.storageDomain.open` 的暴露形状与错误形状（A2 档取证）。
- 规格 §5.4：`workspaceRegistry` 的运行时字段、服务绑定时机/生命周期、`connection`/`storageDomain` 相对 `apply()` 的到达顺序（A2 档）。
- 规格 §5.1/§8：cordis 4.0.2 无 `on('dispose')`；倾向的 `ctx.effect` 拆除语义未确认（A2 档）。
- 规格 §7.1 第 9 条：`createStatusTool` output schema 的**运行时快照字段覆盖哨兵**尚未新增（A2/A3 档）。
- 规格 §7.2：`tools/probe-host.mjs` 尚无「`registerBoardChannel` 实际被调用」断言（A12）。
- 规格 §8 第 1/2 条：真实 `connection.rpc` 网络往返、浏览器真实渲染仍属档 1，本档未碰。
- 规格 §8 第 11 条：reorder 的 order 级基线缺失（D6）未解决，留给 B/后续契约扩展。
- 本档没有执行任何真实 profile 安装，也没有重启/触碰用户 GUI。

## 7. 环境观察（记录，不据此改仓库或放宽门禁）

- 本机 pnpm 11.7.0 在沙盒里**首次**跑非 frozen `pnpm install` 时，写完 `pnpm-lock.yaml` 与 `node_modules`（`node_modules/.modules.yaml` 已更新、锁文件 importer 已含 core）后进程未退出：CPU 无增长、无网络连接，挂起 >3 分钟。kill 后从干净 `node_modules` 复跑同一命令，**EXIT 0**，lockfile diff 仍只有 importer 三行；随后从提交后的干净 worktree 复跑 `--frozen-lockfile` 也 **EXIT 0**（见 §4.2）。后续档如再遇到，按「kill 后从干净 node_modules 重跑」处理，不要修改仓库或放宽门禁。

## 8. 下一档

- 按任务书下一档范围执行。就规格依赖顺序，下一步是 host 半接线：A2（`HostContext` 探测与 `apply()` 启动链、激活快照/诊断事件、同步扩 output schema）+ A3（通道契约）与 A12（探针断言），随后才是 A1（`board-adapter.ts`）与浏览器半 A5–A10。**仍不新增端点、不做项目选择 UI、不改 UI 信息架构、AT 保持「待执行」。**
- 本档交出的硬前置：清单与 lockfile 已在同一提交，任何干净 worktree 可用 `pnpm install --frozen-lockfile` 复现（A-G0 成立）。

## 9. P2 取证 + P3 落地：host 半接线（2026-10-21，提交 `345ad5f`、`572193c`）

> 本节仍是**实施记录**，不是验收记录：F01/F02 的 AT 全部保持「待执行」，`docs/prd/mapping/acceptance.csv` 的 status 未改；本节的测试与探针是档 2/档 3 辅助证据。本档完成 ≠ 切片 A 完成：P5b 的 `board-adapter.ts` 与浏览器半 A5–A10 尚未实施。

### 9.1 范围与改动

按 `git diff --stat d6c2351..572193c`：**8 文件，+1392/−42**。两个聚焦提交：

| 提交 | 文件 | 改动 |
| --- | --- | --- |
| `345ad5f`（3 文件，+284/−2） | `packages/plugin/src/data-layer.ts`（新，158 行） | zod-free 结构校验器 shim；`buildDomainSpec` 造 spec → `ctx.storageDomain.open` → `createStorageDomainPort` → `createKanbanCore`；open 后再做一次 `getDraft` 读（open 解析不等于介质可读）；`open-failed`/`invalid-domain`/`read-failed`/`create-failed` 全部返回结果、不抛 |
| | `packages/plugin/src/index.ts` | `apply()` 异步 bootstrap：经 `ctx.reflect.get('storageDomain', false)` 探测 + `internal/service` 晚到重试；`void runBootstrap(...).catch(...)`；导出 `getKanbanCore()` / `getDataLayerError()` |
| | `packages/core/src/domainSpec.ts` | **仅 JSDoc 改写**（见 §9.6 偏差⑤），无语义变化 |
| `572193c`（6 文件，+1149/−81） | `packages/plugin/src/index.ts` | `HostContext` 增 `connection`/`storageDomain`/`workspaceRegistry`/`inject`；`/aikanban` 注册；`ActivationSnapshot` 增三字段；`createStatusTool` 的 output schema 同步；新增 `aikanban:board-channel` 事件；`internal/service` 重试 |
| | `packages/plugin/src/delayed-board-port.ts`（新，91 行） | 未就绪：四端点 `unavailable`；就绪但适配器未接线（P5b）：读 `read-failed`、写 `save-failed`，message 含 `not-wired-yet`；绝不抛、绝不伪造空看板 |
| | `packages/plugin/src/scoped-channel-registration.ts`（新，128 行） | 公开 `connection.rpc.handle` 优先 + 宿主内部 `register(owner, channel, handler)` 兼容回退（§9.3） |
| | `packages/plugin/test/host.test.ts` | 19 → **34** 用例（+15）：运行时快照 schema 字段覆盖哨兵、通道注册（公开/晚到/register-failed/兼容回退/inject 同步抛错）、延迟端口四端点、数据层 bootstrap/open 拒绝/`dataLayerReady` 重发布 |
| | `tools/probe-host.mjs` | 观察者订阅 `aikanban:board-channel`；新增第 5 项检查；步骤编号 `[1/5]..[5/5]`；PASS 明细附末次 activation 的 `dataLayerReady`（false 时归入 `not observed`） |
| | `tools/COMMANDS.md` | 期望值 164 用例 / probe 5/5；§10.4 第 4/5 项 SKIP 与 dataLayerReady 说明（2026-10-20 历史快照原文保留） |

**明确未做**：`packages/plugin-client/**` 零改动（wire/source/channel-source/controller/model/board.tsx/runtime/index.tsx 全未动）；未新增端点、`BOARD_ENDPOINTS`/`BOARD_CHANNEL` 未变；未改 `docs/prd/**`、`acceptance.csv`、`docs/tools/check_docs.py`、`tools/verify-host-import.mjs`；`packages/plugin/src/board-adapter.ts` 未创建（P5b）；未装真实 profile、未重启用户 GUI。

### 9.2 P2 取证结论（关闭规格 §5.2/§8 的「未确认」项 1、2）

**Q1：`ctx.storageDomain.open(<裸 DomainSpecLike>)` 在真实插件上下文中是否被接受？**
→ **被接受**。隔离宿主（DSH 44.7.0，probe profile = dsh-base + dsh-web-app + aikanban 行）的宿主进程日志（边界 1 的 `--keep` 运行，`.probe-out-scaffold/probe-probe.log` 原文）：

``text
[aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
[probe] ACTIVATION {"marker":"[aikanban] active","plugin":"@aikanban/dsh-aikanban","version":"0.0.0","activationId":"mvgog78q-1","startedAt":1792500388010,"appliedAt":1792500388010,"pid":33496,"statusToolRegistered":false,"promptSectionRegistered":false,"servicesObserved":[]}
[aikanban] P2 data-layer: storageDomain became reachable after apply()
[aikanban] P2 data-layer: open-ok domain=aikanban_core probeRead=getDraft
[probe] ACTIVATION {"marker":"[aikanban] active","plugin":"@aikanban/dsh-aikanban","version":"0.0.0","activationId":"mvgog78q-1","startedAt":1792500388010,"appliedAt":1792500388010,"pid":33496,"statusToolRegistered":true,"promptSectionRegistered":true,"servicesObserved":["systemPrompt","tools","storageDomain"]}
``

其中 `open-ok domain=aikanban_core probeRead=getDraft` 表示 `open()` 解析后还成功执行了一次 `core.getDraft('aikanban-open-probe')` 读（域已挂载、表可读；返回 null 是预期）。**没有观察到 open 被拒的失败形状**；`openDataLayer` 仍把失败收敛成 4 个 stage 的结果，单测覆盖 `open()` reject 时 `dataLayerReady=false` 且 `getDataLayerError()` 可见。

> 上述两行 `[aikanban] P2 ...` 是边界 1 的**临时诊断输出**（规格允许 P2 先取证）；`572193c` 已删除，等价的最终状态改由 `ActivationSnapshot.dataLayerReady` + 重发激活信号表达（见 §9.4.4）。

**Q2：`ctx.reflect.get` / `ctx.storageDomain` 是否可达、何时可达？**
→ 可达，但**三个服务在 `apply()` 时刻都不可达**（同一日志：`storageDomain=absent connection=absent workspaceRegistry=absent`），随后均经 cordis `internal/service` 晚到。`storageDomain` 晚到后 open 成功；`connection` 晚到后通道注册成功；最终激活快照的 `servicesObserved` 为 `["systemPrompt","tools","storageDomain","connection"]`。这正是规格 §8 第 7 条预留的「晚到重试 + 重发激活信号」路径，实测成立。

### 9.3 真实宿主的新发现：公开的 `connection.rpc.handle` 在 DSH 44.7.0 不可用（本档唯一的规格外发现）

**现象**：按规格 §5.1 用 `ctx.reflect.get('connection')` 拿到服务后调用 `registerBoardChannel`，真实宿主恒报 `register-failed`；把注册放进 `ctx.inject(['connection','webServer'])` 子 fiber 后**仍然失败**。宿主日志中的诊断（临时加、已删）给出错误 `cannot get property "webServer" without inject`，栈指向安装包 `@deepseek-ai/dsh-client-connection/lib/index.js:618`：

``text
[aikanban] P2 register-failed detail: cannot get property "webServer" without inject | Error: cannot get property "webServer" without inject
    at Fiber.<anonymous> (.../@deepseek-ai/dsh-client-connection/lib/index.js:618:35)
    at Proxy.register (.../@deepseek-ai/dsh-client-connection/lib/index.js:618:16)
    at Object.handle (.../@deepseek-ai/dsh-client-connection/lib/index.js:543:39)
    at registerBoardChannel (.../aikanban-p2/packages/plugin/lib/index.js:288:34)
``

根因（读安装包实现确认）：`get rpc()` 内 `const owner = this.ctx`，而 cordis 的服务追踪把 `this.ctx` 影子重绑到**服务提供方**上下文（`dsh-client-connection` 插件 ctx 只 inject `credentials`）；`register(owner,...)` 里 `owner.effect(() => owner.webServer.register(route))` 因此在任何消费方插件里都解析不到 `webServer`。换句话说，**44.7.0 的公开 RPC 通道注册入口对插件不可用**，与 ADR-005/规格 §5.1 的字面假设冲突。

**取证矩阵**（隔离宿主内临时探测代码，已从提交中删除）：在同一个 `ctx.inject(['connection','webServer'])` 子 fiber 里：

| 访问路径 | 结果 |
| --- | --- |
| `scoped.connection.rpc.handle(...)`（公开路径） | 抛 `cannot get property "webServer" without inject` |
| `scoped.reflect.get('connection').rpc.handle(...)` | 同上 |
| 宿主内部 `register(owner=scoped, channel, handler)`（`handle` 内部调用的同一方法，仅 owner 不同） | **成功**，路由可注册 |
| `rpc` getter 配 `this.ctx = scoped` 的等价调用 | 成功 |
| 子 fiber 内直接读 `scoped.webServer.register` | 可用（证明注入本身正确） |

**处置**（`scoped-channel-registration.ts`）：先走公开 `rpc.handle`；仅在它抛错时回退到宿主自身的 `register(owner=注入子上下文, channel, handler)`。找不到内部方法时报 `register-failed`（不静默）；成功走兼容路径时 `logger.warn` 留痕。`tools/probe-host.mjs` 第 5 项据此在真实宿主观察到 `aikanban:board-channel {channel:'/aikanban', registered:true, reason:null}`。

**风险与删除条件**：兼容回退依赖运行时的原型方法 `HostConnectionService#register`（TS `private`，非 `#private`）；宿主升级可能改名或改签名。防线是「找不到/抛错 → `register-failed`」可见失败 + 探针第 5 项直接失败，不会静默退化；`scoped-channel-registration.ts` 的模块注释记录了完整证据，宿主修复公开入口后可整文件删除回退分支。**需要评审决策**：接受该兼容层，或改为上游修复/其他方案（后者会改契约，超出本档）。

### 9.4 门禁原始输出

环境：node v24.21.0 / pnpm 11.7.0（DSH runtime 自带），全部在**同步盘之外的 worktree** `C:\Users\InformationDS\aikanban-p2` 内执行；日志除 URL 的 `token=` 替换为 `<redacted>` 外逐字保留。基线跑过一次 `pnpm install --frozen-lockfile`（EXIT 0）；后两次复用同一 `node_modules`（`-SkipInstall`），A-G0 的 frozen 基线本身未变。

#### 9.4.1 改动前基线（`d6c2351`）

``text

AIKanBan gates [P2-BASE] cwd=C:\Users\InformationDS\aikanban-p2 HEAD=d6c2351ecd4366966aecf22998c41389b474b019
===== INSTALL-FROZEN =====
Scope: all 4 workspace projects
Already up to date
Done in 466ms using pnpm v11.7.0
===== INSTALL-FROZEN EXIT=0 =====
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      21.38 kB │ gzip:  7.00 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  65.44 kB │ gzip: 18.04 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 86.82 kB
✔ [@aikanban/dsh-aikanban] Build complete in 107ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 42ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 13ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 22ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 8ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 6ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  23:35:53
packages/plugin-client test:    Duration  2.62s (transform 421ms, setup 0ms, collect 920ms, tests 41ms, environment 1ms, prepare 2.19s)
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 18ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 25ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 23ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 27ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 28ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 20ms
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 25ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 45ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 39ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  23:35:53
packages/core test:    Duration  3.32s (transform 1.26s, setup 0ms, collect 5.57s, tests 284ms, environment 3ms, prepare 8.18s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 14ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 116ms
packages/plugin test:  ✓ test/host.test.ts (19 tests) 10ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  38 passed (38)
packages/plugin test:    Start at  23:35:58
packages/plugin test:    Duration  1.37s (transform 250ms, setup 0ms, collect 382ms, tests 140ms, environment 0ms, prepare 822ms)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY-HOST-IMPORT =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (20.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvgo2r2l-1 pid=30740
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgo2r2l-1, pid 30740, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
===== PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p2
  isolated home    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/4] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/4] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgo2rhr-1

[3/4] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:1262/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=9dab673c58ee6ba6-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/4] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgo2w90-1 pid=1716 tools=false systemPrompt=false

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgo2rhr-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=9dab673c58ee6ba6-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgo2w90-1 pid=1716 tools=false systemPrompt=false

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
ALL DONE FAILED=False
``

#### 9.4.2 提交边界 1（`345ad5f`）

``text

AIKanBan gates [P2-B1] cwd=C:\Users\InformationDS\aikanban-p2 HEAD=d6c2351ecd4366966aecf22998c41389b474b019
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      147.13 kB │ gzip: 36.48 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  322.83 kB │ gzip: 76.31 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 469.95 kB
✔ [@aikanban/dsh-aikanban] Build complete in 64ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 49ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 13ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 23ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 7ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 10ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  23:47:31
packages/plugin-client test:    Duration  3.06s (transform 422ms, setup 0ms, collect 915ms, tests 46ms, environment 3ms, prepare 2.53s)
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 23ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 22ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 22ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 21ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 29ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 24ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 26ms
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 48ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 60ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  23:47:31
packages/core test:    Duration  3.91s (transform 1.28s, setup 0ms, collect 6.55s, tests 301ms, environment 4ms, prepare 9.25s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 17ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 227ms
packages/plugin test: stderr | test/host.test.ts > host half: activation > activates without throwing when no optional service is bound
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: activation > activates without a logger (logger is optional in the contract)
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: activation > emits the startup marker on the host logger
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: activation > gives each activation a distinct id
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: registration > registers exactly one diagnostic tool when `tools` is already bound
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: registration > re-probing the same service does not double-register
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: registration > lands both registrations when services arrive after apply()
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: registration > ignores a malformed service value instead of throwing during boot
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: diagnostic tool > reports the live snapshot, matching the activation id
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test: stderr | test/host.test.ts > host half: activation signal > publishes on the documented channel when apply() runs
packages/plugin test: [aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
packages/plugin test:  ✓ test/host.test.ts (19 tests) 18ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  38 passed (38)
packages/plugin test:    Start at  23:47:37
packages/plugin test:    Duration  2.04s (transform 597ms, setup 0ms, collect 857ms, tests 262ms, environment 2ms, prepare 1.07s)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY-HOST-IMPORT =====
[aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (143.7 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvgohqz1-1 pid=424
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgohqz1-1, pid 424, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
===== PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p2
  isolated home    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/4] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/4] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgohru3-1[aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent

[3/4] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:1183/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=a4075ff132dd9dcc-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/4] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgohwrx-1 pid=27780 tools=false systemPrompt=false

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgohru3-1[aikanban] P2 services at apply(): storageDomain=absent connection=absent workspaceRegistry=absent
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=a4075ff132dd9dcc-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgohwrx-1 pid=27780 tools=false systemPrompt=false

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
ALL DONE FAILED=False
``

#### 9.4.3 本档最终状态（`572193c`，独立复核 SF1–SF3 修补后重跑）

``text

AIKanBan gates [P2-FINAL] cwd=C:\Users\InformationDS\aikanban-p2 HEAD=572193cc21506a63fb8b82c406b13ab651acf48c
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      159.22 kB │ gzip: 39.77 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  349.17 kB │ gzip: 83.05 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 508.39 kB
✔ [@aikanban/dsh-aikanban] Build complete in 70ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 44ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 12ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 19ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 8ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 21ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 22ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 24ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 25ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 31ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 21ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 25ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  00:50:47
packages/plugin-client test:    Duration  2.82s (transform 417ms, setup 0ms, collect 896ms, tests 40ms, environment 1ms, prepare 2.09s)
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 50ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 49ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  00:50:47
packages/core test:    Duration  3.44s (transform 1.18s, setup 0ms, collect 6.16s, tests 295ms, environment 3ms, prepare 7.82s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 16ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 203ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 91ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  53 passed (53)
packages/plugin test:    Start at  00:50:52
packages/plugin test:    Duration  1.97s (transform 627ms, setup 0ms, collect 829ms, tests 310ms, environment 1ms, prepare 974ms)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY-HOST-IMPORT =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (155.5 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvgqr2ue-1 pid=24676
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgqr2ue-1, pid 24676, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
===== PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p2
  isolated home    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgqr3aa-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:2403/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=39ec24ac4c959ecb-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgqr84o-1 pid=37944 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p2\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgqr3aa-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=39ec24ac4c959ecb-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgqr84o-1 pid=37944 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
ALL DONE FAILED=False
``

#### 9.4.4 探针宿主内证据（最终运行，`.probe-out-scaffold/probe-probe.log`）

三次 `aikanban:activation` 依次表示 apply 同步发布 → 数据层就绪重发 → 通道注册重发；`aikanban:board-channel` 为注册成功事件：

``text
[probe] ACTIVATION {"marker":"[aikanban] active","plugin":"@aikanban/dsh-aikanban","version":"0.0.0","activationId":"mvgqr84o-1","startedAt":1792504261608,"appliedAt":1792504261608,"pid":37944,"statusToolRegistered":false,"promptSectionRegistered":false,"boardChannelRegistered":false,"boardChannel":null,"dataLayerReady":false,"servicesObserved":[]}
[probe] ACTIVATION {"marker":"[aikanban] active","plugin":"@aikanban/dsh-aikanban","version":"0.0.0","activationId":"mvgqr84o-1","startedAt":1792504261608,"appliedAt":1792504261608,"pid":37944,"statusToolRegistered":true,"promptSectionRegistered":true,"boardChannelRegistered":false,"boardChannel":null,"dataLayerReady":true,"servicesObserved":["systemPrompt","tools","storageDomain"]}
[probe] BOARD-CHANNEL {"channel":"/aikanban","registered":true,"reason":null,"at":1792504266990}
[probe] ACTIVATION {"marker":"[aikanban] active","plugin":"@aikanban/dsh-aikanban","version":"0.0.0","activationId":"mvgqr84o-1","startedAt":1792504261608,"appliedAt":1792504261608,"pid":37944,"statusToolRegistered":true,"promptSectionRegistered":true,"boardChannelRegistered":true,"boardChannel":"/aikanban","dataLayerReady":true,"servicesObserved":["systemPrompt","tools","storageDomain","connection"]}
``

### 9.5 门禁数字核对

| 判据 | 改动前 `d6c2351` | 边界 1 `345ad5f` | 最终 `572193c` |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | EXIT 0 | 复用已安装依赖 | 复用已安装依赖 |
| `pnpm run typecheck` | EXIT 0 | EXIT 0 | EXIT 0 |
| `pnpm run build` | EXIT 0（host `lib/index.js` 21.38 kB） | EXIT 0（147.13 kB，core 内联） | EXIT 0（159.22 kB） |
| `pnpm -r --if-present run test` | **149**（core 66 / plugin 38 / plugin-client 45） | **149**（未加用例） | **164**（core 66 / **plugin 53** / plugin-client 45） |
| `node tools\verify-host-import.mjs` | 11/11 PASS | 11/11 PASS | **11/11 PASS**（`1 module(s), only node: builtins`） |
| `node tools\probe-host.mjs` | PROBE OK **4/4** | PROBE OK **4/4** | PROBE OK **5/5**（新增 `/aikanban` 注册 PASS，`dataLayerReady=true`） |
| `python docs/tools/check_docs.py` | PASS（59 个 Markdown 文件） | PASS | PASS（本节追加后仍 59） |

### 9.6 与 `s1-wiring.md` 的字面不一致（本档属实；规格未改，供下一轮修订）

| # | 规格字面 | 实际实现 | 原因/边界 |
| --- | --- | --- | --- |
| ① | §5.1 第 2–3 步「reflect 探测 connection/storageDomain，connection 就绪 → 立即 registerBoardChannel；不新增 inject」 | 新增 `HostContext.inject` 成员 + `apply()` 里动态 `ctx.inject(['connection','webServer'])` 子 fiber，再注册 | 真实宿主必须让注册所属上下文能解析 `webServer`（§9.3）；动态子 fiber 不阻塞父 fiber，`inject` 导出数组仍为 `[]`，无服务上下文仍激活（verify 11/11 未退化） |
| ② | §5.1 第 3 步 / A12「同步 registerBoardChannel」 | 公开 `registerBoardChannel` 优先，抛错时回退宿主内部 `register(owner)` | 公开入口在 44.7.0 不可用（§9.3）。探针断言名相应为「host half registered /aikanban inside the booting host」，不再声称调用的一定是公开 `registerBoardChannel` |
| ③ | §5.1 第 2 步探测三服务 | `workspaceRegistry` 只在 `HostContext` 声明，未在 apply 探测/消费 | 项目解析属 P5b 适配器；本档不消费它，避免造空列表 |
| ④ | §7.2「第 4 步增加第 5 项检查」 | 独立 `[5/5]` 步骤 | 第 4 项保持「apply 在宿主内运行」语义不变；新增独立步骤更清晰，退出码语义不变 |
| ⑤ | —（门禁误报） | `packages/core/src/domainSpec.ts` JSDoc 改写一行 | `verify-host-import.mjs` 的文本扫描把注释里的示例 `import z from 'zod'` 当成真实 bare specifier，内联 core 后 11/11 退化；仅改措辞，未改校验脚本、未改任何运行时行为 |
| ⑥ | §5.5 诊断事件 reason 词表为 no-connection / register-failed / null | 同左词表，但 44.7.0 下真实宿主走兼容路径成功，`reason:null`；`no-connection` 只出现在无注入器的最小组合/假宿主 | 不新增浏览器失败码（8 码不变） |
| ⑦ | §7.3 A-G2 用例数 149 | 164（plugin 53） | 新增用例是 host 半接线证据；core 66 / plugin-client 45 未变 |

### 9.7 剩余未确认项（本档未取证，不得写成已验证）

- **`aikanban:board-channel` 之后的真实网络往返**：探针只证明宿主进程内注册发生；浏览器经 `/aikanban` 的真实请求（Host/Origin、token、页面↔宿主）仍属档 1，未执行（ADR-005 仍 `提议`）。
- **P5b 适配器**：`delayed-board-port` 在 ready 后仍返回 `not-wired-yet`；4 端点的真实 core 映射、错误码映射（§6）与集成测试（`board-adapter.test.ts`）未做。
- **浏览器半 A5–A10**：Q1=B 的 `selection-required`/`readBoard(projectId)`、Q2=A 的基线/撤销凭据/`verdict` 重试政策全部未实施；本档对 `packages/plugin-client/**` 零改动。
- **`workspaceRegistry` 运行时字段与绑定时机**：本档只声明结构类型，未消费（P5b 取证）。
- **析构/生命周期**：忽略 `registerBoardChannel` 的 disposer，按进程级生命周期；cordis 4 的 `ctx.effect` 拆除语义未验证（规格 §8 第 6 条）。
- **兼容回退的宿主版本风险**：依赖 `HostConnectionService#register` 原型方法；宿主升级后可能失败（会以 `register-failed` + 探针第 5 项 FAIL 可见）。
- **工具 output schema 的真实 `ToolOutputError` 形状**：本地只有「以运行时快照为基准」的字段覆盖哨兵 + 关键字检查；真实调用报错形状仍未验证。
- **order 级基线缺失（D6）**：未解决，留给 B/后续契约扩展。
- **数据层失败后的恢复路径**：只有 `internal/service` 晚到重试一次；无周期重试/手动重开（规格未要求，记录边界）。

### 9.8 下一档建议

1. **决策 §9.3 的兼容层**：接受（保留并向上游报 issue，宿主修复后删除回退）或改方案（会改公开契约，需要先评审）。这是本档唯一需要人拍板的点。
2. **P5b：A1 `board-adapter.ts`**（core→4 端点映射，§3/§6）——`delayed-board-port` 变成真正的转发层；补 `board-adapter.test.ts` 集成测试。注意 §4.5 的「2 个当前必红 + 2 个类型层必改」集合会随 A3/A5 一起到来。
3. **浏览器半 A5–A10**：按 Q1=B / Q2=A 改 wire/source/channel-source/controller/model/board.tsx/runtime；本档未动它们正是为了把破坏性契约变更集中到一个可评审的提交。
4. **规格/ADR 修订（需用户/评审同意）**：把 §5.1 的注册机制、§5.4 的 `HostContext` 成员表、§7.2 的第 5 项、§8 的 connection 生命周期/注册语义按 §9.3 与 §9.6 更新；ADR-007 §11 证据补记本档的档 2/档 3 结果（仍不是验收）。
5. **档 1 证据**：把插件装进真实 profile、在真实 GUI 完成「选择项目→看板→改状态→撤销」——需要用户批准与重启；本档未做。

