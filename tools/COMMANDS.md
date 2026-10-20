> 复原说明：本页为 2026-10-14 S0 记录的原文复原（来源提交 bd16535）。2026-10-19 已在 DSH 44.7.0 上做部分复核，结论见 [S0 复核记录](../docs/engineering/s0-reverification-20261019.md)；未复核部分仍是「提议」，不得当作已验证。

# AIKanBan 运行命令与目录说明（供根 README 收口）

> 本片段的每一条命令都在本会话中**实际执行过**，输出见每条的「实测」行。
> Lead 可直接摘录进根 README；本文件不修改根 README。

## 0. 环境前提

本仓库没有 PATH 上的 `node`/`pnpm`，用 DSH 自带运行时；下文的 `$NODE` / `$PNPM` 指向：

```powershell
$NODE = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
```

装了全局 `pnpm` 的机器上，把 `& $NODE $PNPM` 直接换成 `pnpm` 即可，参数完全一致。

## 1. 目录结构

```
AIKanBan/
  package.json            工作区根：脚本入口（build / typecheck / test / verify / probe / sync / clean）
  pnpm-workspace.yaml     packages/* 工作区 + nodeLinker: hoisted + supportedArchitectures(win32-x64) + allowBuilds(esbuild)
  .npmrc                  store-dir / cache-dir / state-dir 全部指向工作区内（避免写用户目录需要越权）
  tsconfig.json           解决方案文件，仅引用 plugin-client → plugin（不引用 core，见 §6）
  tsconfig.base.json      共享编译选项（strict / noUncheckedIndexedAccess / exactOptionalPropertyTypes / composite）
  vitest.config.ts        各包继承的根 Vitest 配置
  packages/
    plugin/               ★ DSH 可寻址包 @aikanban/dsh-aikanban（唯一声明 dsh.bundle / dsh.client 的包）
      package.json          main=lib/index.js；exports["./client"]=lib/client.js；dsh.client.platform=web
      cordis.patch.yml      bundle 层：insert id=aikanban
      src/index.ts          host 半（cordis 插件；零运行时依赖，只用 node: 内置模块）
      src/client.tsx        浏览器半的 loader 入口（把 plugin-client 再导出，保证只注册一个 factory）
      test/host.test.ts     19 个用例：激活、幂等注册、延迟服务、诊断工具、schema 子集、激活信号
      test/client-bundle.test.ts  7 个用例：直接执行构建产物，验证 loader 协议与两个座位
      tsdown.config.ts      host 半 → lib/index.js（ESM, node22）
      tsdown.client.config.ts  client 半 → lib/client.js（CJS factory + __ModuleLoader__ 外壳, browser）
    plugin-client/        浏览器半 UI 库（不单独打包；被 plugin 的 client bundle 内联）
      src/index.tsx         main 面板体 + sidebar.panellist 图标 + registerSlots/apply
      test/slots.test.ts    7 个用例：座位形状、禁用座位、disposer
    core/                  ★ 由 S0-W2 拥有（数据模型 / storageDomain / ADR-002），本任务只预留引用
  tools/
    verify-host-import.mjs 无宿主依赖的导入链验证（元数据、ESM 形态、bare specifier 扫描、apply 激活）
    probe-host.mjs         隔离宿主加载探针（DSH_HOME=<工作区>/.probe-home，--port 0，四道检查）
    sync-to-profile.mjs    参数化的 profile 同步（默认 desktop，--profile web；只打印越权步骤，不执行）
    clean.mjs              只删本仓库生成的产物，路径先校验在工作区内
  .probe-home-scaffold/   隔离 Harness home，本工具**专用**（gitignore；probe 每次运行前删除重建）
  .probe-out-scaffold/    probe 日志 / 转储 / 同步暂存（gitignore）
  .probe-home/            另一个探针（S0-W3）的隔离 home —— 本工具**不会**碰它
```

## 2. 依赖安装

```powershell
cd D:\BaiduSyncdisk\dsh-plugin\AIKanBan
& $NODE $PNPM install
```

- store/cache/state 都重定向到工作区内（`.npmrc`），因此**不需要**写 `~/.dsh` 或用户级 pnpm 目录。
- `pnpm-workspace.yaml` 固定 `supportedArchitectures: win32/x64`。不固定的话 pnpm 会去拉 esbuild/rollup/rolldown 的全平台二进制（数百 MB）；固定后只装本机需要的。
- 首次安装后若 pnpm 报告 `Ignored build scripts: esbuild`，说明 `allowBuilds` 未生效；本仓库已在 `pnpm-workspace.yaml` 里显式允许 `esbuild`（Vite/Vitest 依赖它的 postinstall 链接平台二进制）。

**实测**：`Scope: all 4 workspace projects / Already up to date / Done in 415ms`（exit 0；补装 react 那次为 `reused 88, downloaded 3, added 2 / Done in 940ms`）

**注意**：`pnpm --filter <包名> run <脚本>` 在这台机器的同步盘上会无限挂起（S0-W2 与本任务各实测一次，>5 分钟无输出；`pnpm -C packages/plugin run build:bundle` 实测 31ms 完成）。因此根 `scripts` 与本文档一律使用 `pnpm -r` / `pnpm -C`，**不要用 `--filter`**。

## 3. 类型检查 / 构建

```powershell
& $NODE $PNPM run typecheck   # tsc -b，按项目引用顺序
& $NODE $PNPM run build       # tsc -b（声明 → dist/）+ tsdown（打包 → lib/）
```

**实测 typecheck**：`$ tsc -b` exit 0
**实测 build**：host 半 `lib\index.js 8.66 kB │ gzip: 3.29 kB`；client 半 `lib\client.js 1.99 kB │ gzip: 0.97 kB`；exit 0

## 4. 测试

```powershell
& $NODE $PNPM -r --if-present run test
```

**实测**：`packages/plugin-client` 7 passed、`packages/plugin` 26 passed、`packages/core` 35 passed（S0-W2 拥有），全绿 exit 0。

`packages/plugin/test/client-bundle.test.ts` 是加载链的关键测试：它**执行构建产物本身**，用假的 `window.__ModuleLoader__.load` 捕获注册，然后 materialize factory 并断言 `apply`/`inject` 与两个座位（`main` keyed + `sidebar.panellist` list）。只编译通过骗不过它。

### 4.1 两个「在真实宿主里才会暴露」的坑（已有回归测试）

1. **工具 output schema 用的是严格子集，不是标准 JSON Schema。** `@deepseek-ai/dsh-tools` 在 register 前跑 `assertSupportedJsonSchema`：每节点只能有**单个** `type` 字符串（禁 `type: ["integer","null"]`）、`required` 只能是**对象级**字符串数组（禁止属性级 `required: true`）、`additionalProperties` 只能是布尔。
   第一次真机启动就是这样整棵 load 失败的：`dsh: fatal load failure: JsonSchemaError: … schema.properties.marker.required is not supported on type "string" …`（本次探针实测抓到）。现在 `host.test.ts` 有 5 条回归断言。
2. **cordis 的 logger 不落 stdout。** 它是「内存环形缓冲 + 注册的 exporter」，本次测到的 profiles 里没有任何插件注册 console exporter，所以 `logger.info`/`warn` 从进程外完全看不见 —— 第一版只用 `logger.info` 打激活标记，探针因此一直「看不到激活」。
   正确的对外可观测面是 `node:diagnostics_channel`：host 半在 `apply()` 末尾 publish 到 `aikanban:activation`（`ACTIVATION_CHANNEL`），探针用 `--require` 预载一个订阅器（走 `NODE_OPTIONS`，不往隔离 home 写任何东西）就能拿到结构化 payload。日志行仍保留，但只是给人看的。

## 5. 加载验证（不需要重启任何东西）

### 5.1 导入链验证（最快，无宿主）

```powershell
& $NODE tools\verify-host-import.mjs
```

**实测**：11 项全 PASS，exit 0。含：`import graph is host-resolvable (no bare specifiers)  1 module(s), only node: builtins`、`apply() activates against a service-less context  activation=mv7hbuv3-1 pid=38576`、`diagnostic tool is exported and callable  aikanban_status → [aikanban] active (plugin @aikanban/dsh-aikanban@0.0.0, …)`。

### 5.2 隔离宿主探针（最强）

```powershell
& $NODE tools\probe-host.mjs --timeout 180
```

因为 `DSH_HOME` 可覆盖 Harness home，探针在**工作区内**建一个完全隔离的宿主（自己的 `profiles/ sessions/ storages/ node_modules/`），**不碰任何已运行的 profile**，并且 `--port 0` 让 OS 分配端口，**绝不会和正在运行的 GUI 抢端口**。注意 GUI 端口每次启动由系统分配、会变（本机先后观察到 19387 / 7420 / 8748），**不要在任何文档或脚本里写死它**。

**实测**（exit 0，四道检查全 PASS）：

| # | 检查 | 实测输出 |
| --- | --- | --- |
| 1 | 组合树含 aikanban 行 | `- id: aikanban | name: '@aikanban/dsh-aikanban'` |
| 2 | 从 profile 目录解析并激活 host 半 | `packages/plugin/package.json → [aikanban] active (host half) plugin=@aikanban/dsh-aikanban version=0.0.0 activation=mv7hb05h-1` |
| 3 | 宿主发布浏览器行并服务 client.js | `entry=/plugins/??@aikanban/dsh-aikanban/client.js&rev=ba9b816410630a95-44 status=200 bytes=2082`，首行 `window.__ModuleLoader__.load({id:`@aikanban/dsh-aikanban`,factory:e=>{var t={exp…` |
| 4 | 运行中的宿主内 `apply()` 真的执行 | `aikanban:activation activation=mv7hb4ct-1 pid=33064 tools=false systemPrompt=false` |

第 4 项是**从宿主进程内部**拿到的（diagnostics channel 订阅器随 `--require` 预载进去），不是从日志猜的。`tools=false / systemPrompt=false` 是正常的：那一刻这两个可选服务还没绑上，host 半靠 `internal/service` 事件补注册 —— 这正是它不做硬 `inject` 的原因。

常用参数：`--dump-only`（只组合、不绑端口）、`--keep`（保留 `.probe-home` 供检查）、`--timeout <秒>`。
若探针提示 `SKIP ... NODE_OPTIONS restricted`，说明宿主环境禁止注入观察器；此时第 4 项**未验证**，探针会单独列在「not observed」里而不会算通过。

## 6. 与 `packages/core`（S0-W2）的接缝

- `packages/core` 有自己的 `tsconfig.json` / `tsconfig.test.json` / `vitest.config.ts`，`pnpm -r --if-present run test` 会自动带上它（实测 35 passed）。
- 根 `tsconfig.json` **故意不引用** `packages/core`：引用一个尚未存在的工程会让所有人的 `tsc -b` 直接失败。该包的 `tsconfig.json` 现已存在，Lead 若要纳入可加一行 `{ "path": "./packages/core" }`。
- `packages/plugin/src/probe/`（S0-W3 的宿主探针，纯 JS + 自己的 `package.json`）也在 `packages/plugin` 下；它不在 `tsconfig` 的 `include` 里（只收 `src/**/*.ts|tsx`），tsdown 也只从 `src/index.ts` / `src/client.tsx` 两个入口打包，所以两者互不干扰。
- `pnpm --filter <name> run <script>` 在这台机器的同步盘上会挂起（S0-W2 与 S0-W1 各实测一次，>5 分钟无输出）；`pnpm -C packages/<dir> run <script>`（实测 31ms）和 `pnpm -r` 都正常。**因此文档与脚本一律使用 `-r` 或 `-C`，不要用 `--filter`。**

## 7. 同步到真实 profile（需要越权，本任务未执行）

```powershell
# 只打印计划，什么都不写（任何沙箱下都安全）
& $NODE tools\sync-to-profile.mjs --dry-run

# 默认目标 profiles/desktop（用户当前 GUI 所在）
& $NODE tools\sync-to-profile.mjs

# 另一个 profile
& $NODE tools\sync-to-profile.mjs --profile web

# 快照式拷贝而不是 junction
& $NODE tools\sync-to-profile.mjs --mode copy
```

脚本行为：解析 home（`--home` > `$DSH_HOME` > `~/.dsh`）→ 打印解析到的**绝对** profile 目录 → 目录不存在则拒绝（exit 3）→ 包未构建则拒绝（exit 4）→ 暂存到 `.probe-out/sync-<profile>/` → 建/更新 junction（`copy` 模式则拷贝）→ 打印需要用户执行的确切步骤。

它**不会**改 `cordis.patch.yml`，也**不会**重启任何进程。生效步骤与影响见 §8。

## 8. 重启生效（需要用户执行）

DSH 的 loader 层在进程启动时组合；新 bundle 层只有重启该 profile 的 DSH 进程才会加载。**本会话绝不自行重启**（会中断用户正在运行的 GUI 会话；端口每次启动分配，本机先后见过 19387 / 7420 / 8748）。

```powershell
# 1) 让新包成为 profile 的一个 bundle 层（官方流程，会自动追加到 dsh.profile.bundles）
dsh plugin --profile desktop add <仓库绝对路径>\packages\plugin

#    注意：该命令会在 profile 目录内转发给 pnpm。
#    对 profiles/web 尤其不要手跑裸 `pnpm install`：它的 package.json 里有失效的 file: 依赖。

# 2) 重启该 profile 的 DSH 进程（profiles/desktop 由 Electron 应用管理）
# 3) 验证（任选）
dsh --profile desktop --dump-config | Select-String aikanban
#    或在应用内调用工具 aikanban_status；或看启动日志里的 [aikanban] active
```

`profiles/desktop` 由 Electron 独占：CLI 对它的 `--dump-config` 会直接报
`profile "desktop" is managed exclusively by the Electron application`（实测），所以上一步的验证要在应用内做，不能靠 CLI。

## 9. 清理

```powershell
& $NODE tools\clean.mjs                    # 删 lib/ dist/ coverage/ .probe-home/ .probe-out/
& $NODE tools\clean.mjs --keep-probe-home  # 保留隔离 home
```

## 10. 本机约定（2026-10-20 追加，不属于 `bd16535` 原文）

> 本节是在回收后重新实测的事实，供后续实现直接用。§0—§9 保持复原原样；与现在不一致的地方由本节指出。

### 10.1 运行时与版本

| 项 | 实际值 | 说明 |
| --- | --- | --- |
| node | `C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，**v24.21.0** | 满足 `engines.node: ^22.19.0 \|\| >=24.0.0`；PATH 上也有同名 node |
| pnpm（**推荐这套**） | 同一 runtime 下的 `pnpm\bin\pnpm.mjs`，**11.7.0** | 与 `packageManager: pnpm@11.7.0` 一致 |
| pnpm（另一处并存） | `D:\dsh\resources\runtime\versions.json` 记 **11.28.5** | 两套都在 11.x，都满足 `>=11.7.0 <12`；**统一用 11.7.0**，避免 lockfile 抖动 |
| dsh CLI（隔离探针需要） | `C:\Users\InformationDS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | `tools/probe-host.mjs` 按 `DSH_CLI` → `%APPDATA%\npm\…` → PATH 查找；找不到会 exit 2 |
| 当前 GUI | **端口每次启动由系统分配，不要写死**（本机先后观察到 19387 / 7420 / 8748） | §5.2 与 §8 写的 `19387` 是 2026-10-14 的记录，已过期；读实际监听端口即可 |
| 当前 DSH 版本 | **44.7.0**（nightly 通道） | S0 复核即在此版本完成，见 [S0 复核记录](../docs/engineering/s0-reverification-20261019.md) |

### 10.2 构建位置：不要在同步盘里装依赖

仓库位于 `D:\BaiduSyncdisk\…`（百度同步盘）。`.npmrc` 把 `store-dir`/`cache-dir`/`state-dir` 都重定向到工作区内，所以**在仓库根直接 `pnpm install` 会把 `node_modules` 与 `.pnpm-store` 写进同步目录**，同步客户端会把这几百 MB 上传；此外这台机器上已知 `pnpm --filter` 在同步盘上会无限挂起。

推荐做法：**在盘外建一个 worktree 当构建沙盒**，仓库自身保持干净。

```powershell
$NODE = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$BOX  = "C:\Users\InformationDS\aikanban-build"     # 放在非同步目录即可

# 首次：从要验证的分支建 worktree 并装依赖
git -C "D:\BaiduSyncdisk\dsh-plugin\AIKanBan" worktree add --detach $BOX s1-recover
Set-Location $BOX
& $NODE $PNPM install --frozen-lockfile

# 之后换提交/分支：只更新工作树，依赖不用重装
git -C $BOX checkout --detach <commit-or-branch>
```

判据：只要 `git status` 里不出现 `node_modules` / `.pnpm-store`，位置就是对的（`.gitignore` 虽然忽略了它们，但同步盘不在乎 gitignore）。

### 10.3 最短上手序列（在沙盒目录里跑）

```powershell
& $NODE $PNPM install --frozen-lockfile
& $NODE $PNPM run typecheck              # 期望 EXIT 0
& $NODE $PNPM run build                  # 期望 EXIT 0；产出 packages/plugin/lib/index.js 与 lib/client.js
& $NODE $PNPM -r --if-present run test   # 期望 164 通过（core 66 / plugin 53 / plugin-client 45）
& $NODE tools\verify-host-import.mjs     # 期望 11/11 PASS
& $NODE tools\probe-host.mjs             # 期望 PROBE OK 5/5（约 40–120 秒）
```

**实测基线（2026-10-20，DSH 44.7.0，提交 `d7d73a6`）**：以上六条全部 `EXIT 0`。用例分布为 `packages/core` **66**（11 个测试文件）、`packages/plugin` **38**（3 个）、`packages/plugin-client` **45**（3 个），合计 **149**；§4 记的 35/26/7 是 2026-10-14 的更早快照，不要再用旧数字。

**更新（2026-10-21，P2/P3 档）**：`packages/plugin` 新增 15 个 host 半接线用例后为 **53**，合计 **164**；探针新增第 5 项 `/aikanban` 注册断言后为 **5/5**。上方 149/4/4 是 2026-10-20 的历史快照，保留原文。

### 10.4 仍然禁止 / 仍然需要人

- **仍然禁止** `pnpm --filter <包名>`（同步盘挂起）；一律用 `pnpm -r` 或 `pnpm -C`。
- **仍然不要**自行重启用户的 GUI 进程。装进真实 profile 属于要用户确认的动作（见 §7/§8 与 `docs/engineering/architecture.md` 的未决项）；`desktop` profile 由 Electron 独占，CLI 的 `--dump-config` 会被拒绝。
- **2026-10-20 已用启动环境变量注入 `DEEPSEEK_API_KEY` 完成复验**（`completed`、2 条 `assistant` 消息、`multiStepObserved=true`），详见 `docs/engineering/s0-reverification-20261019.md` 第 9 节；探针**默认仍不含凭据**，不要用「探针通过」替代真实模型验证。
- `probe-host` 第 4/5 项若报 `SKIP … NODE_OPTIONS restricted`，属于**未观察**，不得当作通过；第 5 项 PASS 只证 `/aikanban` 已注册，数据层就绪以同一日志里的末次 `[probe] ACTIVATION` 的 `dataLayerReady` 为准（探针会把未观察到的情况列在 `not observed` 段）。
