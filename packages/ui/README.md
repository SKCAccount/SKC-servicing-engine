# @seaking/ui

Shared UI primitives and shadcn/ui components.

Phase 1A: just `cn()` (Tailwind-aware class composer) and `displayCents` / `displayBigIntCents` money formatters. Components land here as the UIs grow.

## Convention

- One component per file under `src/components/`.
- Export individually from `index.ts` so bundlers can drop unused.
- No side-effects at module load; no hardcoded colors — use Tailwind tokens.
