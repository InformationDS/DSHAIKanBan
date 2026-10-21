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
