---
name: Gate 0A print guide
description: Print-ready field guides need export-time pagination and text verification.
---

Treat generated field-guide PDFs as a rendered artifact, not just source markup: verify page count, page boundaries, selectable command text, and visual margins after every content change.

**Why:** Chromium can silently push a checklist block onto an extra page while leaving hard-coded footer numbering and section labels looking valid in source.

**How to apply:** Regenerate the PDF, inspect representative rendered pages, run text extraction for required safety stops and commands, and verify the served PDF is the generated file.