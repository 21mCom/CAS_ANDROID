---
name: Manifest shortcut shadows pinned shortcut disguise
description: A static manifest shortcut sharing an ID with a pinned shortcut overrides the pinned shortcut's runtime label/icon — and deleting the manifest entry disables old pins on upgrade.
---

Two coupled Android shortcut traps:

1. **Shadowing:** if a manifest-declared static shortcut and a `requestPinShortcut` ShortcutInfo share the same ID, the system pins the *manifest* entry — the launcher shows the static resource label/icon and ignores dynamically composed metadata (custom label, composited bitmap icon).
2. **Upgrade immutability:** pinned manifest shortcuts stay bound to the manifest entry. If a later build removes the manifest declaration, existing pins become permanently disabled — they cannot be re-enabled or mutated via ShortcutManager, and a re-pin request with the same disabled ID fails.

**Why:** both were hit while disguising a pinned shortcut with a cover app's runtime-composed name/icon; each silently breaks either the disguise or every existing pin.

**How to apply:** a pinned shortcut that needs runtime-composed label/icon must use an ID that has never appeared in res/xml/shortcuts.xml, and a manifest shortcut ID once shipped must keep its manifest entry forever.
