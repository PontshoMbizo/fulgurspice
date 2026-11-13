// SPICE-flavoured engineering notation. Follows SPICE, not SI: `m` is milli and
// `meg` is mega, case-insensitive, and trailing unit letters are ignored (10uF, 5V).
// Also accepts the infix form printed on real parts (4k7 = 4.7k).

const MULT: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

export function parseSI(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/μ/g, 'µ');
  if (!s) return null;
  const infix = /^([+-]?\d+)(meg|[tgkmuµnpf])(\d+)$/.exec(s);
  if (infix) return Number(`${infix[1]}.${infix[3]}`) * MULT[infix[2]];
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[tgkmuµnpf])?[a-zω]*$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? MULT[m[2]] : 1);
  return Number.isFinite(v) ? v : null;
}

/** A number ngspice parses unambiguously (plain or e-notation, no suffix). */
export function toSpice(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/** Value text for a netlist card: normalised if it is a number, passed through otherwise ({R1}, expressions). */
export function spiceValue(text: string): string {
  const n = parseSI(text);
  return n === null ? text.trim().replace(/\s+/g, ' ') : toSpice(n);
}

const PREFIX: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

/** 0.0047 -> "4.7m", for axis ticks and readouts. */
export function formatSI(n: number, unit = '', digits = 4): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return `0${unit}`;
  const a = Math.abs(n);
  const [scale, prefix] = PREFIX.find(([s]) => a >= s * 0.9999999) ?? PREFIX[PREFIX.length - 1];
  return `${Number((n / scale).toPrecision(digits))}${prefix}${unit}`;
}

/** Round-number tick positions covering [min, max] (1/2/5 × 10^n spacing). */
export function niceTicks(min: number, max: number, target = 8): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) out.push(Number((k * step).toPrecision(12)));
  return out;
}
