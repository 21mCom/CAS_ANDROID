#!/usr/bin/env python3
"""Fail if kit scripts hardcode the JDK minimum instead of deriving it from
tool-requirements.json.

This is the JDK-axis sibling of check-hardcoded-api-floor.py. The drift gate
(check-tool-requirements-drift.py) only catches JDK literals that DISAGREE
with the declaration and needs a keyword form ("JDK 17", "jdk-17",
"Java 17") to match at all. A bare comparison like `-lt 17` carries no JDK
keyword and compares against a value below the API-floor gate's 20-49 band,
so neither existing gate would catch a script that re-hardcodes the declared
JDK minimum the way the API floor was hardcoded twice before. This gate
closes that hole: it rejects comparisons against plausible JDK majors in
script files (*.ps1, *.cmd, *.sh) outright, regardless of whether they
currently match the declaration:

    -lt 17                  -ge 21                  (any PowerShell/cmd-style
                                                     comparison against a
                                                     plausible JDK major,
                                                     including -ceq/-ine
                                                     variants)
    (( x >= 17 ))           [[ x -lt 17 ]]          (shell arithmetic)

Only comparison forms are scanned. Bare assignments (for example the
preflight parser regression fixtures' deliberately varied ExpectedMajor
values) and keyword literals are out of scope: keyword literals that
disagree with the declaration are the drift gate's job. Scripts must DERIVE
the JDK minimum from tool-requirements.json instead of repeating it.

Deliberate hardcodes (for example the preflight self-test's altered
requirements fixture, whose injected minimum must differ from the declared
value) are exempted with an explicit marker:

    # jdkfloor-gate: allow-begin -- <reason>
    ...exempted lines...
    # jdkfloor-gate: allow-end

or a single-line form:

    ... # jdkfloor-gate: allow -- <reason>

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

# Comparisons against integers in this band are treated as JDK-minimum
# hardcodes: low enough to catch a legacy Java 8 floor, high enough to leave
# room for the next declaration bumps, and above the 0/1/2 sentinel
# comparisons the scripts use for counts and exit codes. The band overlaps
# the API-floor gate's 20-49 band on purpose: a comparison in the overlap is
# a hardcode on at least one axis, and both gates turning red is preferable
# to a gap between them.
JDK_BAND_MIN = 8
JDK_BAND_MAX = 30

ALLOW_LINE = re.compile(r"jdkfloor-gate:\s*allow\s+--\s*(\S.*)")
ALLOW_BEGIN = re.compile(r"jdkfloor-gate:\s*allow-begin\s+--\s*(\S.*)")
ALLOW_END = re.compile(r"jdkfloor-gate:\s*allow-end\s*$")


def build_patterns() -> list[tuple[re.Pattern[str], str]]:
    """Each entry: (regex capturing the literal in group 1, kind label)."""
    return [
        # PowerShell/cmd-style operators (-lt, -ge, -ceq, -ine, ...) and the
        # same spellings inside bash [[ ... ]] / test comparisons.
        (re.compile(r"-[ci]?(?:lt|le|gt|ge|eq|ne)\s+\$?\(?\s*(\d+)\b", re.IGNORECASE),
         "JDK-major comparison"),
        # C-style operators inside shell arithmetic or [[ ... ]].
        (re.compile(r"(?:>=|<=|==|!=)\s*\$?\(?\s*(\d+)\b"),
         "JDK-major comparison"),
        # Bare < / > are only compared inside (( ... )) arithmetic; elsewhere
        # they are redirections.
        (re.compile(r"\(\(.*?(?<![<>=!])[<>]\s*\$?\(?\s*(\d+)\b"),
         "JDK-major comparison"),
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
                violations.append(f"{rel}:{lineno}: nested jdkfloor-gate allow-begin (block opened at line {block_start}).")
            exempt_block = True
            block_start = lineno
            continue
        if ALLOW_END.search(line):
            if not exempt_block:
                violations.append(f"{rel}:{lineno}: jdkfloor-gate allow-end without a matching allow-begin.")
            exempt_block = False
            continue
        if exempt_block or ALLOW_LINE.search(line):
            continue
        for pattern, kind in patterns:
            # Check EVERY occurrence on the line: one exempt-looking mention
            # must not hide a second hardcode later on the same line.
            for match in pattern.finditer(line):
                value = match.group(1)
                if not (JDK_BAND_MIN <= int(value) <= JDK_BAND_MAX):
                    continue
                violations.append(
                    f"{rel}:{lineno}: {kind} '{value}' bypasses tool-requirements.json; "
                    f"scripts must derive the JDK minimum from the declaration: {line.strip()[:160]}"
                )
    if exempt_block:
        violations.append(f"{rel}:{block_start}: jdkfloor-gate allow-begin is never closed with allow-end.")
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
        f"Scanning scripts for hardcoded JDK-minimum comparisons "
        f"(comparison band {JDK_BAND_MIN}-{JDK_BAND_MAX}); the minimum must derive from tool-requirements.json."
    )

    violations: list[str] = []
    scanned = 0
    for path in iter_scan_files(root):
        scanned += 1
        violations.extend(check_file(path, root, patterns))

    if violations:
        print(f"::error::Hardcoded JDK-minimum gate failed: {len(violations)} violation(s) in {scanned} scanned script file(s).")
        for violation in violations:
            print(f"HARDCODE {violation}")
        print(
            "Derive the value from tool-requirements.json instead of repeating a literal, or "
            "(only for deliberate fixtures/fallbacks) exempt the line with "
            "'jdkfloor-gate: allow -- <reason>'."
        )
        return 1

    print(f"Hardcoded JDK-minimum gate passed: {scanned} script file(s) scanned, no hardcoded comparisons.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
