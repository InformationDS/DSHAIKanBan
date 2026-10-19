# AIKanBan

AIKanBan 是面向 Deepseek Harness 桌面版的项目看板与跨对话交接功能：用任务组织多条 AI 对话，以经用户确认的任务记录和概况接续工作，完成后将成果沉淀为项目记录与项目总览。

## 当前仓库内容

本仓库包含产品需求（PRD）、治理载体、S0 工程记录与**回收的 S0/S1 实施代码**：`packages/core`、`packages/plugin`、`packages/plugin-client` 共 63 个文件，加上根构建配置 8 个，均自 `bd16535` 逐字节复原，仅追加一处 3 行空值守卫。**代码回收不等于功能实现**：F01—F20 的实现与产品验收状态一律以[交付状态](docs/delivery/status.md)为准。

- 需求入口：[文档入口](docs/README.md) → [产品总览](docs/prd/overview.md)
- 功能清单：[小 PRD 索引](docs/prd/README.md)（F01—F20）
- 实施顺序：[分阶段实施路线](docs/prd/roadmap.md)
- 未决事项：[未决事项与首版边界](docs/prd/open-questions.md)
- 需求追溯：[追溯说明](docs/prd/traceability.md)
- 工程准备：[架构准备](docs/engineering/architecture.md)、[宿主能力合同](docs/engineering/host-capabilities.md)
- 技术决策：[技术决策记录](docs/engineering/decisions/README.md)（ADR-001—006，状态见索引）
- S0 复核：[S0 复核记录](docs/engineering/s0-reverification-20261019.md)（2026-10-19，DSH 44.7.0；含旧声称更正）
- 实施代码：`packages/`（回收的 S0/S1 实现）与根构建配置 8 个（`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.json`、`tsconfig.base.json`、`vitest.config.ts`、`.npmrc`、`.gitignore`）
- 运行与构建：[tools/COMMANDS.md](tools/COMMANDS.md)（`node_modules` 与 `.pnpm-store` 未随仓库提供，先读该页再 `pnpm install`）
- 交付进度：[交付状态](docs/delivery/status.md)（实现与验收的唯一状态入口）

## 从只保留需求到回收 S0/S1 代码

上一轮实施在额度受限的情况下中断，代码与文档状态互相矛盾（交付状态写着功能尚未实现，仓库里却已有核心实现和对应的实现记录）。为避免把不完整的实施当作基线继续演进，2026-10-18 曾整体删除实施执行内容，只保留仍完整、可独立校验的需求文档，并恢复两个只写约定的治理落点：[技术决策记录](docs/engineering/decisions/README.md)与[交付状态](docs/delivery/status.md)；2026-10-19 先补回 S0 工程记录的**文档层**（架构准备、宿主能力合同、五份 ADR 与[复核记录](docs/engineering/s0-reverification-20261019.md)）与 `tools/` 脚本。

**2026-10-19 已按复核结论回收代码**：`packages/`（63 文件）与根构建配置（8 个）自 `bd16535` 逐字节复原，仅追加 `packages/plugin-client/src/channel-source.ts` 的一处 3 行空值守卫，提交为 `ed6b151`。被删除过的内容仍可从 Git 历史中的基线提交 `bd16535` 找回。

## 计划中的核心使用方式

1. 创建任务，也可先在项目内开展未关联对话。
2. 在任务内新建对话或关联已有对话，由用户发送要求推进工作。
3. 形成任务记录，预览并一次确认记录及概况变化。
4. 新对话使用当前正式背景继续工作，详细材料按需读取。
5. 用户标记任务完成后生成项目记录，确认成果及总览变化。

看板状态由用户决定；AI 草稿须审核确认；默认背景不包含全部聊天或版本历史。新建、关联或准备背景不会自行执行工作。

## 文档校验

需要 Python 3 标准库，无第三方包。在项目根目录运行：

```powershell
python docs/tools/check_docs.py
```

此命令校验文档链接、基线完整性、需求/验收映射、编号及功能依赖；扫描范围仅限项目文档，结果只说明文档结构成立，不代表产品功能已经通过。

## 目录

```text
AIKanBan/
├─ README.md            # 项目简介、仓库范围与文档校验入口
├─ package.json         # 根构建配置（另有 pnpm-workspace.yaml / pnpm-lock.yaml / tsconfig.json /
│                       #   tsconfig.base.json / vitest.config.ts / .npmrc / .gitignore，共 8 个）
├─ packages/            # 回收的 S0/S1 实施代码：core（数据模型）、plugin（host 半）、plugin-client（浏览器半）
├─ tools/               # S0 探针/同步/清理脚本与 COMMANDS.md
└─ docs/
   ├─ README.md         # 文档入口、职责与维护规则
   ├─ prd/              # 有效需求、公共规则、20 份小 PRD、历史基线、映射与模板
   ├─ engineering/      # S0 工程记录：架构准备、宿主能力合同、ADR、复核记录
   │  └─ decisions/     # 技术决策记录（ADR-001…005，均为提议）
   ├─ delivery/         # 交付状态唯一入口（status.md，实现与验收进度）
   └─ tools/            # 文档校验与基线映射工具
```
