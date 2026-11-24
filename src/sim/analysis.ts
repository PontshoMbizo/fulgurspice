// Everything the waveform viewer does with numbers, kept pure so the tests can
// exercise it without a browser: decimation, trace math, cursor interpolation, CSV,
// and reading `.meas` results out of the ngspice log.

import { parseSI } from '../core/units';
import type { SimResult, Vector } from './result';

// ---------------------------------------------------------------- decimation

/** Indices worth drawing for `y[i0..i1]` on a plot `buckets` pixels wide: the minimum
 * and maximum of every pixel column (in index order), so a fast ripple is never lost
 * to thinning. Short ranges come back whole. The first and last points always stay. */
export function envelopeIndices(y: ArrayLike<number>, i0: number, i1: number, buckets: number): number[] {
  const n = i1 - i0 + 1;
  if (n <= 0) return [];
  if (n <= buckets * 2 + 2) return Array.from({ length: n }, (_, k) => i0 + k);
  const out: number[] = [i0];
  const size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = i0 + Math.floor(b * size), e = Math.min(i1, i0 + Math.floor((b + 1) * size) - 1);
    let lo = s, hi = s;
    for (let i = s; i <= e; i++) { if (y[i] < y[lo]) lo = i; if (y[i] > y[hi]) hi = i; }
    const a = Math.min(lo, hi), c = Math.max(lo, hi);
    if (a > out[out.length - 1]) out.push(a);
    if (c > out[out.length - 1]) out.push(c);
  }
  if (out[out.length - 1] !== i1) out.push(i1);
  return out;
}

// ---------------------------------------------------------------- interpolation and cursors

/** y at x = xv, by linear interpolation; clamped to the ends. `x` must be ascending. */
export function interpAt(x: ArrayLike<number>, y: ArrayLike<number>, xv: number): number {
  const n = x.length;
  if (!n) return NaN;
  if (xv <= x[0]) return y[0];
  if (xv >= x[n - 1]) return y[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= xv) lo = mid; else hi = mid; }
  const dx = x[hi] - x[lo];
  return dx === 0 ? y[lo] : y[lo] + ((y[hi] - y[lo]) * (xv - x[lo])) / dx;
}

export interface CursorRow { a: number; b: number; delta: number }
export interface CursorDelta {
  dx: number;
  /** 1/dx: the frequency a time difference corresponds to. Null when the cursors coincide. */
  inverse: number | null;
  rows: CursorRow[];
}

/** What two cursors at xa and xb read on each trace, and the differences. */
export function cursorDelta(series: { x: ArrayLike<number>; y: ArrayLike<number> }[], xa: number, xb: number): CursorDelta {
  const dx = xb - xa;
  return {
    dx,
    inverse: dx === 0 ? null : 1 / Math.abs(dx),
    rows: series.map((s) => { const a = interpAt(s.x, s.y, xa), b = interpAt(s.x, s.y, xb); return { a, b, delta: b - a }; }),
  };
}

// ---------------------------------------------------------------- trace math

type Unit = Vector['unit'];

/** A signal while an expression is evaluated: values plus how many volts and amps it is made of. */
interface Sig { re: Float64Array; im: Float64Array | null; v: number; a: number; scalar: boolean; unit?: Unit }

const unitOf = (s: Sig): Unit => {
  if (s.unit !== undefined) return s.unit;
  if (s.v === 1 && s.a === 0) return 'V';
  if (s.v === 0 && s.a === 1) return 'A';
  if (s.v === 1 && s.a === 1) return 'W';
  if (s.v === 1 && s.a === -1) return 'Ω';
  return '';
};

const at = (s: Sig, i: number) => (s.scalar ? s.re[0] : s.re[i]);
const atIm = (s: Sig, i: number) => (s.im ? (s.scalar ? s.im[0] : s.im[i]) : 0);

const FUNCS = new Set(['abs', 'mag', 'db', 'ph', 'phase', 're', 'im', 'sqrt']);

export type MathResult = { ok: true; vector: Vector } | { ok: false; error: string };

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d*\.?\d+(?:[eE][+-]?\d+)?[A-Za-z]*)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) {
      const n = parseSI(m[1]);
      if (n === null) throw new Error(`"${m[1]}" is not a number`);
      out.push({ t: 'num', v: n });
    } else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined && m[3].trim()) out.push({ t: 'op', v: m[3] });
  }
  return out;
}

/** Evaluate a trace expression such as `V(out)/V(in)`, `V(a)-V(b)`, `V(out)*I(R1)` or
 * `db(V(out)/V(in))` against a result. Works on complex AC data too. */
export function evaluate(expr: string, result: SimResult): MathResult {
  try {
    const tokens = tokenize(expr);
    if (!tokens.length) return { ok: false, error: 'Type an expression, e.g. V(out)/V(in)' };
    const n = result.x ? result.x.re.length : 1;
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (op: string) => { const t = tokens[pos]; if (t?.t === 'op' && t.v === op) { pos++; return true; } return false; };
    const need = (op: string) => { if (!eat(op)) throw new Error(`Expected "${op}"`); };

    const scalar = (v: number): Sig => ({ re: Float64Array.of(v), im: null, v: 0, a: 0, scalar: true });
    const lookup = (ref: string): Sig => {
      const key = ref.toLowerCase().replace(/\s+/g, '');
      const vec = result.vectors.find((x) => x.name.toLowerCase() === key || x.label.toLowerCase() === key);
      if (!vec) {
        const have = result.vectors.slice(0, 6).map((x) => x.label).join(', ');
        throw new Error(`No trace called ${ref}. This run has: ${have}${result.vectors.length > 6 ? ', …' : ''}`);
      }
      return { re: vec.re, im: vec.im ?? null, v: vec.unit === 'V' ? 1 : 0, a: vec.unit === 'A' ? 1 : 0, scalar: false };
    };
    const map = (s: Sig, f: (re: number, im: number) => number): Sig => {
      const len = s.scalar ? 1 : n, re = new Float64Array(len);
      for (let i = 0; i < len; i++) re[i] = f(s.re[i], s.im ? s.im[i] : 0);
      return { re, im: null, v: 0, a: 0, scalar: s.scalar };
    };
    const combine = (x: Sig, y: Sig, op: '+' | '-' | '*' | '/'): Sig => {
      if ((op === '+' || op === '-') && !x.scalar && !y.scalar && (x.v !== y.v || x.a !== y.a)) {
        throw new Error(`Cannot ${op === '+' ? 'add' : 'subtract'} ${unitOf(x) || 'a number'} and ${unitOf(y) || 'a number'}`);
      }
      const both = x.scalar && y.scalar;
      const len = both ? 1 : n;
      const complex = !!(x.im || y.im);
      const re = new Float64Array(len), im = complex ? new Float64Array(len) : null;
      for (let i = 0; i < len; i++) {
        const ar = at(x, i), ai = atIm(x, i), br = at(y, i), bi = atIm(y, i);
        let r: number, c = 0;
        if (op === '+') { r = ar + br; c = ai + bi; }
        else if (op === '-') { r = ar - br; c = ai - bi; }
        else if (op === '*') { r = ar * br - ai * bi; c = ar * bi + ai * br; }
        else { const d = br * br + bi * bi; r = (ar * br + ai * bi) / d; c = (ai * br - ar * bi) / d; }
        re[i] = r; if (im) im[i] = c;
      }
      const dims = op === '*' ? { v: x.v + y.v, a: x.a + y.a } : op === '/' ? { v: x.v - y.v, a: x.a - y.a }
        : x.scalar ? { v: y.v, a: y.a } : { v: x.v, a: x.a }; // a bare number adopts the other side's unit
      return { re, im, ...dims, scalar: both };
    };

    const primary = (): Sig => {
      const t = tokens[pos++];
      if (!t) throw new Error('The expression ends too soon');
      if (t.t === 'num') return scalar(t.v);
      if (t.t === 'op' && t.v === '(') { const s = sum(); need(')'); return s; }
      if (t.t === 'id') {
        const next = peek();
        if (next?.t === 'op' && next.v === '(') {
          if (FUNCS.has(t.v.toLowerCase())) {
            pos++;
            const arg = sum();
            need(')');
            switch (t.v.toLowerCase()) {
              case 'abs': case 'mag': return { ...map(arg, (r, i) => Math.hypot(r, i)), v: arg.v, a: arg.a };
              case 'db': return { ...map(arg, (r, i) => 20 * Math.log10(Math.max(Math.hypot(r, i), 1e-30))), unit: 'dB' };
              case 'ph': case 'phase': return { ...map(arg, (r, i) => (Math.atan2(i, r) * 180) / Math.PI), unit: '°' };
              case 're': return { ...map(arg, (r) => r), v: arg.v, a: arg.a };
              case 'im': return { ...map(arg, (_, i) => i), v: arg.v, a: arg.a };
              default: return { ...map(arg, (r) => Math.sqrt(r)), v: arg.v / 2, a: arg.a / 2 };
            }
          }
          // not a function: a trace reference such as V(out) or I(R1); read up to the matching ")"
          pos++;
          let depth = 1, ref = '';
          while (pos < tokens.length && depth > 0) {
            const q = tokens[pos++];
            if (q.t === 'op' && q.v === '(') depth++;
            else if (q.t === 'op' && q.v === ')') { depth--; if (!depth) break; }
            ref += q.t === 'num' ? String(q.v) : q.v;
          }
          if (depth) throw new Error('Missing ")"');
          return lookup(`${t.v}(${ref})`);
        }
        throw new Error(`"${t.v}" is not a trace or a function. Traces are written like V(out) or I(R1)`);
      }
      throw new Error(`Unexpected "${t.v}"`);
    };
    const unary = (): Sig => (eat('-') ? combine(scalar(0), unary(), '-') : eat('+') ? unary() : primary());
    const product = (): Sig => {
      let s = unary();
      for (;;) { if (eat('*')) s = combine(s, unary(), '*'); else if (eat('/')) s = combine(s, unary(), '/'); else return s; }
    };
    function sum(): Sig {
      let s = product();
      for (;;) { if (eat('+')) s = combine(s, product(), '+'); else if (eat('-')) s = combine(s, product(), '-'); else return s; }
    }

    const sig = sum();
    if (pos < tokens.length) { const t = tokens[pos]; throw new Error(`Unexpected "${t.v}"`); }
    if (sig.scalar) return { ok: false, error: 'That is a constant, not a trace: include a trace such as V(out)' };
    const name = expr.trim();
    return { ok: true, vector: { name, label: name, unit: unitOf(sig), re: sig.re, ...(sig.im ? { im: sig.im } : {}) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The result with each valid expression added as a trace named after it. Bad ones are reported, not added.
 * For a sweep, the expression is evaluated in every run. */
export function withDerived(result: SimResult, exprs: string[]): { result: SimResult; errors: Record<string, string> } {
  if (!result.ok || !result.x || !exprs.length) return { result, errors: {} };
  if (result.sweep) {
    const parts = result.sweep.runs.map((r) => withDerived({ ...r, sweep: undefined }, exprs));
    const first = parts[0].result;
    return { result: { ...first, sweep: { ...result.sweep, runs: parts.map((p) => p.result) } }, errors: parts[0].errors };
  }
  const errors: Record<string, string> = {};
  const extra: Vector[] = [];
  for (const e of exprs) {
    if (result.vectors.some((v) => v.name === e) || extra.some((v) => v.name === e.trim())) continue;
    const r = evaluate(e, result);
    if (r.ok) extra.push(r.vector); else errors[e] = r.error;
  }
  return { result: extra.length ? { ...result, vectors: [...result.vectors, ...extra] } : result, errors };
}

/** Combine the runs of a parameter sweep into one result. Top-level fields are the first run's,
 * so everything that does not know about sweeps keeps working on it. */
export function mergeSweep(param: string, tags: string[], runs: SimResult[]): SimResult {
  const first = runs[0];
  return {
    ...first,
    messages: [...new Set(runs.flatMap((r) => r.messages))],
    log: runs.map((r, i) => `* ${param} = ${tags[i]}\n${r.log}`).join('\n'),
    ms: runs.reduce((t, r) => t + r.ms, 0),
    sweep: { param, tags, runs },
  };
}

// ---------------------------------------------------------------- CSV

const num = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(9))) : '');
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The sweep variable and the chosen traces as CSV. AC traces give real and imaginary
 * parts; the unit sits in the header so a spreadsheet keeps it. */
export function toCsv(result: SimResult, names: string[]): string {
  if (!result.ok || !result.x) return '';
  if (result.sweep) {
    // long form: one row per point per run, led by the sweep value (the runs have their own time points)
    const { param, tags, runs } = result.sweep;
    const parts = runs.map((r) => toCsv({ ...r, sweep: undefined }, names).trimEnd().split('\n'));
    return [`${csvCell(param)},${parts[0][0]}`, ...parts.flatMap((rows, i) => rows.slice(1).map((row) => `${csvCell(tags[i])},${row}`))].join('\n') + '\n';
  }
  const picked = names.map((n) => result.vectors.find((v) => v.name === n)).filter((v): v is Vector => !!v);
  const head = [`${result.x.label} [${result.x.unit}]`];
  for (const v of picked) {
    if (v.im) head.push(`${v.label} re [${v.unit}]`, `${v.label} im [${v.unit}]`);
    else head.push(`${v.label} [${v.unit}]`);
  }
  const rows = [head.map(csvCell).join(',')];
  const n = result.x.re.length;
  for (let i = 0; i < n; i++) {
    const row = [num(result.x.re[i])];
    for (const v of picked) { row.push(num(v.re[i])); if (v.im) row.push(num(v.im[i])); }
    rows.push(row.join(','));
  }
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------- .meas results

export interface Measurement {
  name: string;
  /** Null when ngspice could not evaluate it (the condition never happened). */
  value: number | null;
  /** The rest of ngspice's line: "at= 3.37e-04", "targ= … trig= …". */
  note: string;
}

/** Read the "Measurements for … Analysis" block of an ngspice log. */
export function parseMeasurements(log: string): Measurement[] {
  const start = log.search(/Measurements for [A-Za-z ]*Analysis/i);
  if (start < 0) return [];
  const out: Measurement[] = [];
  for (const line of log.slice(start).split(/\r?\n/).slice(1)) {
    if (/^\s*ngspice\s+\d|binary raw file/i.test(line)) break;
    const bad = /^\s*Error:\s*measure\s+(\S+)\s*(.*)$/i.exec(line);
    if (bad) { if (!out.some((x) => x.name === bad[1])) out.push({ name: bad[1], value: null, note: bad[2].replace(/^:\s*/, '').trim() || 'could not be evaluated' }); continue; }
    const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    out.push({ name: m[1], value: Number.isFinite(value) ? value : null, note: m[3].trim() });
  }
  return out;
}

/** Measurements from every run of a result, named with the sweep value when there is a sweep. */
export function measurementsOf(result: SimResult): Measurement[] {
  if (!result.ok) return [];
  if (!result.sweep) return parseMeasurements(result.log);
  const { param, tags, runs } = result.sweep;
  return runs.flatMap((r, i) => parseMeasurements(r.log).map((m) => ({ ...m, name: `${m.name} (${param}=${tags[i]})` })));
}
