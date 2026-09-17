---
name: drizzle-zod insert schemas vs route zod
description: createInsertSchema exports from @workspace/db/schema are type-incompatible with the zod instance in api-server routes; hand-write route payload schemas instead.
---

The `insertCas*Schema` exports from `@workspace/db/schema` (drizzle-zod
`createInsertSchema`) fail typecheck when composed into `z.object(...)` inside
artifacts/api-server routes: the generated schema objects don't satisfy the
route file's `ZodTypeAny` because the two packages resolve different zod
implementations.

**Why:** @workspace/db and the api-server each link their own zod, so
drizzle-zod's schema objects don't satisfy the route file's zod types across
that boundary.

**How to apply:** When validating request bodies in artifacts/api-server
routes, define explicit zod schemas in the route file (mirroring the console's
payload types) instead of importing the generated drizzle-zod insert schemas.
The generated declarations for @workspace/db are also stale-prone — see
generated-db-artifacts.md — so rebuild (`pnpm exec tsc -b lib/db`) before
trusting any typecheck result.
