---
name: Generated database artifacts
description: Workspace packages may consume generated database declarations rather than source files during TypeScript checks.
---

When database schema exports change, regenerate the library build artifacts before typechecking dependent packages.

**Why:** Dependent workspace packages can otherwise report missing exports even when the source schema is correct.

**How to apply:** Run the workspace library typecheck/build step before diagnosing schema export errors in an API package.