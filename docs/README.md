# 文档入口

这里统一保存 AIKanBan 的产品需求文档。本仓库当前只保留需求与治理约定，不保存实施代码：技术决策按[技术决策记录](engineering/decisions/README.md)的约定落点，实现与验收进度只在[交付状态](delivery/status.md)维护。项目入口见[项目 README](../README.md)。

## 按任务阅读

| 当前任务 | 阅读入口 |
| --- | --- |
| 理解产品 | [产品总览](prd/overview.md) |
| 安排实施顺序 | [分阶段实施路线](prd/roadmap.md) |
| 开始一个功能 | [功能索引](prd/README.md) → 当前 prd.md → 指定公共规则 → 依赖合同 |
| 核对需求来源 | [追溯说明](prd/traceability.md) → 条款映射/验收映射 → 原始基线 |
| 处理尚未定义的行为 | [未决事项](prd/open-questions.md) |
| 核对验收场景 | 当前功能验收条件 → [验收映射](prd/mapping/acceptance.csv) |
| 记录技术决策 | [技术决策记录](engineering/decisions/README.md)（约定与索引，当前暂无记录） |
| 查看实现与验收进度 | [交付状态](delivery/status.md)（唯一状态入口） |

## 文档职责与有效性

- `prd/overview.md` 定义产品定位、范围和总体指标；`common/` 定义跨功能不变量；`features/*/prd.md` 定义具体用户行为，三者组成当前有效需求。
- `prd/feature-catalog.json` 是功能编号、目录、阶段、直接依赖和 FR 来源的结构化索引，供链接和校验使用，不代替具体规则。
- `prd/baseline/` 仅保存 v1.17 历史基线；不在日常需求修改时同步改基线，不能要求编码 AI 每次加载整份。
- `prd/mapping/` 是定位、归属和验收责任索引，不是另一份可独立修改的业务规则正文。
- `engineering/decisions/` 保存技术决策（约定与索引见其 [README](engineering/decisions/README.md)）；`delivery/status.md` 是[实现与验收进度的唯一入口](delivery/status.md)。实现开始时在该功能目录创建 implementation.md，验收开始时创建 verification.md，记录内容与有效 PRD 分离，状态变化只登记到交付状态页。
- 本仓库不保存实施代码：产品需求、技术决策约定与状态入口都在 `docs/` 下，根目录只有 [项目 README](../README.md)。
- `tools/` 下的脚本只校验文档结构，不代表产品已实现或已验收。

## 维护与变更

1. 定位功能和原条款，修改对应有效 PRD；跨功能不变量修改公共规则并评估所有引用方。
2. 保持 Fxx、规则编号、目录名稳定，撤销的规则保留弃用说明，不把旧编号分配给别的行为。
3. 更新 catalog、路线、条款归属或验收协同关系中受影响部分；新增需求注明决策来源和日期，不伪装原始基线内容。
4. 未决业务行为写入 open-questions；确定后同步相关 PRD 并保留处置记录。
5. 运行 `python docs/tools/check_docs.py`（在项目根目录执行），并人工核对改动涉及的业务含义。结构通过不等于内容无矛盾，也不等于产品通过。

原始 106 个 AT 场景仍全部保留，拆分仅改变组织和实施顺序，不降低首版 P0 标准。完整首版包含任务完成后项目成果闭环。
