'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { upsertRuleSetAction } from './actions';

export interface RulesFormDefaults {
  period_1_days: number;
  period_1_fee_rate_pct: number;
  period_2_days: number;
  period_2_fee_rate_pct: number;
  subsequent_period_days: number;
  subsequent_period_fee_rate_pct: number;
  po_advance_rate_pct: number;
  ar_advance_rate_pct: number;
  pre_advance_rate_pct: number;
  ar_aged_out_days: number;
  aged_out_warning_lead_days: number;
  aged_out_warnings_enabled: boolean;
  payment_allocation_principal_pct: number;
  payment_allocation_fee_pct: number;
}

export function RulesForm({
  clientId,
  defaults,
}: {
  clientId: string;
  defaults: RulesFormDefaults;
}) {
  const router = useRouter();

  // We keep each numeric field as a string in state so users can type freely.
  // Parsing happens on submit. This avoids the "can't clear a number input"
  // class of UX bugs and preserves trailing decimals.
  const [f, setF] = useState({
    period_1_days: String(defaults.period_1_days),
    period_1_fee_rate_pct: String(defaults.period_1_fee_rate_pct),
    period_2_days: String(defaults.period_2_days),
    period_2_fee_rate_pct: String(defaults.period_2_fee_rate_pct),
    subsequent_period_days: String(defaults.subsequent_period_days),
    subsequent_period_fee_rate_pct: String(defaults.subsequent_period_fee_rate_pct),
    po_advance_rate_pct: String(defaults.po_advance_rate_pct),
    ar_advance_rate_pct: String(defaults.ar_advance_rate_pct),
    pre_advance_rate_pct: String(defaults.pre_advance_rate_pct),
    ar_aged_out_days: String(defaults.ar_aged_out_days),
    aged_out_warning_lead_days: String(defaults.aged_out_warning_lead_days),
    payment_allocation_principal_pct: String(defaults.payment_allocation_principal_pct),
    payment_allocation_fee_pct: String(defaults.payment_allocation_fee_pct),
  });
  const [agedOutEnabled, setAgedOutEnabled] = useState(defaults.aged_out_warnings_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Keep principal + fee split summed to 100 by auto-filling the other side
  // when one changes. User can still edit both independently after — this is
  // only a nudge, not a lock.
  function updateAllocation(which: 'principal' | 'fee', val: string) {
    const num = Number(val);
    const other = 100 - num;
    if (which === 'principal') {
      setF((prev) => ({
        ...prev,
        payment_allocation_principal_pct: val,
        payment_allocation_fee_pct: Number.isFinite(num) ? String(other) : prev.payment_allocation_fee_pct,
      }));
    } else {
      setF((prev) => ({
        ...prev,
        payment_allocation_fee_pct: val,
        payment_allocation_principal_pct: Number.isFinite(num)
          ? String(other)
          : prev.payment_allocation_principal_pct,
      }));
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const toNum = (s: string): number => Number(s);

    const result = await upsertRuleSetAction({
      client_id: clientId,
      period_1_days: toNum(f.period_1_days),
      period_1_fee_rate_pct: toNum(f.period_1_fee_rate_pct),
      period_2_days: toNum(f.period_2_days),
      period_2_fee_rate_pct: toNum(f.period_2_fee_rate_pct),
      subsequent_period_days: toNum(f.subsequent_period_days),
      subsequent_period_fee_rate_pct: toNum(f.subsequent_period_fee_rate_pct),
      po_advance_rate_pct: toNum(f.po_advance_rate_pct),
      ar_advance_rate_pct: toNum(f.ar_advance_rate_pct),
      pre_advance_rate_pct: toNum(f.pre_advance_rate_pct),
      ar_aged_out_days: toNum(f.ar_aged_out_days),
      aged_out_warning_lead_days: toNum(f.aged_out_warning_lead_days),
      aged_out_warnings_enabled: agedOutEnabled,
      payment_allocation_principal_pct: toNum(f.payment_allocation_principal_pct),
      payment_allocation_fee_pct: toNum(f.payment_allocation_fee_pct),
    });

    if (!result.ok) {
      setError(result.error.message);
      setFieldErrors(result.error.fieldErrors ?? {});
      setBusy(false);
      return;
    }

    router.push(`/clients/${clientId}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      {/* -------- Fee rules -------- */}
      <Section title="Fee schedule">
        <Row>
          <NumField
            id="period_1_days"
            label="Period 1 length (days)"
            step="1"
            value={f.period_1_days}
            onChange={(v) => setF({ ...f, period_1_days: v })}
            error={fieldErrors['period_1_days']}
          />
          <NumField
            id="period_1_fee_rate_pct"
            label="Period 1 fee (% of principal)"
            step="0.01"
            value={f.period_1_fee_rate_pct}
            onChange={(v) => setF({ ...f, period_1_fee_rate_pct: v })}
            error={fieldErrors['period_1_fee_rate_pct']}
          />
        </Row>
        <Row>
          <NumField
            id="period_2_days"
            label="Period 2 length (days)"
            step="1"
            value={f.period_2_days}
            onChange={(v) => setF({ ...f, period_2_days: v })}
            error={fieldErrors['period_2_days']}
          />
          <NumField
            id="period_2_fee_rate_pct"
            label="Period 2 fee (% of principal)"
            step="0.01"
            value={f.period_2_fee_rate_pct}
            onChange={(v) => setF({ ...f, period_2_fee_rate_pct: v })}
            error={fieldErrors['period_2_fee_rate_pct']}
          />
        </Row>
        <Row>
          <NumField
            id="subsequent_period_days"
            label="Subsequent periods (days each)"
            step="1"
            value={f.subsequent_period_days}
            onChange={(v) => setF({ ...f, subsequent_period_days: v })}
            error={fieldErrors['subsequent_period_days']}
          />
          <NumField
            id="subsequent_period_fee_rate_pct"
            label="Subsequent-period fee (%)"
            step="0.01"
            value={f.subsequent_period_fee_rate_pct}
            onChange={(v) => setF({ ...f, subsequent_period_fee_rate_pct: v })}
            error={fieldErrors['subsequent_period_fee_rate_pct']}
          />
        </Row>
      </Section>

      {/* -------- Borrowing base -------- */}
      <Section title="Borrowing base rates">
        <Row>
          <NumField
            id="po_advance_rate_pct"
            label="Purchase Order advance rate (%)"
            step="0.01"
            value={f.po_advance_rate_pct}
            onChange={(v) => setF({ ...f, po_advance_rate_pct: v })}
            error={fieldErrors['po_advance_rate_pct']}
          />
          <NumField
            id="ar_advance_rate_pct"
            label="Accounts Receivable advance rate (%)"
            step="0.01"
            value={f.ar_advance_rate_pct}
            onChange={(v) => setF({ ...f, ar_advance_rate_pct: v })}
            error={fieldErrors['ar_advance_rate_pct']}
          />
        </Row>
        <Row>
          <NumField
            id="pre_advance_rate_pct"
            label="Pre-advance rate (% of eligible AR principal)"
            hint="Set to 0 if not offered."
            step="0.01"
            value={f.pre_advance_rate_pct}
            onChange={(v) => setF({ ...f, pre_advance_rate_pct: v })}
            error={fieldErrors['pre_advance_rate_pct']}
          />
          <NumField
            id="ar_aged_out_days"
            label="Aged-out threshold (days)"
            hint="Invoices this old stop contributing to the AR borrowing base."
            step="1"
            value={f.ar_aged_out_days}
            onChange={(v) => setF({ ...f, ar_aged_out_days: v })}
            error={fieldErrors['ar_aged_out_days']}
          />
        </Row>
      </Section>

      {/* -------- Aged-out warning -------- */}
      <Section title="Aged-out warning">
        <Row>
          <div className="flex-1">
            <label className="mb-1 flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={agedOutEnabled}
                onChange={(e) => setAgedOutEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-seaking-border"
              />
              Email warning before invoices age out
            </label>
            <p className="mt-1 text-xs text-seaking-muted">
              Grouped by Advance Date so multiple invoices share one email.
            </p>
          </div>
          <NumField
            id="aged_out_warning_lead_days"
            label="Lead time (days before aging out)"
            step="1"
            value={f.aged_out_warning_lead_days}
            onChange={(v) => setF({ ...f, aged_out_warning_lead_days: v })}
            error={fieldErrors['aged_out_warning_lead_days']}
          />
        </Row>
      </Section>

      {/* -------- Payment allocation -------- */}
      <Section title="Payment allocation">
        <p className="mb-3 text-xs text-seaking-muted">
          How each incoming payment is split between principal and fee priorities before running
          the waterfall. Must sum to 100%. Defaults from the AR advance rate but editable.
        </p>
        <Row>
          <NumField
            id="payment_allocation_principal_pct"
            label="% to Principal"
            step="0.01"
            value={f.payment_allocation_principal_pct}
            onChange={(v) => updateAllocation('principal', v)}
            error={fieldErrors['payment_allocation_principal_pct']}
          />
          <NumField
            id="payment_allocation_fee_pct"
            label="% to Fees"
            step="0.01"
            value={f.payment_allocation_fee_pct}
            onChange={(v) => updateAllocation('fee', v)}
            error={fieldErrors['payment_allocation_fee_pct']}
          />
        </Row>
      </Section>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-seaking-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-seaking-border pt-4">
        <button
          type="button"
          onClick={() => router.push(`/clients/${clientId}`)}
          disabled={busy}
          className="rounded border border-seaking-border bg-white px-4 py-2 text-sm font-medium text-seaking-ink transition hover:bg-seaking-bg disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-seaking-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-seaking-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 border-b border-seaking-border pb-1 text-sm font-semibold uppercase tracking-wider text-seaking-muted">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-3 md:flex-row md:gap-6">{children}</div>;
}

function NumField({
  id,
  label,
  hint,
  step,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  hint?: string;
  step: string;
  value: string;
  onChange: (v: string) => void;
  error?: string[] | undefined;
}) {
  return (
    <div className="flex-1">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        min="0"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-seaking-border px-3 py-2 text-sm outline-none focus:border-seaking-navy"
      />
      {hint && !error && <p className="mt-1 text-xs text-seaking-muted">{hint}</p>}
      {error && error.length > 0 && (
        <p className="mt-1 text-xs text-seaking-danger">{error.join('; ')}</p>
      )}
    </div>
  );
}
