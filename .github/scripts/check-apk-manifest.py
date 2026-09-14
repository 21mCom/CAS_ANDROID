#!/usr/bin/env python3
"""Verify the built Gate 0A APK manifest declares CATEGORY_DEFAULT on the
PROXY_TRIGGER intent filter.

Input: the output of `aapt dump xmltree <apk> AndroidManifest.xml`, which is an
indented tree of lines like:

    E: intent-filter (line=25)
      E: action (line=26)
        A: android:name(0x01010003)="com.covertalert.pixeltest.action.PROXY_TRIGGER" ...

Indentation (leading spaces) encodes tree depth. The check finds the
intent-filter element that owns the PROXY_TRIGGER action and asserts a
category element named android.intent.category.DEFAULT exists inside the same
filter, so a pinned-shortcut launch cannot fail with an intent-resolution
error on the field device.
"""

from __future__ import annotations

import re
import sys

PROXY_TRIGGER = "com.covertalert.pixeltest.action.PROXY_TRIGGER"
CATEGORY_DEFAULT = "android.intent.category.DEFAULT"


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def element_tag(line: str) -> str | None:
    match = re.match(r"\s*E: ([\w-]+)", line)
    return match.group(1) if match else None


def check(dump_path: str) -> list[str]:
    with open(dump_path, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()

    failures: list[str] = []
    filters_checked = 0

    for index, line in enumerate(lines):
        if PROXY_TRIGGER not in line:
            continue

        # Find the enclosing intent-filter: the nearest preceding intent-filter
        # element with a smaller indentation than the PROXY_TRIGGER line. The
        # action's own filter always immediately encloses it, so any earlier
        # sibling filter is farther away and cannot be picked by mistake.
        action_indent = indent_of(line)
        filter_index = None
        for back in range(index - 1, -1, -1):
            if indent_of(lines[back]) < action_indent and element_tag(lines[back]) == "intent-filter":
                filter_index = back
                break
        if filter_index is None:
            failures.append(
                f"PROXY_TRIGGER action (line {index + 1} of dump) is not inside an intent-filter element."
            )
            continue

        filters_checked += 1
        filter_indent = indent_of(lines[filter_index])

        # Scan the filter body for the DEFAULT category, stopping when the
        # filter element closes (indentation returns to the filter level). A
        # category's name is on the A: attribute line below the E: category
        # element line, so track whether we are inside a category element.
        has_default = False
        category_indent = None
        for forward in range(filter_index + 1, len(lines)):
            forward_line = lines[forward]
            forward_indent = indent_of(forward_line)
            if forward_indent <= filter_indent and element_tag(forward_line):
                break
            tag = element_tag(forward_line)
            if tag is not None:
                category_indent = forward_indent if tag == "category" else None
                continue
            if category_indent is not None and forward_indent > category_indent:
                if CATEGORY_DEFAULT in forward_line:
                    has_default = True
                    break
        if not has_default:
            failures.append(
                "The PROXY_TRIGGER intent-filter is missing "
                f"{CATEGORY_DEFAULT}; pinned-shortcut launches will not resolve."
            )

    if filters_checked == 0 and not failures:
        failures.append(f"No {PROXY_TRIGGER} action found anywhere in the APK manifest dump.")

    return failures


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-apk-manifest.py <aapt-xmltree-dump>", file=sys.stderr)
        return 2
    failures = check(sys.argv[1])
    for failure in failures:
        print(f"::error::{failure}", file=sys.stderr)
    if failures:
        return 1
    print("APK manifest check passed: PROXY_TRIGGER filter includes CATEGORY_DEFAULT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
