import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isAdminManager } from '@seaking/auth';
import { bpsToPct } from '@seaking/validators';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { RulesForm, type RulesFormDefaults } from './rules-form';

interface PageProps {
  params: Promise<{ clientId: string }>;
}

// Reasonable starting point for a brand-new Client, lifted from the example
// in the functional spec (§Set Fee Rules). Admin can adjust before saving.
const DEFAULT_RULES: RulesFormDefaults = {
  period_1_days: 30,
  period_1_fee_rate_pct: 3.0,
  period_2_days: 15,
  period_2_fee_rate_pct: 1.5,
  subsequent_period_days: 15,
  subsequent_period_fee_rate_pct: 1.5,
  po_advance_rate_pct: 70.0,
  ar_advance_rate_pct: 80.0,
  pre_advance_rate_pct: 0.0,
  ar_aged_out_days: 90,
  aged_out_warning_lead_days: 5,
  aged_out_warnings_enabled: true,
  payment_allocation_principal_pct: 80.0,
  payment_allocation_fee_pct: 20.0,
};

export default async function RulesPage({ params }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isAdminManager(user.role)) redirect('/clients?reason=forbidden');

  const { clientId } = await params;
  const supabase = await createSupabaseServerClient();

  const [{ data: clientRow }, { data: currentRuleSet }] = await Promise.all([
    supabase
      .from('clients')
      .select('id, display_name')
      .eq('id', clientId)
      .maybeSingle(),
    supabase
      .from('rule_sets')
      .select(
        'id, effective_from, period_1_days, period_1_fee_rate_bps, period_2_days, period_2_fee_rate_bps, subsequent_period_days, subsequent_period_fee_rate_bps, po_advance_rate_bps, ar_advance_rate_bps, pre_advance_rate_bps, ar_aged_out_days, aged_out_warning_lead_days, aged_out_warnings_enabled, payment_allocation_principal_bps, payment_allocation_fee_bps',
      )
      .eq('client_id', clientId)
      .is('effective_to', null)
      .maybeSingle(),
  ]);

  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };

  const defaults: RulesFormDefaults = currentRuleSet
    ? {
        period_1_days: (currentRuleSet as { period_1_days: number }).period_1_days,
        period_1_fee_rate_pct: bpsToPct(
          (currentRuleSet as { period_1_fee_rate_bps: number }).period_1_fee_rate_bps,
        ),
        period_2_days: (currentRuleSet as { period_2_days: number }).period_2_days,
        period_2_fee_rate_pct: bpsToPct(
          (currentRuleSet as { period_2_fee_rate_bps: number }).period_2_fee_rate_bps,
        ),
        subsequent_period_days: (currentRuleSet as { subsequent_period_days: number })
          .subsequent_period_days,
        subsequent_period_fee_rate_pct: bpsToPct(
          (currentRuleSet as { subsequent_period_fee_rate_bps: number })
            .subsequent_period_fee_rate_bps,
        ),
        po_advance_rate_pct: bpsToPct(
          (currentRuleSet as { po_advance_rate_bps: number }).po_advance_rate_bps,
        ),
        ar_advance_rate_pct: bpsToPct(
          (currentRuleSet as { ar_advance_rate_bps: number }).ar_advance_rate_bps,
        ),
        pre_advance_rate_pct: bpsToPct(
          (currentRuleSet as { pre_advance_rate_bps: number }).pre_advance_rate_bps,
        ),
        ar_aged_out_days: (currentRuleSet as { ar_aged_out_days: number }).ar_aged_out_days,
        aged_out_warning_lead_days: (currentRuleSet as { aged_out_warning_lead_days: number })
          .aged_out_warning_lead_days,
        aged_out_warnings_enabled: (currentRuleSet as { aged_out_warnings_enabled: boolean })
          .aged_out_warnings_enabled,
        payment_allocation_principal_pct: bpsToPct(
          (currentRuleSet as { payment_allocation_principal_bps: number })
            .payment_allocation_principal_bps,
        ),
        payment_allocation_fee_pct: bpsToPct(
          (currentRuleSet as { payment_allocation_fee_bps: number })
            .payment_allocation_fee_bps,
        ),
      }
    : DEFAULT_RULES;

  const hasExisting = Boolean(currentRuleSet);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to {client.display_name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Borrowing Base and Fee Rules
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          {hasExisting
            ? 'Update the rules in effect for ' + client.display_name + '.'
            : 'Configure the initial rules for ' + client.display_name + '.'}
        </p>
      </header>

      <div className="mb-6 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>How changes apply:</strong>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Fee rate changes are prospective.</strong> Existing advances keep the fee
            schedule frozen at their Advance Date; only advances committed from today forward use
            the new rates.
          </li>
          <li>
            <strong>Borrowing base rate changes are retroactive.</strong> The new rates apply
            immediately to all outstanding POs and invoices.
          </li>
          <li>
            Saving closes the currently-active rule set and creates a new one. Historical rule
            sets are preserved for audit.
          </li>
        </ul>
      </div>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <RulesForm clientId={client.id} defaults={defaults} />
      </div>
    </main>
  );
}
