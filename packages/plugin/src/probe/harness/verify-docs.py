"""Run docs/engineering/tools/check_docs.py with vendor trees excluded.

Why this exists
---------------
`check_docs.py` validates every relative Markdown link under the repository root
with `Path.rglob('*.md')` and no vendor exclusion. Once `pnpm install` creates
the workspace `node_modules/`, third-party packages fail that check on links to
files they never shipped (`node_modules/debug/README.md: broken link
./examples/node/app.js`, and ~40 more). That failure says nothing about AIKanBan
docs, but it makes `check_docs.py` unusable as an acceptance gate.

This script execs the real checker **unchanged except for that one scan**, so its
PASS/FAIL output is exactly what the checker would print with a vendor exclusion
added. It does not modify `check_docs.py`.

    <python> packages/plugin/src/probe/harness/verify-docs.py
"""
import pathlib
import sys

# harness -> probe -> src -> plugin -> packages -> repository root
ROOT = pathlib.Path(__file__).resolve().parents[5]
CHECKER = ROOT / "docs" / "engineering" / "tools" / "check_docs.py"

IGNORED_PARTS = frozenset({"node_modules", ".probe-home", ".probe-out", ".git"})
ORIGINAL = "md_files = list(ROOT.rglob('*.md'))"

if not CHECKER.exists():
    sys.exit(f"check_docs.py not found at {CHECKER}")

source = CHECKER.read_text(encoding="utf-8")
if ORIGINAL not in source:
    sys.exit(f"check_docs.py changed: expected to find {ORIGINAL!r}; update this wrapper")

patched = source.replace(
    ORIGINAL,
    "md_files = sorted(p for p in ROOT.rglob('*.md') "
    f"if {set(IGNORED_PARTS)!r}.isdisjoint(p.relative_to(ROOT).parts))",
)
exec(compile(patched, str(CHECKER), "exec"), {"__file__": str(CHECKER), "__name__": "__main__"})
