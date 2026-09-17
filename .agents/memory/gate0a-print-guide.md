---
name: Gate 0A print guide
description: Print-ready field guides need export-time pagination and text verification.
---

Treat generated field-guide PDFs as a rendered artifact, not just source markup: verify page count, page boundaries, selectable command text, and visual margins after every content change.

**Why:** Chromium can silently push a checklist block onto an extra page while leaving hard-coded footer numbering and section labels looking valid in source.

**How to apply:** Regenerate the PDF, inspect representative rendered pages, run text extraction for required safety stops and commands, and verify the served PDF is the generated file.

Visual equivalence must be checked alongside text: a CSS-only change (colors, borders, layout) leaves extracted text and page count untouched, so text-only comparison silently accepts visual drift. And the pixel tolerance must be a small absolute count, not a percentage of the page — a whole-page fraction waves through localized drift like a recolored 1px rule (~700 changed pixels on a ~1M-pixel page).