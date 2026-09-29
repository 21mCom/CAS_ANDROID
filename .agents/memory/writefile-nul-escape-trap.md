---
name: WriteFile NUL-escape trap
description: "\0 written through the file tools becomes a literal NUL byte; the file turns 'binary' and later exact-match edits fail invisibly"
---

Writing a `\0` escape through the file-editing tools stores a literal NUL
byte (0x00). ReadFile renders it invisibly, so later exact-match edits fail
with a misleading "old_string did not appear verbatim" error, and grep
starts reporting the file as binary.

**Why:** environment tooling quirk, not project code — it cost real
debugging time once and will again.

**How to apply:** put control characters in source via
`String.fromCharCode(0)` instead of escapes; after writing a file that
contains backslash escapes, sanity-check `grep -cP '[\x00-\x08]' <file>`
returns 0.
