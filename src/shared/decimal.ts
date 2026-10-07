/**
 * Decimal exato para cálculo tributário (nunca float). Ponto fixo com 30 casas
 * sobre bigint; arredondamento "meio para cima" (half-up), afastando do zero.
 */
const SCALE = 30;
const S = 10n ** BigInt(SCALE);

function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("Divisão por zero");
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (a * 2n + b) / (2n * b);
  return neg ? -q : q;
}

export class Dec {
  private constructor(readonly raw: bigint) {}

  static of(v: string | number | bigint | Dec): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === "bigint") return new Dec(v * S);
    const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : (() => { throw new Error("Use string para valores fracionários"); })()) : v.trim();
    const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new Error(`Número inválido: ${s}`);
    const frac = (m[3] ?? "").slice(0, SCALE).padEnd(SCALE, "0");
    const raw = BigInt(m[2]!) * S + BigInt(frac);
    return new Dec(m[1] ? -raw : raw);
  }

  static readonly ZERO = new Dec(0n);

  /** "53.50" (percentual) → 0.535 */
  static pct(v: string): Dec {
    return Dec.of(v).div(100n);
  }

  add(o: Dec | string): Dec { return new Dec(this.raw + Dec.of(o).raw); }
  sub(o: Dec | string): Dec { return new Dec(this.raw - Dec.of(o).raw); }
  mul(o: Dec | string | bigint): Dec { return new Dec(divRound(this.raw * Dec.of(o).raw, S)); }
  div(o: Dec | string | bigint): Dec { return new Dec(divRound(this.raw * S, Dec.of(o).raw)); }
  cmp(o: Dec | string): number { const b = Dec.of(o).raw; return this.raw < b ? -1 : this.raw > b ? 1 : 0; }
  gt(o: Dec | string) { return this.cmp(o) > 0; }
  lte(o: Dec | string) { return this.cmp(o) <= 0; }
  isZero() { return this.raw === 0n; }
  static min(a: Dec, b: Dec) { return a.cmp(b) <= 0 ? a : b; }
  static max(a: Dec, b: Dec) { return a.cmp(b) >= 0 ? a : b; }

  /** Arredonda para `places` casas (half-up). */
  round(places = 2): Dec {
    const unit = 10n ** BigInt(SCALE - places);
    return new Dec(divRound(this.raw, unit) * unit);
  }

  toFixed(places = 2): string {
    const r = this.round(places).raw;
    const neg = r < 0n;
    const a = neg ? -r : r;
    const int = a / S;
    const frac = (a % S).toString().padStart(SCALE, "0").slice(0, places);
    return `${neg ? "-" : ""}${int}${places ? "." + frac : ""}`;
  }

  toString() { return this.toFixed(10).replace(/\.?0+$/, ""); }
}

export const sumDec = (xs: Dec[]) => xs.reduce((a, b) => a.add(b), Dec.ZERO);
