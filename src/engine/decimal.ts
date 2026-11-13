/**
 * Exact decimal numbers for money, built on BigInt. No floats anywhere.
 *
 * Why not a library: the engine needs add, subtract, multiply, divide and
 * rounding, nothing more. A ~150 line class with no dependency is easier to
 * audit than pulling in a general-purpose decimal package.
 *
 * Values are stored as an integer count of 10^-SCALE units. SCALE = 10 keeps
 * interest calculations accurate to well below one piaster over centuries of
 * compounding, while display rounds to 2 places. Intermediate results of
 * multiply/divide round half-to-even (no systematic bias over many months).
 */

const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);
const NUMBER_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

export type DecimalInput = Dec | string | bigint | number;

/** Integer division rounded half to even. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("Division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  const away = n < 0n ? q - 1n : q + 1n;
  if (twice > d) return away;
  if (twice < d) return q;
  return q % 2n === 0n ? q : away;
}

export class Dec {
  static readonly ZERO = new Dec(0n);

  private constructor(private readonly units: bigint) {}

  /**
   * Parse a decimal. Accepts "1234.56", "-5", "1,234.5" and safe numbers.
   * Numbers are only accepted when they are finite; they are converted via
   * their shortest decimal string, which is exact for any value that came
   * from a 2-decimal numeric column.
   */
  static of(value: DecimalInput): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === "bigint") return new Dec(value * ONE);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return new Dec(BigInt(value) * ONE);
      return Dec.parse(Dec.numberToPlain(value));
    }
    return Dec.parse(value);
  }

  /** Like of() but returns null instead of throwing (for user input). */
  static tryOf(value: unknown): Dec | null {
    if (value === null || value === undefined || value === "") return null;
    if (!(value instanceof Dec) && !["string", "number", "bigint"].includes(typeof value)) return null;
    try {
      return Dec.of(value as DecimalInput);
    } catch {
      return null;
    }
  }

  private static parse(text: string): Dec {
    const clean = text.trim().replace(/,/g, "");
    const m = NUMBER_RE.exec(clean);
    if (!m) throw new RangeError(`Not a valid number: "${text}"`);
    const [, sign, int = "0", frac = ""] = m;
    let units = BigInt(int) * ONE;
    if (frac.length <= SCALE) {
      units += BigInt(frac.padEnd(SCALE, "0") || "0");
    } else {
      // more precision than we keep: round half to even
      const extra = frac.length - SCALE;
      units += divRound(BigInt(frac), 10n ** BigInt(extra));
    }
    return new Dec(sign === "-" ? -units : units);
  }

  private static numberToPlain(n: number): string {
    const s = String(n);
    if (!/e/i.test(s)) return s;
    // 1e-7 -> "0.0000001", 1.5e21 -> "1500000000000000000000"
    const [mant = "0", expPart = "0"] = s.toLowerCase().split("e");
    const exp = Number(expPart);
    const neg = mant.startsWith("-");
    const digits = mant.replace(/^-/, "");
    const [i = "0", f = ""] = digits.split(".");
    const all = i + f;
    const point = i.length + exp;
    let out: string;
    if (point <= 0) out = "0." + "0".repeat(-point) + all;
    else if (point >= all.length) out = all + "0".repeat(point - all.length);
    else out = all.slice(0, point) + "." + all.slice(point);
    return (neg ? "-" : "") + out;
  }

  static sum(values: Iterable<DecimalInput>): Dec {
    let total = 0n;
    for (const v of values) total += Dec.of(v).units;
    return new Dec(total);
  }

  plus(other: DecimalInput): Dec {
    return new Dec(this.units + Dec.of(other).units);
  }

  minus(other: DecimalInput): Dec {
    return new Dec(this.units - Dec.of(other).units);
  }

  times(other: DecimalInput): Dec {
    return new Dec(divRound(this.units * Dec.of(other).units, ONE));
  }

  div(other: DecimalInput): Dec {
    const d = Dec.of(other).units;
    if (d === 0n) throw new RangeError("Division by zero");
    return new Dec(divRound(this.units * ONE, d));
  }

  neg(): Dec {
    return new Dec(-this.units);
  }

  abs(): Dec {
    return this.units < 0n ? this.neg() : this;
  }

  cmp(other: DecimalInput): -1 | 0 | 1 {
    const o = Dec.of(other).units;
    return this.units < o ? -1 : this.units > o ? 1 : 0;
  }

  eq(other: DecimalInput): boolean {
    return this.cmp(other) === 0;
  }
  gt(other: DecimalInput): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: DecimalInput): boolean {
    return this.cmp(other) >= 0;
  }
  lt(other: DecimalInput): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: DecimalInput): boolean {
    return this.cmp(other) <= 0;
  }
  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }

  static max(a: Dec, b: Dec): Dec {
    return a.gte(b) ? a : b;
  }
  static min(a: Dec, b: Dec): Dec {
    return a.lte(b) ? a : b;
  }

  /** Round to `places` decimals, half away from zero (how people round money). */
  round(places = 2): Dec {
    if (places >= SCALE) return this;
    const step = 10n ** BigInt(SCALE - places);
    const q = this.units / step;
    const r = this.units % step;
    const twice = (r < 0n ? -r : r) * 2n;
    const rounded = twice >= step ? (this.units < 0n ? q - 1n : q + 1n) : q;
    return new Dec(rounded * step);
  }

  /** Plain string, rounded half away from zero, e.g. "-1234.50". */
  toFixed(places = 2): string {
    const r = this.round(places).units;
    const neg = r < 0n;
    const abs = neg ? -r : r;
    const int = abs / ONE;
    let s = int.toString();
    if (places > 0) {
      const frac = (abs % ONE).toString().padStart(SCALE, "0").slice(0, places);
      s += "." + frac;
    }
    return (neg && /[1-9]/.test(s) ? "-" : "") + s;
  }

  /** Full precision string without trailing zeros. */
  toString(): string {
    const neg = this.units < 0n;
    const abs = neg ? -this.units : this.units;
    const int = (abs / ONE).toString();
    const frac = (abs % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + int + (frac ? "." + frac : "");
  }

  /** Only for charts and other display math. Never feed it back into calculations. */
  toNumber(): number {
    return Number(this.toString());
  }

  toJSON(): string {
    return this.toString();
  }
}

export const D = Dec.of;
