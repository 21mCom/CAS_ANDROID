---
name: OpenAPI integer compatibility
description: The generated API Zod package currently uses Zod 3 while Orval emits zod.int for OpenAPI integer fields.
---

OpenAPI integer fields can break generated declarations and runtime imports because the workspace's Zod 3 build does not expose `zod.int()`. Use a numeric OpenAPI representation when codegen is required, and enforce integer/safe-number semantics in the server boundary.

**Why:** Regenerating a contract with integer fields produced `zod.int is not a function` and prevented both typechecking and API tests from starting.

**How to apply:** When adding integer-valued API fields, check generated Zod compatibility before committing; keep strict integer validation in the authoritative server schema if the generated contract must use `number`.