'use server';

/**
 * PO Upload — server actions.
 *
 * The upload workflow is two round-trips: the user picks a file, previews the
 * parser output, then confirms the commit.
 *
 *   1. parsePoUploadAction(formData) → PoUploadPreview
 *        Reads file bytes, runs the retailer-specific parser, queries
 *        existing PO numbers to compute add/update counts, returns a
 *        summary the browser renders on the review screen. No DB writes.
 *
 *   2. commitPoUploadAction(formData) → PoUploadCommitResult
 *        Re-parses the file, writes the raw bytes to Supabase Storage,
 *        inserts the po_uploads row, calls bulk_upsert_purchase_orders
 *        (migration 0015) to atomically apply all PO and line changes.
 *
 * Why send the file twice instead of caching across actions: Server Actions
 * are stateless and caching server-side introduces abandoned-upload GC.
 * Files are small (<2 MB typical) and both request paths are authenticated,
 * so the double-send is fine for Phase 1.
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
import {
  parseWalmartPurchaseOrders,
} from '@seaking/retailer-parsers/walmart/purchase-orders';
import {
  parseGenericPurchaseOrders,
} from '@seaking/retailer-parsers/generic/purchase-orders';
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
function readFormInput(formData: FormData): { ok: true; data: FormInput } | { ok: false; err: ActionResult<never> } {
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

/**
 * Authorize the caller: must be a Manager AND have access to the Client.
 * The RLS policies on reads would filter data out but wouldn't give a
 * clean "you can't upload here" error — this explicit check surfaces it.
 */
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

/** Resolve the retailer_slug string to a retailer UUID. */
async function resolveRetailerId(slug: RetailerSlug): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('retailers')
    .select('id')
    .eq('name', slug)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Dispatch to the right parser for the retailer. */
function runParser(
  slug: RetailerSlug,
  bytes: ArrayBuffer,
): ParseResult<NormalizedPoRecord> {
  if (slug === 'walmart') return parseWalmartPurchaseOrders(bytes);
  if (slug === 'generic') return parseGenericPurchaseOrders(bytes);
  // Kroger PO parser throws per spec; keep the throw here for clarity.
  throw new Error(
    'Kroger PO parser not yet available. Please upload Kroger POs using the Generic CSV template.',
  );
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

  const retailerId = await resolveRetailerId(input.data.retailer_slug);
  if (!retailerId) {
    return err('NOT_FOUND', `Retailer "${input.data.retailer_slug}" is not registered.`);
  }

  let parseResult: ParseResult<NormalizedPoRecord>;
  try {
    const bytes = await input.data.file.arrayBuffer();
    parseResult = runParser(input.data.retailer_slug, bytes);
  } catch (e) {
    return err('PARSE_ERROR', e instanceof Error ? e.message : 'Parser threw an unknown error.');
  }

  // Query existing PO numbers for the client+retailer so the summary can
  // show accurate add vs update counts.
  const parsedPoNumbers = parseResult.rows.map((r) => r.po_number);
  const existingSet = await fetchExistingPoNumbers(
    input.data.client_id,
    retailerId,
    parsedPoNumbers,
  );

  let rowsToAdd = 0;
  let rowsToUpdate = 0;
  let rowsCancelled = 0;
  let newPoValueCents = 0;
  for (const row of parseResult.rows) {
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
    rows_skipped: parseResult.stats.skipped_rows,
    rows_cancelled: rowsCancelled,
    line_rows: parseResult.stats.line_rows ?? 0,
    new_po_value_cents: newPoValueCents,
    existing_po_numbers: [...existingSet],
    warnings: parseResult.warnings.slice(0, 50).map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.row_index !== undefined ? { row_index: w.row_index } : {}),
    })),
    skipped: parseResult.skipped.slice(0, 50).map((s) => ({
      reason: s.reason,
      row_index: s.row_index,
    })),
    sample_rows: parseResult.rows.slice(0, 20).map((r) => ({
      po_number: r.po_number,
      po_value_cents: r.po_value_cents as number,
      status: r.status,
      issuance_date: r.issuance_date,
    })),
  };

  return ok(preview);
}

async function fetchExistingPoNumbers(
  clientId: string,
  retailerId: string,
  poNumbers: string[],
): Promise<Set<string>> {
  if (poNumbers.length === 0) return new Set();
  const supabase = await createSupabaseServerClient();
  // Supabase .in() supports up to a few thousand values but large arrays
  // can trip URL-length limits; chunk at 500.
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
// commitPoUploadAction
// ============================================================================

export async function commitPoUploadAction(
  formData: FormData,
): Promise<ActionResult<PoUploadCommitResult>> {
  const input = readFormInput(formData);
  if (!input.ok) return input.err;

  const authz = await authorize(input.data.client_id);
  if (!authz.ok) return authz.err;

  const retailerId = await resolveRetailerId(input.data.retailer_slug);
  if (!retailerId) {
    return err('NOT_FOUND', `Retailer "${input.data.retailer_slug}" is not registered.`);
  }

  // Re-parse the file on commit. Cheap relative to the round-trip and keeps
  // the server as the single source of truth for what gets written.
  let parseResult: ParseResult<NormalizedPoRecord>;
  let fileBytes: ArrayBuffer;
  try {
    fileBytes = await input.data.file.arrayBuffer();
    parseResult = runParser(input.data.retailer_slug, fileBytes);
  } catch (e) {
    return err('PARSE_ERROR', e instanceof Error ? e.message : 'Parser threw an unknown error.');
  }

  // Service-role client for Storage + po_uploads insert. The RPC itself runs
  // SECURITY INVOKER — we keep the service role scoped to the Storage step
  // where RLS on storage.objects would otherwise need app-level policies.
  const admin = createServiceRoleClient();

  // 1. Upload raw file to Storage. Path: {client_id}/{yyyy-mm-dd}/{uuid}-{filename}
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

  // 2. Insert po_uploads row.
  const userSupabase = await createSupabaseServerClient();
  const { data: uploadRow, error: uploadInsertError } = await userSupabase
    .from('po_uploads')
    .insert({
      client_id: input.data.client_id,
      retailer_id: retailerId,
      uploaded_by: authz.user.id,
      source_filename: input.data.file.name,
      storage_path: storagePath,
      parser_version: parseResult.parser_version,
      row_count: parseResult.rows.length,
    })
    .select('id')
    .single();
  if (uploadInsertError || !uploadRow) {
    // Roll back Storage to avoid an orphan file.
    await admin.storage.from('po-uploads').remove([storagePath]);
    return supabaseError(uploadInsertError ?? { message: 'Upload row insert failed' });
  }
  const uploadId = (uploadRow as { id: string }).id;

  // 3. Call the bulk_upsert RPC with both POs and (if present) lines.
  const poJson = parseResult.rows.map((r) => normalizePoForRpc(r));
  const linesJson =
    parseResult.lines && parseResult.lines.length > 0
      ? parseResult.lines.map((l) => normalizeLineForRpc(l))
      : null;

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
    // Roll back Storage + upload row. (The RPC's own transaction rolls back
    // any partial PO writes.)
    await admin.storage.from('po-uploads').remove([storagePath]);
    await admin.from('po_uploads').delete().eq('id', uploadId);
    return supabaseError(rpcError);
  }

  const counts = rpcResult as {
    inserted: number;
    updated: number;
    skipped: number;
    lines_replaced: number;
    lines_inserted: number;
  };

  revalidatePath(`/clients/${input.data.client_id}`);
  revalidatePath(`/clients/${input.data.client_id}/purchase-orders`);

  return ok({
    upload_id: uploadId,
    inserted: counts.inserted,
    updated: counts.updated,
    skipped: counts.skipped,
    lines_replaced: counts.lines_replaced,
    lines_inserted: counts.lines_inserted,
  });
}

// ============================================================================
// RPC payload shaping
// ============================================================================
//
// bulk_upsert_purchase_orders expects every nullable field as an EMPTY STRING
// when null, because jsonb->>'key' returns null for the literal null JSON,
// but the RPC's NULLIF('','')::date pattern only handles empty strings.
// Casting to the proper jsonb shape here keeps the SQL simple.

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
