import { describe, expect, it } from 'vitest';
import { cursorDelta, envelopeIndices, evaluate, interpAt, measurementsOf, mergeSweep, parseMeasurements, toCsv, withDerived } from '../src/sim/analysis';
import { parseSweep } from '../src/core/params';
import type { SimResult, Vector } from '../src/sim/result';

const vec = (name: string, label: string, unit: Vector['unit'], re: number[], im?: number[]): Vector =>
  ({ name, label, unit, re: Float64Array.from(re), ...(im ? { im: Float64Array.from(im) } : {}) });
const result = (vectors: Vector[], x: number[], kind: SimResult['kind'] = 'tran'): SimResult =>
  ({ kind, ok: true, x: vec('time', 'time', 's', x), vectors, points: x.length, messages: [], log: '', ms: 0 });

describe('envelopeIndices', () => {
  it('returns short ranges whole', () => { expect(envelopeIndices([1, 2, 3, 4], 0, 3, 10)).toEqual([0, 1, 2, 3]); });
  it('keeps the global min and max, in order, and far fewer points', () => {
    const n = 100000, y = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50) + (i === 70001 ? 5 : 0) + (i === 33333 ? -4 : 0));
    const idx = envelopeIndices(y, 0, n - 1, 400);
    expect(idx.length).toBeLessThanOrEqual(400 * 2 + 2);
    expect(idx[0]).toBe(0); expect(idx[idx.length - 1]).toBe(n - 1);
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBeGreaterThan(idx[k - 1]);
    expect(Math.max(...idx.map((i) => y[i]))).toBe(Math.max(...y));
    expect(Math.min(...idx.map((i) => y[i]))).toBe(Math.min(...y));
    expect(idx).toContain(70001); expect(idx).toContain(33333); // single-sample spikes survive
  });
  it('respects a sub-range', () => {
    const y = Float64Array.from({ length: 50000 }, (_, i) => i % 7);
    const idx = envelopeIndices(y, 10000, 20000, 100);
    expect(Math.min(...idx)).toBe(10000); expect(Math.max(...idx)).toBe(20000);
  });
  it('handles an empty range', () => { expect(envelopeIndices([], 0, -1, 10)).toEqual([]); });
});

describe('interpAt and cursorDelta', () => {
  const x = [0, 1, 2, 4], y = [0, 10, 20, 0];
  it('interpolates linearly and clamps at the ends', () => {
    expect(interpAt(x, y, 0.5)).toBe(5); expect(interpAt(x, y, 3)).toBe(10);
    expect(interpAt(x, y, -1)).toBe(0); expect(interpAt(x, y, 9)).toBe(0);
    expect(interpAt(x, y, 2)).toBe(20);
  });
  it('reads two cursors and their difference, with 1/dx for a period', () => {
    const d = cursorDelta([{ x, y }, { x, y: [1, 1, 1, 1] }], 0.5, 2);
    expect(d.dx).toBe(1.5);
    expect(d.inverse).toBeCloseTo(1 / 1.5, 12);
    expect(d.rows[0]).toEqual({ a: 5, b: 20, delta: 15 });
    expect(d.rows[1].delta).toBe(0);
    expect(cursorDelta([{ x, y }], 1, 1).inverse).toBeNull();
    expect(cursorDelta([{ x, y }], 2, 1).dx).toBe(-1); // order matters for the sign
  });
});

describe('trace math', () => {
  const r = result([
    vec('v(a)', 'V(a)', 'V', [1, 2, 3]), vec('v(b)', 'V(b)', 'V', [0.5, 0.5, 1]), vec('i(r1)', 'I(R1)', 'A', [0.1, 0.2, 0.3]),
  ], [0, 1, 2]);
  const ok = (e: string) => { const m = evaluate(e, r); if (!m.ok) throw new Error(m.error); return m.vector; };
  const err = (e: string) => { const m = evaluate(e, r); return m.ok ? '' : m.error; };

  it('adds, subtracts, multiplies and divides traces, tracking units', () => {
    expect(Array.from(ok('V(a)-V(b)').re)).toEqual([0.5, 1.5, 2]);
    expect(ok('V(a)-V(b)').unit).toBe('V');
    expect(Array.from(ok('V(a)*I(R1)').re).map((v) => Number(v.toFixed(9)))).toEqual([0.1, 0.4, 0.9]);
    expect(ok('V(a)*I(R1)').unit).toBe('W');
    expect(ok('V(a)/I(R1)').unit).toBe('Ω');
    expect(Array.from(ok('V(a)/V(b)').re)).toEqual([2, 4, 3]);
    expect(ok('V(a)/V(b)').unit).toBe('');
  });
  it('respects precedence, parentheses, unary minus, case and SPICE suffixes', () => {
    expect(Array.from(ok('V(a) + V(b) * 2').re)).toEqual([2, 3, 5]);
    expect(Array.from(ok('(V(a) + V(b)) * 2').re)).toEqual([3, 5, 8]);
    expect(Array.from(ok('-V(a)').re)).toEqual([-1, -2, -3]);
    expect(Array.from(ok('v(A) * 1k').re)).toEqual([1000, 2000, 3000]);
    expect(Array.from(ok('v(a)*1e-3').re)).toEqual([0.001, 0.002, 0.003]);
    expect(ok('V(a)+1').unit).toBe('V'); // a bare number takes the other side's unit
  });
  it('has abs, sqrt, db and phase', () => {
    expect(Array.from(ok('abs(V(b)-V(a))').re)).toEqual([0.5, 1.5, 2]);
    expect(Array.from(ok('sqrt(V(a)*V(a))').re)).toEqual([1, 2, 3]);
    expect(ok('sqrt(V(a)*V(a))').unit).toBe('V');
    expect(ok('db(V(a))').unit).toBe('dB');
    expect(ok('db(V(a))').re[1]).toBeCloseTo(20 * Math.log10(2), 12);
    expect(ok('ph(V(a))').unit).toBe('°');
  });
  it('explains what is wrong in terms of the trace names', () => {
    expect(err('V(a)+I(R1)')).toMatch(/Cannot add V and A/);
    expect(err('V(zz)')).toMatch(/No trace called V\(zz\)\. This run has: V\(a\), V\(b\), I\(R1\)/);
    expect(err('foo')).toMatch(/not a trace or a function/);
    expect(err('V(a) +')).toMatch(/ends too soon/);
    expect(err('(V(a)')).toMatch(/Expected "\)"/);
    expect(err('V(a) V(b)')).toMatch(/Unexpected/);
    expect(err('2*3')).toMatch(/constant, not a trace/);
    expect(err('')).toMatch(/Type an expression/);
    expect(err('V(a) @ 2')).toMatch(/Unexpected "@"/);
  });
  it('does complex arithmetic for AC: gain and phase of V(out)/V(in)', () => {
    const ac = result([vec('v(in)', 'V(in)', 'V', [1, 1], [0, 0]), vec('v(out)', 'V(out)', 'V', [0.5, 0], [-0.5, -1])], [10, 100], 'ac');
    const h = evaluate('V(out)/V(in)', ac);
    expect(h.ok && Array.from(h.vector.re)).toEqual([0.5, 0]);
    expect(h.ok && Array.from(h.vector.im!)).toEqual([-0.5, -1]);
    const db = evaluate('db(V(out)/V(in))', ac);
    expect(db.ok && db.vector.re[1]).toBeCloseTo(0, 12); // |−j| = 1
    const ph = evaluate('ph(V(out))', ac);
    expect(ph.ok && ph.vector.re[1]).toBeCloseTo(-90, 9);
    const prod = evaluate('V(out)*V(out)', ac); // (0.5-0.5j)^2 = -0.5j
    expect(prod.ok && prod.vector.re[0]).toBeCloseTo(0, 12);
    expect(prod.ok && prod.vector.im![0]).toBeCloseTo(-0.5, 12);
  });
  it('withDerived adds valid expressions as traces named after them and reports the rest', () => {
    const { result: out, errors } = withDerived(r, ['V(a)-V(b)', 'V(nope)', 'V(a)-V(b)']);
    expect(out.vectors.map((v) => v.name)).toEqual(['v(a)', 'v(b)', 'i(r1)', 'V(a)-V(b)']);
    expect(Object.keys(errors)).toEqual(['V(nope)']);
    expect(withDerived(r, []).result).toBe(r);
  });
});

describe('toCsv', () => {
  it('writes the sweep variable and chosen traces with units in the header', () => {
    const r = result([vec('v(a)', 'V(a)', 'V', [1, 2]), vec('i(r1)', 'I(R1)', 'A', [0.001, 0.002])], [0, 1e-6]);
    expect(toCsv(r, ['v(a)', 'i(r1)'])).toBe('time [s],V(a) [V],I(R1) [A]\n0,1,0.001\n0.000001,2,0.002\n');
    expect(toCsv(r, ['v(a)', 'missing'])).toBe('time [s],V(a) [V]\n0,1\n0.000001,2\n');
  });
  it('gives AC traces as real and imaginary columns, and quotes awkward labels', () => {
    const ac = result([vec('v(o)', 'V(o)', 'V', [1], [-2])], [100], 'ac');
    expect(toCsv(ac, ['v(o)'])).toBe('time [s],V(o) re [V],V(o) im [V]\n100,1,-2\n');
    const odd = result([vec('x', 'a,b', 'V', [1])], [0]);
    expect(toCsv(odd, ['x']).split('\n')[0]).toBe('time [s],"a,b [V]"');
    expect(toCsv({ ...odd, ok: false }, ['x'])).toBe('');
  });
});

describe('parseMeasurements', () => {
  const log = `ngspice 1 -> 
No. of Data Rows : 512

  Measurements for Transient Analysis

vmax                =  8.619923e-01 at=  3.373063e-04
vpp                 =  1.708580e+00 from=  0.000000e+00 to=  0.000000e+00
tr                  =  8.930514e-05 targ=  1.089306e-03 trig=  1.000001e-03
gone                =  failed
Error: measure  never  find(AT) : out of interval
 .meas tran never find v(out) at=99 failed!
	measure 'oops'  failed
Error: measure  oops  :
	no such function as 'wibble'

ngspice 4 -> binary raw file "out.raw"
`;
  it('reads names, values and the trailing note', () => {
    const m = parseMeasurements(log);
    expect(m.map((x) => x.name)).toEqual(['vmax', 'vpp', 'tr', 'gone', 'never', 'oops']);
    expect(m[0]).toEqual({ name: 'vmax', value: 0.8619923, note: 'at=  3.373063e-04' });
    expect(m[2].value).toBeCloseTo(8.930514e-5, 12);
    expect(m[3]).toEqual({ name: 'gone', value: null, note: '' });
    expect(m[4]).toEqual({ name: 'never', value: null, note: 'find(AT) : out of interval' });
    expect(m[5]).toEqual({ name: 'oops', value: null, note: 'could not be evaluated' });
  });
  it('finds nothing when there is no measurement block', () => {
    expect(parseMeasurements('Circuit: x\nNo. of Data Rows : 5\n')).toEqual([]);
    expect(parseMeasurements('')).toEqual([]);
  });
});

describe('parseSweep', () => {
  const ok = (param: string, values: string) => { const r = parseSweep({ param, values }); if (!r.sweep) throw new Error(r.error ?? 'no sweep'); return r.sweep; };
  const bad = (param: string, values: string) => parseSweep({ param, values }).error;

  it('reads a list, with SPICE suffixes, commas or spaces', () => {
    const s = ok('R', '1k, 2k 4k7');
    expect(s.param).toBe('R');
    expect(s.values.map((v) => v.value)).toEqual(['1000', '2000', '4700']);
    expect(s.values.map((v) => v.tag)).toEqual(['1k', '2k', '4.7k']);
  });
  it('generates linear and decade sweeps, endpoints included', () => {
    expect(ok('R', 'lin 1k 4k 4').values.map((v) => v.value)).toEqual(['1000', '2000', '3000', '4000']);
    const dec = ok('C', 'dec 100 10k 2').values.map((v) => Number(v.value));
    expect(dec).toHaveLength(5);
    expect(dec[0]).toBeCloseTo(100, 6); expect(dec[2]).toBeCloseTo(1000, 6); expect(dec[4]).toBeCloseTo(10000, 4);
  });
  it('says nothing when there is no sweep, and explains what is wrong otherwise', () => {
    expect(parseSweep(undefined)).toEqual({ sweep: null, error: null });
    expect(parseSweep({ param: '', values: '' })).toEqual({ sweep: null, error: null });
    expect(bad('', '1k')).toMatch(/Name the parameter/);
    expect(bad('1R', '1k')).toMatch(/not a valid parameter name/);
    expect(bad('R', '')).toMatch(/List the values/);
    expect(bad('R', '1k abc')).toMatch(/"abc" is not a number/);
    expect(bad('R', 'lin 1k')).toMatch(/Write lin start stop count/);
    expect(bad('R', 'lin 1k 2k 1')).toMatch(/at least 2/);
    expect(bad('R', 'dec 0 10 3')).toMatch(/0 < start < stop/);
    expect(bad('R', 'lin 1 100 50')).toMatch(/50 runs; the limit is 12/);
  });
});

describe('sweep results', () => {
  const run = (scale: number, x: number[]): SimResult => ({
    ...result([vec('v(out)', 'V(out)', 'V', x.map((t) => scale * t)), vec('i(v1)', 'I(V1)', 'A', x.map(() => 0.001 * scale))], x),
    log: `Measurements for Transient Analysis\n\nvmax = ${scale * 2} at= 1e-3\n\nngspice 2 -> binary raw file "x"\n`,
  });
  const runs = [run(1, [0, 1, 2]), run(2, [0, 0.5, 1, 1.5, 2])]; // different time points per run, as ngspice gives
  const merged = mergeSweep('R', ['1k', '2k'], runs);

  it('keeps the first run as the top level, so code that ignores sweeps still works', () => {
    expect(merged.vectors).toBe(runs[0].vectors);
    expect(merged.sweep!.runs).toBe(runs);
    expect(merged.sweep!.tags).toEqual(['1k', '2k']);
    expect(merged.log).toContain('* R = 1k');
    expect(merged.log).toContain('* R = 2k');
  });
  it('evaluates trace math in every run', () => {
    const { result: d, errors } = withDerived(merged, ['V(out)*2']);
    expect(errors).toEqual({});
    // run 1 has V(out) = t = [0,1,2]; run 2 has V(out) = 2t = [0,1,2,3,4] on its own time points
    expect(d.sweep!.runs.map((r) => Array.from(r.vectors.find((v) => v.name === 'V(out)*2')!.re))).toEqual([[0, 2, 4], [0, 2, 4, 6, 8]]);
    expect(d.vectors.map((v) => v.name)).toContain('V(out)*2'); // the top level is the first run
    expect(withDerived(merged, ['V(nope)']).errors).toHaveProperty(['V(nope)']);
  });
  it('writes a sweep as long-form CSV led by the sweep value', () => {
    const csv = toCsv(merged, ['v(out)']).trim().split('\n');
    expect(csv[0]).toBe('R,time [s],V(out) [V]');
    expect(csv).toHaveLength(1 + 3 + 5);
    expect(csv[1]).toBe('1k,0,0');
    expect(csv[4]).toBe('2k,0,0');
    expect(csv[8]).toBe('2k,2,4');
  });
  it('collects measurements from every run and names them by sweep value', () => {
    expect(measurementsOf(merged).map((m) => [m.name, m.value])).toEqual([['vmax (R=1k)', 2], ['vmax (R=2k)', 4]]);
    expect(measurementsOf(runs[0]).map((m) => m.name)).toEqual(['vmax']);
    expect(measurementsOf({ ...runs[0], ok: false })).toEqual([]);
  });
});
