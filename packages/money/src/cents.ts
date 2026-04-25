/**
 * Integer-cents money type.
 *
 * All monetary amounts in Sea King flow through this module. Storage and
 * arithmetic are ALWAYS integer cents — never floats, never `numeric` strings.
 * Conversion to/from display happens at the API/UI boundary.
 *
 * Why integer cents, not decimal?
 *  - Integer arithmetic is exact.
 *  - bigint handles amounts well beyond anything Sea King will ever see
 *    (9 quadrillion dollars at the TS-number boundary; full bigint for DB).
 *  - Ratable allocation has a well-defined, deterministic rounding rule
 *    that only works cleanly in integer space.
 */

/**
 * Branded type: a non-negative integer number of cents.
 * Use {@link cents} or {@link fromDollars} to construct.
 *
 * Internally a number (safe up to ~$90 trillion). For DB writes, use bigint
 * via {@link toBigInt}. For amounts that could exceed Number.MAX_SAFE_INTEGER
 * (9007199254740991 cents = $90T), work in bigint directly.
 */
export type Cents = number & { readonly __brand: 'Cents' };

/** Maximum safe cents value representable as a JS number. */
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER as Cents;

/**
 * Construct a Cents from an already-integer value.
 * Throws if the input is non-integer, negative, or NaN.
 */
export function cents(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cents() requires a finite number; got ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`cents() requires an integer number of cents; got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`cents() requires non-negative; got ${value}`);
  }
  if (value > MAX_SAFE_CENTS) {
    throw new RangeError(`cents() value ${value} exceeds MAX_SAFE_CENTS`);
  }
  return value as Cents;
}

/**
 * Signed variant — useful for delta amounts in ledger events where negatives
 * represent outflows. Same integer/finite guards, but negatives are allowed.
 */
export type SignedCents = number & { readonly __brand: 'SignedCents' };

export function signedCents(value: number): SignedCents {
  if (!Number.isFinite(value)) {
    throw new RangeError(`signedCents() requires finite; got ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`signedCents() requires integer; got ${value}`);
  }
  return value as SignedCents;
}

export const ZERO_CENTS = cents(0);

// --------------------------------------------------------------------------
// Dollar conversions (string-based to avoid float ingest ambiguity)
// --------------------------------------------------------------------------

/**
 * Parse a dollar string ("1,234.56", "$1,234.56", "1234.5") into Cents.
 * Rounds half-away-from-zero to the nearest cent.
 * Throws on invalid input.
 */
export function fromDollarString(input: string): Cents {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (cleaned === '') {
    throw new RangeError(`fromDollarString(): empty input`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new RangeError(`fromDollarString(): invalid format "${input}"`);
  }
  const negative = cleaned.startsWith('-');
  if (negative) {
    throw new RangeError(
      `fromDollarString(): negative values not allowed for Cents; got "${input}". ` +
        `Use fromSignedDollarString() for signed deltas.`,
    );
  }
  const [whole, fraction = ''] = cleaned.split('.');
  const wholeNum = Number(whole);
  const paddedFraction = (fraction + '00').slice(0, 3); // keep 3 digits for rounding
  const fractionCents = Math.round(Number(paddedFraction) / 10);
  const totalCents = wholeNum * 100 + fractionCents;
  return cents(totalCents);
}

/**
 * Convert a Number of dollars (e.g. 12.34) to Cents.
 * WARNING: prefer fromDollarString when parsing user input. This is intended
 * for internal math where the input is a computed float result.
 */
export function fromDollarsNumber(dollars: number): Cents {
  if (!Number.isFinite(dollars)) {
    throw new RangeError(`fromDollarsNumber(): non-finite ${dollars}`);
  }
  if (dollars < 0) {
    throw new RangeError(`fromDollarsNumber(): negative ${dollars}`);
  }
  // Banker's rounding guard: round half-away-from-zero at cent precision.
  return cents(Math.round(dollars * 100));
}

/** Convert Cents to a display string "$1,234.56". */
export function formatDollars(c: Cents | SignedCents): string {
  // Defensive floor: callers should always pass integer cents, but if the
  // value flowed through Postgres `numeric` arithmetic upstream (e.g.
  // SUM(bigint) returns numeric) it can arrive here with fractional cents.
  // Without this, value % 100 would be a float and the output would look
  // like "$2,013,695.72.59999999403954". Floor matches the spec's rule
  // ("rounded to the nearest cent" — see CLAUDE.md borrowing-base note).
  const value = Math.floor(c as number);
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  const wholeFormatted = whole.toLocaleString('en-US');
  const sign = value < 0 ? '-' : '';
  return `${sign}$${wholeFormatted}.${fraction.toString().padStart(2, '0')}`;
}

/** Convert Cents to a bigint for DB writes. */
export function toBigInt(c: Cents | SignedCents): bigint {
  return BigInt(c as number);
}

/** Convert a bigint from the DB back to Cents (with overflow guard). */
export function fromBigInt(b: bigint): Cents {
  if (b < 0n) {
    throw new RangeError(`fromBigInt(): negative ${b}; use fromBigIntSigned()`);
  }
  if (b > BigInt(MAX_SAFE_CENTS)) {
    throw new RangeError(`fromBigInt(): value ${b} exceeds MAX_SAFE_CENTS`);
  }
  return cents(Number(b));
}

export function fromBigIntSigned(b: bigint): SignedCents {
  if (b > BigInt(MAX_SAFE_CENTS) || b < -BigInt(MAX_SAFE_CENTS)) {
    throw new RangeError(`fromBigIntSigned(): value ${b} out of safe range`);
  }
  return signedCents(Number(b));
}

// --------------------------------------------------------------------------
// Arithmetic (nominal wrappers; enforce type discipline)
// --------------------------------------------------------------------------

export function add(a: Cents, b: Cents): Cents {
  return cents((a as number) + (b as number));
}

export function sub(a: Cents, b: Cents): Cents {
  const result = (a as number) - (b as number);
  if (result < 0) {
    throw new RangeError(`sub(): underflow ${a} - ${b} = ${result}; use subClamped for 0-floor`);
  }
  return cents(result);
}

/** Clamp subtraction at zero. Useful for "borrowing base available" style math. */
export function subClamped(a: Cents, b: Cents): Cents {
  const result = (a as number) - (b as number);
  return cents(Math.max(0, result));
}

/** Multiply cents by a basis-points (bps) rate, rounding to the nearest cent. */
export function applyBps(amount: Cents, bps: number): Cents {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`applyBps(): bps must be non-negative integer; got ${bps}`);
  }
  // (amount_cents * bps) / 10000, rounded half-away-from-zero
  const numerator = (amount as number) * bps;
  return cents(Math.round(numerator / 10000));
}

/**
 * Multiply cents by a bps rate, FLOORING the result.
 *
 * Preferred over applyBps for borrowing-base math: per Derek's spec
 * clarification, each PO's contribution to the borrowing base is
 * `floor(po_value × rate / 10000)`, computed PER PO before summing.
 * Aggregate-then-multiply produces fractional cents and lets the
 * effective per-PO advance rate creep over the cap.
 *
 * Floor is the conservative choice: it never lets the borrowing base
 * exceed the spec's percentage limit even by a fractional cent.
 *
 * Reserve applyBps (round) for fee math, where the spec calls for
 * rounding to the nearest cent.
 */
export function applyBpsFloor(amount: Cents, bps: number): Cents {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(`applyBpsFloor(): bps must be non-negative integer; got ${bps}`);
  }
  const numerator = (amount as number) * bps;
  return cents(Math.floor(numerator / 10000));
}
