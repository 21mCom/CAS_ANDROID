---
name: pwsh captured-error phrase assertions
description: Phrase assertions on `2>&1 | Out-String` captures of a failing child pwsh break under ConciseView wrapping — strip " | " prefixes and collapse whitespace before matching.
---

When a CI step captures a child pwsh's failing output (`& pwsh -File ... 2>&1 | Out-String`) and asserts a multi-word phrase with `-match`, the assertion fails in CI even when the message is correct: pwsh 7's ConciseView wraps the error message at the non-interactive host width and prefixes every continuation line with `     | `, which can land *inside* the phrase. Collapsing whitespace alone is not enough — the pipe characters remain inside the phrase.

Working normalization before matching: `(($output -replace '\|', ' ') -replace '\s+', ' ')`. Safe for packager/workflow messages that contain no literal `|`.

**Why:** The mvp-handoff same-path refusal negative test failed on real CI twice (2026-09-28 and 2026-09-30) with "failed without explaining why the overwrite was refused" while the packager refused correctly — first unfixed, then with whitespace-collapse only. The pipe-strip version was verified locally against the real ConciseView renderer (child throw → 2>&1 | Out-String → flattened match) and then went green on CI.

**How to apply:** Any time a workflow or harness greps captured pwsh *error* output for a phrase longer than ~40 chars, normalize with the pipe-strip + whitespace-collapse first, and verify locally with a child-pwsh throw reproducer before burning a CI run. Plain Write-Host output is not pipe-prefixed; only error rendering is.
