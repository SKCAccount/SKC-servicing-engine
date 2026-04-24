import { describe, expect, it } from 'vitest';
import { cents } from '@seaking/money';
import {
  arBorrowingBase,
  borrowingBaseAvailable,
  borrowingRatioBps,
  formatBpsAsPercent,
  poBorrowingBase,
  preAdvanceBorrowingBase,
  roundBpsToNearestPercent,
  singleArRoomCents,
  singlePoRoomCents,
} from './borrowing-base';

describe('poBorrowingBase', () => {
  it('applies the bps rate to the PO value', () => {
    // $100,000 at 70% = $70,000
    expect(poBorrowingBase(cents(10_000_000), 7000)).toBe(7_000_000);
  });

  it('handles zero PO value', () => {
    expect(poBorrowingBase(cents(0), 7000)).toBe(0);
  });

  it('handles 100% rate', () => {
    expect(poBorrowingBase(cents(12345), 10000)).toBe(12345);
  });

  it('rounds half-away-from-zero on fractional cents', () => {
    // $1.23 at 50% = $0.615 → 62 cents (round half up)
    const r = poBorrowingBase(cents(123), 5000);
    expect([61, 62]).toContain(r);
  });
});

describe('arBorrowingBase / preAdvanceBorrowingBase', () => {
  it('arBorrowingBase mirrors PO base math', () => {
    expect(arBorrowingBase(cents(50_000), 8000)).toBe(40_000);
  });
  it('preAdvanceBorrowingBase mirrors PO base math', () => {
    expect(preAdvanceBorrowingBase(cents(20_000), 5000)).toBe(10_000);
  });
});

describe('borrowingBaseAvailable', () => {
  it('subtracts outstanding from base', () => {
    expect(borrowingBaseAvailable(cents(100_000), cents(30_000))).toBe(70_000);
  });
  it('floors at zero (over-advanced state)', () => {
    expect(borrowingBaseAvailable(cents(100_000), cents(150_000))).toBe(0);
  });
});

describe('borrowingRatioBps', () => {
  it('computes 70%', () => {
    // $7000 / $10000 = 0.7 = 7000 bps
    expect(borrowingRatioBps(cents(700_000), cents(1_000_000))).toBe(7000);
  });

  it('returns 0 for zero denominator', () => {
    expect(borrowingRatioBps(cents(100), cents(0))).toBe(0);
  });

  it('exceeds 10000 bps when over-advanced', () => {
    // $150 / $100 = 150% = 15000 bps
    expect(borrowingRatioBps(cents(15_000), cents(10_000))).toBe(15000);
  });

  it('rounds to nearest bp', () => {
    // $1234 / $5678 = 0.21733... = 2173 bps (banker rounded)
    const r = borrowingRatioBps(cents(123_400), cents(567_800));
    expect(r).toBeGreaterThanOrEqual(2173);
    expect(r).toBeLessThanOrEqual(2174);
  });
});

describe('roundBpsToNearestPercent', () => {
  it('rounds 5004 → 5000 (down)', () => {
    expect(roundBpsToNearestPercent(5004)).toBe(5000);
  });
  it('rounds 5050 → 5100 (half up)', () => {
    expect(roundBpsToNearestPercent(5050)).toBe(5100);
  });
  it('rounds 5099 → 5100', () => {
    expect(roundBpsToNearestPercent(5099)).toBe(5100);
  });
  it('handles zero', () => {
    expect(roundBpsToNearestPercent(0)).toBe(0);
  });
});

describe('formatBpsAsPercent', () => {
  it('formats with two decimals', () => {
    expect(formatBpsAsPercent(7000)).toBe('70.00%');
    expect(formatBpsAsPercent(7350)).toBe('73.50%');
    expect(formatBpsAsPercent(1)).toBe('0.01%');
  });
});

describe('singlePoRoomCents', () => {
  it('returns base − principal when room available', () => {
    // $1000 PO, $300 advanced, 70% rate → base = $700, room = $400
    expect(singlePoRoomCents(cents(100_000), cents(30_000), 7000)).toBe(40_000);
  });
  it('returns 0 when fully utilized', () => {
    expect(singlePoRoomCents(cents(100_000), cents(70_000), 7000)).toBe(0);
  });
  it('returns 0 when over-advanced (no negative room)', () => {
    expect(singlePoRoomCents(cents(100_000), cents(80_000), 7000)).toBe(0);
  });
});

describe('singleArRoomCents', () => {
  it('mirrors PO room math at the AR rate', () => {
    // $1000 invoice, $400 advanced, 80% rate → base = $800, room = $400
    expect(singleArRoomCents(cents(100_000), cents(40_000), 8000)).toBe(40_000);
  });
});
