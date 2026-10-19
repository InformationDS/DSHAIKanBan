"""Read-only document integrity/coverage checks. No application tests implied.

Scope: document structure and cross-document consistency only. It cannot judge
whether the rules are right, whether a feature is implemented, or whether any
product acceptance has passed.
"""
from pathlib import Path
from collections import Counter
from urllib.parse import unquote, urlsplit
import csv
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
PRD = ROOT / 'docs/prd'
ERRORS = []

def require(condition, message):
    if not condition:
        ERRORS.append(message)

def load_csv(name):
    with (PRD / 'mapping' / name).open(encoding='utf-8-sig', newline='') as fh:
        rows = list(csv.reader(fh))
    require(bool(rows), f'{name}: empty file')
    if not rows:
        return []
    header = rows[0]
    for number, row in enumerate(rows[1:], start=2):
        require(len(row) == len(header),
                f'{name}:{number}: {len(row)} fields, expected {len(header)}')
    return [dict(zip(header, row)) for row in rows[1:]]

def at_ids(text):
    ids = set()
    pattern = r'AT-\d{2,3}(?:[—–-](?:AT-)?\d{2,3})?(?:(?:、|/|，|,)(?:AT-)?\d{2,3}(?:[—–-](?:AT-)?\d{2,3})?)*'
    for match in re.finditer(pattern, text):
        group = match[0].replace('AT-', '')
        for part in re.split(r'[、/，,]', group):
            ends = re.split(r'[—–-]', part)
            start, stop = int(ends[0]), int(ends[-1])
            ids.update(f'AT-{i:02d}' for i in range(start, stop+1))
    return ids

def table_rows(text):
    """Data rows of the first Markdown table in `text`, header row excluded."""
    rows = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith('|'):
            continue
        cells = [c.strip() for c in stripped.strip('|').split('|')]
        if not cells or all(re.fullmatch(r'[\s:\-]*', c) for c in cells):
            continue
        rows.append(cells)
    return rows[1:] if rows else []

def section_body(text, number):
    body = re.split(rf'^## {number}[.．]', text, flags=re.M)[-1]
    return re.split(r'^## ', body, flags=re.M)[0]

cat = json.loads((PRD / 'feature-catalog.json').read_text(encoding='utf-8'))
features = cat['features']
fids = [f['id'] for f in features]
require(len(fids) == 20 and len(set(fids)) == 20, 'Need 20 unique feature IDs')
files = {f['id']:PRD / f"features/{f['id']}-{f['slug']}/prd.md" for f in features}
baseline = PRD / cat['baseline']
require(hashlib.sha256(baseline.read_bytes()).hexdigest() == cat['baseline_sha256'], 'Baseline SHA-256 differs')
lines = baseline.read_text(encoding='utf-8-sig').splitlines()
require(not (ROOT / 'AIKanBan_桌面版功能PRD.md').exists(), 'Original PRD remains at project root')
require({p.name for p in ROOT.glob('*.md')} == {'README.md'}, 'Project docs must be under docs except root README')

stage = {f['id']:int(f['stage'][1:]) for f in features}
graph = {f['id']:f['depends'] for f in features}
catalog_stage = {f['id']: f['stage'] for f in features}
catalog_deps = {f['id']: set(f['depends']) for f in features}
catalog_sources = {f['id']: set(f['sources']) for f in features}
visiting, visited = set(), set()

def visit(fid):
    if fid in visiting:
        ERRORS.append(f'Circular dependency at {fid}'); return
    if fid in visited:
        return
    visiting.add(fid)
    for dep in graph[fid]:
        require(dep in graph, f'{fid}: unknown dependency {dep}')
        if dep in graph:
            require(stage[dep] <= stage[fid], f'{fid} depends on later-stage {dep}')
            visit(dep)
    visiting.remove(fid); visited.add(fid)

for fid in fids:
    visit(fid)

common_rules = set()
for file in (PRD / 'common').glob('*.md'):
    text = file.read_text(encoding='utf-8')
    common_rules.update(re.findall(r'^## ((?:OBJ|SAVE|APP|CTX|REC)-\d{2})\b', text, re.M))
require(len(common_rules) == 48, 'Expected 48 common rule IDs')

texts, local_rules = {}, []
for f in features:
    file = files[f['id']]
    require(file.exists(), f'Missing {file.relative_to(ROOT)}')
    if not file.exists():
        continue
    text = file.read_text(encoding='utf-8')
    texts[f['id']] = text
    require(f['id'] in text.splitlines()[0], f'{f["id"]}: wrong title')
    require(f"P0 / {f['stage']}" in text, f'{f["id"]}: stage differs from catalog')
    require(len(re.findall(r'^## [1-7][.．]', text, re.M)) == 7, f'{f["id"]}: need seven PRD sections')
    rules = re.findall(r'^### (F\d{2}-R\d{2})\b', text, re.M)
    require(bool(rules), f'{f["id"]}: no numbered implementation rules')
    require(all(r.startswith(f['id']+'-') for r in rules), f'{f["id"]}: wrong rule prefix')
    local_rules.extend(rules)
    require('待执行' in text or '尚未' in text, f'{f["id"]}: must not imply acceptance passed')
    for m in re.finditer(r'\b(OBJ|SAVE|APP|CTX|REC)-(\d{2})(?:[—–-](?:(?:OBJ|SAVE|APP|CTX|REC)-)?(\d{2}))?', text):
        for n in range(int(m[2]),int(m[3] or m[2])+1):
            require(f'{m[1]}-{n:02d}' in common_rules, f'{f["id"]}: unknown common rule {m[1]}-{n:02d}')
    if re.search(r'^\| (?:前置依赖|直接依赖) \|', text, re.M):
        dep_row = re.search(r'^\| (?:前置依赖|直接依赖) \|(.+)$', text, re.M)[1]
        require(set(re.findall(r'F\d{2}', dep_row)) == set(f['depends']), f'{f["id"]}: declared deps differ from catalog')
require(len(local_rules) == len(set(local_rules)), 'Duplicate local rule IDs')

# Common rule references must resolve outside feature PRDs too, not only inside them.
for extra in sorted(list(PRD.glob('*.md')) + list((PRD / 'templates').glob('*.md'))):
    extra_text = extra.read_text(encoding='utf-8-sig')
    for m in re.finditer(r'\b(OBJ|SAVE|APP|CTX|REC)-(\d{2})(?:[—–-](?:(?:OBJ|SAVE|APP|CTX|REC)-)?(\d{2}))?', extra_text):
        for n in range(int(m[2]),int(m[3] or m[2])+1):
            require(f'{m[1]}-{n:02d}' in common_rules, f'{extra.name}: unknown common rule {m[1]}-{n:02d}')

# Validate all relative Markdown links, including frozen original if it has any.
# Scope: project documents only (docs/ plus root README). Vendored packages, the
# isolated probe home and build output carry third-party Markdown whose links are
# not part of this project's document contract and must not be judged here.
EXCLUDED_DIRS = {'node_modules', '.git', '.probe-home', '.probe-out', 'dist', 'coverage'}
md_files = [
    p for p in ROOT.rglob('*.md')
    if not EXCLUDED_DIRS.intersection(p.relative_to(ROOT).parts[:-1])
]
for file in md_files:
    text = file.read_text(encoding='utf-8-sig')
    targets = re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text)
    targets += re.findall(r'^ {0,3}\[[^\]]+\]:\s*(\S+)', text, re.M)
    for raw in targets:
        target = raw.strip().strip('<>')
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', target) or target.startswith('#'):
            continue
        target = unquote(target.split('#')[0])
        if not target or '[' in target or 'Fxx' in target:
            continue
        resolved = (file.parent / target).resolve()
        require(resolved.exists(), f'{file.relative_to(ROOT)}: broken link {target}')

requirements = load_csv('requirements.csv')
seen_clauses = Counter(r['clause_id'] for r in requirements)
require(all(n == 1 for n in seen_clauses.values()), 'Duplicate source clause IDs')
require({r['clause_id'].split('.')[0] for r in requirements} == {f'FR-{i:02d}' for i in range(1,33)}, 'FR coverage incomplete')
expected_lines = set()
inside = False
for n, line in enumerate(lines,1):
    if re.match(r'### FR-\d+ ', line):
        inside = True; continue
    if line.startswith('## '):
        inside = False
    if inside and line.strip() and not line.startswith('#') and not re.fullmatch(r'\|[\s|:-]+\|',line):
        expected_lines.add(n)
require({int(r['baseline_line']) for r in requirements} == expected_lines, 'FR source-location units missing/extra')
for r in requirements:
    n = int(r['baseline_line'])
    require(1 <= n <= len(lines), f'{r["clause_id"]}: invalid source line')
    excerpt = r['source_excerpt'].removesuffix('…')
    require(lines[n-1].startswith(excerpt), f'{r["clause_id"]}: source excerpt mismatch')
    require(len(r['source_excerpt']) <= 90, f'{r["clause_id"]}: source excerpt longer than 90 characters')
    require((PRD / r['owner_path']).exists(), f'{r["clause_id"]}: missing owner file')
    require(r['primary_owner'] in fids or r['primary_owner'] in ('OQ-01','OQ-02'), f'{r["clause_id"]}: unknown owner')
    require((r['scope'] == 'excluded') == r['clause_id'].startswith('FR-27.'), f'{r["clause_id"]}: wrong excluded scope')
    for common in r['common_files'].split(';'):
        require((PRD / common).exists(), f'{r["clause_id"]}: missing common file')

interactions = load_csv('interaction.csv')
require(len(interactions) == 16 and {r['ux_id'] for r in interactions} == {f'UX-{i:02d}' for i in range(1,17)}, 'UX rule coverage incomplete')
for r in interactions:
    require(r['primary_owner'] in fids and (PRD / r['owner_path']).exists(), f'{r["ux_id"]}: invalid owner')
    source = [c.strip() for c in lines[int(r['baseline_line'])-1].strip('|').split('|')]
    require(source == [r['ux_id'],r['original_rule']], f'{r["ux_id"]}: original UX rule altered')

acceptance = load_csv('acceptance.csv')
expected_ats = {f'AT-{i:02d}' for i in range(1,107)}
require(len(acceptance) == 106 and {r['at_id'] for r in acceptance} == expected_ats, 'Need exactly original 106 AT scenarios')
traceability_text = (PRD / 'traceability.md').read_text(encoding='utf-8')
trace_at = at_ids(traceability_text)
require(expected_ats <= trace_at, 'Traceability map missing ATs')
require(trace_at <= expected_ats | {f'AT-{i}' for i in range(107,201)}, 'Traceability map references unknown ATs')
STATUS_VOCABULARY = {'待执行', '部分执行', '通过', '失败', '结果需核对'}
for r in acceptance:
    owner = r['primary_owner']
    require(owner in texts, f'{r["at_id"]}: unknown primary owner')
    source = [x.strip() for x in lines[int(r['baseline_line'])-1].strip('|').split('|')]
    require(source[:4] == [r['at_id'],r['scenario'],r['expected'],r['source_fr']], f'{r["at_id"]}: original scenario altered')
    require(r['status'] in STATUS_VOCABULARY, f'{r["at_id"]}: unknown status {r["status"]!r}')
    if owner in texts:
        accept_section = section_body(texts[owner], 6)
        require(r['at_id'] in at_ids(accept_section), f'{r["at_id"]}: primary owner {owner} lacks acceptance reference')
    for dep in filter(None, r['collaborators'].split(';')):
        require(dep in fids, f'{r["at_id"]}: unknown collaborator {dep}')

# The original 106 stay frozen; new acceptance lives in a separate file and
# continues the numbering, so a new item can never be mistaken for a baseline AT.
additions_path = PRD / 'mapping' / 'acceptance-additions.csv'
require(additions_path.exists(), 'Missing docs/prd/mapping/acceptance-additions.csv')
additions = load_csv('acceptance-additions.csv') if additions_path.exists() else []
add_ids = [r['id'] for r in additions]
require(len(add_ids) == len(set(add_ids)), 'Duplicate addition IDs')
require(set(add_ids) == {f'AT-{i}' for i in range(107, 107 + len(add_ids))},
        'Addition IDs must continue from AT-107 without gaps')
require(not (set(add_ids) & expected_ats), 'Addition IDs must not reuse the original 106')
for r in additions:
    require(r['primary_owner'] in texts, f'{r["id"]}: unknown primary owner')
    require((PRD / r['owner_path']).exists(), f'{r["id"]}: missing owner file')
    require(re.fullmatch(r'\d{4}-\d{2}-\d{2}', r['source_date']), f'{r["id"]}: invalid source_date')
    require(r['kind'] in ('新增-本功能', '新增-联合'), f'{r["id"]}: unknown kind')
    require(bool(r['steps'].strip()) and bool(r['expected'].strip()), f'{r["id"]}: empty steps/expected')

# Section 6 of each feature PRD must be fully numbered, must agree with the
# 验收来源 row, and may only cite scenarios the mapping already assigns to it.
at_owner = {r['at_id']: r['primary_owner'] for r in acceptance}
at_collab = {r['at_id']: set(filter(None, r['collaborators'].split(';'))) for r in acceptance}
add_owner = {r['id']: r['primary_owner'] for r in additions}
valid_ids = expected_ats | set(add_ids)
section_ids = {}
for f in features:
    fid = f['id']
    if fid not in texts:
        continue
    rows = table_rows(section_body(texts[fid], 6))
    require(bool(rows), f'{fid}: section 6 has no acceptance rows')
    ids = set()
    for cells in rows:
        head = cells[0]
        found = at_ids(head)
        require(bool(found), f'{fid}: acceptance row without a numbered ID: {head!r}')
        ids |= found
    unknown = ids - valid_ids
    require(not unknown, f'{fid}: unknown acceptance IDs {sorted(unknown)}')
    section_ids[fid] = ids
    declared = re.search(r'^\| 验收来源 \|(.+)$', texts[fid], re.M)
    require(bool(declared), f'{fid}: missing 验收来源 row')
    if declared:
        declared_ids = at_ids(declared[1])
        require(declared_ids == ids,
                f'{fid}: 验收来源 {sorted(declared_ids)} != section 6 {sorted(ids)}')
    for at in sorted(ids & expected_ats):
        require(at_owner[at] == fid or fid in at_collab[at],
                f'{fid}: cites {at} but is neither its primary owner ({at_owner[at]}) nor a collaborator')
    # The reverse direction: a feature named as a joint verifier on a row must be
    # registered for that scenario, otherwise "who signs off" stays ambiguous.
    # Only the explicit `联合 Fxx/Fyy` form is read, so prose is never guessed at.
    for cells in rows:
        partners = set()
        for group in re.findall(r'联合\s*((?:F\d{2})(?:\s*[/、,，]\s*F\d{2})*)', ' '.join(cells)):
            partners |= set(re.findall(r'F\d{2}', group))
        for at in sorted(at_ids(cells[0]) & expected_ats):
            for partner in sorted(partners):
                require(partner == at_owner[at] or partner in at_collab[at],
                        f'{fid}: row {cells[0]!r} names {partner} as joint on {at}, but {at} lists '
                        f'neither as its owner ({at_owner[at]}) nor as a collaborator')

referenced = set().union(*section_ids.values()) if section_ids else set()
require(set(add_ids) <= referenced, f'Additions missing from section 6: {sorted(set(add_ids) - referenced)}')
for addition in add_ids:
    holders = sorted(fid for fid, idset in section_ids.items() if addition in idset)
    require(holders == [add_owner[addition]],
            f'{addition}: section 6 holders {holders}, expected [{add_owner[addition]}]')

# traceability.md's FR responsibility table must agree with requirements.csv.
trace_body = re.split(r'^## FR 条款主责任分布', traceability_text, flags=re.M)
require(len(trace_body) == 2, 'traceability.md: missing FR responsibility section')
if len(trace_body) == 2:
    fr_units = Counter(r['clause_id'].split('.')[0] for r in requirements)
    fr_owners = {}
    for r in requirements:
        fr_owners.setdefault(r['clause_id'].split('.')[0], set()).add(r['primary_owner'])
    fr_rows = re.findall(r'^\| (FR-\d{2}) \| (\d+) \| (.+) \|$', trace_body[1], re.M)
    require(len(fr_rows) == 32, f'traceability.md: FR responsibility table has {len(fr_rows)} rows, expected 32')
    for fr, units, owners_cell in fr_rows:
        require(fr in fr_units, f'traceability.md: {fr} absent from requirements.csv')
        require(int(units) == fr_units.get(fr),
                f'traceability.md: {fr} lists {units} units, requirements.csv has {fr_units.get(fr)}')
        listed = set(re.findall(r'F\d{2}', owners_cell)) | set(re.findall(r'OQ-\d{2}', owners_cell))
        require(listed == fr_owners.get(fr, set()),
                f'traceability.md: {fr} owners {sorted(listed)} != requirements.csv {sorted(fr_owners.get(fr, set()))}')

# The catalog is the single source for stage, dependencies and FR sources; the
# two human-facing index tables must not drift from it.
prd_readme = (PRD / 'README.md').read_text(encoding='utf-8')
matrix_rows = 0
for line in prd_readme.splitlines():
    if not re.match(r'^\| F\d{2} \|', line):
        continue
    cells = [c.strip() for c in line.strip().strip('|').split('|')]
    fid = cells[0]
    matrix_rows += 1
    require(cells[2] == catalog_stage[fid],
            f'docs/prd/README.md: {fid} stage {cells[2]} != catalog {catalog_stage[fid]}')
    require(set(re.findall(r'F\d{2}', cells[3])) == catalog_deps[fid],
            f'docs/prd/README.md: {fid} dependencies differ from catalog')
    require(set(re.findall(r'FR-\d{2}', cells[4])) == catalog_sources[fid],
            f'docs/prd/README.md: {fid} FR sources differ from catalog')
require(matrix_rows == 20, f'docs/prd/README.md: feature matrix has {matrix_rows} rows, expected 20')

roadmap = (PRD / 'roadmap.md').read_text(encoding='utf-8')
roadmap_body = re.split(r'^## 直接依赖清单', roadmap, flags=re.M)
require(len(roadmap_body) == 2, 'roadmap.md: missing dependency list section')
if len(roadmap_body) == 2:
    roadmap_rows = 0
    for line in roadmap_body[1].splitlines():
        if not re.match(r'^\| \[F\d{2}\]', line):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        fid = re.match(r'\[(F\d{2})\]', cells[0])[1]
        roadmap_rows += 1
        require(cells[1] == catalog_stage[fid],
                f'roadmap.md: {fid} stage {cells[1]} != catalog {catalog_stage[fid]}')
        require(set(re.findall(r'F\d{2}', cells[2])) == catalog_deps[fid],
                f'roadmap.md: {fid} dependencies differ from catalog')
    require(roadmap_rows == 20, f'roadmap.md: dependency list has {roadmap_rows} rows, expected 20')

if ERRORS:
    print('DOCUMENT CHECK FAILED')
    for message in ERRORS:
        print('- '+message)
    sys.exit(1)
print(f'PASS: {len(md_files)} Markdown files; {len(features)} PRDs; {len(common_rules)} common rules; {len(local_rules)} local rules.')
print(f'PASS: unchanged baseline; {len(requirements)} FR source units; 16 UX rules; {len(acceptance)} original ATs + {len(additions)} additions, all fully indexed by section 6.')
print('PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.')
print('PASS: FR unit counts and owners agree between traceability.md and requirements.csv; catalog stage/dependencies/FR sources agree with both index tables.')
print('Scope: document integrity only. Application and product acceptance have not run.')
