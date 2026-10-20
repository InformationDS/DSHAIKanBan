# S1 接线实施记录

> **性质**：本页是切片 A 的工程**实施记录**，不是实现进度声明，也不是验收记录。F01/F02 的 AT 仍全部「待执行」，`docs/prd/mapping/acceptance.csv` 的 `status` 保持「待执行」；本页的测试与探针只能作为档 2/档 3 辅助证据，不能替代验收（见[验收执行规则](acceptance-execution.md)）。
>
> **依据与分工**：[s1-wiring.md](s1-wiring.md) §7.4（S5 分工）与 [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md) §10；按 M6 首次创建，后续追加章节须注明日期与提交号（[vibecoding-task.md](../prd/templates/vibecoding-task.md)）。
>
> **覆盖范围**：P0（基线复现）+ P1（`@aikanban/core` 依赖边与 lockfile）。不含业务逻辑；`packages/plugin/src/board-adapter.ts` **未创建**，`apply()` **未改**，未新增端点，未改 UI 信息架构。

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
