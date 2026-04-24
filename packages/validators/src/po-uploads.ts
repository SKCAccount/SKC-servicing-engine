/**
 * Shared types for the PO upload workflow.
 *
 * The wire shape between parse (preview) and commit (persist) server actions
 * lives here so both sides agree on what summary data the review UI reads.
 */

import { z } from 'zod';
import { uuidSchema } from './primitives';

export const retailerSlugSchema = z.enum(['walmart', 'kroger', 'generic']);
export type RetailerSlug = z.infer<typeof retailerSlugSchema>;

/** Input shape for the preview + commit server actions. */
export const poUploadContextSchema = z.object({
  client_id: uuidSchema,
  retailer_slug: retailerSlugSchema,
  /** true = don't overwrite existing POs; false = overwrite. */
  skip_duplicates: z.boolean().default(false),
});
export type PoUploadContext = z.infer<typeof poUploadContextSchema>;

/**
 * Summary rendered by the review UI. Assembled by parsePoUploadAction,
 * passed back to the browser for display, never persisted.
 */
export interface PoUploadPreview {
  parser_version: string;
  /** Total rows the parser read from the file. */
  total_rows_read: number;
  /** Rows the parser would create. */
  rows_to_add: number;
  /** Rows the parser would update (pre-existing POs). */
  rows_to_update: number;
  /** Rows the parser skipped (malformed source row). */
  rows_skipped: number;
  /** Rows the parser flagged cancelled. */
  rows_cancelled: number;
  /** Rows the parser wrote line-level data for (0 for header-only uploads). */
  line_rows: number;
  /** Total new PO value added (from the 'would-add' subset). */
  new_po_value_cents: number;
  /** The PO numbers that already exist — useful to visualize overwrites. */
  existing_po_numbers: string[];
  /** Non-fatal warnings. */
  warnings: Array<{ code: string; message: string; row_index?: number }>;
  /** Rows the parser dropped. */
  skipped: Array<{ reason: string; row_index: number }>;
  /** A very short sample of the records that will land — first 20. */
  sample_rows: Array<{
    po_number: string;
    po_value_cents: number;
    status: string;
    issuance_date: string | null;
  }>;
}

export interface PoUploadCommitResult {
  upload_id: string;
  inserted: number;
  updated: number;
  skipped: number;
  lines_replaced: number;
  lines_inserted: number;
}
