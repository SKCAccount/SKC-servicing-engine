import { describe, expect, it } from 'vitest';
import { cents } from '@seaking/money';
import { planPoAdvance, summarizeSelectedPos, type SelectedPoForAdvance } from './po-advance';

describe('planPoAdvance — lowest ratio first', () => {
  it('routes 100% of the new advance to the only PO with room', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'low', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
      { id: 'full', po_value_cents: cents(100_000), current_principal_cents: cents(70_000) },
    ];
    // 70% rate → 'full' has 0 room, 'low' has 70k room
    const plan = planPoAdvance(cents(50_000), pos, 7000);
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));
    expect(byId.get('low')!.newly_assigned_cents).toBe(50_000);
    expect(byId.get('full')!.newly_assigned_cents).toBe(0);
  });

  it('cascades when the lowest-ratio bucket runs out of room', () => {
    const pos: SelectedPoForAdvance[] = [
      // 0% ratio, $30 room (PO $100 × 30%)
      { id: 'a', po_value_cents: cents(10_000), current_principal_cents: cents(0) },
      // 0% ratio, $30 room
      { id: 'b', po_value_cents: cents(10_000), current_principal_cents: cents(0) },
      // 100% ratio, $0 room — un-eligible for first pass
      { id: 'c', po_value_cents: cents(10_000), current_principal_cents: cents(10_000) },
    ];
    // Try to allocate $50 with 30% rate. 'a' and 'b' tied at 0% ratio, 30 room each.
    // Total room in the bottom bucket = $60. Allocation should fully fit.
    const plan = planPoAdvance(cents(5000), pos, 3000);
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));
    expect(byId.get('a')!.newly_assigned_cents).toBe(2500);
    expect(byId.get('b')!.newly_assigned_cents).toBe(2500);
    expect(byId.get('c')!.newly_assigned_cents).toBe(0);
  });

  it('preserves input order in the lines output', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'z', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
      { id: 'a', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
      { id: 'm', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
    ];
    const plan = planPoAdvance(cents(30_000), pos, 7000);
    expect(plan.lines.map((l) => l.po_id)).toEqual(['z', 'a', 'm']);
  });

  it('total of newly_assigned equals the requested total exactly', () => {
    const pos: SelectedPoForAdvance[] = Array.from({ length: 7 }, (_, i) => ({
      id: `po${i}`,
      po_value_cents: cents(7_000 + i * 113), // intentionally odd values
      current_principal_cents: cents(i * 17),
    }));
    const plan = planPoAdvance(cents(12_345), pos, 7000);
    const sum = plan.lines.reduce((acc, l) => acc + (l.newly_assigned_cents as number), 0);
    expect(sum).toBe(12_345);
  });

  it('flags pro_forma_over_advanced when an allocation pushes a PO past 100%', () => {
    // Single PO with $100 value, $90 already advanced, allocating $20 more pushes it over.
    const pos: SelectedPoForAdvance[] = [
      { id: 'over', po_value_cents: cents(10_000), current_principal_cents: cents(9000) },
    ];
    // Use 110% rate so room = $1100 (allows the allocation), then we look at the PO ratio.
    const plan = planPoAdvance(cents(2000), pos, 11_000);
    expect(plan.lines[0]!.pro_forma_over_advanced).toBe(true);
    expect(plan.any_over_advanced).toBe(true);
  });

  it('sets any_over_advanced false when nothing crosses 100%', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'safe', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
    ];
    const plan = planPoAdvance(cents(50_000), pos, 7000);
    expect(plan.any_over_advanced).toBe(false);
  });

  it('throws when the request exceeds total available room', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'p1', po_value_cents: cents(10_000), current_principal_cents: cents(0) },
    ];
    // $100 PO at 70% = $70 room. Request $100 → throws.
    expect(() => planPoAdvance(cents(10_000), pos, 7000)).toThrow();
  });

  it('handles a single PO cleanly', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'only', po_value_cents: cents(100_000), current_principal_cents: cents(0) },
    ];
    const plan = planPoAdvance(cents(50_000), pos, 7000);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]!.newly_assigned_cents).toBe(50_000);
    expect(plan.lines[0]!.pro_forma_principal_cents).toBe(50_000);
    expect(plan.lines[0]!.pro_forma_ratio_bps).toBe(5000); // 50%
  });
});

describe('planPoAdvance — ratio leveling (Derek’s regression case)', () => {
  // Concrete example from Phase 1D testing. Documents the leveling intent
  // baked into the algorithm: a PO at a lower ratio is FIRST raised to
  // match the rest of the selection, then a partial leftover is shared
  // ratably by PO value so every PO ends at the same final ratio.
  it('lifts PO3 from 0% → 50% then splits the remainder ratably by value', () => {
    const pos: SelectedPoForAdvance[] = [
      // PO1: $1,000, $500 principal → 50% ratio, $200 room at 70%
      { id: 'p1', po_value_cents: cents(100_000), current_principal_cents: cents(50_000) },
      // PO2: $800, $400 principal → 50% ratio, $160 room
      { id: 'p2', po_value_cents: cents(80_000), current_principal_cents: cents(40_000) },
      // PO3: $1,200, $0 principal → 0% ratio, $840 room
      { id: 'p3', po_value_cents: cents(120_000), current_principal_cents: cents(0) },
    ];

    const plan = planPoAdvance(cents(80_000), pos, 7000); // $800 at 70%
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));

    // Step 1 of the leveling: PO3 absorbs $600 to reach 50%, matching PO1/PO2.
    // Step 2: $200 remaining splits ratably by po_value (5:4:6) →
    //   PO1: 6,667c   PO2: 5,333c   PO3: 8,000c
    expect(byId.get('p1')!.newly_assigned_cents).toBe(6_667);
    expect(byId.get('p2')!.newly_assigned_cents).toBe(5_333);
    expect(byId.get('p3')!.newly_assigned_cents).toBe(60_000 + 8_000);

    // Total exactly equals requested amount.
    const sum = plan.lines.reduce((a, l) => a + (l.newly_assigned_cents as number), 0);
    expect(sum).toBe(80_000);

    // Final ratios are equal across all three POs (~56.67%).
    const ratios = plan.lines.map((l) => l.pro_forma_ratio_bps);
    const minR = Math.min(...ratios);
    const maxR = Math.max(...ratios);
    expect(maxR - minR).toBeLessThanOrEqual(1); // ≤ 1 bp drift from rounding
    expect(ratios[0]).toBeGreaterThanOrEqual(5666);
    expect(ratios[0]).toBeLessThanOrEqual(5667);
  });

  it('with all POs already tied, splits ratably by value (no lifting needed)', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'a', po_value_cents: cents(100_000), current_principal_cents: cents(30_000) }, // 30%
      { id: 'b', po_value_cents: cents(200_000), current_principal_cents: cents(60_000) }, // 30%
    ];
    // 80% rate, allocate $30 — should split 1:2 across the two POs.
    const plan = planPoAdvance(cents(3_000), pos, 8000);
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));
    expect(byId.get('a')!.newly_assigned_cents).toBe(1_000);
    expect(byId.get('b')!.newly_assigned_cents).toBe(2_000);
  });

  it('skips POs already at the borrowing-rate cap', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'capped', po_value_cents: cents(10_000), current_principal_cents: cents(7_000) }, // 70%, room 0
      { id: 'low', po_value_cents: cents(10_000), current_principal_cents: cents(0) }, // 0%, room 7k
    ];
    // 70% rate. Request $5k — all should go to 'low'.
    const plan = planPoAdvance(cents(5_000), pos, 7000);
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));
    expect(byId.get('capped')!.newly_assigned_cents).toBe(0);
    expect(byId.get('low')!.newly_assigned_cents).toBe(5_000);
  });

  it('lifts in two stages when the highest-ratio PO is below the rate cap', () => {
    // Setup: PO 'low' at 20%, PO 'mid' at 40%, PO 'cap-bound' irrelevant.
    // 70% rate. Allocate enough to lift 'low' to 40%, then both to 70%.
    const pos: SelectedPoForAdvance[] = [
      // 20% ratio, room = (70-20) × 1000 = $500
      { id: 'low', po_value_cents: cents(100_000), current_principal_cents: cents(20_000) },
      // 40% ratio, room = (70-40) × 1000 = $300
      { id: 'mid', po_value_cents: cents(100_000), current_principal_cents: cents(40_000) },
    ];

    // Cost to lift 'low' from 20% → 40%: $200.
    // Then both at 40%, cost to lift to 70%: $300 + $300 = $600. Total available: $800.
    // Request $400 → first $200 brings 'low' to 40%, then $200 splits 1:1 → +$100 each.
    const plan = planPoAdvance(cents(40_000), pos, 7000);
    const byId = new Map(plan.lines.map((l) => [l.po_id, l]));
    expect(byId.get('low')!.newly_assigned_cents).toBe(20_000 + 10_000); // 200 lift + 100 split = 300
    expect(byId.get('mid')!.newly_assigned_cents).toBe(10_000); // 0 lift + 100 split

    // Both end at the same final ratio (50%).
    expect(byId.get('low')!.pro_forma_ratio_bps).toBe(5000);
    expect(byId.get('mid')!.pro_forma_ratio_bps).toBe(5000);
  });
});

describe('planPoAdvance — pro forma ratios', () => {
  it('computes the right pro-forma ratio per line', () => {
    const pos: SelectedPoForAdvance[] = [
      // Currently 20% (1000/5000), advancing 1500 → 50% (2500/5000)
      { id: 'p', po_value_cents: cents(500_000), current_principal_cents: cents(100_000) },
    ];
    // 80% rate so room = 400 - 100 = 300k → fits 150k easily
    const plan = planPoAdvance(cents(150_000), pos, 8000);
    const line = plan.lines[0]!;
    expect(line.current_ratio_bps).toBe(2000);
    expect(line.pro_forma_ratio_bps).toBe(5000);
  });
});

describe('summarizeSelectedPos', () => {
  it('aggregates value, principal, base, and available correctly', () => {
    const pos: SelectedPoForAdvance[] = [
      { id: 'a', po_value_cents: cents(100_000), current_principal_cents: cents(20_000) },
      { id: 'b', po_value_cents: cents(200_000), current_principal_cents: cents(50_000) },
    ];
    // 70% rate
    const s = summarizeSelectedPos(pos, 7000);
    expect(s.total_po_value_cents).toBe(300_000);
    expect(s.total_current_principal_cents).toBe(70_000);
    // base = 70% × 300k = 210k
    expect(s.total_borrowing_base_cents).toBe(210_000);
    // available = (70% × 100k - 20k) + (70% × 200k - 50k) = 50k + 90k = 140k
    expect(s.total_borrowing_base_available_cents).toBe(140_000);
    // aggregate ratio = 70/300 = 23.33% = 2333 bps
    expect(s.aggregate_ratio_bps).toBe(2333);
  });

  it('handles empty selection', () => {
    const s = summarizeSelectedPos([], 7000);
    expect(s.total_po_value_cents).toBe(0);
    expect(s.total_current_principal_cents).toBe(0);
    expect(s.total_borrowing_base_cents).toBe(0);
    expect(s.total_borrowing_base_available_cents).toBe(0);
    expect(s.aggregate_ratio_bps).toBe(0);
  });
});
