---
name: uiautomator-driven emulator harness lessons
description: Three non-obvious uiautomator/adb behaviors that cost three CI iterations of the send-outcome-line harness; read before writing any UI-driving emulator test.
---

Lessons from getting the first UI-driving emulator harness (verify-send-outcome-line.sh) green on CI:

1. **Button labels are ALL-CAPS in the accessibility tree.** Android's default Button style applies textAllCaps; uiautomator dump reports the TRANSFORMED text. `Send MVP alert now` in Kotlin appears as `SEND MVP ALERT NOW` in dumps. Grep the transformed form (or dump once and look).
2. **uiautomator dump serializes ONLY the visible viewport.** Off-screen ScrollView children are absent from the XML, so "find text, else swipe" loops must re-dump after every position change, and an off-screen target can be sailed past between dumps.
3. **`input swipe` cannot go slow enough to avoid flinging.** Even a 0.25-screen 700-800ms drag exceeds ScrollView's fling velocity threshold, so overshoot in either direction is always possible. Use a sweep-with-reversal loop: scroll until the viewport digest (visible-text list) stops changing, reverse direction, repeat. Log the per-pass digest — it makes CI failures self-diagnosing.

**Why:** Three consecutive CI runs failed Phase A while the app, button, and scroll were all fine — run 1 flung past the button, run 2's digests revealed the all-caps needle mismatch. Each blind CI iteration costs ~10 minutes.

**How to apply:** Any harness that taps in a scrollable screen: match all-caps button labels, assert on visible-viewport dumps only, use sweep-with-reversal with digest logging, and prefer journal/event polling (fast, on-device) to know when to spend a dump.
