#!/usr/bin/env python3
"""Fail if packaged docs/scripts reintroduce JDK/SDK/build-tools literals that
disagree with tool-requirements.json.

tool-requirements.json is the single source of truth for the JDK minimum, SDK
platform, and build-tools minimum; docs reference it instead of repeating
literals. This gate greps the packaged kit's human-readable files (*.md,
*.ps1, *.cmd, *.sh) for literal forms a future edit might reintroduce:

    JDK 17            jdk-17            OpenJDK 21
    Java 17
    android-35        (also matches platforms;android-35 and system-images;android-35)
    API 35
    build-tools;35.0.0      build-tools 35.0.0

A literal is a violation only when it DISAGREES with the declared value, so
both drift directions are caught: a stale literal added while the declaration
stays put, and a declaration bump that leaves old literals behind.

Deliberate non-matching values (for example the preflight self-test's altered
requirements fixture, which must differ from the declared values to prove the
thresholds are not hardcoded) are exempted with an explicit marker:

    # toolreq-gate: allow-begin -- <reason>
    ...exempted lines...
    # toolreq-gate: allow-end

or a single-line form:

    ... # toolreq-gate: allow -- <reason>

The marker requires a non-empty reason so an exemption cannot be added
lazily. Unbalanced block markers fail the gate.

Exit codes: 0 = no drift, 1 = drift or marker misuse, 2 = the declaration
itself is missing/invalid (the gate's reference is broken).
"""

from __future__ import annotations

import json
import os
import re
import sys

SCAN_EXTENSIONS = {".md", ".ps1", ".cmd", ".sh"}
SKIP_DIRECTORIES = {".gradle", "build", ".git"}

ALLOW_LINE = re.compile(r"toolreq-gate:\s*allow\s+--\s*(\S.*)")
ALLOW_BEGIN = re.compile(r"toolreq-gate:\s*allow-begin\s+--\s*(\S.*)")
ALLOW_END = re.compile(r"toolreq-gate:\s*allow-end\s*$")
ALLOW_ANY = re.compile(r"toolreq-gate:\s*allow")


def build_patterns(jdk: int, api: int, build_tools: str) -> list[tuple[re.Pattern[str], str, str]]:
    """Each entry: (regex capturing the literal in group 1, kind label, expected value)."""
    return [
        (re.compile(r"(?i)\bjdk[\s-]?(\d+)\b"), "JDK major", str(jdk)),
        (re.compile(r"\bJava\s+(\d+)\b"), "JDK major", str(jdk)),
        (re.compile(r"\bandroid-(\d+)\b"), "SDK platform", str(api)),
        (re.compile(r"\bAPI\s+(\d+)\b"), "SDK API level", str(api)),
        (re.compile(r"(?i)\bbuild-tools;(\d+\.\d+\.\d+)\b"), "build-tools", build_tools),
        (re.compile(r"(?i)\bbuild-tools\s+(\d+\.\d+\.\d+)\b"), "build-tools", build_tools),
    ]


def load_requirements(root: str) -> tuple[int, int, str, str]:
    path = os.path.join(root, "tool-requirements.json")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        jdk = int(data["jdk"]["minimumMajor"])
        api = int(data["androidSdk"]["apiLevel"])
        platform = str(data["androidSdk"]["platform"])
        build_tools = str(data["androidSdk"]["buildToolsMinimum"])
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"::error::Cannot read declared tool requirements from {path}: {exc}", file=sys.stderr)
        sys.exit(2)
    if jdk < 1 or api < 1:
        print(f"::error::tool-requirements.json declares implausible values (jdk={jdk}, apiLevel={api}).", file=sys.stderr)
        sys.exit(2)
    if platform != f"android-{api}":
        print(
            f"::error::tool-requirements.json is internally inconsistent: platform {platform!r} "
            f"does not match apiLevel {api}. The drift gate cannot trust the declaration.",
            file=sys.stderr,
        )
        sys.exit(2)
    if not re.fullmatch(r"\d+\.\d+\.\d+", build_tools):
        print(f"::error::buildToolsMinimum {build_tools!r} is not an X.Y.Z version.", file=sys.stderr)
        sys.exit(2)
    return jdk, api, platform, build_tools


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
                violations.append(f"{rel}:{lineno}: nested toolreq-gate allow-begin (block opened at line {block_start}).")
            exempt_block = True
            block_start = lineno
            continue
        if ALLOW_END.search(line):
            if not exempt_block:
                violations.append(f"{rel}:{lineno}: toolreq-gate allow-end without a matching allow-begin.")
            exempt_block = False
            continue
        if exempt_block or ALLOW_LINE.search(line):
            continue
        for pattern, kind, expected in patterns:
            # Check EVERY occurrence on the line: a declared value mentioned
            # first must not hide a stale literal of the same kind later on
            # the same line.
            for match in pattern.finditer(line):
                if match.group(1) != expected:
                    violations.append(
                        f"{rel}:{lineno}: {kind} literal '{match.group(1)}' disagrees with "
                        f"tool-requirements.json (declared {expected}): {line.strip()[:160]}"
                    )
    if exempt_block:
        violations.append(f"{rel}:{block_start}: toolreq-gate allow-begin is never closed with allow-end.")
    return violations


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <kit-root>", file=sys.stderr)
        return 2
    root = os.path.abspath(sys.argv[1])
    if not os.path.isdir(root):
        print(f"::error::Kit root does not exist: {root}", file=sys.stderr)
        return 2

    jdk, api, platform, build_tools = load_requirements(root)
    patterns = build_patterns(jdk, api, build_tools)
    print(
        f"Declared requirements: JDK {jdk}+, {platform} (API {api}), build-tools {build_tools}+. "
        f"Scanning docs/scripts for disagreeing literals."
    )

    violations: list[str] = []
    scanned = 0
    for path in iter_scan_files(root):
        scanned += 1
        violations.extend(check_file(path, root, patterns))

    if violations:
        print(f"::error::Tool-requirements drift gate failed: {len(violations)} violation(s) in {scanned} scanned file(s).")
        for violation in violations:
            print(f"DRIFT {violation}")
        print(
            "Either update the literal to match tool-requirements.json, reference the declaration "
            "instead of repeating a literal, or (only for deliberate non-matching fixtures) exempt "
            "the line with 'toolreq-gate: allow -- <reason>'."
        )
        return 1

    print(f"Tool-requirements drift gate passed: {scanned} file(s) scanned, no disagreeing literals.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
