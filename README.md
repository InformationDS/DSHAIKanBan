# AIKanBan

AIKanBan 是面向 Deepseek Harness 桌面版的项目看板与跨对话交接功能：用任务组织多条 AI 对话，以经用户确认的任务记录和概况接续工作，完成后将成果沉淀为项目记录与项目总览。

## 项目状态

目前处于 **S0 开发准备已成形、功能实现尚未开始**阶段。仓库已包含完整产品文档、文档校验工具，以及可构建、可测试、可在隔离宿主中完成真实加载验证的插件源码骨架。**尚无任何 F01—F20 功能实现，未执行产品验收。** 首版 P0 按 S0—S5 分阶段实现，P1/P2 不自动进入范围。

- 开发顺序：[实施路线](docs/prd/roadmap.md)。
- 当前进度：[交付状态](docs/delivery/status.md)。
- 技术准备：[架构准备](docs/engineering/architecture.md)、[宿主能力边界](docs/engineering/host-capabilities.md)与[技术决策记录](docs/engineering/decisions/README.md)。
- 全部文档：[文档入口](docs/README.md)。

## 计划中的核心使用方式

1. 创建任务，也可先在项目内开展未关联对话。
2. 在任务内新建对话或关联已有对话，由用户发送要求推进工作。
3. 形成任务记录，预览并一次确认记录及概况变化。
4. 新对话使用当前正式背景继续工作，详细材料按需读取。
5. 用户标记任务完成后生成项目记录，确认成果及总览变化。

看板状态由用户决定；AI 草稿须审核确认；默认背景不包含全部聊天或版本历史。新建、关联或准备背景不会自行执行工作。

## 环境、安装与运行

形态已由 S0 确定为 **DSH 插件包**（host 半 + 浏览器半），源码在本仓库，不另建桌面应用。技术决策见[技术决策记录](docs/engineering/decisions/README.md)，宿主能力核对见[宿主能力合同](docs/engineering/host-capabilities.md)。

本仓库没有 PATH 上的 `node`/`pnpm`，用 DSH 自带运行时；下文 `$NODE`/`$PNPM` 指：

```powershell
$NODE = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM = "C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
```

装了全局 pnpm 的机器把 `& $NODE $PNPM` 换成 `pnpm` 即可，参数一致。

```powershell
& $NODE $PNPM install        # 依赖安装（store/cache 已重定向到工作区内）
& $NODE $PNPM run typecheck  # tsc -b，按项目引用顺序
& $NODE $PNPM run build      # host 半 → lib/index.js；client 半 → lib/client.js
& $NODE $PNPM -r --if-present run test   # 全部包测试
& $NODE tools\verify-host-import.mjs     # 无宿主的导入链验证
& $NODE tools\probe-host.mjs             # 隔离宿主真实加载验证（不碰正在运行的 GUI）
& $NODE tools\clean.mjs                  # 只删本仓库生成的产物
```

**不要用 `pnpm --filter <包名> run <脚本>`**：在本仓库所在的同步盘上会无限挂起（已实测两次，>5 分钟无输出）；请用 `pnpm -r` 或 `pnpm -C <目录>`。

`tools/probe-host.mjs` 在**工作区内**建一个完全隔离的 Harness home（`DSH_HOME` 可覆盖），用 `--port 0` 让操作系统分配端口，因此不会与正在运行的 GUI 抢端口，也不会读写 `~/.dsh`。这是本项目在不需要重启任何进程的前提下取得真实加载证据的手段。

**安装到 profile 并生效**需要写工作区之外并重启该 profile 的进程，因此不由会话自动执行：

```powershell
& $NODE tools\sync-to-profile.mjs --dry-run          # 只打印计划，什么都不写
& $NODE tools\sync-to-profile.mjs --profile desktop  # 默认目标即 desktop
```

安装目标与完整步骤（含 `dsh plugin --profile <p> add <包绝对路径>`、重启影响与重启后验证方式）见 [tools/COMMANDS.md](tools/COMMANDS.md) §7–8。

文档校验需要 Python 3 标准库，无第三方包。可在项目根目录运行：

```powershell
python docs/engineering/tools/check_docs.py
```

此命令校验文档链接、基线完整性、需求/验收映射、编号及功能依赖；扫描范围仅限项目文档（排除 `node_modules`、隔离 home 与构建产物），不代表产品功能已经通过。

## 目录

```text
AIKanBan/
├─ README.md       # 项目简介、开发准备、运行与验证入口
├─ packages/       # 插件源码：plugin（host 半 + client 入口）、plugin-client（UI）、core（数据模型）
├─ tools/          # 构建/探针/同步/清理脚本与命令说明
└─ docs/           # 所有项目文档与文档维护工具
   ├─ prd/         # 有效需求、公共规则、20 份小 PRD、历史基线
   ├─ engineering/ # 架构、宿主能力、技术决策、文档校验工具
   └─ delivery/    # 实现进度与联合验收证据
```

不按文档分阶段移动代码。所有新增项目文档仍统一放在 docs 下。

## 开发与维护

每次选择一个小 PRD，读取其指定公共规则和已完成依赖，再明确改动范围、实现并验收。多个相关功能联合构成阶段闭环；内部阶段可试用不代表完整首版。

保留原始基线不变，日常需求维护以拆分文档为准。功能编号和目录稳定，阶段变化更新路线和交付状态；技术实现决定记录在工程文档中，不写成额外产品需求。详见[文档维护规则](docs/README.md#维护与变更)。
