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


### 9.4.5 推送后干净 worktree 复跑（自证不算数）

上方 9.4.1–9.4.4 都在开发沙盒里跑。推送后另建**干净 worktree** `C:\Users\InformationDS\aikanban-p2-clean`（detached `461e21c`，即 `main` 推送后的 HEAD），先跑 `pnpm install --frozen-lockfile`，再跑全部六项门禁——结果与 9.4.3 相同（164 用例、verify 11/11、probe 5/5、docs PASS）。完整原始输出（仅 URL token 替换为 `<redacted>`）：

~~~text

AIKanBan gates [P2-POST] cwd=C:\Users\InformationDS\aikanban-p2-clean HEAD=461e21c182920caeeba0e623c3621ea734065972
===== INSTALL-FROZEN =====
Scope: all 4 workspace projects
✓ Lockfile passes supply-chain policies (verified 1h ago)
Lockfile is up to date, resolution step is skipped
Packages: +89
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 0, reused 1, downloaded 0, added 0
Progress: resolved 0, reused 89, downloaded 0, added 89, done

Done in 1.9s using pnpm v11.7.0
===== INSTALL-FROZEN EXIT=0 =====
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2-clean\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      159.22 kB │ gzip: 39.77 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  349.93 kB │ gzip: 82.97 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 509.14 kB
✔ [@aikanban/dsh-aikanban] Build complete in 70ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p2-clean\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 51ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2-clean/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2-clean/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 13ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 21ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 10ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  00:54:03
packages/plugin-client test:    Duration  3.01s (transform 522ms, setup 0ms, collect 946ms, tests 43ms, environment 1ms, prepare 2.65s)
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 18ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 21ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 24ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 23ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 23ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 28ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 22ms
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 27ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 42ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 47ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  00:54:03
packages/core test:    Duration  3.85s (transform 1.43s, setup 0ms, collect 6.12s, tests 285ms, environment 3ms, prepare 9.56s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p2-clean/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 17ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 266ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 107ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  53 passed (53)
packages/plugin test:    Start at  00:54:09
packages/plugin test:    Duration  2.31s (transform 729ms, setup 0ms, collect 1.04s, tests 391ms, environment 1ms, prepare 1.10s)
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
  PASS  apply() activates against a service-less context      activation=mvgqvbba-1 pid=38844
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvgqvbba-1, pid 38844, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
===== PROBE-HOST =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p2-clean
  isolated home    C:\Users\InformationDS\aikanban-p2-clean\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p2-clean\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p2-clean\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p2-clean\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgqvbvd-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:13289/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=2eb5b8c433d53878-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvgqvh8i-1 pid=30104 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p2-clean\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvgqvbvd-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=2eb5b8c433d53878-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvgqvh8i-1 pid=30104 tools=false systemPrompt=false
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

~~~

结论：A-G0 的 frozen 基线与全部门禁在**提交后的干净检出**上成立；本档没有依赖开发沙盒里的未提交状态。

## 10. P5a 边界 0：宿主缺陷入决策 + 兼容路径可见（2026-10-21）

### 10.1 改动

| 文件 | 改动 |
| --- | --- |
| `docs/engineering/decisions/ADR-005-浏览器半与宿主半的数据通道.md` | 新增「宿主缺陷与兼容层（2026-10-21）」：DSH 44.7.0 的 `dsh-client-connection/lib/index.js:540-545`（`get rpc()` 把 `owner` 固定为 `this.ctx`）、`:618`（`owner.effect(() => owner.webServer.register(route), …)`，实际抛栈行）、`lib/types/rpc-host.d.ts` 的 `HostConnectionService` 声明原文（channel registrations **belong to the caller fiber**）、isolated probe 实测表、兼容层三段式行为、**可删除条件**。ADR 状态仍为「提议」（真实 RPC 网络往返未验证）。 |
| `packages/plugin/src/index.ts` | `BoardChannelEventPayload` 增 `path: 'public' \| 'compat' \| 'failed' \| null`；`channelState` / `settleChannelRegistration` 在各注册分支填值（公开成功 `public`、兼容回退成功 `compat`、两条都失败 `failed`、无 `connection` 服务 `null`）；兼容路径日志改以 `path === 'compat'` 判定。 |
| `tools/probe-host.mjs` | 第 5 项 detail 增 `path=…`，输出形如 `channel=/aikanban registered=true path=compat reason=null dataLayerReady=true`。 |

不改：端点集合（仍 4 个）、浏览器失败码（仍 8 个）、`tools/verify-host-import.mjs` 匹配逻辑、`docs/prd/**`、`acceptance.csv`。

### 10.2 已知的检查器局限（只记录，不改脚本）

- `tools/verify-host-import.mjs` 的 bare-specifier 检查（导入图收集 `:263-276`、判定 `:265`）是**文本扫描**：它把注释里的示例也当成真实 import。P3 因此把 `packages/core/src/domainSpec.ts` 的一条 JSDoc 措辞改写（原措辞含 `import z from 'zod'` 形态的示例；**无语义变化**，见 §9.6 ⑤）。
- 本轮**不改**匹配逻辑（任务书硬边界），也**不在报错信息里加提示**（避免把检查器行为变更夹带进本档）；只在本记录写明：以后遇到同类命中，先确认是否位于注释中，属误报时按既有做法只改措辞，或另开任务改检查器（改词法感知，而不是继续改注释）。
- 结论：这条限制不改变「host 半导入图必须零 bare specifier」的判据本身；它只说明**报错可能指向注释**，不能作为放宽检查的理由。

### 10.3 门禁原始输出（沙盒 `C:\Users\InformationDS\aikanban-p5a`，HEAD `0f9cf1b` + 边界 0 改动）

``text
AIKanBan gates [P5a-B0] HEAD=0f9cf1b
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      159.45 kB │ gzip: 39.80 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  351.54 kB │ gzip: 83.33 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 511.00 kB
✔ [@aikanban/dsh-aikanban] Build complete in 140ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  28.40 kB │ gzip: 9.08 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 28.40 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 45ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 13ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 19ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 7ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 21ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 25ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 22ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 33ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 22ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 29ms
packages/plugin-client test:  Test Files  3 passed (3)
packages/plugin-client test:       Tests  45 passed (45)
packages/plugin-client test:    Start at  02:36:14
packages/plugin-client test:    Duration  3.27s (transform 503ms, setup 0ms, collect 903ms, tests 41ms, environment 1ms, prepare 3.01s)
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 51ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 57ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  02:36:14
packages/core test:    Duration  4.01s (transform 1.25s, setup 0ms, collect 6.13s, tests 312ms, environment 4ms, prepare 9.96s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 18ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (12 tests) 233ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 93ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  53 passed (53)
packages/plugin test:    Start at  02:36:19
packages/plugin test:    Duration  2.19s (transform 685ms, setup 0ms, collect 921ms, tests 344ms, environment 1ms, prepare 1.14s)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (155.7 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvguipbg-1 pid=35932
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvguipbg-1, pid 35932, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5a
  isolated home    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguiprq-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:7520/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=455d696edaad31ee-44
        served 200 26923B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvguivzc-1 pid=1240 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguiprq-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=455d696edaad31ee-44 status=200 bytes=26923
  PASS  apply() ran inside the booting host
        activation=mvguivzc-1 pid=1240 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
``

### 10.4 结论

六项门禁全绿且用例数**不变**（164 = core 66 / plugin 53 / plugin-client 45），`probe` 第 5 项首次直接显示 `path=compat`——兼容路径从此在宿主升级后可观测（宿主修好后应变为 `path=public`，回退失效则 `path=failed`）。

## 11. P5a：Q1=B / Q2=A 契约层与浏览器半（2026-10-21，提交 `fbb4ef9`、`95f085f`）

### 11.1 边界 A：wire 契约 + 两端解析（`fbb4ef9`，10 文件 +625/−99）

| 文件 | 改动 |
| --- | --- |
| `packages/plugin-client/src/wire.ts` | `ReadBoardPayload.projectId` 改**必填**，删除“current project”语义；三个写 payload 的 `expectedStatusVersion` 改必填，`UndoStatusPayload` 增必填 `appliedUpdateId`，`operationId` 明确为**本次撤销**的身份；新增 `STATUS_VERSION_PREFIX='ver1:'`、`encodeStatusVersion`、`parseStatusVersion`（严格 `^ver1:(0\|[1-9]\d*)$`）；`parseBoardTask` 要求 `statusRevision`（非负整数）与 `undoTarget`（对象或 `null`）；`parseReadBoardPayload` 拒绝缺省/空串。 |
| `packages/plugin-client/src/model.ts` | `BoardTask.statusRevision` 改必填、新增必填 `undoTarget: BoardUndoTarget \| null`；新增 `BoardUndoTarget {statusVersion, appliedUpdateId}`。 |
| `packages/plugin/src/board-channel.ts` | 三个写端点**在调用 port 之前**校验 `ver1:` 语法；非法/缺失基线 → `invalid-payload`（host 码），不进入 port、无写（F5）。`board/read` 缺 `projectId` 的报错文案改为“must carry a non-empty projectId; the host never guesses a project”。undo 成功分支的 `undoable` 从硬编码 `false` 改为透传 port（P3 脚手架遗留，按 §6.2“undoable 取写后快照”修正）。 |
| `packages/plugin-client/src/source.ts` | `BoardSource.readBoard(projectId)` 每次传参；`StatusChangeInput`/`ReorderInput.expectedStatusVersion` 必填；`UndoInput` 改为 `{taskId, operationId, expectedStatusVersion, appliedUpdateId}`。 |
| `packages/plugin-client/src/channel-source.ts` | 构造选项删除 `projectId`（source 不持有项目）；每次 read 组装 `{projectId}`，空 id 本地拒绝（不发请求）；写 payload 使用必填基线/双身份；unknown-result 文案改为“请先核对当前正式状态，**不要重复提交**”（A7）。 |
| `packages/plugin-client/src/controller.ts` | **最小对齐**（编译强制）：写前从当前视图任务的 `statusRevision` 编码基线；`UndoToken` 改为 `{taskId, expectedStatusVersion, appliedUpdateId}` 且**只由写后快照的 `undoTarget` 构造**；`undoLastChange` 为撤销新铸 `operationId`；无选择时 `load()` 不发请求（暂回 idle，选择状态机在 B）。 |
| 测试 | `channel-roundtrip.test.ts`（12→17，见 11.2）；新增 `plugin-client/test/wire.test.ts`（10 条）；`host.test.ts` 只补 payload 基线（34 条不变）；`controller.test.ts` fixture 补必填字段、断言新令牌（19 条不变）。 |

不改：`BOARD_ENDPOINTS`（仍 4 个）、`BOARD_FAILURE_CODES`（仍 8 个）、`verify-host-import.mjs` 匹配逻辑、`docs/prd/**`、`acceptance.csv`。

### 11.2 边界 A 用例变化（164 → 179，+15）

| 包 | 前 | 后 | 解释 |
| --- | --- | --- | --- |
| core | 66 | 66 | 未改 core。 |
| plugin | 53 | **58** | `channel-roundtrip` 12→17（+5 净增：改名/替换 1 条 + 新增 5 条）；`host.test` 34 不变（仅既有 payload 补基线，不是新用例）；`client-bundle` 7 不变（导出面未变）。 |
| plugin-client | 45 | **55** | 新增 `wire.test.ts` 10 条；`controller` 19、`model` 19、`slots` 7 不变。 |

`channel-roundtrip` 逐条（12→17）：

- **改名/替换（净 0）**：`travels an omitted payload as JSON null and still reads` → `refuses a board/read without a projectId: invalid-payload and no host read`（旧的“省略 payload 合法”语义被 Q1=B 删除，不能保留）。
- **新增 5**：`rejects a task snapshot without the required baseline/undo fields`（快照收紧）；`refuses a non-canonical baseline before the data layer, on all three write endpoints`（F5，逐端点 + 断言 port 未被调用）；`sends two distinct identities on undo: this undo and the write being undone`（撤销双身份）；`rejects an undo payload that conflates the two identities (missing appliedUpdateId)`（协议形状）；`reports a transport failure as unknown-result exactly once and never invites a resubmission`（F9/F10/D6 + A7 文案）。
- 既有 11 条全部**更新而非删除**：读/写 payload 新形状、`readBoard('ws-1')`、撤销/基线字段。

`wire.test.ts` 10 条：`ver1:` 编解码 3 条（round-trip、非法值全集、非法编码抛 `RangeError`）；payload 守卫 3 条（projectId 必填、写基线必填、撤销双身份必填）；快照守卫 4 条（合法快照、显式 `undoTarget:null`、缺 `statusRevision`、`undoTarget` 缺失/畸形）。

### 11.3 边界 B：浏览器半状态机（`95f085f`，6 文件 +445/−81）

| 文件 | 改动 |
| --- | --- |
| `packages/plugin-client/src/controller.ts` | 新增 `selection-required` 读状态（常量 `SELECTION_REQUIRED_TITLE`/`SELECTION_REQUIRED_DESCRIPTION`）；新增 `resetSelection()`；`load()` 无参、由 `state.selectedProjectId` 驱动，无选择时只置 `selection-required`、**不访问 source**；删除 `BoardControllerOptions.projectId`；写失败分级：`unknown-result` 与写后 `read-failed`（含传输抛异常）一律只给 `{kind:'read'}` 重试，**不保留写重试**（F9/F10/D6），`save-failed` 仍保留写重试（REC-02 同 operationId）；新增 `undoTaskChange(taskId)`，用当前视图任务的 `undoTarget` 发起撤销（刷新后仍可撤销）。 |
| `packages/plugin-client/src/runtime.ts` | 删除 `selectedProjectId` 与 `setSelectedProject`；`getBoardController()` 以无选择状态创建。**唯一真相源 = `BoardController.state`**。 |
| `packages/plugin-client/src/board.tsx` | 渲染 `selection-required` 空态（标题「请选择项目」+ 说明原文，无任何默认选择暗示）；`BoardPanel` 每次挂载 `resetSelection()` 且不再自动 `load()`；卡片/详情在 `undoTarget !== null` 时显示「撤销该状态修改」；失败重试按钮按 `feedback.retry.kind === 'read'` 显示「重新读取」，否则「重试」。 |
| `packages/plugin-client/src/model.ts` | `TaskDetailView` 增 `undoAvailable`（= `undoTarget !== null`），UI 不自行推断可撤销性。 |
| `packages/plugin-client/src/index.tsx` | **未改**：grep 证实它从不持有选择状态（`setSelectedProject` 无调用方），第二份持有只在 `runtime.ts`。 |
| 测试 | `controller.test.ts` 19→30（选择态 5、重试政策 4、快照撤销 2）；`model.test.ts` 19→20（`undoAvailable` + 必填 fixture 字段）。 |

不改：`slots.test.ts`（7 条仅回归）、`client-bundle.test.ts`（7 条仅回归）、host 半代码。

### 11.4 边界 B 用例变化（179 → 191，+12）

| 包 | 前 | 后 | 解释 |
| --- | --- | --- | --- |
| core | 66 | 66 | 不变。 |
| plugin | 58 | 58 | 不变（边界 B 不改 host 半与协议测试）。 |
| plugin-client | 55 | **67** | `controller` 19→30（+11）；`model` 19→20（+1）；`wire` 10、`slots` 7 不变。 |

`controller.test` 新增 11 条逐条：

- selection 5：`starts on selection-required and never reads without a selection`；`passes the selected project id on every read`；`resetSelection returns to selection-required without a read and clears the view`；`selectProject(null) returns to selection-required`；`a fresh controller has no memory of a previous selection`。
- retry 政策 4：`keeps a write retry only for a confirmed non-landing (save-failed)`；`offers only a re-read after an unknown write result, and retryPending never re-writes`；`offers only a re-read after a read-failed write outcome (no-change re-read failed)`；`treats a throwing transport as unknown-result with only a re-read available`。
- 快照撤销 2：`undoes the task credential carried by the snapshot with a fresh operation id`；`does nothing when the task has no undoTarget`。

`model.test` +1：`offers undo only when the data layer supplied an undoTarget (never inferred)`。

### 11.5 门禁原始输出

#### 11.5.1 边界 A（`fbb4ef9` 的树，沙盒 `C:\Users\InformationDS\aikanban-p5a`）

``text
AIKanBan gates [P5a-A] HEAD=9acf148
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      161.56 kB │ gzip: 40.51 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  356.22 kB │ gzip: 84.59 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 517.78 kB
✔ [@aikanban/dsh-aikanban] Build complete in 130ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  29.43 kB │ gzip: 9.37 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 29.43 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 46ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (19 tests) 11ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 9ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 11ms
packages/plugin-client test:  ✓ test/controller.test.ts (19 tests) 19ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 20ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 23ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 31ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 26ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 21ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 24ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  55 passed (55)
packages/plugin-client test:    Start at  02:45:02
packages/plugin-client test:    Duration  2.73s (transform 547ms, setup 0ms, collect 1.13s, tests 48ms, environment 1ms, prepare 3.16s)
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 40ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 44ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  02:45:02
packages/core test:    Duration  3.40s (transform 1.16s, setup 0ms, collect 5.79s, tests 288ms, environment 3ms, prepare 9.47s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 13ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 200ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 96ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  58 passed (58)
packages/plugin test:    Start at  02:45:07
packages/plugin test:    Duration  1.78s (transform 604ms, setup 0ms, collect 794ms, tests 309ms, environment 1ms, prepare 879ms)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (157.8 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvguu0h5-1 pid=30176
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvguu0h5-1, pid 30176, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5a
  isolated home    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguu0x3-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:11099/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=38271924e9d00c26-44
        served 200 27896B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvguu6em-1 pid=31640 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguu0x3-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=38271924e9d00c26-44 status=200 bytes=27896
  PASS  apply() ran inside the booting host
        activation=mvguu6em-1 pid=31640 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
``

#### 11.5.2 边界 B（`95f085f` 的树，同一沙盒；边界 A 提交后 `reset --hard` 复跑）

``text
AIKanBan gates [P5a-B] HEAD=fbb4ef9
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      161.56 kB │ gzip: 40.51 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  356.43 kB │ gzip: 84.68 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 517.99 kB
✔ [@aikanban/dsh-aikanban] Build complete in 68ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5a\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.20 kB │ gzip: 9.71 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.20 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 44ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/plugin-client test$ vitest run
packages/core test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 12ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 13ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 10ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 25ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 10ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 25ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 25ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 30ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 22ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 29ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 50ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  02:49:26
packages/plugin-client test:    Duration  3.12s (transform 692ms, setup 0ms, collect 1.72s, tests 60ms, environment 1ms, prepare 3.57s)
packages/plugin-client test: Done
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 50ms
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  02:49:26
packages/core test:    Duration  3.79s (transform 1.63s, setup 0ms, collect 7.02s, tests 315ms, environment 3ms, prepare 8.79s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5a/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 16ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 235ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 104ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  58 passed (58)
packages/plugin test:    Start at  02:49:31
packages/plugin test:    Duration  1.98s (transform 733ms, setup 0ms, collect 863ms, tests 355ms, environment 1ms, prepare 950ms)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (157.8 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvguzo9j-1 pid=31372
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvguzo9j-1, pid 31372, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5a
  isolated home    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguzoqf-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:14353/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=900db8e2ea5904b2-44
        served 200 29573B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvguztp5-1 pid=10656 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5a\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvguzoqf-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=900db8e2ea5904b2-44 status=200 bytes=29573
  PASS  apply() ran inside the booting host
        activation=mvguztp5-1 pid=10656 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
``

### 11.6 与 `s1-wiring.md` 的字面不一致 / 实施中被证明需要修正的条目（只报告，未改规格）

| # | 规格字面 | 实施事实 | 建议 |
| --- | --- | --- | --- |
| ① | §4.5「当前门禁下真正会红的 2 个：`channel-roundtrip`、`controller.test`」 | 契约输入改必填后，`controller.test` 在**边界 A** 就会红（fixture 缺 `statusRevision`、输入缺基线）；本档因此在边界 A 内同步改了它的 fixture/断言（用例数仍 19） | 规格把“契约必填”与“状态机”拆开后，红/绿集合应按提交边界分别列：边界 A 红 3 个（含 controller.test），边界 B 再扩 |
| ② | §4.4 第 2 条（输入/`UndoToken` 改形）与 §2.4/A10（删除 `BoardControllerOptions.projectId`、runtime 选择状态）都归在同一个“切片 A” | 实施证明两者可分离：**写基线与撤销凭据**必须随 wire 同提交（`tsc` 强制），**选择状态机**可以后置（边界 B），且两者独立可测 | 建议把 A8 拆为 A8a（写基线/撤销双身份，随契约）与 A8b（`selection-required`/`load()` 无参/`resetSelection`，独立提交） |
| ③ | §2.2 第 4 条空态文案标注“建议，实施时可改措辞但不能含默认选择暗示” | 实际采用：标题「请选择项目」+ 说明「看板不会记住上次的项目；每次进入都需要显式选择。」（与建议原文一致，仅标点用「；」） | 规格可去掉“建议”标注，直接定为文案 |
| ④ | §3.3/A5「读快照补 `undoTarget` 与版本字段」，未明确字段**缺失**是否合法 | 按「解析器收紧、缺失/非法返回 null」实施为：`statusRevision` 必填非负整数；`undoTarget` **必填键**（对象或 `null`）。缺失/畸形 → `read-failed`，不默认 0/不默认不可撤销 | 规格补一句“缺失即协议违规” |
| ⑤ | §6.2「`undoable` 一律取写后快照」 | `board-channel` 的 undo 成功分支原为 P3 脚手架硬编码 `undoable:false`，本档改为透传 port 的 `undoable`（适配器 P5b 才会真正计算） | 规格可补“A3 handler 不再硬编码 undo 的 undoable” |
| ⑥ | §2.5/A 的「A 没有 `project/list`，面板只能停在选择空态」 | 本档（P5a）实现后确认：**在 `project/list` 与选择器落地前，用户无法在界面选择项目**，面板只显示选择空态；`selectProject` API 已就绪，仅测试可调用 | 下一档需明确选择器与 `project/list` 的归属（P5b 适配器档或切片 B），否则 S1 界面不可演示 |
| ⑦ | §7.2 探针第 5 项 | 输出已带 `path`，真实宿主（44.7.0）为 `path=compat`，与 §9.6 ⑥ 的 P3 记录一致；断言名仍是「registered /aikanban inside the booting host」，不声称调用的是公开 `registerBoardChannel` | 规格 §7.2 第 2 条措辞按此更新（P3 已提出同一项） |

### 11.7 剩余未确认项（本档未取证，不得写成已验证）

- **真实 Connection RPC 网络往返**：仍只有进程内注册 + 协议级往返；ADR-005 保持 `提议`（档 1）。
- **P5b 适配器未做**：`delayed-board-port` 在数据层 ready 后仍返回 `not-wired-yet`；4 端点的真实 core 映射、§6 错误码映射、`board-adapter.test.ts` 集成测试（含 stale-baseline+current 合成、F3 重读失败分级）全部未做。
- **项目选择入口未实现**：`project/list` 与选择器属切片 B；当前面板只能显示 `selection-required` 空态（§11.6 ⑥）。
- **浏览器真实渲染未验证**：无 DOM 测试；选择空态、卡片/详情撤销按钮、重试文案只在 `renderBoard` 纯函数层面被构建产物加载测试间接覆盖，真实 GUI 未观察。
- **写后 `read-failed` 的宿主产生路径**：依赖 P5b 适配器（no-change + 重读失败）；本档只验证客户端对该 code 的处理。
- **`projectId` 必填后旧语义的运行时残留**：无（`parseReadBoardPayload` 已拒绝缺省）；但 `delayed-board-port.readBoard()` 仍无参（P5b 替换）。
- **order 级基线缺失（D6）**：仍未解决；本档按政策强制 reorder 未知结果只重读、不重发。
- **干净 worktree 的 frozen 复跑**：本档门禁在开发沙盒（`aikanban-p5a`，`--frozen-lockfile` install 于 `0f9cf1b`）全绿；推送后如要按 §9.4.5 先例自证，应另建干净 worktree 复跑六项门禁。

### 11.8 下一档（P5b 适配器）建议

1. **`packages/plugin/src/board-adapter.ts`**：4 端点映射到 core（§3/§6），`delayed-board-port` 变为真正转发层；项目解析用 `workspaceRegistry.get` + `registerProject`；`capabilities` 全 true；`hints` 恒省略；`workScope` 摊平。
2. **错误码严格按 §6**：`stale-baseline + current`（由 adapter `readTask` 取 status 并编码 `ver1:<n>` 合成，F6）、`saved`/`already-applied`+重读失败 → `unknown-result`、`undone`+重读失败 → `unknown-result`（message 必须“撤销已生效、视图未刷新”）、`no-change`+重读失败 → `read-failed`。
3. **`board-adapter.test.ts` 集成测试**（真实 `createKanbanCore` + `createMemoryStoragePort` + 真实 handler）覆盖 §7.1 全部 11 条，尤其 F5（非法基线不进 port）与 F9/F10（unknown-result 不重发）。
4. **保持本档契约不变**：`projectId` 必填、handler 前置基线校验、`undoTarget`/撤销双身份、8 码集合、4 端点集合。
5. **选择器与 `project/list` 归属决策**：若切片 B 前移，则同时补 `project/list`（不猜、不持久化）与 `selectProject` 接线；否则在验收记录里明确“S1 界面暂不可选择项目”。
6. **回归门禁**：typecheck/build/用例全绿（本档基线 191）、verify 11/11、probe 5/5（含 `path=compat`）、python docs PASS；不得把 P5b 集成测试写成 F01/F02 验收通过（AT 仍全部「待执行」）。

### 11.9 推送后干净 worktree 复跑（自证不算数）

推送后另建**干净 worktree** `C:\Users\InformationDS\aikanban-p5a-clean`（detached `3a8890c`，即 `main` 推送后的 HEAD），先跑 `pnpm install --frozen-lockfile`，再跑全部六项门禁。结果与 §11.5 相同：**安装 EXIT 0、用例 191（core 66 / plugin 58 / plugin-client 67）、verify 11/11、probe 5/5（`path=compat`）、docs PASS（59 md）**。完整原始输出保存在该 worktree 的 `.gates-clean.log`；关键行：

``text
AIKanBan gates [P5a-POST] cwd=C:\Users\InformationDS\aikanban-p5a-clean HEAD=3a8890c
===== INSTALL-FROZEN EXIT=0 =====
Done in 2.6s using pnpm v11.7.0
===== TYPECHECK EXIT=0 =====
===== BUILD EXIT=0 =====
  lib\index.js      161.56 kB │ gzip: 40.51 kB
  lib\client.js  31.20 kB │ gzip: 9.71 kB
packages/plugin-client test:       Tests  67 passed (67)
packages/core test:       Tests  66 passed (66)
packages/plugin test:       Tests  58 passed (58)
===== TESTS EXIT=0 =====
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  apply() activates against a service-less context      activation=mvgv40m3-1 pid=33020
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active …
OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true
PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
``

结论：本档的六项门禁在**提交后的干净检出**上成立，不依赖开发沙盒里的未提交状态；用例数从 164 基线变为 191（+27），无既有用例被删除（`channel-roundtrip` 的 1 条“省略 payload 合法”是按 Q1=B 语义**替换**，不是丢失覆盖）。

## 12. P5b：规格回写 + core→`HostBoardPort` 适配器 + 四端点集成矩阵（2026-10-21，提交 `7fb96a6`、`f64c74d`、`a3b3162`）

本档把「core 已存在、通道已注册，但数据层就绪后仍返回 `not-wired-yet`」补成可用的四端点接线，并把 P5a 报出的规格偏差写回 `s1-wiring.md`。**本档仍未执行任何 AT**；`board-adapter.test.ts` 是档 2 辅助证据，不是 F01/F02 验收。

不改（硬边界，逐项核对）：端点仍 4 个、浏览器失败码仍 8 个、`projectId` 必填、`ver1:` 编码、撤销双身份；`hints` 恒省略；选择不持久化；未改 `docs/prd/**`、未改 `docs/tools/check_docs.py`、未改 `tools/verify-host-import.mjs` 的匹配逻辑、未改 `acceptance.csv` 的 status。

### 12.1 边界 0：P5a 实施反馈回写规格（`7fb96a6`，1 文件 +26/−16）

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | §4.5 | 红/绿集合改为**按提交边界分别列**：契约层（wire/model 必填与写基线）`channel-roundtrip.test.ts`、`controller.test.ts` 会红，必须随契约同提交改 fixture/断言；浏览器半（选择状态机与 UI 空态）`model.test.ts`（类型层）、`host.test.ts`（类型层 + 新增用例）；删除「当前门禁下真正会红 2 个」的表述。表格「类别」列同步改为「契约层必改（会红）」「浏览器半必改」。 |
| 2 | §1.1 | A8 拆为 **A8a**（写基线与撤销凭据的最小对齐，被 `tsc` 强制随契约层同提交）与 **A8b**（`selection-required`/`resetSelection()`/`load()` 无参与写后失败重试政策，可独立提交）。 |
| 3 | §3.3 / A5 | 快照字段必填性定稿：`statusRevision` **必填非负整数**、`undoTarget` **必填键**（对象或显式 `null`）；缺失/畸形 = 协议违规 → 解析失败 → `read-failed`（不默认 0、不默认“不可撤销”）。 |
| 4 | §6.2 | 补第 5 条代码点：undo 成功分支的 `undoable` 必须**透传 port**（P3 脚手架曾硬编码 `false`）；「四条定稿规则」改为「五条」。 |
| 5 | §2.2 第 4 条 | 空态文案去掉「建议」，定为**定稿文案**：标题「请选择项目」+ 说明「看板不会记住上次的项目；每次进入都需要显式选择。」（标点只用中文分号）；注明 P5a 已按原文落地。 |
| 6 | §2.5 / §7.2 | §2.5 显式承认：P5a 之后、`project/list` 与选择器（P5c）落地之前，界面只显示选择空态、**无法在 UI 中完成选择**，`selectProject` 仅测试可调；§7.2 探针第 5 项断言改为「观察到 `/aikanban` 已被注册（不声称走的是公开入口）」，并说明输出含 `path`、`compat` 不等于公开入口可用。 |

### 12.2 边界 A：适配器与接线（`f64c74d`，6 文件 +796/−86）

| 文件 | 改动 |
| --- | --- |
| `packages/plugin/src/board-adapter.ts`（**新建**，653 行） | `createHostBoardPort({core, workspaceRegistry})`：4 端点真实映射。项目解析：`workspaceRegistry.get(projectId)` → 不存在/未登记/空 `path`/registry 缺失均 `unknown-project`（不猜）；首次访问 `core.registerProject` 登记，登记失败读侧 `read-failed`、写侧 `save-failed`（写未发生、给 `current`）。读：core `readBoard({projectId, workScope:{availability}})` 三态映射；`capabilities` 合成全 `true`；`workScope` 摊平（`reason:null`→省略）；`hints` 不合成；`TaskView→BoardTask` 带必填 `statusRevision` 与 `undoTarget`（对象或显式 `null`）。写：每次成功后**重读一次快照**再返回；`undoable` 一律取写后快照 `undoTarget !== null`（`no-change` 亦然）。 |
| 同上（失败映射） | `baseline-changed` → `stale-baseline + current`；`save-failed` 一律 `core.readTask` 取 `status/statusRevision` 编码 `ver1:<n>` 合成 `current`（F6，含三个写端点的 `failed/write-failed`）；`rejected/*` 逐条按 §6.2；`cannot-undo` 前置：`readTask().lastStatusUpdateId === operationId` 视为撤销已生效（成功、再重读），否则 `stale-baseline + current`；`superseded` 返回后再用权威 `lastStatusUpdateId` 复核一次（防读/写间隙内的同 id 重试误报）。重读失败分级：`saved`/`already-applied` → `unknown-result`（“已保存、视图未刷新”，不带 snapshot）；`undone` → `unknown-result`（**必须**“撤销已生效、视图未刷新”，不得 `read-failed`）；`no-change` → `read-failed`。每个方法外层 try/catch，适配器自身异常也转失败结果（读 `read-failed`、写 `unknown-result`），**永不抛**。 |
| `packages/plugin/src/board-channel.ts` | `HostBoardPort` 的写输入改为**已解码**的 `HostSetStatusInput/HostReorderInput/HostUndoInput`（`expectedStatusRevision:number`）；handler 仍前置校验 `ver1:` 语法，并在调用 port 前解码——**编码不过 port**。wire payload/value 形状不变；`invalid-payload`/`invalid-reason` 行为不变。 |
| `packages/plugin/src/delayed-board-port.ts` | ready 分支从 `not-wired-yet` 占位改为**转发真实适配器**；未 ready 仍 `unavailable`；`NOT_WIRED_MARKER` 及其两个占位失败分支删除。 |
| `packages/plugin/src/index.ts` | `apply()` 内创建 `createHostBoardPort({core: () => lastCore, workspaceRegistry: () => serviceOf(...)})` 并交给 `createDelayedBoardPort(state, boardAdapter)`；`workspaceRegistry` 绑定记入 `servicesObserved`；再导出 `createHostBoardPort` 与三个 host 写输入类型；`WorkspaceLike/WorkspaceRegistryLike` 移入适配器模块并由 index 再导出。 |
| 既有测试 | `channel-roundtrip.test.ts` 2 条 port 输入断言随「handler 解码后传 number」更新（**用例数仍 58**，非删除覆盖）；`host.test.ts` 数据层就绪用例的期望从 `not-wired-yet` 改为真实适配器行为（无 registry → `unknown-project`；未知任务写 → `not-found`），**用例数仍 58**。 |

**边界 A 最小冒烟**（临时文件，未提交）：真实 core + 内存 port + 真实适配器 + 真实 handler 走通 `board/read` → `task/status.set` → `task/status.undo`（1 用例 EXIT 0），确认接线不是只过类型检查。

### 12.3 边界 B：集成矩阵（`a3b3162`，1 文件 +1036）

`packages/plugin/test/board-adapter.test.ts`（**41 用例**）：真实 `createKanbanCore({port: createMemoryStoragePort(createMemoryMedium())})` → 真实 `createHostBoardPort` → 真实 `createBoardChannelHandler`。故障注入只在测试缝：存储 port 包装（读写失败）、core `Proxy`（写后重读失败 / `readBoard` 返回 `failed` / 写后自动 arm）、一个「抛异常的 port」用例验证 handler 自身 catch。每次读成功都用真实 `parseBoardSnapshotValue` 判快照是否 wire 合法。

| 组 | 用例数 | 覆盖 |
| --- | --- | --- |
| `board/read` 三态与映射 | 9 | 首访登记 + 快照（capabilities/hints 缺省/`statusRevision`/`undoTarget`/`boardToken` 与 core 一致/5 列不重复下发）；缺 `projectId` 不猜；未登记项目；无 registry；存储读失败；core `failed` 变体；`missing-dir` 摊平；`status()` reject → `unknown`；空 path。 |
| `task/status.set` 成功 | 3 | 状态变更 + 写后重读快照；同 `operationId` 重试 → `already-applied` 成功；`no-change` 成功且 **`undoable=true`**（取写后快照 `undoTarget`）。 |
| `task/status.set` 失败 | 7 | 基线丢失 → `stale-baseline+current`；`invalid-status` → `save-failed+current`；未知任务 → `not-found`；项目从 registry 消失 → `unknown-project`；写失败 → `save-failed+current`（正式值不变）；`blocked-reason-required` → `invalid-reason`（**直连 port**，handler 会先拒）；`invalid-input` → `save-failed+current`（直连 port）。 |
| `task/reorder` | 7 | 成功并返回重读后的列顺序（与 core 直读一致）；可见列已变 → `stale-baseline+current`；基线变化 → `stale-baseline+current`；`invalid-input` → `save-failed+current`（直连 port）；写失败 → `save-failed+current`；未知任务 → `not-found`；项目缺失 → `unknown-project`。 |
| `task/status.undo` | 7 | 用快照 `undoTarget` 成功（撤销后 `undoable=false`）；同 undoId 重试 → 预检命中“已生效”成功；`superseded` → `stale-baseline+current`；`nothing-to-undo` → `stale-baseline+current`；未知任务 → `not-found`；`invalid-input` → `save-failed+current`（直连 port）；写失败 → `save-failed+current`。 |
| 写后重读失败（§6.2 规则 1） | 5 | `saved` → `unknown-result`（无 snapshot，“已保存、视图未刷新”）；`already-applied` → `unknown-result`；`undone` → `unknown-result`（“撤销已生效、视图未刷新”，明确断言不是 `read-failed`）；`no-change` → `read-failed`；`reorder saved` → `unknown-result`。 |
| handler 永不抛 | 2 | 11 组畸形 payload/未知端点逐条返回协议码且无写入；port 抛异常 → handler 返回 `unknown-result`。 |
| 延迟端口 | 1 | 未 ready 读/写均 `unavailable`；ready 后转发真实适配器并读到快照。 |

**§6.2 逐行覆盖说明（不可映射项的理由）**：

- `setTaskStatus`/`reorderTask` 的 core `rejected/unknown-task`：适配器在进入 core 前已 `readTask` 预检，真实可达路径是 `not-found`（已测）；core 分支保留为防御，无法从 port 外部构造。
- `setTaskStatus` 的 core `rejected/unknown-project`：写前必须能 `readTask` 并解析项目；项目从 registry 消失已由适配器 `unknown-project` 覆盖（已测）；core 侧“任务在但项目未登记”不是可达状态。
- `reorderTask`/`undoStatusChange` 的 `rejected/invalid-input`（缺 `requestId`/`undoId`）与 `blocked-reason-required`：真实 handler 的 wire guard 会先拒绝（`invalid-payload`/`invalid-reason`），所以这三条映射只能用**直连 port** 的用例证明适配器仍有防御（已测，并在用例名标注 adapter branch）。
- `adapter/传输异常 → unknown-result`：适配器自身 catch 用「抛异常 port」用例覆盖；真实 handler 的 catch 在 `channel-roundtrip.test.ts` 已覆盖。
- `undoStatusChange` 的 `cannot-undo/superseded` 竞争（非同 id）：已测；同 undoId 重试走 §6.2 的**前置预检**成功路径（已测），core 内部的“写入槽内再判定”分支只作防御。
- `unavailable`：延迟端口用例覆盖读/写两方向；`register-failed` 不进浏览器码（F1），仍只由 `host.test.ts` 的诊断事件用例覆盖。

### 12.4 用例变化（191 → 232，+41；core 66 / plugin 99 / plugin-client 67）

| 包 | 前 | 后 | 解释 |
| --- | --- | --- | --- |
| core | 66 | 66 | 未改 core。 |
| plugin | 58 | **99** | 新增 `board-adapter.test.ts` 41 条；`channel-roundtrip`/`host`/`client-bundle` 用例数不变（仅既有断言按解码/真实适配器更新）。 |
| plugin-client | 67 | 67 | 未改浏览器半。 |

41 条逐组解释见 §12.3 表格（9+3+7+7+7+5+2+1）。**无既有用例被删除**：`channel-roundtrip` 的 2 条是同一覆盖在新 port 输入形状下的断言更新，`host.test` 的 1 条是把「占位 `not-wired-yet`」期望替换为真实适配器行为（占位本身已删除，不能保留）。

### 12.5 六项门禁原始输出

#### 12.5.1 边界 0（`7fb96a6` 的树，沙盒 `C:\Users\InformationDS\aikanban-p5b`）

```text
AIKanBan gates [P5b-B0] cwd=C:\Users\InformationDS\aikanban-p5b HEAD=7fb96a6
$ tsc -b
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      161.56 kB │ gzip: 40.51 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  356.43 kB │ gzip: 84.68 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 517.99 kB
✔ [@aikanban/dsh-aikanban] Build complete in 134ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.20 kB │ gzip: 9.71 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.20 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 46ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 13ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 11ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 7ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 24ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 8ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 17ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 21ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 24ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 22ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 22ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 30ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 19ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  11:42:25
packages/plugin-client test:    Duration  3.11s (transform 806ms, setup 0ms, collect 1.62s, tests 56ms, environment 1ms, prepare 3.64s)
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 25ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 44ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 43ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  11:42:25
packages/core test:    Duration  3.79s (transform 1.57s, setup 0ms, collect 6.61s, tests 274ms, environment 3ms, prepare 9.03s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 15ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 217ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 102ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  58 passed (58)
packages/plugin test:    Start at  11:42:30
packages/plugin test:    Duration  2.11s (transform 700ms, setup 0ms, collect 969ms, tests 334ms, environment 1ms, prepare 1.03s)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (157.8 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvhe13i2-1 pid=35896
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvhe13i2-1, pid 35896, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5b
  isolated home    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvhe140d-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:4642/?token=8Lkqy9lJifWMk9MCa4dSyLHOi_yT8PbtKbCHmRc_NX0
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=4afc4877f2ffd72f-44
        served 200 29573B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvhe1a29-1 pid=38140 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvhe140d-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=4afc4877f2ffd72f-44 status=200 bytes=29573
  PASS  apply() ran inside the booting host
        activation=mvhe1a29-1 pid=38140 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

#### 12.5.2 边界 A（`f64c74d` 的树，同一沙盒）

```text
AIKanBan gates [P5b-A] cwd=C:\Users\InformationDS\aikanban-p5b HEAD=f64c74d
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      179.09 kB │ gzip: 44.35 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  397.02 kB │ gzip: 93.66 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 576.11 kB
✔ [@aikanban/dsh-aikanban] Build complete in 66ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.20 kB │ gzip: 9.71 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.20 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 42ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 12ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 9ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 11ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 22ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 18ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 21ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 23ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 22ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 23ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 27ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 21ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  11:50:19
packages/plugin-client test:    Duration  2.55s (transform 670ms, setup 0ms, collect 1.30s, tests 54ms, environment 1ms, prepare 2.74s)
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 26ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 39ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 44ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  11:50:19
packages/core test:    Duration  3.06s (transform 1.08s, setup 0ms, collect 5.15s, tests 271ms, environment 3ms, prepare 7.47s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 13ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 203ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 97ms
packages/plugin test:  Test Files  3 passed (3)
packages/plugin test:       Tests  58 passed (58)
packages/plugin test:    Start at  11:50:23
packages/plugin test:    Duration  1.78s (transform 611ms, setup 0ms, collect 820ms, tests 313ms, environment 1ms, prepare 854ms)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (174.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvheb838-1 pid=21100
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvheb838-1, pid 21100, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5b
  isolated home    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvheb8ih-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:5630/?token=EsZTV60o4VA48PVn9MWiNpRMneyNHxHJtRmSPxVc1s0
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=d358afddca409782-44
        served 200 29573B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvhebcy7-1 pid=34188 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvheb8ih-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=d358afddca409782-44 status=200 bytes=29573
  PASS  apply() ran inside the booting host
        activation=mvhebcy7-1 pid=34188 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

#### 12.5.3 边界 B（`a3b3162` 的树，同一沙盒）

```text
AIKanBan gates [P5b-B] cwd=C:\Users\InformationDS\aikanban-p5b HEAD=a3b3162
$ tsc -b
===== TYPECHECK EXIT=0 =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      179.09 kB │ gzip: 44.35 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  397.02 kB │ gzip: 93.66 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 576.11 kB
✔ [@aikanban/dsh-aikanban] Build complete in 135ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5b\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.20 kB │ gzip: 9.71 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.20 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 51ms
===== BUILD EXIT=0 =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 14ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 11ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 8ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 18ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 7ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 17ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 25ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 21ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 22ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 21ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 24ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 23ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 28ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  11:55:56
packages/plugin-client test:    Duration  2.54s (transform 688ms, setup 0ms, collect 1.17s, tests 50ms, environment 1ms, prepare 3.03s)
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 46ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 50ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  11:55:56
packages/core test:    Duration  3.12s (transform 1.15s, setup 0ms, collect 5.30s, tests 284ms, environment 3ms, prepare 7.64s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5b/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 13ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 252ms
packages/plugin test:  ✓ test/board-adapter.test.ts (41 tests) 41ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 104ms
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  99 passed (99)
packages/plugin test:    Start at  11:56:01
packages/plugin test:    Duration  1.83s (transform 893ms, setup 0ms, collect 1.43s, tests 411ms, environment 1ms, prepare 1.23s)
packages/plugin test: Done
===== TESTS EXIT=0 =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (174.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvheigwl-1 pid=16720
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvheigwl-1, pid 16720, services seen: none)

OK
===== VERIFY-HOST-IMPORT EXIT=0 =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5b
  isolated home    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvheihcm-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:12347/?token=PZ-ZMyge0EmhopZ4BgMH5LyZSFeXqTbrpW3hya5fvGU
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=ea460a741d076d1c-44
        served 200 29573B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvheimt9-1 pid=31332 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5b\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvheihcm-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=ea460a741d076d1c-44 status=200 bytes=29573
  PASS  apply() ran inside the booting host
        activation=mvheimt9-1 pid=31332 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE-HOST EXIT=0 =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

结论：三次门禁均 **typecheck EXIT=0 / build EXIT=0 / tests EXIT=0 / verify 11/11 EXIT=0 / probe 5/5 EXIT=0（`path=compat`）/ check_docs EXIT=0（59 md）**；用例数 191（边界 0、A）→ **232**（边界 B），无既有用例删除。探针第 5 项仍如实输出 `path=compat`，本档没有把它写成“公开入口已验证”。

### 12.6 与 `s1-wiring.md` 的字面不一致 / 实施中被证明需要修正的条目（只报告，除 §12.1 明列的 6 处外未改规格）

| # | 规格字面 | 实施事实 | 建议 |
| --- | --- | --- | --- |
| ① | 任务书 §2C 的前提「P5a 已在 handler 前置把 `ver1:` **解出**；port 收的是已解码值」；§4.2 也要求“前置解码/校验” | P5a 实际只做了**语法校验**并把编码原样传给 port（`expectedStatusVersion:string`）。本档把 `HostBoardPort` 三个写输入改为 `expectedStatusRevision:number`，handler 校验后解码再调用 port；wire 契约不变，`channel-roundtrip` 2 条 port 输入断言随之更新 | 规格 A3 的表述从“前置校验”改为“前置解码/校验；`ver1:` 编码不过 port”，并明确 port 输入类型是 number |
| ② | §3.1 第 5 步「`status()` 调用 reject/**超时** → `unknown`」 | 已实现 reject → `unknown`；**超时未实现**——规格没有给超时值/超时后行为，适配器 `await workspace.status()` 不设上限 | 规格补一个超时值（或明确“不设超时，宿主自身负责”）后再实现 |
| ③ | §3.1 第 4 步「`rejected` → `unknown-project`（`invalid-input`）或 `read-failed`（其余）」 | core `ProjectOutcome.rejected` 只有 `invalid-input`/`unknown-project` 两个码，没有“其余”；两者都被映射为 `unknown-project`（登记失败不是读失败） | 把该句改成「`invalid-input`/`unknown-project` → `unknown-project`」 |
| ④ | §6.2 `setTaskStatus`/`reorderTask` 的 `rejected/unknown-task`、`setTaskStatus` 的 `rejected/unknown-project` | 适配器在进入 core 前先 `readTask` + 解析 registry，这三条 core 分支从 port 外部**不可达**；实际用户可见映射由前置检查给出（`not-found`/`unknown-project`） | 规格注明“这些映射由适配器前置检查实现，core 分支仅防御” |
| ⑤ | A3「`registerBoardChannel` 的 `rpc.handle` 包 try/catch，失败返回 `{ok:false, reason:'register-failed'}`」 | 现状是 `registerBoardChannel` 不 catch；try/catch 在 `apply()`/`scoped-channel-registration` 调用侧，`BoardChannelRegistration.reason` 仍只有 `'no-connection'`。**行为**已满足（不抛、诊断事件报 `register-failed`），**类型面**未按 A3 字面扩展 | 二选一：把 try/catch 收进 `registerBoardChannel` 并扩 reason 联合，或把 A3 改为“在调用侧捕获” |
| ⑥ | §3.2「每次写成功后重读一次看板快照」，未说明重读是否重新观测 workScope | 适配器用**写前**已观测的 `availability` 作为重读 hint（不重新调用 `workspace.status()`），避免同一请求两次宿主观测；只影响显示态 `workScopeAvailability`，不影响任何正式值 | 规格补一句“重读复用本次解析的 workScope hint” |
| ⑦ | §7.3 A-G2 仍写「当前 66/38/45=149，更新后据实」 | 该 149 是 P2 时代的历史数字；P5b 后据实为 66/99/67=**232** | 把 A-G2 的历史基线更新为 191（P5a）→ 232（P5b），避免再次被误读 |
| ⑧ | §3.4 `capabilities` 由适配层合成 | 已实现为常量全 `true`（数据层就绪才可能返回快照）；单卡撤销由 `undoTarget` 表达，二者未混 | 与规格一致，无需改 |

### 12.7 剩余未确认项（本档未取证，不得写成已验证）

- **真实 Connection RPC 网络往返**：仍只有进程内注册 + 协议级往返（`channel-roundtrip`）与探针的宿主内观察。探针第 5 项现在 `dataLayerReady=true`，说明真实宿主内 `storageDomain.open` + `createKanbanCore` + 通道注册已发生；但**没有**从浏览器经 HTTP 调用四端点，ADR-005 仍保持 `提议`。
- **真实 profile / 真实 GUI**：未安装 profile、未在真实页面渲染（本档禁止）；选择空态、写失败文案等仍只有纯函数/协议级证据。
- **`workspace.status()` 超时**：未实现（见 §12.6 ②）。
- **`workspace.status()` 之外的真实 `Workspace` 字段/生命周期**：适配器按结构读取 `id/title/path/status()`；真实 registry 的运行时字段与绑定时机仍需探针/GUI 观察。
- **order 级基线缺失（D6）**：仍未解决；本档保持 reorder 的 `unknown-result`/写后 `read-failed` 只给 `{kind:'read'}` 的政策，不自动重发。
- **host 卸载时的 domain 关闭/通道注销**：按 §5.1 第 3 步的“进程级生命周期”现状，未主动关闭（cordis 4.0.2 无 dispose 事件）。
- **大载荷/并发**：写后重读使每次写多一次整板读取；未测大项目/高并发下的时延与内存。
- **AT 全部「待执行」**：本档集成测试不是 F01/F02 验收；`acceptance.csv` status 未动。

### 12.8 下一档（P5c：`project/list` + 选择器）建议

1. **契约**：新增第 5 个端点 `project/list`（`{}` → `{projects:[{projectId,title,path}]}`）；列表唯一来源是宿主 `ctx.workspaceRegistry.list()`，**不猜、不写、不缓存、不持久化选择**；core 的 `listProjects()` 只用于“已登记”补充，不能当权威列表。
2. **host**：`HostBoardPort` 增 `listProjects()`；适配器直接读 registry，保持永不全抛；空列表是合法“无可选项目”，不是错误。
3. **浏览器**：`BoardSource.listProjects()`；controller 接 `loadProjects()`/`selectProject(id)`（P5a 已有 `selectProject` 与 `selection-required`）；面板把选择空态换成选择器（同名项目用 `path` 辨识），挂载时 `resetSelection()` + 拉列表，选择后 `readBoard(projectId)`；仍不持久化。
4. **测试**：适配器 `listProjects` 用例（来源、不写、空表）；controller 选择流程；`renderBoard` 选择器渲染；`wire.test` 新 payload 校验；`channel-roundtrip` 新端点往返。探针不需要新断言。
5. **待决**：`order` 级基线（D6）是否随 P5c 一并做（需 core 侧配合 `orderRevision`）；`workspace.status()` 超时值；真实网络往返的取证方式（真实 profile + 页面）。
6. **保持**：浏览器失败码仍 8 个，直到切片 B 明确新增第 9 个 `invalid-input`；`projectId` 必填、`ver1:`、撤销双身份、hints 恒省略不变。

### 12.9 记录追加后的文档门禁

本记录只改 `docs/engineering/s1-wiring-implementation.md`（未新增 md 文件数）；追加后复跑 `python docs/tools/check_docs.py`：`PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.`（四项 PASS + `EXIT=0`；文档完整性，不涉及应用/产品验收）。

## 13. P5c：`project/list` + 项目选择器（2026-10-22，提交 `d05beb8`、`5e95f08`、`c3cf922`）

> **本档任务书裁定的硬边界**：唯一允许变动的不变量是**端点数（4→5）**；浏览器失败码仍 **8 个**，不新增；切片 B 的 `task/create`、`task/fields.update`、`activity/read` **不做**；AT 全部「待执行」、`acceptance.csv` 未动；Q1=B 不变（每次进入必须显式选择、选择只存内存、不持久化、不默认第一个、不记忆上次）；`hints` 恒省略；未改 `docs/prd/**`、`check_docs.py`、`verify-host-import.mjs` 匹配逻辑；**项目列表不缓存为「当前项目」**——列表只是候选集，选中才成为 `state.selectedProjectId`。

### 13.1 边界 0：规格回写（`d05beb8`，1 文件 +76/−50）

只改 `docs/engineering/s1-wiring.md`，把 P5b 报的 8 条偏差按任务书裁定回写 7 条（第 8 条 capabilities 与规格一致、无需改）：

1. §4.2/§4.3/A3/§6.2 规则 3：port 写输入是**已解码值** `expectedStatusRevision:number`，`ver1:<n>` 由 handler 前置解码、编码不过 port，wire 契约不变。
2. §3.1 第 5 步写死 `status()` 超时口径：**不实现超时值**，永不 resolve 由宿主/传输层负责；reject（含宿主超时）→ `unknown`，永不抛出。
3. 删除 §3.1 第 4 步不存在的「其余→read-failed」分支：`rejected` 只有 `invalid-input`/`unknown-project`，均映射 `unknown-project`。
4. §6.2 两条 `rejected/*` 行标注「**防御性映射，port 外不可达**」（`readTask`+registry 前置检查给出 `not-found`/`unknown-project`）。
5. A3：写明 try/catch 在 `apply()` 调用侧、`BoardChannelRegistration.reason` 未扩 `'register-failed'` 是**有意取舍**（行为达标，不是缺陷）。
6. §6.2 统一回读策略：写后重读**复用**本次请求已观测的 workScope hint，不重新调用 `workspace.status()`。
7. §7.3 A-G2 不再写死用例数，改为「引用 `docs/engineering/s1-wiring-implementation.md` 中的最新数字」。

**切片边界更新**：切片 A 纳入 `project/list` 与项目选择器（端点数 4→5），更新 §1.1 目标/范围/改动面（A1/A3/A5/A7/A8b/A9/A11）、§2.2、§2.5、§7.1 第 12 条、§7.3、§8 第 9 条；切片 B 剩余 = `task/create`、`task/fields.update`、`activity/read`（§1.2 表、§9 扩展清单同步）；新增 **§2.6 Q1=B 落地方式**（每次进入现取、选中后 `selectProject`→`readBoard`、无「当前项目」概念/无持久化/无默认选中/不记上次、切换项目回到选择器）与 **§3.6 `project/list` 字段映射**（`projectId=workspace.id`、`title`、`path`；来源宿主 `workspaceRegistry.list()` 而非 core `listProjects()`；空列表合法；列表项不得含当前/默认/最近字段；同名用 `path` 区分）。

文档门禁与其余五项门禁见 §13.5.1（纯文档提交，代码零变化）。提交信息：`docs(spec): P5b 反馈回写 + 切片 A 纳入 project/list 与选择器`。

### 13.2 边界 A：协议与 host 侧（`5e95f08`，6 文件 +286/−1）

| 文件 | 改动 |
| --- | --- |
| `packages/plugin-client/src/model.ts` | 新增 `BoardProjectChoice { projectId, title, path }`：**没有**「当前/默认/最近」字段，选择项在类型层就无法表达「上次使用」（Q1=B）。 |
| `packages/plugin-client/src/wire.ts` | `BOARD_ENDPOINTS.listProjects = 'project/list'`（第 5 端点）；`ProjectListPayload`（空对象）；`ProjectListValue { projects: ProjectListItem[] }`（`ProjectListItem = BoardProjectChoice`）；`parseProjectListPayload`（非 JSON 对象即 `null`）与 `parseProjectListValue`（逐项校验非空 `projectId` + 字符串 `title`/`path`，畸形即 `null`）。**未加**任何「是否当前」字段。 |
| `packages/plugin/src/board-channel.ts` | `HostProjectListOutcome`（成功 `{projects}`；失败只用 8 个浏览器码 + message）；`HostBoardPort.listProjects(signal?)`；handler 第 5 分支：先校验空 payload（非法 → host 码 `invalid-payload`），再调 port；port 抛异常 → `read-failed`；handler 永不抛。 |
| `packages/plugin/src/delayed-board-port.ts` | 数据层未就绪时 `listProjects` 返回 `unavailable`（与读/写同一门控，不列出打不开的候选）；就绪后原样转发真实适配器。 |
| `packages/plugin/src/board-adapter.ts` | `listProjects()` 数据来源 **`ctx.workspaceRegistry.list()`**（不是 core `listProjects()`）；映射 `projectId=workspace.id`（与 `readBoard`/`registerProject` 用同一 id）、`title`（空则回退 id）、`path`（trim，空串保留）；**空列表是合法成功**；registry 缺失 → `unavailable`；`list()` 抛异常或 signal 已取消 → `read-failed`；不写、不注册、不调 core、不缓存。 |
| `packages/plugin/test/board-adapter.test.ts` | 新增 5 个集成用例（真实 core + 真实 handler + 真实适配器），见 §13.4。 |

**host 侧验证**：`board-adapter.test.ts` 41→46；其余既有用例未改。`5e95f08` 时点总用例 **237**（core 66 / plugin 104 / plugin-client 67），既有 232 全部保留、无删除、无改写。

### 13.3 边界 B：浏览器侧（`c3cf922`，8 文件 +765/−25）

| 文件 | 改动 |
| --- | --- |
| `packages/plugin-client/src/source.ts` | `ProjectChoice`（=`ProjectListItem`）、`ProjectListSuccess/Failure/Result`；`BoardSource.listProjects()`；unavailable 源加 `listProjects`（`unavailable` + 专用文案 `NO_CHANNEL_PROJECTS_MESSAGE`，不伪装成空列表）。 |
| `packages/plugin-client/src/channel-source.ts` | `listProjects()` 走**同一** Connection 通道，payload 恒 `{}`；传输拒绝（通道未注册/未接通）→ `unavailable`；解析失败 → `read-failed`；**不自动重试、不降级为空列表**。 |
| `packages/plugin-client/src/controller.ts` | 新增独立于 read 的 `ProjectListState`（`idle`/`loading`/`loaded`/`failed`）与 `BoardState.projects`；`loadProjects()`（每次现取，失败写 `projects.failed` + feedback `retry:{kind:'read'}`）；`resetSelection()` 同时清列表与选择；`selectProject(projectId)` 记录内存选择后 `load()`；`retryPending()` 在 `selection-required` 时把 `read` 重试路由到 `loadProjects()`（**不**在无选择时发 board/read）；列表失败/加载均不自动选中第一个。 |
| `packages/plugin-client/src/board.tsx` | `selection-required` 渲染**项目选择器**：加载中（`data-aikanban-projects-loading`）/ 失败可重试（`projects-failed` + `projects-retry`）/ 空列表（`projects-empty`「没有可用项目」+ 刷新）/ 多项目列表（每项 `data-aikanban-project=projectId`，**同名项目同时显示 title 与 path**）；无 `aria-selected`/`aria-current`/`aria-pressed`，无「默认/最近/推荐」文案；选中 → `onSelectProject(id)`；已选状态提供「切换项目」→ `resetSelection()` + `loadProjects()`（不持久化）；`BoardPanel` 每次挂载 `resetSelection()` + `loadProjects()`。 |
| 测试 | `wire.test.ts` +2、`channel-roundtrip.test.ts` +2、`controller.test.ts` +5、新增 `board.test.ts` 6 个，见 §13.4。 |

**Q1=B 落地（本档实证形态）**：面板每次挂载从 `selection-required` 开始并**现取**候选集；面板/控制器/runtime 没有任何「当前项目」副本（唯一真相源＝`controller.state.selectedProjectId`）；选择只在内存；列表项类型无「当前/默认/最近」字段；刷新/切回/重进一律回到选择器；`resetSelection()` 清列表+选择且不发请求；列表失败保留可重试且**不猜项目**。

### 13.4 用例数变化（逐条解释）

**边界 A：232 → 237（+5）**

| 文件 | 变化 | 解释 |
| --- | --- | --- |
| `packages/plugin/test/board-adapter.test.ts` | 41 → 46（+5） | ① 列表映射（同名用 path 区分、每项键恰为 `projectId/title/path`、id 可直接 `board/read`）；② 只读：不注册/不读/不写（core `listProjects()` 仍为空、直接读仍 `unknown-project`）；③ 空 registry 合法空候选集；④ registry 缺失 → `unavailable`、`list()` 抛异常 → `read-failed` 且 handler 不抛；⑤ 非对象 payload 在触碰 registry 前即 `invalid-payload`。 |
| 其余 | 不变 | core 66 / plugin-client 67；既有 232 全部保留。 |

**边界 B：237 → 252（+15）**

| 文件 | 变化 | 解释 |
| --- | --- | --- |
| `packages/plugin-client/test/wire.test.ts` | 10 → 12（+2） | `project/list` schema 守卫：① 只有 JSON 对象 payload 合法（`null`/数组/字符串/数字皆 `invalid-payload`，不能借列表请求夹带选择）；② value 守卫：合法 `{projectId,title,path}`、空数组合法、缺字段/空 id/非数组均 `null`。 |
| `packages/plugin/test/channel-roundtrip.test.ts` | 17 → 19（+2） | ① 经**真实构建产物**（built client bundle ↔ built host handler）往返 `project/list`：endpoint 正确、payload 恒 `{}`、结果逐项相等；② host 失败（`unavailable`）→ 浏览器得到失败，**不得**变成空候选集。 |
| `packages/plugin-client/test/controller.test.ts` | 30 → 35（+5） | ① `idle→loading→loaded` 且拉列表不选中/不读板；② 列表失败 → `projects.failed` + `retry:{kind:'read'}`，`retryPending` 重拉列表（不发 board/read）后恢复且不自动选中；③ `selectProject` 用显式 id 读板并保留候选；④ `resetSelection` 清列表+选择且不重读；⑤ 空列表合法、无失败反馈、无选择。 |
| `packages/plugin-client/test/board.test.ts` | 新增 6 | 选择器渲染：① 加载中（无伪造条目）；② 失败内联提示+重试（不渲染为空列表、不重复 banner）；③ 空列表「没有可用项目」+ 刷新且不自动选；④ 两个同名项目用 path 区分、全部按钮无 selected/pressed/current 标记、无默认/最近/推荐文案；⑤ 点击第二个项目只把显式 id 交给 `onSelectProject`；⑥ 「切换项目」仅在已选后出现并触发回到选择器。 |
| 其余 | 不变 | model 20 / slots 7 / board-adapter 46 / client-bundle 7 / host 34 / core 66。 |

合计：**core 66 / plugin 106 / plugin-client 80 = 252**，+15，无既有用例删除或改写。

### 13.5 六项门禁原始输出

#### 13.5.1 边界 0（`d05beb8` 的树，沙盒 `C:\Users\InformationDS\aikanban-p5c`）

```text
===== TARGET d05beb8 =====
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      179.09 kB │ gzip: 44.35 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  397.02 kB │ gzip: 93.66 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 576.11 kB
✔ [@aikanban/dsh-aikanban] Build complete in 70ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.20 kB │ gzip: 9.71 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.20 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 46ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 13ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 12ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 8ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 25ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 22ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 23ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 27ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 27ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  00:32:57
packages/plugin-client test:    Duration  2.93s (transform 971ms, setup 0ms, collect 1.53s, tests 59ms, environment 1ms, prepare 3.37s)
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 22ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 28ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 42ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 47ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  00:32:57
packages/core test:    Duration  3.62s (transform 1.72s, setup 0ms, collect 6.79s, tests 288ms, environment 4ms, prepare 9.90s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 15ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 279ms
packages/plugin test:  ✓ test/board-adapter.test.ts (41 tests) 50ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 107ms
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  99 passed (99)
packages/plugin test:    Start at  00:33:02
packages/plugin test:    Duration  2.04s (transform 1.03s, setup 0ms, collect 1.60s, tests 452ms, environment 1ms, prepare 1.36s)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (174.9 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvi5k0bn-1 pid=26492
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvi5k0bn-1, pid 26492, services seen: none)

OK
===== VERIFY EXIT=0 =====
===== PROBE =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5c
  isolated home    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5k0si-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:12514/?token=pEIZb4u_t8rQDopVa9sB99oXS_XefTX8YnDVLBrh0rY
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=f68aa091c9482a31-44
        served 200 29573B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvi5k5ue-1 pid=41712 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5k0si-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=f68aa091c9482a31-44 status=200 bytes=29573
  PASS  apply() ran inside the booting host
        activation=mvi5k5ue-1 pid=41712 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

#### 13.5.2 边界 A（`5e95f08` 的树，同一沙盒）

```text
===== TARGET 5e95f08 =====
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      182.58 kB │ gzip: 45.26 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  405.02 kB │ gzip: 95.51 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 587.60 kB
✔ [@aikanban/dsh-aikanban] Build complete in 68ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  31.23 kB │ gzip: 9.72 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 31.23 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 43ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 13ms
packages/plugin-client test:  ✓ test/wire.test.ts (10 tests) 11ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 10ms
packages/plugin-client test:  ✓ test/controller.test.ts (30 tests) 22ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 15ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 20ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 20ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 23ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 24ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 27ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 9ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 22ms
packages/plugin-client test:  Test Files  4 passed (4)
packages/plugin-client test:       Tests  67 passed (67)
packages/plugin-client test:    Start at  00:33:31
packages/plugin-client test:    Duration  2.61s (transform 589ms, setup 0ms, collect 1.20s, tests 55ms, environment 1ms, prepare 2.72s)
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 23ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 35ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 41ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  00:33:31
packages/core test:    Duration  3.20s (transform 1.32s, setup 0ms, collect 5.41s, tests 259ms, environment 3ms, prepare 8.00s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 15ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (17 tests) 241ms
packages/plugin test:  ✓ test/board-adapter.test.ts (46 tests) 49ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 97ms
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  104 passed (104)
packages/plugin test:    Start at  00:33:36
packages/plugin test:    Duration  1.91s (transform 1.02s, setup 0ms, collect 1.39s, tests 402ms, environment 1ms, prepare 1.27s)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (178.3 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvi5kqe0-1 pid=41820
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvi5kqe0-1, pid 41820, services seen: none)

OK
===== VERIFY EXIT=0 =====
===== PROBE =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5c
  isolated home    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5kqtw-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:8257/?token=iAXmL8nKWgRMQRRBCIrckXJ0xqvShrkgffesBb5NtaE
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=e8e221aff6113768-44
        served 200 29601B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvi5kvq2-1 pid=40000 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5kqtw-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=e8e221aff6113768-44 status=200 bytes=29601
  PASS  apply() ran inside the booting host
        activation=mvi5kvq2-1 pid=40000 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

#### 13.5.3 边界 B（`c3cf922` 的树，同一沙盒）

```text
===== TARGET c3cf922 =====
===== TYPECHECK =====
$ tsc -b
===== TYPECHECK EXIT=0 =====
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      182.58 kB │ gzip: 45.26 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  405.02 kB │ gzip: 95.51 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 587.60 kB
✔ [@aikanban/dsh-aikanban] Build complete in 67ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p5c\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  34.54 kB │ gzip: 10.39 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 34.54 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 42ms
===== BUILD EXIT=0 =====
===== TESTS =====
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin-client
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/core
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 13ms
packages/plugin-client test:  ✓ test/wire.test.ts (12 tests) 12ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 7ms
packages/plugin-client test:  ✓ test/controller.test.ts (35 tests) 32ms
packages/plugin-client test:  ✓ test/board.test.ts (6 tests) 13ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 19ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 22ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 22ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 31ms
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 34ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 25ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 10ms
packages/plugin-client test:  Test Files  5 passed (5)
packages/plugin-client test:       Tests  80 passed (80)
packages/plugin-client test:    Start at  00:34:04
packages/plugin-client test:    Duration  2.79s (transform 624ms, setup 0ms, collect 1.75s, tests 80ms, environment 2ms, prepare 4.28s)
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 28ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 43ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 51ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  00:34:04
packages/core test:    Duration  3.32s (transform 1.39s, setup 0ms, collect 5.73s, tests 305ms, environment 3ms, prepare 9.06s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p5c/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 15ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (19 tests) 272ms
packages/plugin test:  ✓ test/board-adapter.test.ts (46 tests) 42ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 106ms
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  106 passed (106)
packages/plugin test:    Start at  00:34:09
packages/plugin test:    Duration  1.93s (transform 1.17s, setup 0ms, collect 1.61s, tests 436ms, environment 1ms, prepare 1.29s)
packages/plugin test: Done
===== TESTS EXIT=0 =====
===== VERIFY =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (178.3 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvi5lfi7-1 pid=31068
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvi5lfi7-1, pid 31068, services seen: none)

OK
===== VERIFY EXIT=0 =====
===== PROBE =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p5c
  isolated home    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5lfzl-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:11720/?token=F3TbUP6pMh57ujgOE7i66K4vB6cu1WnqIpUl-ipDq0w
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=de6456ca54af30e3-44
        served 200 32704B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvi5lkrx-1 pid=41360 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p5c\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi5lfzl-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=de6456ca54af30e3-44 status=200 bytes=32704
  PASS  apply() ran inside the booting host
        activation=mvi5lkrx-1 pid=41360 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
===== PROBE EXIT=0 =====
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
===== CHECK-DOCS EXIT=0 =====
```

**结论**：三次门禁均 **typecheck EXIT=0 / build EXIT=0 / tests EXIT=0 / verify 11/11 EXIT=0 / probe 5/5 EXIT=0（`path=compat`）/ check_docs EXIT=0（59 md）**；用例数 232（既有）→ 237（边界 A）→ **252**（边界 B）。

### 13.6 与规格的字面不一致 / 实施中需要说明的点

| # | 规格字面 | 实施事实 | 说明 |
| --- | --- | --- | --- |
| ① | §1.1 A9「模型补候选项目列表项」 | `BoardProjectChoice` 定义在 `model.ts`，wire 用 `ProjectListItem = BoardProjectChoice` 别名、source 用 `ProjectChoice` 别名 | 与规格一致；三个名字是同一结构类型，不产生第二份事实源。 |
| ② | §9.2「列表来自宿主 `workspaceRegistry.list()`」 | delayed-ready 包装器在**数据层未就绪**时把 `listProjects` 也回答 `unavailable` | 规格 §5.1 第 3 步要求「每个方法」在未就绪时显式失败；列表本体不依赖 core，但避免列出「选中后必然读失败」的候选；就绪后原样转发。 |
| ③ | §2.2 第 4 条空态文案 | 选择器复用 `SELECTION_REQUIRED_TITLE`/`_DESCRIPTION` 作为选择器区标题/说明；列表失败/空列表各自内联显示 | 规格回写 §2.2 已注明「A 起该状态的主体是选择器…标题/说明仍可作选择器区文案」。 |
| ④ | 规格未规定失败反馈渲染位置 | 列表失败同时写 `projects.failed` 与 feedback `retry:{kind:'read'}`；`selection-required` 时面板只渲染选择器内联失败与重试，不再渲染底部 banner | 避免同一句失败文案与同一个重试按钮出现两次；控制器状态仍保留 `{kind:'read'}` 重试形态，`retryPending()` 在无选择时路由到 `loadProjects()`。 |
| ⑤ | 规格只要求空列表显示「没有可用项目」 | 空列表额外提供「刷新项目列表」按钮 | 只重拉列表、不选中任何项目；不引入默认/推荐语义。 |
| ⑥ | §7.2 探针 | 未改 `tools/probe-host.mjs`（本档不新增宿主依赖） | 第 5 项仍如实输出 `path=compat`；本档未把兼容路径写成「公开入口已验证」。 |
| ⑦ | §2.6 端点为第 5 个 | `BOARD_ENDPOINTS` 5 个；`BOARD_FAILURE_CODES` 仍 8 个 | 失败码未增；`invalid-payload`/`unknown-endpoint` 仍是 host-only 协议码（既有）。 |

### 13.7 剩余未确认项（本档未取证，不得写成已验证）

- **真实 Connection RPC 网络往返**：仍只有「构建产物 ↔ 构建产物」的进程内协议往返 + 探针的宿主内注册观察。**本档没有从真实浏览器发出任何一条 `board/read` 或 `project/list`**（见 §13.8 结论），ADR-005 保持 `提议`。
- **真实 profile / 真实 GUI**：未安装 profile、未重启 GUI（本档明令不做）；选择器在真实页面的渲染、键盘可达性、点击选择路径均未观测。
- **`workspaceRegistry.list()` 的真实运行时字段/生命周期**：适配器按结构读取 `id/title/path/status()`；真实 registry 在页面打开时是否已绑定、`title`/`path` 是否总有值，仍需 P6 观察（若形状不符，列表映射只影响显示，不影响 `projectId` 解析）。
- **`workspace.status()` 超时**：按规格 §3.1 写死「不实现超时」，永不 resolve 由宿主负责。
- **order 级基线缺失（D6）**：仍未解决；reorder 的 `unknown-result`/写后 `read-failed` 仍只给 `{kind:'read'}`，不自动重发。
- **host 卸载时的 domain 关闭/通道注销**：沿用进程级生命周期，未主动关闭。
- **列表规模/时延**：未测大数量 workspace 下的列表与选择渲染。
- **AT 全部「待执行」**：本档测试（含 UI 渲染测试）不是 F01/F02 验收，`acceptance.csv` 未动。

### 13.8 现在浏览器是否能真的发出一条 `board/read`：结论与 P6 前置

**结论：仍不能证明。** 本档新增的 `project/list` 让**界面侧**第一次具备「候选列表 → 显式选择 → 读取看板」的完整代码路径，且 `channel-roundtrip` 用**构建后的 client bundle** 与**构建后的 host handler** 走通了同一信封；但这仍是**进程内协议往返**：

- 没有真实 profile，也就没有真实页面的 `window.__DSH_BOOT__` → client bundle 装配；
- 没有真实 GUI，也就没有 `POST /aikanban/...` 的 HTTP 观测（Host/Origin/token 校验、路由挂载都未经过）；
- 探针只证明宿主**进程内**注册了通道（`channel=/aikanban registered=true path=compat, dataLayerReady=true`），不证明网络可用，也不证明页面能调通。

**因此：ADR-005 不能在本档关闭；P6（真实 profile + 真实 RPC 往返）是关闭它的必要条件。** 下一档前置条件与风险：

1. **前置**：三提交已推送、干净 worktree 上六项门禁复跑通过；GUI 端口每次由系统分配（**不得写死**，从探针输出或 `window.__DSH_BOOT__` 读取实际 URL）；安装真实 profile / 重启 GUI 会写用户 `~/.dsh`，需用户明确批准（本档禁止）。
2. **必须观测到的最小证据**：真实页面打开 AIKanBan 面板 → 观察 `POST /aikanban/project/list` 返回 200 且 envelope 合法 → 点击某项目 → 观察 `POST /aikanban/board/read` 的 payload 为 `{projectId:<workspace id>}`、返回合法快照；同时观察 Host/Origin/token 校验通过（不是 401/403/404/500）。在此之前不得写「浏览器已能读写看板」。
3. **风险**：
   - 公开 `connection.rpc.handle` 在 DSH 44.7.0 抛 `cannot get property webServer without inject`，本仓库走兼容注册路径（探针 `path=compat`）；宿主升级/换组合会改变该行为，P6 需重新观察 `path` 并如实记录。
   - `workspaceRegistry` / `connection` / `webServer` 均可能晚于 `apply()` 绑定；页面若在数据层就绪前打开，`project/list` 会先得到 `unavailable`，选择器显示失败+重试（本档的预期行为），P6 需确认重试后恢复正常，而不是误判为缺陷。
   - 真实 `storageDomain.open` 的错误形状仍可能与安装包声明不同；失败时列表 `unavailable`、读 `read-failed`，都不得显示空看板。
   - 真实页面交互（选择器点击/键盘、切换项目）没有自动化 DOM 证据，P6 至少需要手工或 DevTools 记录；不得用 `renderBoard` 单测冒充真实渲染。
   - 真实并发/大项目时延未测；写后重读使每次写多一次整板读取。

### 13.9 记录追加后的文档门禁

本记录只改 `docs/engineering/s1-wiring-implementation.md`（未新增 md 文件数）；追加后复跑 `python docs/tools/check_docs.py`：`PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.`（四项 PASS + `EXIT=0`；文档完整性，不涉及应用/产品验收）。

## 14. P6a：真实 HTTP 上的 RPC 往返证据（2026-10-22，提交 `75726cf` + 本记录提交）

> **本档任务书裁定的硬边界**：不改 `packages/*/src` 的任何业务逻辑；唯一新增代码是 `tools/verify-rpc-roundtrip.mjs`（验证脚本），并**复用** `packages/plugin/src/probe/` 的探针设施（探针不是产品代码）。不装 `desktop` profile、不重启 GUI、不写 `~/.dsh/profiles/desktop`。端点仍 **5 个**、失败码仍 **8 个**、契约一律不动。AT 全部「待执行」、`acceptance.csv` 未动；**本档证据不是 AT 验收**。**ADR-005 状态未改**（仍「提议」），只在其后追加「证据（2026-10-22）」节。

### 14.1 本档补的是哪一层证据

§13.7/§13.8 与 [ADR-005](decisions/ADR-005-浏览器半与宿主半的数据通道.md)「尚未验证」把缺口写得很明确：已有的是**进程内协议往返**（构建后的 client bundle ↔ 构建后的 host handler）与**探针的宿主内注册观察**，缺的是**真实 HTTP carrier 上的往返**。

本档不写 profile、不重启 GUI，而是复用 `tools/probe-host.mjs` 的**隔离宿主**形态：它是真实 HTTP 服务（`--port 0` 由系统分配端口，不写死），有自己的 `DSH_HOME`，不碰用户正在使用的 GUI。区别只在于：探针只看宿主日志，本档**真的向它发 HTTP 请求**。

### 14.2 新增工具与做法（可重复运行）

新增 [tools/verify-rpc-roundtrip.mjs](../../tools/verify-rpc-roundtrip.mjs)（`75726cf`，1 文件 +1224 行，唯一代码改动）。做法逐条对应任务书 §2.1：

1. **隔离宿主引导**：与 `probe-host.mjs` 同形——独立 `DSH_HOME`、临时 profile（`dsh-base` + `dsh-web-app` 两个 bundle + 只 insert `@aikanban/dsh-aikanban`）、junction 指向当前构建产物、`--port 0`、`--no-open`、退出时整树删除。默认 home 是 `.probe-home-scaffold/rpc-roundtrip`（嵌套在既有 gitignore 目录内，工具只删自己那一层，`probe-host` 不会与它共用 home）。
2. **认证**：照 `probe-host.mjs:436-452` 的写法，从宿主打印的 URL 取 `origin` 与 `token`，`GET /?token=…`（`redirect:'manual'`）→ **303 + `set-cookie`**，取 `name=value` 作为后续请求的 cookie；再用同一 cookie `GET /` 应得 **200** 且 HTML 含 `__DSH_BOOT__`。
3. **正向 `project/list`**：`POST {origin}/aikanban/project/list`，显式带 `Host`（= URL 的 `host:port`）、同源 `Origin`、cookie、`content-type: application/json`；请求体是**宿主真实信封** `{"type":"client-request","rpcId":…,"method":"project/list","payload":{}}`。断言 HTTP 200、信封合法（`type='server-response'`、`rpcId` 回显、`result` 对象）、`result.ok===true`、`projects` 为数组且与隔离 home 的 workspace 夹具逐项一致（`projectId`/`title`/`path`）。
4. **正向 `board/read`**：取上一步的一个 `projectId`，`POST {origin}/aikanban/board/read`，payload `{"projectId":…}`。断言 200、信封合法、`result.ok===true`，并校验看板快照形状：`project.projectId/title/path` 与夹具一致、`tasks` 数组、`columns` 5 列（`todo/doing/blocked/done/cancelled`，含 `label`/`collapsedByDefault`）、`boardToken` 非空、`capabilities` 三布尔全 `true`。
5. **负载与就绪**：隔离 home 冷启动时数据层尚未打开，`project/list` 会先回 `unavailable`（delayed-ready 包装器的既有行为）。工具用**轮询 + 超时**等待，不假设固定启动窗口；就绪前失败、超时仍失败则如实记为 FAIL 并跳过 `board/read`。
6. **围栏负向**（每次只改一个请求属性）：无 cookie → **401**；cookie 合法但 `Origin: https://evil.example` → **403**；cookie 合法但 `content-type: text/plain` → **415**；方法 `GET` → **404**；路径 `/aikanban`（无 endpoint 段）→ **404**；补充：cookie 合法但 `Host: evil.example:1234` → **403**。负向批次之后**再发一条同 cookie 的健康请求**作对照（FEN-7，200 + `result.ok=true`），以排除「cookie 中途失效」这一替代解释。
7. **契约负向（与围栏分开计数）**：`/aikanban/does-not-exist`（端点名不在 5 端点内）→ **HTTP 200 + `result.ok=false, error.code='unknown-endpoint'`**；`board/read` 携带未登记 `projectId` → **HTTP 200 + `error.code='unknown-project'`**。这两条证明 handler 用 envelope 返回失败、没有抛成 500，也覆盖了任务书 §4 提到的「未登记项目 → unknown-project」路径。
8. **原始证据落盘**：`stdout` 打印可粘贴摘要（每条断言的 ID / 期望 / 实际 / HTTP 状态 / PASS|FAIL），完整原始 transcript（请求头、HTTP 状态、响应体、host log）写入 `.probe-out-scaffold/rpc-roundtrip/roundtrip-probe.{log,json}`（gitignored；`token` 与 `Set-Cookie` 值已脱敏）。退出码：0 全通过 / 1 有断言失败 / 2 参数或找不到 dsh CLI / 4 未构建 / 5 宿主未就绪 / 6 隔离 home 准备失败。

**「隔离 home 里没有 workspace」的解法（任务书要求写清楚）**：不改产品代码，而是复用探针设施 [packages/plugin/src/probe/harness/prepare.mjs](../../packages/plugin/src/probe/harness/prepare.mjs) 的 `prepare(home)`：它把 durable workspace 存储 unit（`storages/workspace.json`，domain `workspace` version 2）直接写进隔离 home，内容就是真实 registry 里观察到的两条 workspace 记录（仓库目录 `03696d17-…` 与父目录 `455306c1-…`）。产品的 `workspaceRegistry` 启动时按**正常读取路径**加载它；`board/read` 的 `registerProject` 由适配层在同一请求内自动触发（契约里没有注册端点，也不需要）。因此 `board/read` 走的是真实适配层 `registry.get → core.registerProject → core.readBoard`，不是特制入口。**这不等于「产品能自己创建 workspace」**：真实创建入口（GUI / 宿主 API）本档仍未经过。

**实现中的一个必要细节**：请求用 `node:http` 而不是 `fetch` 发送，因为 Node 的 `fetch` 会忽略调用方提供的 `Host`，否则 Host 围栏负向根本不可能被证明；cookie 交换仍用 `fetch`（与 `probe-host.mjs` 一致）。

### 14.3 逐条断言（本次门禁运行，17/17）

| # | 断言 | 期望 | 实际 |
| --- | --- | --- | --- |
| AUTH-1 | launch token → 签名 cookie | 303 + `set-cookie` | 303 + `set-cookie`（`dsh-auth-…`） |
| AUTH-2 | cookie 可载入应用壳 | 200 且含 `__DSH_BOOT__` | 200、27899B、含 `__DSH_BOOT__` |
| POS-1 | `project/list` HTTP | 200 | 200（数据层就绪后，1 次尝试） |
| POS-2 | `project/list` 信封 | `type=server-response`、`rpcId` 回显、`result.ok=true` | 同期望 |
| POS-3 | `project/list` 候选集 | 与 workspace 夹具 2 项逐项一致 | 2 项：`03696d17…`(AIKanBan)、`455306c1…`(dsh-plugin（旧）) |
| POS-4 | `board/read` HTTP | 200 | 200（`projectId=03696d17-…`） |
| POS-5 | `board/read` 信封 | 同 POS-2 | 同期望 |
| POS-6 | `board/read` 快照形状 | project 字段一致、tasks 数组、5 列、boardToken、capabilities | project 一致、`tasks=0`、5 列、boardToken 非空、三项 capabilities 全 true |
| FEN-1 | 无 cookie | 401 | 401 `unauthorized` |
| FEN-2 | cookie + 跨站 Origin | 403 | 403 `forbidden` |
| FEN-3 | cookie + 非 JSON content-type | 415 | 415 `content type must be application/json` |
| FEN-4 | 非 POST（GET） | 404 | 404 `not found` |
| FEN-5 | 无 endpoint 段（`/aikanban`） | 404 | 404 `not found` |
| FEN-6 | cookie + 非本机 Host（补充） | 403 | 403 `forbidden` |
| FEN-7 | 负向批次后的同 cookie 对照 | 200 + `result.ok=true` | 200 + `result.ok=true` |
| CON-1 | 5 端点外的端点名 | 200 + `unknown-endpoint` | 200 + `unknown-endpoint` |
| CON-2 | 未登记 `projectId` | 200 + `unknown-project` | 200 + `unknown-project` |

说明：`tasks=0` 不是缺陷——隔离 home 的 core 是全新 domain，本档只做**读路径**，不创建任务（写端点不在本档范围）。因此「快照形状合法」是本次观察到的全部内容；「有任务时的内容正确」由 core/适配器用例与后续真实 GUI 覆盖。

### 14.4 直接回答：真实 HTTP 往返是否成立

**成立（限定在「隔离宿主 + 本脚本作为发起方」这一层）：**

- 真实 HTTP 服务：宿主监听由系统分配的端口（本档三次运行分别是 `10754`、`1572`、`10306`，**没有写死端口**），`project/list` 与 `board/read` 都由该服务返回 200；响应信封 `type/rpcId/result` 与看板快照都是 HTTP 响应体，不是进程内返回值。
- 真实鉴权与围栏：launch token → 签名 cookie 交换在真实 HTTP 上完成；无 cookie 401、跨站 Origin 403、非 JSON 415、非 POST 404 都在 carrier 层被拒绝，负向批次后的对照请求仍 200。
- 真实失败映射：未知端点与未登记项目以 HTTP 200 + envelope 失败码返回，没有 500。

**不成立 / 未证实的部分（不得越级写成结论）：**

- 发起方是**本脚本**，不是页面里的 `ctx.connection.rpc.call`；`window.__DSH_BOOT__` 装配与浏览器半代码没有被本工具执行。「通道在真实 HTTP 上能往返」≠「浏览器半已成立」。
- 没有真实 profile、没有真实 GUI、没有真实页面渲染；因此本档不能支撑「界面可用」「GUI 已接通」这类表述，[ADR-005](decisions/ADR-005-浏览器半与宿主半的数据通道.md) 状态仍为「提议」。
- **注册路径与 HTTP 通道是两件事，证据分开**：
  - 进程内注册（diagnostics `aikanban:board-channel`）：`channel='/aikanban', registered=true, path='compat'`；同次运行最后一个 `aikanban:activation` 显示 `dataLayerReady=true`。这证明宿主进程内注册发生、走的是兼容路径，**不证明公开入口 `ctx.connection.rpc.handle` 可用**。
  - 真实 HTTP 通道：`POST /aikanban/project/list` 与 `/board/read` 的 200/信封/快照（上表 POS-1…POS-6）。这证明**这条通道上的真实请求确实通**，与 `path=compat` 是两条独立事实；本档没有把二者合并成「公开入口已成立」。
- `board/read` 的 `tasks` 为空；写端点（`task/status.set`/`reorder`/`undo`）未在本档经真实 HTTP 验证。AT 全部仍「待执行」。

### 14.5 六项门禁 + 新工具的原始输出

沙盒 `C:\Users\InformationDS\aikanban-p6a`，目标提交 `75726cf`（隔离 home、workspace 夹具与 profile 均由工具按上文生成；下述 token 已脱敏）。

```text
TARGET 75726cf
===== TYPECHECK =====
$ tsc -b
EXIT=0
===== BUILD =====
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p6a\packages\plugin\tsdown.config.ts 
ℹ [@aikanban/dsh-aikanban] entry: src/index.ts
ℹ [@aikanban/dsh-aikanban] target: node22
ℹ [@aikanban/dsh-aikanban] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban] lib\index.js      182.58 kB │ gzip: 45.26 kB
ℹ [@aikanban/dsh-aikanban] lib\index.js.map  405.02 kB │ gzip: 95.51 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 587.60 kB
✔ [@aikanban/dsh-aikanban] Build complete in 151ms
ℹ tsdown v0.22.14 powered by rolldown v1.2.13
ℹ config file: C:\Users\InformationDS\aikanban-p6a\packages\plugin\tsdown.client.config.ts 
ℹ [@aikanban/dsh-aikanban/client] entry: src/client.tsx
ℹ [@aikanban/dsh-aikanban/client] target: es2022
ℹ [@aikanban/dsh-aikanban/client] tsconfig: tsconfig.json
ℹ Build start
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  34.54 kB │ gzip: 10.39 kB
ℹ [@aikanban/dsh-aikanban/client] 1 files, total: 34.54 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 45ms
EXIT=0
===== TESTS =====
$ pnpm -r --if-present run test
Scope: 3 of 4 workspace projects
packages/core test$ vitest run
packages/plugin-client test$ vitest run
packages/core test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p6a/packages/core
packages/plugin-client test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p6a/packages/plugin-client
packages/plugin-client test:  ✓ test/model.test.ts (20 tests) 13ms
packages/core test:  ✓ |core| test/port-parity.test.ts (5 tests) 10ms
packages/plugin-client test:  ✓ test/wire.test.ts (12 tests) 19ms
packages/plugin-client test:  ✓ test/controller.test.ts (35 tests) 35ms
packages/plugin-client test:  ✓ test/board.test.ts (6 tests) 13ms
packages/core test:  ✓ |core| test/restart.test.ts (4 tests) 24ms
packages/core test:  ✓ |core| test/version-chain.test.ts (3 tests) 27ms
packages/core test:  ✓ |core| test/drafts-and-recheck.test.ts (4 tests) 31ms
packages/core test:  ✓ |core| test/applicability.test.ts (5 tests) 35ms
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests) 10ms
packages/plugin-client test:  Test Files  5 passed (5)
packages/plugin-client test:       Tests  80 passed (80)
packages/plugin-client test:    Start at  01:17:38
packages/plugin-client test:    Duration  4.20s (transform 1.45s, setup 0ms, collect 2.72s, tests 90ms, environment 2ms, prepare 6.13s)
packages/core test:  ✓ |core| test/concurrency.test.ts (6 tests) 57ms
packages/core test:  ✓ |core| test/paired-confirmation.test.ts (8 tests) 68ms
packages/core test:  ✓ |core| test/f01-activity.test.ts (2 tests) 28ms
packages/core test:  ✓ |core| test/f01-project-isolation.test.ts (6 tests) 44ms
packages/core test:  ✓ |core| test/f01-task-create-edit.test.ts (12 tests) 67ms
packages/core test:  ✓ |core| test/f02-status-and-order.test.ts (11 tests) 77ms
packages/plugin-client test: Done
packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)
packages/core test:    Start at  01:17:38
packages/core test:    Duration  5.01s (transform 2.62s, setup 0ms, collect 8.56s, tests 468ms, environment 4ms, prepare 12.14s)
packages/core test: Done
packages/plugin test$ vitest run
packages/plugin test:  RUN  v3.2.7 C:/Users/InformationDS/aikanban-p6a/packages/plugin
packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests) 23ms
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (19 tests) 279ms
packages/plugin test:  ✓ test/board-adapter.test.ts (46 tests) 49ms
packages/plugin test:  ✓ test/host.test.ts (34 tests) 94ms
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  106 passed (106)
packages/plugin test:    Start at  01:17:45
packages/plugin test:    Duration  2.19s (transform 1.19s, setup 0ms, collect 1.83s, tests 444ms, environment 1ms, prepare 1.44s)
packages/plugin test: Done
EXIT=0
===== VERIFY =====

Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (178.3 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvi75in3-1 pid=4532
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvi75in3-1, pid 4532, services seen: none)

OK
VERIFY EXIT=0
===== PROBE =====
AIKanBan isolated load probe

  workspace        C:\Users\InformationDS\aikanban-p6a
  isolated home    C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold
  probe profile    C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\profiles\probe
  port             0 (OS-assigned — cannot collide with a running GUI)
  mode             composition + real boot

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/5] composing the probe profile tree (--dump-config)
  PASS  # == C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\profiles\probe\cordis.patch.yml | - id: aikanban

[2/5] resolving and activating the host half from the profile directory
  PASS  packages/plugin/package.json
        [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi75j3x-1

[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:13759/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=5711a768d9de8c7a-44
        served 200 32704B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…

[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvi75pcr-1 pid=35252 tools=false systemPrompt=false

[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

probe host log: .probe-out-scaffold/probe-probe.log
isolated home removed (pass --keep to inspect it)

summary
  PASS  composed tree contains the aikanban row
        # == C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\profiles\probe\cordis.patch.yml
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi75j3x-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=5711a768d9de8c7a-44 status=200 bytes=32704
  PASS  apply() ran inside the booting host
        activation=mvi75pcr-1 pid=35252 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
PROBE EXIT=0
===== CHECK-DOCS =====
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
CHECK-DOCS EXIT=0
===== ROUNDTRIP (新增工具) =====
AIKanBan real-HTTP RPC roundtrip verification

  workspace        C:\Users\InformationDS\aikanban-p6a
  isolated home    C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\rpc-roundtrip
  probe profile    C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\rpc-roundtrip\profiles\probe
  port             0 (OS-assigned — never hardcode a GUI port)
  channel          /aikanban (5 endpoints: board/read, project/list, task/status.set, task/reorder, task/status.undo)
  failure codes    8 (unchanged): unknown-endpoint, invalid-payload, invalid-reason, read-failed, not-found, save-failed, stale-baseline, unknown-result

  dsh cli          C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
  node             C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

prepared isolated home; workspace fixture: 2 workspace(s)
  03696d17-12c2-4d78-9b3e-ff3bdf9e6f10  AIKanBan  C:\Users\InformationDS\aikanban-p6a
  455306c1-4d0a-42ad-ba21-d63b41d753d8  dsh-plugin（旧）  C:\Users\InformationDS
prepared profile; @aikanban/dsh-aikanban → C:\Users\InformationDS\aikanban-p6a\.probe-home-scaffold\rpc-roundtrip\profiles\probe\node_modules\@aikanban\dsh-aikanban

[1/6] booting the isolated host (own DSH_HOME, --port 0, --no-open)
  ok    isolated host settled and bound: dsh web: http://127.0.0.1:10306/?token=<redacted>
  ok    request origin (OS-assigned): http://127.0.0.1:10306

[2/6] exchanging the launch token for the signed session cookie

[3/6] positive: POST /aikanban/project/list over real HTTP

[4/6] positive: POST /aikanban/board/read over real HTTP

[5/6] negative: carrier fence and authentication

[6/6] supplementary: contract-level failures over real HTTP (not fence evidence)

[setup / authentication]
  PASS  AUTH-1 HTTP  303  launch token → signed session cookie exchange
        expected: 303 with a set-cookie header
        actual:   303 with set-cookie (dsh-auth-F2XlDx-CXYpRL2ESwv08Su4FwKnPYIn6gtpsBxID-1k=…)
  PASS  AUTH-2 HTTP  200  the exchanged cookie authenticates the app shell
        expected: GET / with the cookie → 200 and the shell HTML
        actual:   200 (27899B, __DSH_BOOT__ present: true)

[positive: real HTTP RPC roundtrip]
  PASS  POS-1  HTTP  200  project/list answers HTTP 200 (after data-layer readiness, if needed)
        expected: HTTP 200
        actual:   HTTP 200 after 1 attempt(s)
  PASS  POS-2  HTTP  200  project/list response is a valid RPC envelope (type/rpcId echo/result.ok)
        expected: type='server-response', rpcId echoes the request, result.ok=true, content-type application/json
        actual:   type=server-response rpcId-echo=true result.ok=true
  PASS  POS-3  HTTP  200  project/list value carries the candidate set from the host workspaceRegistry
        expected: 2 fixture workspace(s) with matching projectId/title/path; no selection fields
        actual:   2 projects: 03696d17…(AIKanBan), 455306c1…(dsh-plugin（旧）)
  PASS  POS-4  HTTP  200  board/read answers HTTP 200
        expected: HTTP 200
        actual:   HTTP 200 for projectId=03696d17-12c2-4d78-9b3e-ff3bdf9e6f10
  PASS  POS-5  HTTP  200  board/read response is a valid RPC envelope (type/rpcId echo/result.ok)
        expected: type='server-response', rpcId echoes the request, result.ok=true
        actual:   type=server-response rpcId-echo=true result.ok=true
  PASS  POS-6  HTTP  200  board/read value is a board snapshot for the explicitly selected project
        expected: project.projectId/title/path match the registry fixture; tasks array; 5 columns; boardToken; capabilities
        actual:   project=03696d17-12c2-4d78-9b3e-ff3bdf9e6f10 tasks=0 columns=[todo:未开始, doing:进行中, blocked:已阻塞, done:已完成, cancelled:已取消] boardToken=a8713d71a105… capabilities={"statusChange":true,"reorder":true,"undo":true}

[negative: carrier fence and authentication]
  PASS  FEN-1  HTTP  401  no session cookie → 401
        expected: HTTP 401 (authentication rejected before the handler)
        actual:   HTTP 401 body="unauthorized"
  PASS  FEN-2  HTTP  403  valid cookie but cross-site Origin → 403
        expected: HTTP 403 (Host/Origin fence rejected before authentication)
        actual:   HTTP 403 body="forbidden"
  PASS  FEN-3  HTTP  415  cookie valid but content-type is not application/json → 415
        expected: HTTP 415 (the carrier requires application/json)
        actual:   HTTP 415 body="content type must be application/json"
  PASS  FEN-4  HTTP  404  non-POST method (GET) → 404
        expected: HTTP 404 (only POST is routed to the RPC handler)
        actual:   HTTP 404 body="not found"
  PASS  FEN-5  HTTP  404  POST without an endpoint segment (path /aikanban) → 404
        expected: HTTP 404 (no endpoint can be derived from the path)
        actual:   HTTP 404 body="not found"
  PASS  FEN-6  HTTP  403  cookie valid but Host names a non-loopback authority → 403
        expected: HTTP 403 (the Host fence rejects a rebound authority)
        actual:   HTTP 403 body="forbidden"
  PASS  FEN-7  HTTP  200  control: the same cookie still succeeds after the negative batch
        expected: HTTP 200 + result.ok=true (so the negative statuses above are caused by the deviations)
        actual:   HTTP 200 result.ok=true

[supplementary: contract-level failures over real HTTP]
  PASS  CON-1  HTTP  200  endpoint outside the five-endpoint contract returns a failure envelope, not a throw
        expected: HTTP 200 + result.ok=false + error.code='unknown-endpoint'
        actual:   HTTP 200 code="unknown-endpoint"
  PASS  CON-2  HTTP  200  board/read for an unregistered projectId returns a failure envelope, not an empty board
        expected: HTTP 200 + result.ok=false + error.code='unknown-project'
        actual:   HTTP 200 code="unknown-project"

[process-internal registration evidence — diagnostics channel, NOT HTTP]
  observed      aikanban:board-channel channel=/aikanban registered=true path=compat
  dataLayer     dataLayerReady=true (from the last aikanban:activation payload)
  meaning       the registration path is process-internal only. path=compat means the
                public ctx.connection.rpc.handle path threw and the compatibility
                register() call was used (ADR-005); it does NOT say the public path works.

[verdict]
  project/list over real HTTP : RPC roundtrip observed (envelope + candidate set)
  board/read over real HTTP   : RPC roundtrip observed (envelope + snapshot)
  carrier fence               : authentication + Host/Origin enforced (401/403/415/404 observed)
  registration path evidence  : process-internal path=compat (separate from the HTTP result)
  NOT proven here             : the browser half (a page's rpc.call after __DSH_BOOT__ assembly),
                                a real profile / real GUI, and the public registration entry point.
  AT                          : none executed; acceptance.csv untouched; every AT remains 待执行.

  assertions: 17/17 passed (required groups failed: 0)
  exit code:  0 (all assertions passed)
  raw transcript: .probe-out-scaffold/rpc-roundtrip/roundtrip-probe.log
  run report:     .probe-out-scaffold/rpc-roundtrip/roundtrip-probe.json
  isolated home removed (pass --keep to inspect it)
ROUNDTRIP EXIT=0
```

**门禁结论**：typecheck EXIT=0 / build EXIT=0 / 用例 **252**（core 66 / plugin 106 / plugin-client 80，与基线一致，本档未改产品代码）/ verify 11/11 EXIT=0 / probe 5/5 EXIT=0（`path=compat`）/ check_docs EXIT=0（59 md）；新增工具 **17/17 EXIT=0**。本档运行该工具共 3 次（端口 10754 / 1572 / 10306），每次均 17/17 且端口由系统分配。

### 14.6 与规格/任务书的字面不一致，或实施中必须说明的点

| # | 字面要求 / 既有描述 | 实施事实 | 说明 |
| --- | --- | --- | --- |
| ① | ADR-005「本会话无法做真实网络往返（那需要写 profile 并重启进程）」 | 隔离宿主本身就是真实 HTTP 服务，无需写 profile/重启即可在其上做真实往返 | 这是**隔离宿主**上的往返，不是用户真实 profile/GUI；ADR 状态因此不变，本档只在 ADR 追加证据节。 |
| ② | 任务书「方法不是 POST 或 endpoint 不存在 → 期望 404」 | 非 POST → **404**；路径无法解析出 endpoint（`/aikanban`、`/aikanban/`、`/aikanban/a//b`）→ **404**；但「端点名不在 5 端点内」（`/aikanban/does-not-exist`）→ **HTTP 200 + `error.code='unknown-endpoint'`** | 后者是 handler 自己返回的契约失败（8 码之一），不是路由 404。两条都实测并分列在 §14.3（FEN-4/FEN-5 与 CON-1），没有把 200 写成 404。 |
| ③ | 任务书「content-type 不是 application/json → 期望 415」 | 必须**带合法 cookie** 才观察到 415；不带 cookie 时围栏先返回 401 | 宿主 `register()` 路由先跑 `requestRejection`（Host/Origin/token）再进 fetch handler；FEN-3 因此带 cookie，另在 FEN-1 单独验证无 cookie=401。 |
| ④ | 探针第 5 项只证明「宿主进程内注册发生」，且 `path=compat` | 本档用真实 HTTP 证明 `POST /aikanban/project/list`、`/board/read` 通 | 两件事分开写：`path=compat` 是进程内诊断事实；HTTP 200/信封/快照是 carrier 事实。**都不等于公开 `rpc.handle` 入口可用。** |
| ⑤ | 任务书「如果隔离 home 里没有任何 workspace…允许在探针设施里创建 workspace」 | 隔离 home 的 workspace 由 `prepare.mjs` 直接写 durable storage unit（两条真实记录），产品 `workspaceRegistry` 正常读取；`board/read` 内的 `registerProject` 由适配层自动触发 | 未改产品代码、未新增端点；但这不等于「产品自己的 workspace 创建入口被验证」。 |
| ⑥ | 任务书「不改 ADR-005 状态」 | ADR-005 头部状态仍「提议」；只追加「证据（2026-10-22）」节 | 部分「尚未验证」项（真实网络跳转、页面 token 取得）仍未被本档关闭。 |

### 14.7 剩余未确认项（本档未取证，不得写成结论）

- **浏览器半**：页面经 `window.__DSH_BOOT__` 装配后由 `ctx.connection.rpc.call` 发出的真实往返。本档脚本发送的是同一 wire（同 URL、同信封），但不执行浏览器半代码。
- **真实 profile / 真实 GUI / 真实页面渲染**：本档明令不做；未安装 profile、未重启 GUI、未写 `~/.dsh/profiles/desktop`。
- **公开注册入口 `ctx.connection.rpc.handle`**：仍走兼容路径（`path=compat`）；本档没有证明公开入口可用，也不把 `path=compat` 写成「公开入口已成立」。
- **写端点经真实 HTTP**：`task/status.set`、`task/reorder`、`task/status.undo` 未在本档实发；`board/read` 的 `tasks` 为空（隔离 core 全新）。
- **有任务/多任务时看板内容的正确性**：需要写路径与真实数据，本档范围外。
- **`details` 跨通道稳健性、取消语义**：沿用 ADR-005「尚未验证」一节。
- **AT 全部「待执行」**：本档证据不是任何 AT 的验收，`acceptance.csv` 未动。

### 14.8 结论与下一档前置

1. **真实 HTTP 往返成立**（限定层：隔离宿主 + 本脚本发起 + 真实 carrier 鉴权/围栏/路由 + 真实适配层与 core；`project/list`、`board/read` 均观察到合法信封与快照）。
2. **[ADR-005](decisions/ADR-005-浏览器半与宿主半的数据通道.md) 状态仍「提议」**：本档在其后追加「证据（2026-10-22）」节，不改状态、不把隔离宿主结果升级成真实 profile 结论。
3. **关闭 ADR-005 的必要条件仍是 P6**：在真实 profile/GUI 中观察同一条 wire（`POST /aikanban/project/list` 200 + 信封；显式选择后 `board/read` 200 + 快照），并重新观察 `path`（宿主升级可能改变注册路径）。
4. **回归价值**：新工具可在任何宿主升级后重跑——它同时检查 carrier（401/403/415/404）、信封契约（`rpcId` 回显/`result` 形状）、5 端点契约与 `unknown-endpoint`/`unknown-project` 失败形状；产物在 `.probe-out-scaffold/rpc-roundtrip/`（gitignored）。

### 14.9 记录追加后的文档门禁

本记录追加只改 `docs/engineering/s1-wiring-implementation.md` 与 `docs/engineering/decisions/ADR-005-浏览器半与宿主半的数据通道.md`（均为既有文件，未新增 md 文件数）；追加后复跑 `python docs/tools/check_docs.py`：`PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.`（四项 PASS + `EXIT=0`；文档完整性，不涉及应用/产品验收）。

## 15. P6b 安装剧本（待用户授权执行）

> **本剧本尚未执行，也不由本档执行。** 本档只做安装前准备与「页面内自检」工具：`~/.dsh/profiles/desktop` **未被写入**、GUI **未被重启**、当前会话**未被中断**、没有任何插件被安装到用户 profile。
>
> **本剧本由用户明确授权后才执行；执行会重启 GUI，并中断当前正在运行的会话。**

### 15.1 前置检查（全部只读）

```powershell
$NODE   = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM   = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$repo   = "D:\BaiduSyncdisk\dsh-plugin\AIKanBan"
$home   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $home 'profiles\desktop'   # 本机 = C:\Users\InformationDS\.dsh\profiles\desktop

# 1. profile 现状（只读）
Get-Content "$profileDir\package.json"          # dsh.profile.bundles 列表 + dependencies
Get-Content "$profileDir\cordis.patch.yml"      # 用户 patch 层
Get-ChildItem "$profileDir" -Name

# 2. 插件当前「未安装」的确认方法：三个位置都不应出现 aikanban
Test-Path "$profileDir\node_modules\@aikanban\dsh-aikanban"                 # 期望 False
Select-String -Path "$profileDir\package.json" -Pattern 'aikanban'          # 期望无输出（bundles/dependencies 都没有）
Select-String -Path "$profileDir\cordis.patch.yml" -Pattern 'aikanban'      # 期望无输出（没有 insert 条目）
Select-String -Path "$profileDir\cordis.yml" -Pattern 'aikanban'            # 期望无输出

# 3. 在「要安装的那份 checkout」里构建，并核对载荷（见 15.2 的 exit 3/4/5）
& $NODE $PNPM -C $repo run build
$payload = @('package.json', 'README.md', 'cordis.patch.yml', 'lib', 'dist')
foreach ($entry in $payload) { Test-Path (Join-Path "$repo\packages\plugin" $entry) }  # 期望全 True
Test-Path "$repo\packages\plugin\lib\index.js"    # 宿主半构建产物（脚本 exit 4 显式检查）
Test-Path "$repo\packages\plugin\lib\client.js"   # 浏览器半构建产物（脚本不单查，装前自查）

# 4. 安全预演：只打印解析出的绝对路径与载荷，什么都不写
& $NODE "$repo\tools\sync-to-profile.mjs" --dry-run

# 5. 仓库干净、门禁在本次安装前已通过（失败可归因到安装，而不是代码）
git -C $repo status --short --branch
```

**本档观察到的现状（2026-10-22，只读检查；未做任何修改）**：

| 位置 | 观察值 | 结论 |
| --- | --- | --- |
| `profiles/desktop/package.json` | `dependencies: {}`；`dsh.profile.bundles` 为 10 个官方 bundle（base/web-app/experimental…），**无** `@aikanban/dsh-aikanban` | 未安装 |
| `profiles/desktop/cordis.patch.yml` | 只有 `ui-settings-account`、`ui-chat`、`ui-settings`、`agent-default-model`、`cot-translation`、`llm-pi-ai`、`plugin-market`、`ui-theme` 等配置覆盖，**无** `insert: aikanban` | 未安装 |
| `profiles/desktop/node_modules/@aikanban` | 不存在 | 未安装 |
| `profiles/desktop` 目录 | `node_modules`、`cordis.patch.yml`、`cordis.yml`、`package.json`、`pnpm-workspace.yaml` | 由 Electron 独占管理 |
| `packages/plugin/lib/`（主仓库工作树） | 本档未在主仓库构建；构建发生在盘外沙盒 `C:\Users\InformationDS\aikanban-p6b` | 安装前需在**要安装的那份 checkout** 里重新 `pnpm run build` |

### 15.2 安装方式与**实际会写入的路径**（读 `tools/sync-to-profile.mjs` 得出，不是猜）

**脚本本身**（`node tools/sync-to-profile.mjs`，默认 `--profile desktop`、`--mode link`）执行时只写两处：

1. **工作区内暂存目录**：`<repo>/.probe-out-scaffold/sync-desktop/@aikanban/dsh-aikanban/`
   —— 把 `packages/plugin` 的载荷（`PAYLOAD = ['package.json','README.md','cordis.patch.yml','lib','dist']`）完整复制一份，供安装前肉眼检查。该目录在 `.gitignore` 覆盖的 `.probe-out-scaffold/` 下，**不属于产品**，可随时删除。
2. **profile 内安装点**：`<profile>\node_modules\@aikanban\dsh-aikanban`
   —— `link` 模式建成 **junction**，指向 `<repo>\packages\plugin`（绝对路径）；`copy` 模式则把上述载荷复制到该目录（冻结快照）。
   —— 若该路径已存在且**不是** junction，**link 模式**下脚本会拒绝覆盖（exit 5），不会删真实目录。

**脚本不做**：不改 `<profile>\cordis.patch.yml`、不改 `<profile>\package.json`、不重启任何进程、不运行 `dsh plugin add`。

**脚本的退出码（读 `tools/sync-to-profile.mjs` 代码，不猜）**：`0` 成功；`2` 参数错误；`3` `<profile>\package.json` 不存在（拒绝隐式创建 profile，`:197-205`）；`4` 载荷缺失（`PAYLOAD` 五项）或 `lib/index.js` 缺失（`:207-216`；注意它**不单独检查** `lib/client.js`）；`5` **link 模式**下安装点已存在且不是 junction（`:238-248`；`copy` 模式则会删除并重建该目录，`:253-258`）。

**让插件成为 profile 的一个层**（由用户执行）：

> ⚠️ `tools/sync-to-profile.mjs` 会打印 `dsh plugin --profile desktop add "<repo>\packages\plugin"` 作为「官方流程」，但**该命令对 desktop 不可用**：CLI 对 Electron 独占 profile 有统一拒绝（本机 `@deepseek-ai/dsh/lib/bin.js` 的 `rejectElectronProfile`，`--profile` 启动参数与 `plugin` 子命令都会走到它，见该文件 `:28-29`、`:92`、`:109`），实测报 `error: profile "desktop" is managed exclusively by the Electron application`。因此 desktop 只能走**手工路径**；脚本打印的官方流程只适用于非 Electron profile（如 `web`）。

手工路径（**推荐 A**。A 是 `tools/probe-host.mjs` 在隔离 profile 上验证过的同一形状：junction + patch insert → 宿主发布 `window.__DSH_BOOT__` 行并激活）：

A. 把下面条目追加到 `<profile>\cordis.patch.yml`（包名由 15.2 已建好的 junction 解析）：

```yaml
- insert:
    - id: aikanban
      name: '@aikanban/dsh-aikanban'
```

B. 或把包名加进 `<profile>\package.json` 的 `dsh.profile.bundles` 数组。**注意**：这一条依赖 profile 内 pnpm 依赖解析（`dependencies` 也要能解析到该包），本档未验证；若选 B，需自行确认解析失败时 loader 会显式报错而不是静默跳过。

**若改用 `dsh plugin … add`（仅非 desktop profile，如 `web`）**：按脚本注释，它会在 profile 内转发给 pnpm 并追加 `dsh.profile.bundles`，因此会在该 profile 内写 `node_modules/` 与 `package.json`（可能还有该 profile 的锁文件，以实际输出为准）。**任何路径执行前都先备份**：

```powershell
$backup = Join-Path $env:USERPROFILE ("profile-desktop-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item "$profileDir\package.json"       "$backup\package.json"
Copy-Item "$profileDir\cordis.patch.yml"   "$backup\cordis.patch.yml"
Copy-Item "$profileDir\cordis.yml"         "$backup\cordis.yml"
Copy-Item "$profileDir\pnpm-workspace.yaml" "$backup\pnpm-workspace.yaml"
Get-ChildItem "$profileDir" -Filter '*lock*' -File -ErrorAction SilentlyContinue | Copy-Item -Destination $backup
```

**重启**：`profiles/desktop` 由 Electron 应用独占，新 bundle 层只在进程启动时组合，**必须关闭并重新启动 GUI**（CLI 对 desktop 的 `--dump-config` 会被拒绝：`profile "desktop" is managed exclusively by the Electron application`）。重启会中断当前会话，必须由用户在场执行。

### 15.3 回滚（完整撤销清单，按顺序）

1. **恢复 profile 清单**（最稳）：用 15.2 的备份覆盖回 `<profile>\package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` 及可能生成的锁文件。
   —— 若不用整份恢复，至少删掉两处：`package.json` 的 `dependencies` 里 `@aikanban/dsh-aikanban` 条目，与 `dsh.profile.bundles` 里的同名条目。
2. **删安装点**：`<profile>\node_modules\@aikanban\dsh-aikanban`。
   —— 若它是 junction（link 模式）：只删链接，**不要**递归进入目标；用 `cmd /c rmdir "<路径>"`，随后若 `@aikanban` 目录已空再删该空目录。
   —— 若是真实目录（copy 模式）：`Remove-Item -Recurse -Force` 只作用于 profile 内副本。
   —— **永远不要**对 junction 目标 `<repo>\packages\plugin` 执行删除。
3. **删手工 patch 条目**：若曾按 15.2 手工往 `cordis.patch.yml` 追加 `insert: aikanban`，删掉该块（或用备份恢复）。
4. **删暂存目录**（可选，工作区内、gitignored）：`<repo>\.probe-out-scaffold\sync-desktop\`。
5. **再次重启 GUI**：回滚与安装一样，只有重启才会让 loader 重新组合、真正卸载该 bundle 层。
6. **回滚后确认**：重跑 15.1 的第 2 组命令（三处都不应再出现 aikanban）；页面 Console 里 `window.__DSH_BOOT__.entries.map(e => e.id)` 不应包含 `@aikanban/dsh-aikanban`；应用内工具列表不应再有 `aikanban_status`。

### 15.4 重启后的验证顺序

**第一步（页面内证据，P6b）：在 GUI 页面里跑 [`tools/browser-check.js`](../../tools/browser-check.js)** —— F12 → Console → 整段粘贴。期望：

- `B1 PASS`：`window.__DSH_BOOT__` 出现 `@aikanban/dsh-aikanban` 行（打印 `entry`/`rev`；`rev` 优先取 boot 行的 `row.rev`）；
- `B2 PASS`：页面内 `POST /aikanban/project/list` → HTTP 200 + 合法信封 + `result.ok=true` + 候选集；本机预期非空，但**空集也是合法答案**（脚本不把它判失败，只是 B3 无项目可读而 `NOT-RUN`）；
- `B3 PASS`：用 B2 的 `projectId` 调 `board/read` → 200 + 快照字段（`project`/`tasks`/`columns`/`boardToken`/`capabilities`）；
- `B4 PASS`：页面 DOM 命中 `[data-aikanban-panel="aikanban"]` 等面板标记；若面板还没打开，脚本报 `NOT-MOUNTED`（「面板未渲染」，**不算失败**）——打开侧栏 AIKanBan 面板后重跑即可；
- 末行 `BROWSER-CHECK RESULT: PASS`。
- 若 `B2` 读到 `unavailable`：数据层服务晚绑定，等几秒重跑（脚本自身对 `unavailable` 有 10×500ms 轮询并如实打印尝试次数）。
- 若 `B1 FAIL`：bundle 层没有生效（安装/重启问题），**不要**继续下结论。

**第二步（回归证据）：`& $NODE "$repo\tools\verify-rpc-roundtrip.mjs"`** ——「若适用」：它需要 `packages/plugin/lib/index.js` 与可定位的 `dsh` CLI（`DSH_CLI` 可覆盖）。它启动的是**隔离宿主**（自己的 `DSH_HOME`、`--port 0`、`--no-open`），**不读取也不使用 desktop profile**；作用是在安装后的同一份构建上复证 carrier/信封（期望 17/17、exit 0），与第一步互补，不能互相替代。

**补充观察（可选）**：应用内工具列表出现 `aikanban_status`；宿主日志 `[aikanban] active`；`& $NODE "$repo\tools\probe-host.mjs"` 5/5 且打印 `path=public|compat`（宿主升级后这个字段会变，安装/回滚结论要带上它）。记录端口时从实际输出读取，**不要写死**。

### 15.5 风险与已知限制

1. **DSH 44.7.0 的 `rpc.handle` 缺陷 → 走 compat**：公开 `ctx.connection.rpc.handle` 在本插件形态下抛错，兼容层改走宿主内部 `register(owner=注入子上下文, …)`（见 [ADR-005「宿主缺陷与兼容层」](decisions/ADR-005-浏览器半与宿主半的数据通道.md)）。安装后预期 `path=compat`；宿主升级后若兼容分支失效会以 `path=failed` + 探针第 5 项 FAIL 显式暴露，不会静默成功。
2. **服务晚绑定 → 首次列表可能 `unavailable`**：数据层未就绪时 `project/list` 返回 `unavailable`；browser-check 会轮询并打印尝试次数，UI 侧是可见失败 + 重试（REC-05），不要把它当成「空看板」。
3. **真实 Workspace 字段形状未验证**：现有证据的 workspace 来自探针设施写入隔离 home 的 durable 记录；产品自己的 Workspace 创建入口（GUI/宿主 API）未经过。真实 profile 里 `project/list` 读的是宿主 `workspaceRegistry`，`board/read` 的 project 登记由适配层在同一请求内触发——若真实字段形状不同，可能表现为 `unknown-project`/`read-failed`；以 browser-check 的 `actual` 为准记录，不猜测。
4. **重启即中断**：安装和回滚都要重启 GUI；执行会中断当前会话。需要用户在场，agent 不得自行重启或结束 Electron 进程。
5. **junction 的耦合**：link 模式让 profile 直接指向 `<repo>\packages\plugin`；仓库移动/删除、或换 worktree，都会让 profile 失效；反过来，`pnpm run build` 会立刻改变 profile 内行为（无需再 sync）。copy 模式是冻结快照，但没有这个热更新。
6. **`dsh plugin add` 对 desktop 会被拒，且会在 profile 内跑 pnpm**：desktop 由 Electron 独占，CLI 的 `plugin` 子命令与 `--dump-config` 一样直接报错（见 15.2，本机已实测后者、代码同源检查前者）；对 `profiles/web` 等其他 profile，该命令会在 profile 内转发给 pnpm——尤其不要手跑裸 `pnpm install`（web 的 `package.json` 有失效的 `file:` 依赖）。执行任何 profile 写入前先备份清单，并以实际输出为准。
7. **desktop 由 Electron 独占**：CLI 的 `--dump-config` 与 `plugin` 子命令都会被拒绝，验证必须在应用内做；不要用 CLI 参数假设 profile 状态。
8. **不是验收证据，也不等于 `rpc.call` 证据**：browser-check 证明的是「真实页面会话 + 页面 cookie + 同一 URL/信封」的 200 + 合法信封；它**直接调用页面 `fetch`**，不证明客户端半 `ctx.connection.rpc.call` 适配器执行过（脚本头部已写明）。ADR-005「页面内 `rpc.call` 未观察」一项的关闭条件是**客户端半自身请求的证据**——例如 DevTools → Network 过滤 `/aikanban/`，由面板的「选择项目 / 读取看板」操作触发请求并看到 200；或面板实际加载到真实数据的可观察链路。本剧本不据此翻转 ADR 状态。安装/自检 PASS 也不代表任何 AT 通过：`acceptance.csv` 保持不动、全部 AT 仍「待执行」。

### 15.6 本档门禁原始输出（2026-10-22，盘外沙盒 `C:\Users\InformationDS\aikanban-p6b`）

运行于提交前的工作树（内容 = `5809c8c` + 本档改动；产品代码零改动，故代码门禁与基线一致）。端口一律由系统分配；输出中的 token 已脱敏。

```powershell
$NODE = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
Set-Location C:\Users\InformationDS\aikanban-p6b
& $NODE $PNPM install --frozen-lockfile
& $NODE $PNPM run typecheck
& $NODE $PNPM run build
& $NODE $PNPM -r --if-present run test
& $NODE $PNPM run verify
& $NODE tools\probe-host.mjs
& $NODE tools\verify-rpc-roundtrip.mjs
python docs\tools\check_docs.py
# 新增工具的语法与 stub 自测（不启动浏览器；stub 工装为临时文件，未提交）
& $NODE --check tools\browser-check.js
& $NODE .\.tmp-browser-check-selftest.mjs
```

**① typecheck / install**

```text
Scope: all 4 workspace projects
✓ Lockfile passes supply-chain policies (verified 1d ago)
Lockfile is up to date, resolution step is skipped
Packages: +89
Done in 2s using pnpm v11.7.0

$ tsc -b
TYPECHECK EXIT=0
```

**② build**

```text
$ tsc -b && pnpm -C packages/plugin run build:bundle
$ tsdown -c tsdown.config.ts && tsdown -c tsdown.client.config.ts
ℹ [@aikanban/dsh-aikanban] lib\index.js      182.58 kB │ gzip: 45.26 kB
ℹ [@aikanban/dsh-aikanban] 2 files, total: 587.60 kB
✔ [@aikanban/dsh-aikanban] Build complete in 144ms
ℹ [@aikanban/dsh-aikanban/client] lib\client.js  34.54 kB │ gzip: 10.39 kB
✔ [@aikanban/dsh-aikanban/client] Build complete in 49ms
BUILD EXIT=0
```

**③ 用例 252（66 / 106 / 80）**

```text
packages/plugin-client test:  ✓ test/model.test.ts (20 tests)
packages/plugin-client test:  ✓ test/wire.test.ts (12 tests)
packages/plugin-client test:  ✓ test/controller.test.ts (35 tests)
packages/plugin-client test:  ✓ test/board.test.ts (6 tests)
packages/plugin-client test:  ✓ test/slots.test.ts (7 tests)
packages/plugin-client test:  Test Files  5 passed (5)
packages/plugin-client test:       Tests  80 passed (80)

packages/core test:  Test Files  11 passed (11)
packages/core test:       Tests  66 passed (66)

packages/plugin test:  ✓ test/client-bundle.test.ts (7 tests)
packages/plugin test:  ✓ test/channel-roundtrip.test.ts (19 tests)
packages/plugin test:  ✓ test/board-adapter.test.ts (46 tests)
packages/plugin test:  ✓ test/host.test.ts (34 tests)
packages/plugin test:  Test Files  4 passed (4)
packages/plugin test:       Tests  106 passed (106)

TEST EXIT=0    # 合计 252 = 66 + 106 + 80，与基线一致
```

**④ verify 11/11**

```text
Host-half import verification — packages/plugin

  PASS  package.json exists                                   packages\plugin\package.json
  PASS  manifest declares type: module                        module
  PASS  manifest declares a main entry                        ./lib/index.js
  PASS  host entry is built                                   packages\plugin\lib\index.js (178.3 KB)
  PASS  host entry is ESM, not a browser-half bundle          no __ModuleLoader__ banner; ESM statements present
  PASS  import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins
  PASS  module graph is fully present on disk                 1 file(s) reachable
  PASS  exports apply() for the loader to call                function apply(ctx)
  PASS  exports an inject array (cordis activation gate)      []
  PASS  apply() activates against a service-less context      activation=mvi7t1to-1 pid=44940
  PASS  diagnostic tool is exported and callable              aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, activation mvi7t1to-1, pid 44940, services seen: none)

OK
VERIFY EXIT=0
```

**⑤ probe 5/5**

```text
[3/5] booting the probe host; reading its window.__DSH_BOOT__ graph
  ok    host settled and bound: dsh web: http://127.0.0.1:12329/?token=<redacted>
  PASS  browser row published: /plugins/??@aikanban/dsh-aikanban/client.js&rev=c91d1dcd59582b8c-44
        served 200 32704B: window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…
[4/5] waiting for the activation signal from inside the host
  PASS  the booting host published aikanban:activation:
        activation=mvi7t7m6-1 pid=43120 tools=false systemPrompt=false
[5/5] waiting for the /aikanban board channel registration from inside the host
  PASS  the booting host registered the board channel:
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

summary
  PASS  composed tree contains the aikanban row
  PASS  host half resolves from the profile and apply() activates
        packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mvi7t2cw-1
  PASS  host publishes a window.__DSH_BOOT__ row and serves client.js
        entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=c91d1dcd59582b8c-44 status=200 bytes=32704
  PASS  apply() ran inside the booting host
        activation=mvi7t7m6-1 pid=43120 tools=false systemPrompt=false
  PASS  host half registered /aikanban inside the booting host
        channel=/aikanban registered=true path=compat reason=null dataLayerReady=true

PROBE OK — the bundle composed, resolved from the profile, activated, and published a browser row.
PROBE EXIT=0
```

**⑥ roundtrip 17/17（端口由系统分配：本次 12346）**

```text
AIKanBan real-HTTP RPC roundtrip verification

  isolated home    C:\Users\InformationDS\aikanban-p6b\.probe-home-scaffold\rpc-roundtrip
  port             0 (OS-assigned — never hardcode a GUI port)
  channel          /aikanban (5 endpoints: board/read, project/list, task/status.set, task/reorder, task/status.undo)
  failure codes    8 (unchanged): unknown-endpoint, invalid-payload, invalid-reason, read-failed, not-found, save-failed, stale-baseline, unknown-result

prepared isolated home; workspace fixture: 2 workspace(s)

[1/6] booting the isolated host (own DSH_HOME, --port 0, --no-open)
  ok    isolated host settled and bound: dsh web: http://127.0.0.1:12346/?token=<redacted>
  ok    request origin (OS-assigned): http://127.0.0.1:12346
[2/6] exchanging the launch token for the signed session cookie
[3/6] positive: POST /aikanban/project/list over real HTTP
[4/6] positive: POST /aikanban/board/read over real HTTP
[5/6] negative: carrier fence and authentication
[6/6] supplementary: contract-level failures over real HTTP (not fence evidence)

[setup / authentication]
  PASS  AUTH-1 HTTP  303  launch token → signed session cookie exchange
  PASS  AUTH-2 HTTP  200  the exchanged cookie authenticates the app shell
        actual:   200 (27899B, __DSH_BOOT__ present: true)

[positive: real HTTP RPC roundtrip]
  PASS  POS-1  HTTP  200  project/list answers HTTP 200 (after data-layer readiness, if needed)
        actual:   HTTP 200 after 1 attempt(s)
  PASS  POS-2  HTTP  200  project/list response is a valid RPC envelope (type/rpcId echo/result.ok)
        actual:   type=server-response rpcId-echo=true result.ok=true
  PASS  POS-3  HTTP  200  project/list value carries the candidate set from the host workspaceRegistry
        actual:   2 projects: 03696d17…(AIKanBan), 455306c1…(dsh-plugin（旧）)
  PASS  POS-4  HTTP  200  board/read answers HTTP 200
        actual:   HTTP 200 for projectId=03696d17-12c2-4d78-9b3e-ff3bdf9e6f10
  PASS  POS-5  HTTP  200  board/read response is a valid RPC envelope (type/rpcId echo/result.ok)
        actual:   type=server-response rpcId-echo=true result.ok=true
  PASS  POS-6  HTTP  200  board/read value is a board snapshot for the explicitly selected project
        actual:   project=03696d17-12c2-4d78-9b3e-ff3bdf9e6f10 tasks=0 columns=[todo:未开始, doing:进行中, blocked:已阻塞, done:已完成, cancelled:已取消] boardToken=e06486e0cf66… capabilities={"statusChange":true,"reorder":true,"undo":true}

[negative: carrier fence and authentication]
  PASS  FEN-1  HTTP  401  no session cookie → 401
        actual:   HTTP 401 body="unauthorized"
  PASS  FEN-2  HTTP  403  valid cookie but cross-site Origin → 403
        actual:   HTTP 403 body="forbidden"
  PASS  FEN-3  HTTP  415  cookie valid but content-type is not application/json → 415
        actual:   HTTP 415 body="content type must be application/json"
  PASS  FEN-4  HTTP  404  non-POST method (GET) → 404
        actual:   HTTP 404 body="not found"
  PASS  FEN-5  HTTP  404  POST without an endpoint segment (path /aikanban) → 404
        actual:   HTTP 404 body="not found"
  PASS  FEN-6  HTTP  403  cookie valid but Host names a non-loopback authority → 403
        actual:   HTTP 403 body="forbidden"
  PASS  FEN-7  HTTP  200  control: the same cookie still succeeds after the negative batch
        actual:   HTTP 200 result.ok=true

[supplementary: contract-level failures over real HTTP]
  PASS  CON-1  HTTP  200  endpoint outside the five-endpoint contract returns a failure envelope, not a throw
        actual:   HTTP 200 code="unknown-endpoint"
  PASS  CON-2  HTTP  200  board/read for an unregistered projectId returns a failure envelope, not an empty board
        actual:   HTTP 200 code="unknown-project"

[process-internal registration evidence — diagnostics channel, NOT HTTP]
  observed      aikanban:board-channel channel=/aikanban registered=true path=compat
  dataLayer     dataLayerReady=true (from the last aikanban:activation payload)

[verdict]
  assertions: 17/17 passed (required groups failed: 0)
  exit code:  0 (all assertions passed)
ROUNDTRIP EXIT=0
```

**⑦ check_docs**

```text
PASS: 59 Markdown files; 20 PRDs; 48 common rules; 143 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs + 27 additions, all fully indexed by section 6.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.
Scope: document integrity only. Application and product acceptance have not run.
CHECK_DOCS EXIT=0
```

**⑧ 新增工具的语法与 stub 自测（不启动浏览器、不碰 profile；stub 工装是复核用临时文件，用完即删、未提交，避免把测试工装混进 `tools/` 的产品工具集）**

```text
$ node --check tools\browser-check.js
NODE_CHECK EXIT=0

### happy
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 4/4
### pre-install
  last:  BROWSER-CHECK RESULT: FAIL
  pass:  [browser-check]   PASS 0/4
### empty-set
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 2/4
### malformed-snapshot
  last:  BROWSER-CHECK RESULT: FAIL
  pass:  [browser-check]   PASS 3/4
### late-bind
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 4/4
### redaction
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 4/4
### boot-row-rev
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 4/4
### envelope-negative
  last:  BROWSER-CHECK RESULT: FAIL
  pass:  [browser-check]   PASS 1/4
### http-500
  last:  BROWSER-CHECK RESULT: FAIL
  pass:  [browser-check]   PASS 1/4
### body-text-false-positive
  last:  BROWSER-CHECK RESULT: PASS
  pass:  [browser-check]   PASS 3/4

SELFTEST OK — 10 cases
SELFTEST EXIT=0
```

> stub 自测的「FAIL」是**预期**：pre-install（插件未安装）、malformed-snapshot（快照不合 `wire.ts`）、envelope-negative（type/rpcId/value 不合法）、http-500 四组故意构造失败；`body-text-false-positive` 证明「对话正文里出现『已完成/进行中』等列标签」不会被误判成面板已渲染。它证明脚本能区分「通过 / 失败 / 未渲染」并保留 B3 的 `boardToken`/`capabilities` 输出（回归 `redact` 过宽 + 末行格式 + `row.rev`），不证明真实页面里的结果——真实页面结果只能由 15.4 的页面内粘贴跑出。

### 15.7 授权边界（写死）

- 本剧本**由用户授权后才执行**，且执行会**重启 GUI、中断当前会话**。
- 未获授权时：不写 `~/.dsh/profiles/desktop`（含 junction）、不运行非 `--dry-run` 的 `tools/sync-to-profile.mjs`、不执行 `dsh plugin … add`、不重启/结束 Electron、不 kill 端口进程。
- 本档（P6b 准备）的自证范围到此为止：新增 [`tools/browser-check.js`](../../tools/browser-check.js)（已在 Node stub 环境跑过 10 组用例，覆盖 happy path / 未安装 / 合法空集 / 畸形快照 / `unavailable` 重试 / token 脱敏 / boot `row.rev` / 信封负例 / HTTP 500 / 正文列标签假阳性），追加本节与 ADR-005「尚未验证」收窄；**不含任何安装动作**。
