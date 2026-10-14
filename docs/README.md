# 文档入口

这里统一保存 AIKanBan 的需求、技术准备、实现与验收材料。项目安装、运行和开发入口见[项目 README](../README.md)。

## 按任务阅读

| 当前任务 | 阅读入口 |
| --- | --- |
| 理解产品 | [产品总览](prd/overview.md) |
| 决定下一步开发 | [实施路线](prd/roadmap.md) → [进度](delivery/status.md) |
| 开始一个功能 | [功能索引](prd/README.md) → 当前 prd.md → 指定公共规则 → 依赖合同 |
| 选择技术架构 | [架构准备](engineering/architecture.md) → [宿主能力](engineering/host-capabilities.md) → [决策目录](engineering/decisions/README.md) |
| 核对需求来源 | [追溯说明](prd/traceability.md) → 条款映射/验收映射 → 原始基线 |
| 处理尚未定义的行为 | [未决事项](prd/open-questions.md) |
| 验收阶段或首版 | 当前功能验收条件 → [联合验收计划](delivery/acceptance.md) |

## 文档职责与有效性

- `prd/overview.md` 定义产品定位、范围和总体指标；`common/` 定义跨功能不变量；`features/*/prd.md` 定义具体用户行为，三者组成当前有效需求。
- `prd/feature-catalog.json` 是功能编号、目录、阶段、直接依赖和 FR 来源的结构化索引，供链接和校验使用，不代替具体规则。
- `prd/baseline/` 仅保存 v1.17 历史基线；不在日常需求修改时同步改基线，不能要求编码 AI 每次加载整份。
- `prd/mapping/` 是定位、归属和验收责任索引，不是另一份可独立修改的业务规则正文。
- `engineering/` 记录实现选择，不改变 PRD 语义；`delivery/status.md` 是实现/验证进度唯一入口。
- 每功能实现开始时创建 `implementation.md`，验收开始时创建 `verification.md`，文件与 `prd.md` 并置；目前只生成 PRD，不建立空实现/验证记录。

## 维护与变更

1. 定位功能和原条款，修改对应有效 PRD；跨功能不变量修改公共规则并评估所有引用方。
2. 保持 Fxx、规则编号、目录名稳定，撤销的规则保留弃用说明，不把旧编号分配给别的行为。
3. 更新 catalog、路线、条款归属或验收协同关系中受影响部分；新增需求注明决策来源和日期，不伪装原始基线内容。
4. 技术决策写入 engineering/decisions，未决业务行为写入 open-questions；确定后同步相关 PRD 并保留处置记录。
5. 实现状态只改 delivery/status；验收证据写入功能 verification 和联合验收记录，区分待执行、通过、失败与无法核对。
6. 运行 `python docs/engineering/tools/check_docs.py`，人工核对改动涉及的业务含义。结构通过不等于内容无矛盾，也不等于产品通过。

原始 106 个 AT 场景仍全部保留，拆分仅改变组织和实施顺序，不降低首版 P0 标准。完整首版包含任务完成后项目成果闭环。
