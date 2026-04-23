import { describe, expect, it } from 'vitest';
import { allocate, allocateLowestFirst } from './allocation';
import { cents } from './cents';

describe('allocate()', () => {
  it('handles empty input with zero total', () => {
    expect(allocate(cents(0), [])).toEqual([]);
  });

  it('throws on nonzero total with no targets', () => {
    expect(() => allocate(cents(100), [])).toThrow();
  });

  it('splits evenly when weights are equal', () => {
    const result = allocate(cents(100), [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
    ]);
    expect(result).toEqual([
      { id: 'a', share: 50 },
      { id: 'b', share: 50 },
    ]);
  });

  it('sums to exact total even with rounding', () => {
    // $1.00 across 3 targets: 33, 33, 33 + 1 remainder → 34, 33, 33
    const result = allocate(cents(100), [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    const total = result.reduce((acc, r) => acc + (r.share as number), 0);
    expect(total).toBe(100);
  });

  it('gives remainder to largest-fraction-first, tie-broken by lowest ID', () => {
    // 100 cents with weights [1,1,1]: each gets 33.33..., fractional .33 tied
    // → lowest ID gets the +1. Result: a=34, b=33, c=33.
    const result = allocate(cents(100), [
      { id: 'c', weight: 1 },
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
    ]);
    // Preserves input order
    expect(result.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    // a gets the extra cent
    const byId = new Map(result.map((r) => [r.id, r.share as number]));
    expect(byId.get('a')).toBe(34);
    expect(byId.get('b')).toBe(33);
    expect(byId.get('c')).toBe(33);
  });

  it('respects weighted proportions', () => {
    // $3.00 split 200:100 = 2:1 ratio → $2.00 and $1.00
    const result = allocate(cents(300), [
      { id: 'a', weight: 200 },
      { id: 'b', weight: 100 },
    ]);
    expect(result).toEqual([
      { id: 'a', share: 200 },
      { id: 'b', share: 100 },
    ]);
  });

  it('is deterministic: same inputs → same output', () => {
    const inputs = [
      { id: 'x1', weight: 7 },
      { id: 'x2', weight: 13 },
      { id: 'x3', weight: 19 },
    ];
    const a = allocate(cents(1000), inputs);
    const b = allocate(cents(1000), inputs);
    expect(a).toEqual(b);
  });

  it('distributes equally when all weights are zero (edge case)', () => {
    const result = allocate(cents(10), [
      { id: 'a', weight: 0 },
      { id: 'b', weight: 0 },
      { id: 'c', weight: 0 },
    ]);
    const total = result.reduce((acc, r) => acc + (r.share as number), 0);
    expect(total).toBe(10);
    // 10 / 3 = 3 r 1 → a=4 (lowest id), b=3, c=3
    const byId = new Map(result.map((r) => [r.id, r.share as number]));
    expect(byId.get('a')).toBe(4);
    expect(byId.get('b')).toBe(3);
    expect(byId.get('c')).toBe(3);
  });

  it('stress: 100 targets always sum to total', () => {
    const targets = Array.from({ length: 100 }, (_, i) => ({
      id: `t${String(i).padStart(3, '0')}`,
      weight: (i * 7 + 3) % 29, // pseudo-random but deterministic
    }));
    const result = allocate(cents(12345), targets);
    const sum = result.reduce((acc, r) => acc + (r.share as number), 0);
    expect(sum).toBe(12345);
  });
});

describe('allocateLowestFirst()', () => {
  it('assigns to lowest-ratio first', () => {
    // 3 POs at ratios 50%, 70%, 90% with ample room → all goes to 50% first
    const targets = [
      { id: 'p1', borrowingRatioBps: 5000, room: 1000 },
      { id: 'p2', borrowingRatioBps: 7000, room: 1000 },
      { id: 'p3', borrowingRatioBps: 9000, room: 1000 },
    ];
    const result = allocateLowestFirst(cents(500), targets);
    const byId = new Map(result.map((r) => [r.id, r.share as number]));
    expect(byId.get('p1')).toBe(500);
    expect(byId.get('p2')).toBe(0);
    expect(byId.get('p3')).toBe(0);
  });

  it('ratably allocates among tied (rounded to percent) ratios', () => {
    // Two POs tied at ~50% with equal room → split evenly
    const targets = [
      { id: 'p1', borrowingRatioBps: 5004, room: 1000 },
      { id: 'p2', borrowingRatioBps: 4998, room: 1000 },
    ];
    const result = allocateLowestFirst(cents(100), targets);
    const byId = new Map(result.map((r) => [r.id, r.share as number]));
    // Both round to 5000 bps = 50%
    expect(byId.get('p1')).toBe(50);
    expect(byId.get('p2')).toBe(50);
  });

  it('cascades when lower-ratio bucket is full', () => {
    const targets = [
      { id: 'p1', borrowingRatioBps: 5000, room: 300 },
      { id: 'p2', borrowingRatioBps: 7000, room: 1000 },
    ];
    const result = allocateLowestFirst(cents(500), targets);
    const byId = new Map(result.map((r) => [r.id, r.share as number]));
    expect(byId.get('p1')).toBe(300);
    expect(byId.get('p2')).toBe(200);
  });

  it('throws when total exceeds all rooms', () => {
    const targets = [{ id: 'p1', borrowingRatioBps: 5000, room: 100 }];
    expect(() => allocateLowestFirst(cents(500), targets)).toThrow(/capacity/);
  });
});
