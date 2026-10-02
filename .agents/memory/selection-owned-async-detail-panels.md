---
name: Selection-owned async detail panels
description: A "select an entity, fetch its detail" panel must render and mutate only detail whose id matches the current selection; clear stale detail on change and guard async applies with a ref.
---

For any console UI where a selector drives an async detail fetch and the detail offers destructive actions (the Incidents past-alert browser is the canonical case): review rejects naive wiring because a failed or slow load can leave the PREVIOUS entity's detail rendered under the NEW selection, with Delete still armed on the wrong entity.

**The rules that survived review:**
- Render (and arm actions) only when `loadedDetail.id === currentSelection` — a synchronous render-time guard, because effects run after paint.
- Clear the previous detail at the start of the load effect, so a failed load shows the error and nothing else.
- Async refreshes (e.g. post-delete refetch) must capture the target id at call time and apply the result only if a ref-mirrored current selection still equals it; on failure, drop the detail AND surface the error — never silently retain stale actionable rows.
- The delete confirmation should name the owning entity id.

**Why:** a headless-Chromium review reproduction confirmed a confirm-delete click landing on the previous incident's clip id while the selector showed the new incident — a destructive action on the wrong record, not just stale presentation.

**How to apply:** when adding or modifying a selection-driven detail panel (browse/preview/inspector), apply all four rules up front and add a browser proof for (a) failed selection load and (b) selection change while a post-mutation refresh is in flight (route-hold the refresh with Playwright page.route, assert the late response is dropped).
