"""Build immutable v1.17 source-location maps; does not edit effective PRDs."""
from pathlib import Path
import argparse
import csv
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
PRD = ROOT / 'docs/prd'
CAT = json.loads((PRD / 'feature-catalog.json').read_text(encoding='utf-8'))
FEATURES = {f['id']: f for f in CAT['features']}
BASE = PRD / CAT['baseline']
parser = argparse.ArgumentParser(description='Rebuild initial frozen-baseline maps; not for routine maintenance.')
parser.add_argument('--overwrite-initial-maps', action='store_true', help='Overwrite existing maps after preserving manual edits separately.')
args = parser.parse_args()
outputs = [PRD / 'traceability.md', *(PRD / 'mapping' / name for name in ('requirements.csv','acceptance.csv','interaction.csv'))]
if any(p.exists() for p in outputs) and not args.overwrite_initial_maps:
    parser.error('Existing maps are protected. Routine validation: check_docs.py. Preserve manual changes before explicit --overwrite-initial-maps.')
if hashlib.sha256(BASE.read_bytes()).hexdigest() != CAT['baseline_sha256']:
    parser.error('Baseline hash differs; refusing to regenerate source locations.')
LINES = BASE.read_text(encoding='utf-8-sig').splitlines()
DEFAULT = {1:'F01',2:'F01',3:'F02',4:'F02',5:'F02',6:'F16',7:'F17',8:'F04',9:'F04',10:'F05',11:'F04',12:'F08',13:'F06',14:'F06',15:'F06',16:'F07',17:'F03',18:'F06',19:'F08',20:'F10',21:'F11',22:'F11',23:'F12',24:'F13',25:'F13',26:'F15',27:'OQ-02',28:'F18',29:'F18',30:'F19',31:'F11',32:'F20'}
OWNERS = '''F01 F01 F02 F02 F02 F16 F17 F17 F04 F04 F11 F04 F05 F05 F04 F08 F08 F08 F06 F06 F06 F06 F07 F06 F06 F03 F09 F08 F08 F10 F11 F12 F12 F11 F12 F11 F11 F13 F13 F13 F14 F14 F08 F03 F10 F15 F18 F18 F18 F19 F11 F20 F12 F08 F10 F14 F04 F05 F05 F05 F06 F17 F05 F09 F16 F09 F09 F09 F10 F09 F11 F06 F06 F06 F09 F11 F12 F12 F12 F12 F07 F07 F07 F07 F07 F06 F06 F06 F13 F13 F06 F06 F06 F06 F17 F17 F17 F07 F07 F05 F11 F11 F11 F11 F11 F11'''.split()
assert len(OWNERS) == 106
OVERRIDES = {
    'FR-03.C02':'F01', 'FR-03.C06':'F06', 'FR-03.C10':'F06', 'FR-03.C11':'F06',
    'FR-08.C03':'F11', 'FR-08.C10':'F11', 'FR-08.C13':'F11', 'FR-11.C02':'F04',
    'FR-13.C26':'F09', 'FR-16.C10':'F06', 'FR-21.C33':'F11', 'FR-21.C36':'F11',
    'FR-21.C37':'F11', 'FR-21.C40':'F11', 'FR-21.C41':'F11', 'FR-24.C12':'F11',
}
COMMON = {
  'objects-and-states': {1,2,3,4,5,7,8,9,10,11,12,13,15,24,25,26,32},
  'confirmation-and-versions': {3,12,13,14,15,16,17,18,19,20,24,25,26,28,29},
  'conclusion-applicability': {6,13,17,20,21,22,24,25,31},
  'context-rules': {8,9,10,13,14,15,16,21,22,23,24,25,28,31,32},
  'persistence-and-recovery': {1,2,3,4,7,8,15,16,17,18,19,20,22,23,25,26,27,28,29,30,31},
}

def path_for(fid):
    if fid.startswith('OQ'):
        return 'open-questions.md'
    f = FEATURES[fid]
    return f"features/{fid}-{f['slug']}/prd.md"

def owner_for(fr, line, subheading):
    # A single primary owner; global common references retain cross-feature obligations.
    owner = DEFAULT[fr]
    if fr == 3 and any(s in line for s in ('人工','直接修改','概况编辑','修正','草稿','编辑离开')):
        owner = 'F03'
    if fr == 5 and any(s in line for s in ('项目记录未生成','项目记录提示','已完成任务明确')):
        owner = 'F15'
    if fr == 9 and any(s in line for s in ('同步','背景','相同内容')):
        owner = 'F11'
    if fr == 11 and any(s in line for s in ('处理位置','有新内容','尚未形成')):
        owner = 'F06'
    if fr == 13 and subheading == '记录版本与关键结论的当前适用性':
        owner = 'F09'
    if fr == 14 and any(s in line for s in ('任务选择取消','已创建任务但','未关联对话点击')):
        owner = 'F05'
    if fr == 14 and ('运行中提前点击' in line or '暂缓边界不构成' in line):
        owner = 'OQ-01'
    if fr == 15 and any(s in line for s in ('不同对话可','不阻挡其他任务','并发修改')):
        owner = 'F08'
    if fr == 15 and ('手动概况/总览编辑' in line):
        owner = 'F03'
    if fr == 17 and ('关键结论' in line or '涉及关键' in line):
        owner = 'F09'
    if fr == 17 and any(s in line for s in ('看板状态','上述字段','用户另行要求字段')):
        owner = 'F02'
    if fr == 17 and '另一处修改' in line:
        owner = 'F08'
    if fr == 21 and subheading == '按需读取的触发、边界与上下文控制':
        owner = 'F12'
    if fr == 21 and any(s in line for s in ('发送前正式','明确快照')):
        owner = 'F11'
    if fr == 24 and ('手动填写' in line or '共同约定是总览' in line):
        owner = 'F03'
    if fr == 24 and any(s in line for s in ('已否定','引用结论','同范围修正')):
        owner = 'F09'
    if fr == 25 and any(s in line for s in ('任务重新打开','源任务概况','再次完成','来源任务已删除','已有成果可手动')):
        owner = 'F14'
    if fr == 31 and any(s in line for s in ('详细读取及搜索','历史额外读取','打开历史页面')):
        owner = 'F12'
    if fr == 31 and ('体验统计' in line):
        owner = 'F18'
    return owner

def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

clauses = []
fr = None
sub = ''
serial = 0
for n, text in enumerate(LINES, 1):
    match = re.match(r'### FR-(\d+) ', text)
    if match:
        fr, sub, serial = int(match[1]), '', 0
        continue
    if text.startswith('## '):
        fr = None
    if fr is None or not text.strip():
        continue
    if text.startswith('#### '):
        sub = text[5:]
        continue
    if text.startswith('#') or re.fullmatch(r'\|[\s|:-]+\|', text):
        continue
    serial += 1
    clause_id = f'FR-{fr:02d}.C{serial:02d}'
    owner = OVERRIDES.get(clause_id, owner_for(fr, text, sub))
    priority = 'excluded' if fr == 27 else ('pending-boundary' if owner == 'OQ-01' else ('mixed-P0-and-candidate' if 'P1' in text or 'P2' in text else 'P0'))
    clauses.append({
        'clause_id':clause_id,
        'baseline_line':n,
        'primary_owner':owner,
        'owner_path':path_for(owner),
        'scope':priority,
        'implementation_note':('版本/来源/失败保护由F03/F06/F13从首次保存起实现；F10主责完整手动记录编辑/历史/恢复界面' if fr == 20 else ('背景去重由F11；打不开来源与新建入口由F04协同' if clause_id == 'FR-09.C05' else '随功能首次实现遵守所列公共规则')),
        'common_files':';'.join('common/'+name+'.md' for name, values in COMMON.items() if fr in values),
        'source_excerpt':text[:90] + ('…' if len(text)>90 else ''),
    })
write_csv(PRD / 'mapping/requirements.csv', clauses)

ats = []
for n, text in enumerate(LINES, 1):
    if not text.startswith('| AT-'):
        continue
    cells = [c.strip() for c in text.strip().strip('|').split('|')]
    num = int(cells[0][3:])
    owner = OWNERS[num-1]
    # Collaboration is a source-based union, refined by the primary PRD at implementation.
    source_ids = set()
    for part in cells[3].split('、'):
        match = re.fullmatch(r'(?:FR-)?(\d+)(?:[—–-](\d+))?', part)
        if match:
            start = int(match[1]); end = int(match[2] or start)
            source_ids.update(f'FR-{i:02d}' for i in range(start,end+1))
    collaborators = sorted({f['id'] for f in FEATURES.values() if set(f['sources']) & source_ids} - {owner})
    ats.append({'at_id':cells[0], 'baseline_line':n, 'primary_owner':owner,
                'owner_path':path_for(owner), 'collaborators':';'.join(collaborators),
                'scenario':cells[1], 'expected':cells[2], 'source_fr':cells[3], 'status':'待执行'})
write_csv(PRD / 'mapping/acceptance.csv', ats)

ux_owners = ['F01','F04','F06','F06','F13','F02','F02','F10','F03','F08','F04','F13','F11','F06','F04','F05']
uxs = []
for n, text in enumerate(LINES, 1):
    if not text.startswith('| UX-'):
        continue
    cells = [c.strip() for c in text.strip().strip('|').split('|')]
    owner = ux_owners[int(cells[0][3:])-1]
    uxs.append({'ux_id':cells[0], 'baseline_line':n, 'primary_owner':owner,
                'owner_path':path_for(owner), 'original_rule':cells[1],
                'implementation_note':'行为在对应组件首次实现时有效；主责不豁免其他引用功能'})
write_csv(PRD / 'mapping/interaction.csv', uxs)

trace = '''# 原始需求追溯与覆盖

本次拆分保持 v1.17 业务语义，只调整组织、阅读量与开发顺序。原文件逐字迁入 baseline，SHA-256 为 `4c53cdf3182c5fbe23ac2b07ef9681bdda32759a0651619b74da1a3bf51477a3`。

## 追溯方式

- [条款映射](mapping/requirements.csv)：每个 FR 下的非空正文、列表项和内容表格行一个稳定 C 编号，含原始行号、主要负责功能、公共规则及 90 字以内定位摘要。表头也作为结构条目保留；表格分隔线和小标题不作为行为条款。原行号以冻结基线为准。
- [验收映射](mapping/acceptance.csv)：完整 106 个 AT 的原场景、原通过标准、主要验收功能、原 FR 与按来源推导的协同候选。一个场景只有一个主要责任方，可需多个功能联合验收；协同候选不强制全部成为直接依赖。
- [交互规则映射](mapping/interaction.csv)：UX-01—16 的原规则、行号与主要责任功能；共享行为从组件首次实现有效。
- 列表中的 owner 表示主维护/验收责任，不表示其他引用方免于遵守。公共规则与小 PRD 中相关实现规则仍是有效正文；映射不替代它们。
- FR-27 明确 excluded；运行中整理的未决分支记录 pending-boundary/OQ-01，均没有通过拆分变成默认开发功能。混合 P0/P1/P2 条款须读有效 PRD 明确范围，不整行升级候选。
- 基线第 1—7、13—17 章及附录含全局背景/约束，按下表整体映射；其中 FR 的细条款和全部 AT 另有逐行索引。

## 原文整体归属

| 基线章节 | 有效归属 |
| --- | --- |
| 1—3 产品、问题、用户、边界 | [overview](overview.md)、[宿主能力](../engineering/host-capabilities.md) |
| 4 原则、UX-01—16、动作 | [对象状态](common/objects-and-states.md)、[确认版本](common/confirmation-and-versions.md)、相关功能 PRD |
| 5 页面职责 | overview 及 F02/F04/F05/F13/F15 |
| 6 对象、状态、来源 | 全部 common，尤其 OBJ 与 CTX |
| 7 用户流程 | S1—S4 功能与 [路线](roadmap.md)；保存流程见 REC |
| 8—12 FR-01—32 | 下表及逐条 CSV；FR-27 排除 |
| 13 异常与文案 | 各功能异常节、REC、SAVE、CTX |
| 14 范围及约束 | overview、roadmap、common、open-questions |
| 15.1 AT-01—106 | acceptance.csv、[联合验收](../delivery/acceptance.md)、各主要功能验收节 |
| 15.2—15.3 自用与阻断 | delivery/acceptance、overview |
| 16 指标与验证 | overview、delivery/acceptance；无已达成指标 |
| 17 确定决定与评审 | common、相关功能、[未决](open-questions.md) |
| 附录 A 动作边界 | OBJ-10、CTX、SAVE、各功能规则 |

## FR 条款主责任分布

| FR | 定位条目数 | 主要责任方 |
| --- | --- | --- |
'''
for num in range(1,33):
    rows = [c for c in clauses if c['clause_id'].startswith(f'FR-{num:02d}.')]
    owners = sorted({c['primary_owner'] for c in rows})
    trace += f"| FR-{num:02d} | {len(rows)} | " + '、'.join(f'[{o}]({path_for(o)})' for o in owners) + ' |\n'
trace += '''
## 后续变更

保留基线和 C 编号原始来源不变。新业务规则在有效 PRD 中分配 Fxx-Rnn，新增验收可使用新增编号并写明来源日期；不要伪装成原 106 个 AT。更新映射中的实现归属和协同记录时保留原行号与场景文本。

`build_baseline_maps.py` 只用于从冻结基线重建初始映射；默认拒绝覆盖已有文件，并校验基线哈希。需要重建时先保存人工修订，再显式使用 `--overwrite-initial-maps` 并重新合并差异。日常维护不要重建，校验使用 `check_docs.py`。
'''
(PRD / 'traceability.md').write_text(trace, encoding='utf-8')

print(f'Built {len(clauses)} FR source units, {len(uxs)} UX rules and {len(ats)} AT scenarios.')
