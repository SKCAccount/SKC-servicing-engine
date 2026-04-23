# @seaking/validators

Shared Zod schemas for Sea King API boundaries.

## Why this package exists

Every server action, route handler, and Edge Function must validate its inputs before touching the database. Having one place for the common primitives (cents, bps, ISO dates, UUIDs) means the same shape is enforced everywhere.

## Public API

Re-exports `zod` plus shared primitives:

- `isoDateSchema` — "YYYY-MM-DD"
- `centsSchema`, `signedCentsSchema` — integer cents
- `bpsSchema` — basis points 0-10000
- `uuidSchema`
- `nonEmptyStringSchema`

## Usage

```ts
import { z, isoDateSchema, centsSchema, uuidSchema } from '@seaking/validators';

const AdvanceInput = z.object({
  clientId: uuidSchema,
  advanceDate: isoDateSchema,
  amountCents: centsSchema,
});

type AdvanceInput = z.infer<typeof AdvanceInput>;
```

Phase 1 schemas for POs, invoices, payments, etc., will be added as each workflow is built. Keep one file per workflow under `src/` to avoid a single bloated module.
