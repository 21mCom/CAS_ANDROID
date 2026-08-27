---
name: API client generation
description: Compatibility constraints when regenerating OpenAPI TypeScript clients in this workspace.
---

OpenAPI regeneration must be followed by the library typecheck. The installed Zod major version may not support every helper emitted by the generator, and the generated types barrel can overlap with the package's explicit exports.

**Why:** A successful generator run can still leave the shared API package uncompilable, which then blocks every dependent package.

**How to apply:** After changing the OpenAPI document, run the API codegen and `typecheck:libs`; preserve the package's explicit type exports and adapt generated schema helpers to the installed Zod API when needed.