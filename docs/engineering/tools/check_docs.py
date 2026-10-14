"""Read-only document integrity/coverage checks. No application tests implied."""
from pathlib import Path
from collections import Counter
from urllib.parse import unquote, urlsplit
import csv
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
PRD = ROOT / 'docs/prd'
ERRORS = []

def require(condition, message):
    if not condition:
        ERRORS.append(message)

def load_csv(name):
    with (PRD / 'mapping' / name).open(encoding='utf-8-sig', newline='') as fh:
        return list(csv.DictReader(fh))

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
    for match in re.finditer(r'(?<!!)\[[^\]]*\]\(([^)]+)\)', text):
        target = match[1].strip().strip('<>')
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
delivery_text = (ROOT / 'docs/delivery/acceptance.md').read_text(encoding='utf-8')
require(expected_ats <= at_ids(delivery_text), 'Delivery plan missing ATs')
for r in acceptance:
    owner = r['primary_owner']
    require(owner in texts, f'{r["at_id"]}: unknown primary owner')
    source = [x.strip() for x in lines[int(r['baseline_line'])-1].strip('|').split('|')]
    require(source[:4] == [r['at_id'],r['scenario'],r['expected'],r['source_fr']], f'{r["at_id"]}: original scenario altered')
    if owner in texts:
        accept_section = re.split(r'^## 6[.．]', texts[owner], flags=re.M)[-1]
        require(r['at_id'] in at_ids(accept_section), f'{r["at_id"]}: primary owner {owner} lacks acceptance reference')
    for dep in filter(None, r['collaborators'].split(';')):
        require(dep in fids, f'{r["at_id"]}: unknown collaborator {dep}')

if ERRORS:
    print('DOCUMENT CHECK FAILED')
    for message in ERRORS:
        print('- '+message)
    sys.exit(1)
print(f'PASS: {len(md_files)} Markdown files; {len(features)} PRDs; {len(common_rules)} common rules; {len(local_rules)} local rules.')
print(f'PASS: unchanged baseline; {len(requirements)} FR source units; 16 UX rules; 106 original ATs with primary acceptance references.')
print('PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.')
print('Scope: document integrity only. Application and product acceptance have not run.')
