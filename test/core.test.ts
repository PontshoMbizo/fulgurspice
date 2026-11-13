import { describe, expect, it } from 'vitest';
import { formatSI, niceTicks, parseSI, spiceValue } from '../src/core/units';
import { compile } from '../src/core/netlist';
import { EXAMPLES } from '../src/core/examples';
import { emptySchematic, type Part, type Schematic } from '../src/core/types';
import { pinPositions, toWorld } from '../src/core/symbols';
import { vectorLabel } from '../src/sim/result';

const close = (a: number | null, b: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThan(Math.abs(b) * 1e-9 + 1e-30);

describe('units', () => {
  it('parses SPICE suffixes, where m is milli and meg is mega', () => {
    close(parseSI('1k'), 1e3); close(parseSI('4k7'), 4700); close(parseSI('100n'), 1e-7); close(parseSI('1meg'), 1e6);
    close(parseSI('1M'), 1e-3); close(parseSI('10uF'), 1e-5); close(parseSI('2.2µ'), 2.2e-6); close(parseSI('1e3'), 1e3);
    close(parseSI('5V'), 5); close(parseSI('-3.3'), -3.3); close(parseSI('.5'), 0.5);
  });
  it('rejects things that are not numbers', () => {
    for (const s of ['', 'abc', 'SIN(0 1 1k)', '1 2', '{R}']) expect(parseSI(s)).toBeNull();
  });
  it('normalises numbers for the netlist and passes expressions through', () => {
    expect(spiceValue('4k7')).toBe('4700'); expect(spiceValue('100n')).toBe('1e-7'); expect(spiceValue('SIN(0 1  1k)')).toBe('SIN(0 1 1k)');
  });
  it('formats with engineering prefixes', () => {
    expect(formatSI(0.0047, 'A')).toBe('4.7mA'); expect(formatSI(1590, 'Hz')).toBe('1.59kHz'); expect(formatSI(0, 'V')).toBe('0V'); expect(formatSI(-2.5e-6, 's')).toBe('-2.5µs');
  });
  it('picks round ticks', () => { expect(niceTicks(0, 0.01, 10)).toEqual([0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01]); });
});

describe('symbol transforms', () => {
  it('rotates clockwise and mirrors before rotating', () => {
    const at = { x: 10, y: 10, mirror: false };
    expect(toWorld({ ...at, rot: 0 }, 0, -2)).toEqual({ x: 10, y: 8 });
    expect(toWorld({ ...at, rot: 90 }, 0, -2)).toEqual({ x: 12, y: 10 });
    expect(toWorld({ ...at, rot: 180 }, 0, -2)).toEqual({ x: 10, y: 12 });
    expect(toWorld({ ...at, rot: 270 }, 0, -2)).toEqual({ x: 8, y: 10 });
    expect(toWorld({ ...at, rot: 0, mirror: true }, 1, -2)).toEqual({ x: 9, y: 8 });
  });
});

const P = (kind: Part['kind'], ref: string, x: number, y: number, value = '1k', rot: Part['rot'] = 0): Part => ({ id: `${kind}${ref}${x}_${y}`, kind, ref, x, y, rot, mirror: false, value });
const sch = (parts: Part[], w: number[][], patch: Partial<Schematic> = {}): Schematic => ({ ...emptySchematic(), parts, wires: w.map(([x1, y1, x2, y2], i) => ({ id: `w${i}`, x1, y1, x2, y2 })), ...patch });

describe('netlister', () => {
  it('turns the RC example into the expected cards', () => {
    const c = compile(EXAMPLES[0].build());
    expect(c.issues).toEqual([]);
    expect(c.netlist.split('\n')).toEqual(['* RC low-pass', 'V1 in 0 SIN(0 1 1k)', 'R1 out in 1000', 'C1 out 0 1e-7', '.options savecurrents', '.tran 0.00001 0.005', '.end', '']);
  });
  it('compiles every example without issues', () => {
    for (const ex of EXAMPLES) expect(compile(ex.build()).issues, ex.name).toEqual([]);
  });
  it('connects a wire end that lands mid-wire, but not two wires that cross', () => {
    const base = [P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('R', 'R1', 10, 2), P('GND', '', 10, 4, '')];
    const tee = compile(sch(base, [[0, 0, 20, 0], [10, 0, 10, -5]]));
    expect(tee.pinNode.get('RR110_2:1')).toBe(tee.pinNode.get('VV10_2:+'));
    expect(tee.junctions).toEqual([{ x: 10, y: 0 }]);
    const cross = compile(sch([...base, P('R', 'R2', 5, 7), P('GND', '', 5, 9, '')], [[0, 0, 10, 0], [5, -3, 5, 5]]));
    expect(cross.pinNode.get('RR25_7:1')).not.toBe(cross.pinNode.get('VV10_2:+'));
    expect(cross.junctions).toEqual([]);
  });
  it('joins nets that carry the same label', () => {
    const c = compile(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('LABEL', '', 0, 0, 'VCC'), P('R', 'R1', 10, 2), P('LABEL', '', 10, 0, 'vcc'), P('GND', '', 10, 4, '')], []));
    expect(c.issues).toEqual([]);
    expect(c.netlist).toContain('R1 vcc 0 1000');
  });
  it('reports missing ground, dangling pins, duplicate references and bad values', () => {
    const messages = (s: Schematic) => compile(s).issues.map((i) => i.message).join(' | ');
    expect(messages(sch([P('R', 'R1', 0, 0)], []))).toMatch(/No ground/);
    expect(messages(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('R', 'R1', 0, -2)], []))).toMatch(/R1 pin 1 is not connected/);
    expect(messages(sch([P('R', 'R1', 0, 2), P('R', 'R1', 0, -2), P('GND', '', 0, 4, '')], []))).toMatch(/Two parts are called R1/);
    expect(messages(sch([P('R', 'R1', 0, 2, 'lots'), P('GND', '', 0, 4, '')], []))).toMatch(/not a number/);
    expect(messages(sch([], []))).toMatch(/Nothing to simulate/);
    expect(compile(sch([P('R', 'R1', 0, 0)], [])).ok).toBe(false);
  });
  it('emits a built-in model once, only when used, and keeps user directives', () => {
    const c = compile(sch([P('V', 'V1', 0, 2, '5'), P('GND', '', 0, 4, ''), P('D', 'D1', 0, -2, 'dgen'), P('D', 'D2', 0, -6, 'DGEN'), P('R', 'R1', 0, -10)], [[0, -12, 5, -12], [5, -12, 5, 4], [5, 4, 0, 4]], { directives: '.param x=1\n.end' }));
    expect(c.issues).toEqual([]);
    expect(c.netlist.match(/\.model DGEN/g)).toHaveLength(1);
    expect(c.netlist).toContain('.param x=1');
    expect(c.netlist.match(/\.end\b/g)).toHaveLength(1);
  });
  it('orders BJT nodes the way SPICE expects whatever the symbol pin order', () => {
    const q = P('PNP', 'Q1', 0, 0, 'PNP_GEN');
    const pins = Object.fromEntries(pinPositions(q).map((p) => [p.name, p]));
    const c = compile(sch([q, P('LABEL', '', pins.E.x, pins.E.y, 'e'), P('LABEL', '', pins.B.x, pins.B.y, 'b'), P('LABEL', '', pins.C.x, pins.C.y, 'c')], []));
    expect(c.netlist).toContain('Q1 c b e PNP_GEN');
  });
});

describe('vector labels', () => {
  it('reads like LTspice', () => {
    expect(vectorLabel('v(out)')).toBe('V(out)'); expect(vectorLabel('i(v1)')).toBe('I(V1)');
    expect(vectorLabel('i(@r1[i])')).toBe('I(R1)'); expect(vectorLabel('i(@d1[id])')).toBe('I(D1)'); expect(vectorLabel('i(@q1[ic])')).toBe('I(Q1:c)');
  });
});
