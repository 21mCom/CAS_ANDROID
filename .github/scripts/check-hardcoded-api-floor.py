#!/usr/bin/env python3
"""Fail if kit scripts hardcode the Android API floor instead of deriving it
from tool-requirements.json.

tool-requirements.json is the single source of truth for the Android SDK
platform. The sibling drift gate (check-tool-requirements-drift.py) only
catches literals that DISAGREE with the declaration, so a script that
hardcodes the currently declared floor — `-lt 35`, "API 35 or newer" — stays
green today and silently forks the floor at the next declaration bump. This
drift class has already occurred twice (measure-gate0a.sh and
scripts/mvp-install.ps1). This gate therefore rejects API-level literals in
script files (*.ps1, *.cmd, *.sh) outright, regardless of whether they
currently match the declaration:

    -lt 35                  -ge 35                  (any PowerShell/cmd-style
                                                     comparison against a
                                                     plausible API integer,
                                                     including -ceq/-ine
                                                     variants)
    (( x >= 35 ))           [[ x -lt 35 ]]          (shell arithmetic)
    API 35                                          (keyword literal)
    android-35                                      (platform literal)
    apiLevel = 35                                   (bare assignment)
    CAS_Pixel_8a_API_35                             (pinned AVD name literal)

Docs (*.md) are not scanned: they may state the declared values as long as
they agree, and the drift gate covers their disagreement. Scripts must DERIVE
the floor from tool-requirements.json instead of repeating it.

Deliberate hardcodes (for example the preflight's built-in fallback used when
the declaration file is missing, or the preflight self-test's altered
requirements fixture) are exempted with an explicit marker:

    # apifloor-gate: allow-begin -- <reason>
    ...exempted lines...
    # apifloor-gate: allow-end

or a single-line form:

    ... # apifloor-gate: allow -- <reason>

The marker requires a non-empty reason so an exemption cannot be added
lazily. Unbalanced block markers fail the gate.

Exit codes: 0 = no hardcodes, 1 = hardcode or marker misuse, 2 = usage error
(the scan root is missing).
"""

from __future__ import annotations

import os
import re
import sys

SCAN_EXTENSIONS = {".ps1", ".cmd", ".sh"}
SKIP_DIRECTORIES = {".gradle", "build", ".git"}

# Comparisons against integers in this band are treated as API-floor
# hardcodes: low enough to catch an outdated floor, high enough to leave room
# for the next declaration bumps, and above the 0/1 sentinel comparisons the
# scripts use for counts and exit codes.
API_BAND_MIN = 20
API_BAND_MAX = 49

ALLOW_LINE = re.compile(r"apifloor-gate:\s*allow\s+--\s*(\S.*)")
ALLOW_BEGIN = re.compile(r"apifloor-gate:\s*allow-begin\s+--\s*(\S.*)")
ALLOW_END = re.compile(r"apifloor-gate:\s*allow-end\s*$")

# (regex capturing the literal in group 1, kind label, band-filtered?)
def build_patterns() -> list[tuple[re.Pattern[str], str, bool]]:
    return [
        # PowerShell/cmd-style operators (-lt, -ge, -ceq, -ine, ...) and the
        # same spellings inside bash [[ ... ]] / test comparisons.
        (re.compile(r"-[ci]?(?:lt|le|gt|ge|eq|ne)\s+\$?\(?\s*(\d+)\b", re.IGNORECASE),
         "API-level comparison", True),
        # C-style operators inside shell arithmetic or [[ ... ]].
        (re.compile(r"(?:>=|<=|==|!=)\s*\$?\(?\s*(\d+)\b"),
         "API-level comparison", True),
        # Bare < / > are only compared inside (( ... )) arithmetic; elsewhere
        # they are redirections.
        (re.compile(r"\(\(.*?(?<![<>=!])[<>]\s*\$?\(?\s*(\d+)\b"),
         "API-level comparison", True),
        # Bare assignment form used by the preflight's fallback block.
        (re.compile(r"\bapiLevel\s*=\s*\(?\s*(\d+)\b"),
         "apiLevel assignment", False),
        # Keyword literals: in a script these must be derived, never repeated,
        # even when they match the declaration.
        (re.compile(r"\bAPI\s+(\d+)\b"), "API keyword literal", False),
        (re.compile(r"\bandroid-(\d+)\b"), "SDK platform literal", False),
        (re.compile(r"\bCAS_Pixel_8a_API_(\d+)\b"), "pinned AVD name literal", False),
    ]


def iter_scan_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRECTORIES]
        for name in sorted(filenames):
            if os.path.splitext(name)[1].lower() in SCAN_EXTENSIONS:
                yield os.path.join(dirpath, name)


def check_file(path: str, root: str, patterns) -> list[str]:
    rel = os.path.relpath(path, root)
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()

    violations: list[str] = []
    exempt_block = False
    block_start = 0
    for lineno, line in enumerate(lines, start=1):
        if ALLOW_BEGIN.search(line):
            if exempt_block:
                violations.append(f"{rel}:{lineno}: nested apifloor-gate allow-begin (block opened at line {block_start}).")
            exempt_block = True
            block_start = lineno
            continue
        if ALLOW_END.search(line):
            if not exempt_block:
                violations.append(f"{rel}:{lineno}: apifloor-gate allow-end without a matching allow-begin.")
            exempt_block = False
            continue
        if exempt_block or ALLOW_LINE.search(line):
            continue
        for pattern, kind, band_filtered in patterns:
            # Check EVERY occurrence on the line: one exempt-looking mention
            # must not hide a second hardcode later on the same line.
            for match in pattern.finditer(line):
                value = match.group(1)
                if band_filtered and not (API_BAND_MIN <= int(value) <= API_BAND_MAX):
                    continue
                violations.append(
                    f"{rel}:{lineno}: {kind} '{value}' bypasses tool-requirements.json; "
                    f"scripts must derive the Android API floor from the declaration: {line.strip()[:160]}"
                )
    if exempt_block:
        violations.append(f"{rel}:{block_start}: apifloor-gate allow-begin is never closed with allow-end.")
    return violations


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <kit-root>", file=sys.stderr)
        return 2
    root = os.path.abspath(sys.argv[1])
    if not os.path.isdir(root):
        print(f"::error::Kit root does not exist: {root}", file=sys.stderr)
        return 2

    patterns = build_patterns()
    print(
        f"Scanning scripts for hardcoded Android API-floor literals "
        f"(comparison band {API_BAND_MIN}-{API_BAND_MAX}); the floor must derive from tool-requirements.json."
    )

    violations: list[str] = []
    scanned = 0
    for path in iter_scan_files(root):
        scanned += 1
        violations.extend(check_file(path, root, patterns))

    if violations:
        print(f"::error::Hardcoded API-floor gate failed: {len(violations)} violation(s) in {scanned} scanned script file(s).")
        for violation in violations:
            print(f"HARDCODE {violation}")
        print(
            "Derive the value from tool-requirements.json instead of repeating a literal, or "
            "(only for deliberate fixtures/fallbacks) exempt the line with "
            "'apifloor-gate: allow -- <reason>'."
        )
        return 1

    print(f"Hardcoded API-floor gate passed: {scanned} script file(s) scanned, no hardcoded literals.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
