/**
 * Validators for the Advance + Batch-management workflows (Phase 1D onward).
 */

import { z } from 'zod';
import { centsSchema, isoDateSchema, uuidSchema } from './primitives';

/** One PO's allocated share inside a single advance commit. */
export const advanceAllocationSchema = z.object({
  purchase_order_id: uuidSchema,
  principal_cents: centsSchema.refine((v) => v > 0, { message: 'must be > 0' }),
});
export type AdvanceAllocationInput = z.infer<typeof advanceAllocationSchema>;

/** Input the server action accepts to commit a PO advance. */
export const commitPoAdvanceInputSchema = z
  .object({
    client_id: uuidSchema,
    advance_date: isoDateSchema,
    /** The Manager picks one or the other on the configure-batch step. */
    existing_batch_id: uuidSchema.nullable(),
    new_batch: z.boolean(),
    /** Per-PO allocation produced by planPoAdvance. Sum > 0; each > 0. */
    allocations: z.array(advanceAllocationSchema).min(1),
    /**
     * Manager has to acknowledge proceeding when any pro-forma ratio
     * exceeds 100%. UI sets this true after they click through the
     * confirmation modal.
     */
    acknowledged_over_advanced: z.boolean(),
    /**
     * Set true when one or more selected POs are currently assigned to a
     * batch DIFFERENT from the destination batch. Committing the advance
     * will reassign those POs (and all of their existing committed/funded
     * advances) to the destination batch — the Manager has to ack this
     * explicitly because batch-level payment math downstream depends on
     * which batch each advance lives in.
     */
    acknowledged_batch_reassignment: z.boolean(),
  })
  .refine(
    (v) => (v.existing_batch_id !== null) !== v.new_batch,
    {
      message: 'Pick exactly one of an existing batch OR new batch.',
      path: ['existing_batch_id'],
    },
  );
export type CommitPoAdvanceInput = z.infer<typeof commitPoAdvanceInputSchema>;

/**
 * Input the standalone Assign-to-Batch screen submits.
 *
 * Same batch-destination convention as commitPoAdvanceInputSchema: pass
 * either an existing_batch_id OR new_batch=true, never both. The
 * acknowledged_batch_reassignment flag is required when any selected PO is
 * currently in a different batch — the RPC re-validates server-side.
 */
export const reassignToBatchInputSchema = z
  .object({
    client_id: uuidSchema,
    purchase_order_ids: z.array(uuidSchema).min(1),
    existing_batch_id: uuidSchema.nullable(),
    new_batch: z.boolean(),
    acknowledged_batch_reassignment: z.boolean(),
  })
  .refine(
    (v) => (v.existing_batch_id !== null) !== v.new_batch,
    {
      message: 'Pick exactly one of an existing batch OR new batch.',
      path: ['existing_batch_id'],
    },
  );
export type ReassignToBatchInput = z.infer<typeof reassignToBatchInputSchema>;
