---
name: Drizzle raw execute returns unparsed timestamps
description: tx.execute(sql`...`) rows in this stack hand timestamptz columns back as strings, not Date objects — coerce before calling Date methods.
---

Rows returned from `db.execute(sql`...`)` / `tx.execute(sql`...`)` (the raw SQL escape hatch used for `SELECT ... FOR UPDATE` locks) come back with `timestamp with time zone` columns as **strings**, even though the same column read through `db.select()` is a `Date`.

**Why:** a receipt-staleness check calling `row.last_requeued_at.getTime()` on a raw row threw `TypeError: getTime is not a function` and surfaced as a 500; the typed Drizzle select path never has this problem, which is why it went unnoticed until a contract test exercised the raw path.

**How to apply:** when adding a raw `sql`` query that selects timestamp columns (e.g. the row-lock read in `handleDeviceReceipt`), type the field as `string | Date | null` and normalize with `new Date(value)` before comparing or formatting. Prefer `db.select()` over raw SQL whenever the `FOR UPDATE` lock is not the reason for going raw.
