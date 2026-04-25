# @seaking/validators

Shared Zod schemas for Sea King API boundaries.

## Why this package exists

Every server action, route handler, and Edge Function must validate its inputs before touching the database. Having one place for the common primitives (cents, bps, ISO dates, UUIDs) means the same shape is enforced everywhere.

## Public API

Re-exports `zod` plus the schemas listed below. Import from the package root:

```ts
import { z, isoDateSchema, centsSchema, uuidSchema, ... } from '@seaking/validators';
```

### Primitives (`src/primitives.ts`)

- `isoDateSchema` — "YYYY-MM-DD"
- `centsSchema`, `signedCentsSchema` — integer cents
- `bpsSchema` — basis points 0-10000
- `uuidSchema`
- `nonEmptyStringSchema`

### Workflow schemas

| Module | Exports | Used by |
|---|---|---|
| `src/clients.ts` | `clientStatusSchema`, `createClientInputSchema`, `updateClientInputSchema` | Client CRUD server actions |
| `src/rule-sets.ts` | `ruleSetInputSchema` plus `pctToBps` / `bpsToPct` helpers | Borrowing-base + Fee Rules editor |
| `src/users.ts` | `userRoleSchema`, `inviteUserInputSchema`, `updateUserInputSchema` | User invitation + edit flows |
| `src/po-uploads.ts` | `retailerSlugSchema`, `poUploadContextSchema`, plus `PoUploadPreview` / `PoUploadCommitResult` types | PO upload preview + commit actions |
| `src/advances.ts` | `advanceAllocationSchema`, `commitPoAdvanceInputSchema`, `reassignToBatchInputSchema` | Advance on POs commit action + standalone Assign-to-Batch screen |

**Convention**: one file per workflow. `src/index.ts` re-exports everything. New workflow → new file → add to index. Avoids a single bloated module as the schema set grows.

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
