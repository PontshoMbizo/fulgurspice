import { describe, expect, it } from 'vitest';
import { cursorDelta, envelopeIndices, evaluate, interpAt, parseMeasurements, toCsv, withDerived } from '../src/sim/analysis';
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
