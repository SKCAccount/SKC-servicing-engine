'use server';

/**
 * PO Upload — server actions.
 *
 * Two-phase workflow: preview → commit. The file is sent twice rather than
 * cached server-side — Server Actions are stateless and caching introduces
 * abandoned-upload GC for a negligible bandwidth win.
 *
 *   1. parsePoUploadAction(formData) → PoUploadPreview
 *        Reads bytes, runs the retailer-specific parser, resolves
 *        retailer-slugs (for generic uploads) against the retailers
 *        table, queries existing PO numbers per retailer, returns a
 *        summary for the review screen. No DB writes.
 *
 *   2. commitPoUploadAction(formData) → PoUploadCommitResult
 *        Re-parses the file, writes raw bytes to Supabase Storage,
 *        inserts the po_uploads row, calls bulk_upsert_purchase_orders
 *        (migration 0015) to atomically apply changes. For Generic
 *        uploads that span multiple retailers, one RPC is called per
 *        retailer_id group — each group stays atomic in its own
 *        transaction, but cross-retailer groups are independent.
 *
 * Retailer resolution (generic uploads):
 *   - Walmart/Kroger uploads have one implicit retailer — the UI picked it.
 *   - Generic uploads carry retailer per-row in the CSV. We look up each
 *     retailer_slug case-insensitively against retailers.name AND
 *     retailers.display_name. Rows whose slug doesn't resolve are surfaced
 *     in the preview as skipped with reason 'unknown_retailer'. The Manager
 *     can fix the CSV or pre-create the missing retailer row and retry.
 */

import { createSupabaseServerClient, requireAuthUser } from '@seaking/auth/server';
import { createServiceRoleClient } from '@seaking/db';
import { isManager } from '@seaking/auth';
import { ok, err, type ActionResult } from '@seaking/api';
import {
  poUploadContextSchema,
  type PoUploadPreview,
  type PoUploadCommitResult,
  type RetailerSlug,
} from '@seaking/validators';
import { parseWalmartPurchaseOrders } from '@seaking/retailer-parsers/walmart/purchase-orders';
import { parseGenericPurchaseOrders } from '@seaking/retailer-parsers/generic/purchase-orders';
import type {
  NormalizedPoLineRecord,
  NormalizedPoRecord,
  ParseResult,
} from '@seaking/retailer-parsers';
import { supabaseError, zodError } from '@/lib/action-helpers';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';

interface FormInput {
  client_id: string;
  retailer_slug: RetailerSlug;
  skip_duplicates: boolean;
  file: File;
}

/** Pull the three context fields and the file out of FormData with validation. */
function readFormInput(
  formData: FormData,
): { ok: true; data: FormInput } | { ok: false; err: ActionResult<never> } {
  const fileEntry = formData.get('file');
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    return { ok: false, err: err('BAD_REQUEST', 'No file uploaded.') };
  }
  const parsed = poUploadContextSchema.safeParse({
    client_id: formData.get('client_id'),
    retailer_slug: formData.get('retailer_slug'),
    skip_duplicates: formData.get('skip_duplicates') === 'true',
  });
  if (!parsed.success) {
    return { ok: false, err: zodError(parsed.error) };
  }
  return {
    ok: true,
    data: { ...parsed.data, file: fileEntry },
  };
}

async function authorize(clientId: string): Promise<
  | { ok: true; user: { id: string; email: string; role: string } }
  | { ok: false; err: ActionResult<never> }
> {
  let user;
  try {
    user = await requireAuthUser();
  } catch {
    return { ok: false, err: err('UNAUTHENTICATED', 'Please sign in again.') };
  }
  if (!isManager(user.role)) {
    return { ok: false, err: err('FORBIDDEN', 'Only Managers can upload POs.') };
  }
  const supabase = await createSupabaseServerClient();
  const { data: access } = await supabase
    .from('user_client_access')
    .select('client_id')
    .eq('user_id', user.id)
    .eq('client_id', clientId)
    .maybeSingle();
  if (!access) {
    return {
      ok: false,
      err: err('FORBIDDEN', 'You do not have access to this Client.'),
    };
  }
  return { ok: true, user };
}

/** Dispatch to the right parser for the retailer. */
function runParser(slug: RetailerSlug, bytes: ArrayBuffer): ParseResult<NormalizedPoRecord> {
  if (slug === 'walmart') return parseWalmartPurchaseOrders(bytes);
  if (slug === 'generic') return parseGenericPurchaseOrders(bytes);
  throw new Error(
    'Kroger PO parser not yet available. Please upload Kroger POs using the Generic CSV template.',
  );
}

interface RetailerRow {
  id: string;
  name: string;
  display_name: string;
}

/**
 * Resolve a set of retailer slugs (lowercased tokens) to retailer_id.
 * Matches case-insensitively against either retailers.name OR display_name.
 * Returns a map keyed by the lowercase slug; missing entries have no key.
 */
async function resolveRetailerSlugs(slugs: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (slugs.length === 0) return result;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('retailers').select('id, name, display_name');
  const rows = (data ?? []) as RetailerRow[];

  const uniqueSlugs = new Set(slugs);
  for (const r of rows) {
    const candidates = [r.name.toLowerCase(), r.display_name.toLowerCase()];
    for (const c of candidates) {
      if (uniqueSlugs.has(c)) {
        result.set(c, r.id);
      }
    }
  }
  return result;
}

/**
 * For a Walmart/Kroger upload, look up the single retailer by slug.
 * Returns null if the retailer isn't registered (admin needs to seed it).
 */
async function resolveSingleRetailerId(slug: RetailerSlug): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', slug)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Group parser rows by the retailer_id they belong to, bucketing unresolved ones. */
function groupByRetailer(
  rows: NormalizedPoRecord[],
  retailerMap: Map<string, string>,
): {
  byRetailerId: Map<string, NormalizedPoRecord[]>;
  unresolved: NormalizedPoRecord[];
} {
  const byRetailerId = new Map<string, NormalizedPoRecord[]>();
  const unresolved: NormalizedPoRecord[] = [];
  for (const row of rows) {
    const id = retailerMap.get(row.retailer_slug.toLowerCase());
    if (!id) {
      unresolved.push(row);
      continue;
    }
    const bucket = byRetailerId.get(id) ?? [];
    bucket.push(row);
    byRetailerId.set(id, bucket);
  }
  return { byRetailerId, unresolved };
}

/** Fetch existing PO numbers in the given Client+Retailer set, chunked to avoid URL-length issues. */
async function fetchExistingPoNumbers(
  clientId: string,
  retailerId: string,
  poNumbers: string[],
): Promise<Set<string>> {
  if (poNumbers.length === 0) return new Set();
  const supabase = await createSupabaseServerClient();
  const set = new Set<string>();
  for (let i = 0; i < poNumbers.length; i += 500) {
    const chunk = poNumbers.slice(i, i + 500);
    const { data } = await supabase
      .from('purchase_orders')
      .select('po_number')
      .eq('client_id', clientId)
      .eq('retailer_id', retailerId)
      .in('po_number', chunk);
    for (const row of (data ?? []) as { po_number: string }[]) {
      set.add(row.po_number);
    }
  }
  return set;
}

// ============================================================================
// parsePoUploadAction
// ============================================================================

export async function parsePoUploadAction(
  formData: FormData,
): Promise<ActionResult<PoUploadPreview>> {
  const input = readFormInput(formData);
  if (!input.ok) return input.err;

  const authz = await authorize(input.data.client_id);
  if (!authz.ok) return authz.err;

  // Run the parser.
  let parseResult: ParseResult<NormalizedPoRecord>;
  try {
    const bytes = await input.data.file.arrayBuffer();
    parseResult = runParser(input.data.retailer_slug, bytes);
  } catch (e) {
    return err('PARSE_ERROR', e instanceof Error ? e.message : 'Parser threw an unknown error.');
  }

  // Resolve retailer(s). For walmart/kroger there's one; for generic the
  // parser emitted per-row slugs and we resolve them all in one query.
  const warnings = parseResult.warnings.slice(0, 50).map((w) => ({
    code: w.code,
    message: w.message,
    ...(w.row_index !== undefined ? { row_index: w.row_index } : {}),
  }));
  const skipped = parseResult.skipped.slice(0, 50).map((s) => ({
    reason: s.reason,
    row_index: s.row_index,
  }));

  let resolvableRows: NormalizedPoRecord[];
  let existingSet: Set<string>;

  if (input.data.retailer_slug === 'generic') {
    const uniqueSlugs = [
      ...new Set(parseResult.rows.map((r) => r.retailer_slug.toLowerCase())),
    ];
    const retailerMap = await resolveRetailerSlugs(uniqueSlugs);
    const { byRetailerId, unresolved } = groupByRetailer(parseResult.rows, retailerMap);
    resolvableRows = [...byRetailerId.values()].flat();

    // Surface unresolved retailer rows as additional 'skipped' entries so the
    // review UI shows them. These are NOT in parseResult.skipped — the parser
    // can't know which retailers are registered.
    for (const row of unresolved) {
      skipped.push({
        reason: `unknown_retailer:${row.retailer_slug}`,
        row_index: -1, // parser doesn't track row-index by row after grouping
      });
    }

    // Existing PO lookup per retailer.
    existingSet = new Set();
    for (const [retailerId, group] of byRetailerId) {
      const existing = await fetchExistingPoNumbers(
        input.data.client_id,
        retailerId,
        group.map((r) => r.po_number),
      );
      for (const n of existing) existingSet.add(n);
    }
  } else {
    const retailerId = await resolveSingleRetailerId(input.data.retailer_slug);
    if (!retailerId) {
      return err('NOT_FOUND', `Retailer "${input.data.retailer_slug}" is not registered.`);
    }
    resolvableRows = parseResult.rows;
    existingSet = await fetchExistingPoNumbers(
      input.data.client_id,
      retailerId,
      resolvableRows.map((r) => r.po_number),
    );
  }

  // Aggregate the summary.
  let rowsToAdd = 0;
  let rowsToUpdate = 0;
  let rowsCancelled = 0;
  let newPoValueCents = 0;
  for (const row of resolvableRows) {
    if (existingSet.has(row.po_number)) {
      rowsToUpdate += 1;
    } else {
      rowsToAdd += 1;
      newPoValueCents += row.po_value_cents as number;
    }
    if (row.status === 'cancelled') rowsCancelled += 1;
  }

  const preview: PoUploadPreview = {
    parser_version: parseResult.parser_version,
    total_rows_read: parseResult.stats.total_rows_read,
    rows_to_add: rowsToAdd,
    rows_to_update: rowsToUpdate,
    rows_skipped:
      parseResult.stats.skipped_rows + (parseResult.rows.length - resolvableRows.length),
    rows_cancelled: rowsCancelled,
    line_rows: parseResult.stats.line_rows ?? 0,
    new_po_value_cents: newPoValueCents,
    existing_po_numbers: [...existingSet],
    warnings,
    skipped,
    sample_rows: resolvableRows.slice(0, 20).map((r) => ({
      po_number: r.po_number,
      po_value_cents: r.po_value_cents as number,
      status: r.status,
      issuance_date: r.issuance_date,
    })),
  };

  return ok(preview);
}

// ============================================================================
// commitPoUploadAction
// ============================================================================

export async function commitPoUploadAction(
  formData: FormData,
): Promise<ActionResult<PoUploadCommitResult>> {
  const input = readFormInput(formData);
  if (!input.ok) return input.err;

  const authz = await authorize(input.data.client_id);
  if (!authz.ok) return authz.err;

  let parseResult: ParseResult<NormalizedPoRecord>;
  let fileBytes: ArrayBuffer;
  try {
    fileBytes = await input.data.file.arrayBuffer();
    parseResult = runParser(input.data.retailer_slug, fileBytes);
  } catch (e) {
    return err('PARSE_ERROR', e instanceof Error ? e.message : 'Parser threw an unknown error.');
  }

  // Group rows by retailer_id for the RPC call(s).
  // walmart/kroger: single retailer_id from UI, all rows go to one group.
  // generic: resolve per-row slugs and group by retailer_id; unresolved rows drop.
  const groups = new Map<string, NormalizedPoRecord[]>();
  let unresolvedCount = 0;
  if (input.data.retailer_slug === 'generic') {
    const uniqueSlugs = [
      ...new Set(parseResult.rows.map((r) => r.retailer_slug.toLowerCase())),
    ];
    const retailerMap = await resolveRetailerSlugs(uniqueSlugs);
    const { byRetailerId, unresolved } = groupByRetailer(parseResult.rows, retailerMap);
    for (const [rid, rows] of byRetailerId) groups.set(rid, rows);
    unresolvedCount = unresolved.length;
  } else {
    const retailerId = await resolveSingleRetailerId(input.data.retailer_slug);
    if (!retailerId) {
      return err('NOT_FOUND', `Retailer "${input.data.retailer_slug}" is not registered.`);
    }
    groups.set(retailerId, parseResult.rows);
  }

  if (groups.size === 0) {
    return err('NOTHING_TO_COMMIT', 'No rows in the upload resolve to a registered retailer.');
  }

  // Write file bytes to Storage once per upload — independent of retailer
  // grouping. The po_uploads row shared across all groups.
  const admin = createServiceRoleClient();
  const today = new Date().toISOString().slice(0, 10);
  const storageId = randomUUID();
  const safeFilename = input.data.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${input.data.client_id}/${today}/${storageId}-${safeFilename}`;
  const contentType = input.data.file.type || 'text/csv';

  const { error: uploadError } = await admin.storage
    .from('po-uploads')
    .upload(storagePath, fileBytes, { contentType, upsert: false });
  if (uploadError) {
    return err('STORAGE_UPLOAD_FAILED', uploadError.message);
  }

  // po_uploads row: retailer_id is nullable by schema; for multi-retailer
  // generic uploads we pass null and let the per-retailer grouping on each
  // purchase_order carry the identity.
  const singleRetailerId =
    input.data.retailer_slug === 'generic' && groups.size > 1
      ? null
      : [...groups.keys()][0];

  const userSupabase = await createSupabaseServerClient();
  const { data: uploadRow, error: uploadInsertError } = await userSupabase
    .from('po_uploads')
    .insert({
      client_id: input.data.client_id,
      retailer_id: singleRetailerId,
      uploaded_by: authz.user.id,
      source_filename: input.data.file.name,
      storage_path: storagePath,
      parser_version: parseResult.parser_version,
      row_count: parseResult.rows.length,
    })
    .select('id')
    .single();
  if (uploadInsertError || !uploadRow) {
    await admin.storage.from('po-uploads').remove([storagePath]);
    return supabaseError(uploadInsertError ?? { message: 'Upload row insert failed' });
  }
  const uploadId = (uploadRow as { id: string }).id;

  // Call bulk_upsert once per retailer group. Walmart's line-level rows
  // stay with their PO group (all-Walmart uploads → one group).
  const totals = { inserted: 0, updated: 0, skipped: 0, lines_replaced: 0, lines_inserted: 0 };
  const linesByPoNumber = new Map<string, NormalizedPoLineRecord[]>();
  if (parseResult.lines) {
    for (const line of parseResult.lines) {
      const arr = linesByPoNumber.get(line.po_number) ?? [];
      arr.push(line);
      linesByPoNumber.set(line.po_number, arr);
    }
  }

  let groupsCommitted = 0;
  for (const [retailerId, rows] of groups) {
    const poJson = rows.map((r) => normalizePoForRpc(r));
    const groupPoNumbers = new Set(rows.map((r) => r.po_number));
    const lineRows: NormalizedPoLineRecord[] = [];
    if (parseResult.lines) {
      for (const po of groupPoNumbers) {
        const ls = linesByPoNumber.get(po);
        if (ls) lineRows.push(...ls);
      }
    }
    const linesJson = lineRows.length > 0 ? lineRows.map(normalizeLineForRpc) : null;

    const { data: rpcResult, error: rpcError } = await userSupabase.rpc(
      'bulk_upsert_purchase_orders',
      {
        p_client_id: input.data.client_id,
        p_retailer_id: retailerId,
        p_upload_id: uploadId,
        p_po_rows: poJson,
        p_lines: linesJson,
        p_skip_duplicates: input.data.skip_duplicates,
      },
    );
    if (rpcError) {
      // Cleanup strategy depends on whether anything has committed yet:
      //  - groupsCommitted == 0 → roll back po_uploads + Storage so the
      //    user doesn't have an orphan upload record pointing at a file
      //    with zero rows persisted. Clean failure: nothing left behind.
      //  - groupsCommitted > 0 → leave everything in place. Some groups
      //    succeeded (each in its own atomic txn); the partial state is
      //    real and the Manager needs to see it.
      if (groupsCommitted === 0) {
        await admin.from('po_uploads').delete().eq('id', uploadId);
        await admin.storage.from('po-uploads').remove([storagePath]);
        return supabaseError({
          message: `Upload failed: ${rpcError.message}`,
          code: rpcError.code,
        });
      }
      return supabaseError({
        message:
          `Upload PARTIALLY committed: ${groupsCommitted} of ${groups.size} retailer ` +
          `groups succeeded. The current group (${rows.length} rows) failed: ${rpcError.message}. ` +
          `Already-committed groups remain in place; check the Purchase Orders list to see what landed.`,
        code: rpcError.code,
      });
    }
    groupsCommitted += 1;
    const c = rpcResult as typeof totals;
    totals.inserted += c.inserted;
    totals.updated += c.updated;
    totals.skipped += c.skipped;
    totals.lines_replaced += c.lines_replaced;
    totals.lines_inserted += c.lines_inserted;
  }

  // Fold unresolved rows into the skipped count so the Manager sees them.
  totals.skipped += unresolvedCount;

  revalidatePath(`/clients/${input.data.client_id}`);
  revalidatePath(`/clients/${input.data.client_id}/purchase-orders`);

  return ok({
    upload_id: uploadId,
    inserted: totals.inserted,
    updated: totals.updated,
    skipped: totals.skipped,
    lines_replaced: totals.lines_replaced,
    lines_inserted: totals.lines_inserted,
  });
}

// ============================================================================
// RPC payload shaping
// ============================================================================
//
// bulk_upsert_purchase_orders expects every nullable field as an EMPTY STRING
// when null, because jsonb->>'key' returns null for the literal null JSON,
// but the RPC's NULLIF('','')::date pattern only handles empty strings.

function normalizePoForRpc(row: NormalizedPoRecord): Record<string, unknown> {
  return {
    po_number: row.po_number,
    po_value_cents: row.po_value_cents,
    issuance_date: row.issuance_date ?? '',
    requested_delivery_date: row.requested_delivery_date ?? '',
    delivery_location: row.delivery_location ?? '',
    item_description: row.item_description ?? '',
    quantity_ordered: row.quantity_ordered ?? '',
    unit_value_cents: row.unit_value_cents ?? '',
    status: row.status,
    cancellation_reason_category: row.cancellation_reason_category ?? '',
    cancellation_memo: row.cancellation_memo ?? '',
  };
}

function normalizeLineForRpc(line: NormalizedPoLineRecord): Record<string, unknown> {
  return {
    po_number: line.po_number,
    line_number: line.line_number,
    retailer_item_number: line.retailer_item_number ?? '',
    item_description: line.item_description ?? '',
    quantity_ordered: line.quantity_ordered ?? '',
    unit_cost_cents: line.unit_cost_cents ?? '',
    line_value_cents: line.line_value_cents ?? '',
    status: line.status,
  };
}
