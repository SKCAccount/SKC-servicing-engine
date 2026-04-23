# @seaking/api

Shared API types for server-action and route-handler input/output contracts.

Phase 1A: just the `ActionResult<T>` discriminated union (`{ ok: true } | { ok: false }`) plus `ok()` / `err()` helpers. Workflow-specific schemas get added here (or in `@seaking/validators`) as they're built.
