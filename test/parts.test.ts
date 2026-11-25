// Every Phase 4 part, drawn as a schematic, compiled, and run through real ngspice.
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { compile } from '../src/core/netlist';
import { pinPositions } from '../src/core/symbols';
import { emptySchematic, type Analysis, type Part, type PartKind, type Schematic } from '../src/core/types';
import { currentNames, normalise, type SimResult } from '../src/sim/result';

const sim = new Simulation();
beforeAll(async () => { await sim.start(); });

/** [kind, ref, value, nets in symbol pin order] */
type Spec = [PartKind, string, string, string[]];

/** Places each part far from the others and names every pin's net with a label (or ground). */
function circuit(specs: Spec[], analysis: Analysis, directives = ''): Schematic {
  const parts: Part[] = [];
  let id = 0;
  const add = (kind: PartKind, ref: string, value: string, x: number, y: number) => {
    const p: Part = { id: `p${id++}`, kind, ref, x, y, rot: 0, mirror: false, value };
    parts.push(p);
    return p;
  };
  specs.forEach(([kind, ref, value, nets], i) => {
    const part = add(kind, ref, value, i * 20, 0);
    pinPositions(part).forEach((pin, k) => add(nets[k] === '0' ? 'GND' : 'LABEL', '', nets[k] === '0' ? '' : nets[k], pin.x, pin.y));
  });
  return { ...emptySchematic(), parts, wires: [], analysis, directives };
}

async function run(specs: Spec[], analysis: Analysis, directives = ''): Promise<SimResult> {
  const c = compile(circuit(specs, analysis, directives));
  expect(c.ok, c.issues.map((i) => i.message).join(' | ')).toBe(true);
  sim.setNetList(c.netlist);
  const raw = await sim.runSim();
  return normalise(raw, analysis.kind, sim.getError(), sim.getInfo(), 0);
}
const vec = (r: SimResult, name: string) => {
  const v = r.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}: have ${r.vectors.map((x) => x.name)} / ${r.messages}`);
  return v.re;
};
const op: Analysis = { kind: 'op' };
const max = (a: Float64Array) => a.reduce((m, v) => Math.max(m, v), -Infinity);
const min = (a: Float64Array) => a.reduce((m, v) => Math.min(m, v), Infinity);

describe('parts in ngspice', () => {
  it('zener holds about 5.1 V from a 12 V supply', async () => {
    const r = await run([['V', 'V1', '12', ['in', '0']], ['R', 'R1', '470', ['in', 'z']], ['ZENER', 'D1', 'ZENER_5V1', ['0', 'z']]], op);
    expect(vec(r, 'v(z)')[0]).toBeGreaterThan(5.0); expect(vec(r, 'v(z)')[0]).toBeLessThan(5.3);
    expect(vec(r, 'i(@d1[id])')[0]).toBeLessThan(0);
  });
  it('red LED drops about 1.8 V near 10 mA', async () => {
    const r = await run([['V', 'V1', '5', ['in', '0']], ['R', 'R1', '330', ['in', 'a']], ['LED', 'D1', 'LED_RED', ['a', '0']]], op);
    expect(vec(r, 'v(a)')[0]).toBeGreaterThan(1.6); expect(vec(r, 'v(a)')[0]).toBeLessThan(2.1);
  });
  it('potentiometer: position is measured from pin 1', async () => {
    const r = await run([['V', 'V1', '10', ['in', '0']], ['POT', 'RV1', '10k 0.3', ['in', '0', 'w']], ['R', 'R1', '1000meg', ['w', '0']]], op);
    expect(vec(r, 'v(w)')[0]).toBeCloseTo(7, 4);
    expect(r.vectors.map((v) => v.name)).toContain('i(@r_rv1_1[i])');
  });
  it('potentiometer takes {parameters}', async () => {
    const r = await run([['V', 'V1', '10', ['in', '0']], ['POT', 'RV1', '{R} {x}', ['in', '0', 'w']], ['R', 'R1', '1000meg', ['w', '0']]], op, '.param R=10k x=0.8');
    expect(vec(r, 'v(w)')[0]).toBeCloseTo(2, 4);
  });
  it('switch open and closed', async () => {
    const r = await run([['V', 'V1', '10', ['in', '0']], ['SW', 'SW1', 'closed', ['in', 'a']], ['R', 'R1', '1k', ['a', '0']], ['SW', 'SW2', 'open', ['in', 'b']], ['R', 'R2', '1k', ['b', '0']]], op);
    expect(vec(r, 'v(a)')[0]).toBeCloseTo(10, 3); expect(vec(r, 'v(b)')[0]).toBeLessThan(1e-4);
    expect(vec(r, 'i(@r_sw1[i])')[0]).toBeCloseTo(0.01, 6);
  });
  it('voltage-controlled switch closes above 2.5 V', async () => {
    const r = await run([['V', 'V1', '10', ['in', '0']], ['V', 'V2', '5', ['hi', '0']], ['V', 'V3', '0', ['lo', '0']],
      ['VSW', 'S1', 'SW_GEN', ['in', 'a', 'hi', '0']], ['R', 'R1', '1k', ['a', '0']], ['VSW', 'S2', 'SW_GEN', ['in', 'b', 'lo', '0']], ['R', 'R2', '1k', ['b', '0']]], op);
    expect(vec(r, 'v(a)')[0]).toBeCloseTo(10, 3); expect(vec(r, 'v(b)')[0]).toBeLessThan(1e-4);
    expect(vec(r, 'i(v_s1)')[0]).toBeCloseTo(0.01, 6);
    expect(r.vectors.map((v) => v.label)).toContain('I(S1)');
    expect(r.vectors.map((v) => v.name).filter((n) => /sense_|@s1/.test(n))).toEqual([]);
  });
  it('transformer 1:2 doubles a 50 Hz sine (times the coupling)', async () => {
    const r = await run([['V', 'V1', 'SIN(0 10 50)', ['in', '0']], ['XFMR', 'T1', '10 2', ['in', '0', 'sec', '0']], ['R', 'R1', '100k', ['sec', '0']]], { kind: 'tran', step: '100u', stop: '60m' });
    expect(max(vec(r, 'v(sec)'))).toBeGreaterThan(19.6); expect(max(vec(r, 'v(sec)'))).toBeLessThan(20.05);
    expect(r.vectors.map((v) => v.label)).toEqual(expect.arrayContaining(['I(T1:p)', 'I(T1:s)']));
  });
  it('E, G, F, H gains', async () => {
    const r = await run([['V', 'V1', '1', ['c', '0']], ['R', 'R1', '1k', ['c', '0']],
      ['VCVS', 'E1', '10', ['e', '0', 'c', '0']], ['R', 'R2', '1k', ['e', '0']],
      ['VCCS', 'G1', '2m', ['0', 'g', 'c', '0']], ['R', 'R3', '1k', ['g', '0']],
      ['CCCS', 'F1', 'V1 3', ['0', 'f']], ['R', 'R4', '1k', ['f', '0']],
      ['CCVS', 'H1', 'v1 2k', ['h', '0']], ['R', 'R5', '1k', ['h', '0']]], op);
    expect(vec(r, 'v(e)')[0]).toBeCloseTo(10, 6);
    expect(vec(r, 'v(g)')[0]).toBeCloseTo(2, 6);
    // i(V1) is -1 mA (current into the + pin), so the controlled outputs are negative.
    expect(vec(r, 'v(f)')[0]).toBeCloseTo(-3, 6);
    expect(vec(r, 'v(h)')[0]).toBeCloseTo(-2, 6);
  });
  it('behavioural source, V= and I=, with a parameter', async () => {
    const r = await run([['V', 'V1', '1.5', ['in', '0']], ['BSRC', 'B1', 'V=v(in)*{k}+1', ['x', '0']], ['R', 'R1', '1k', ['x', '0']],
      ['BSRC', 'B2', 'I=v(in)/1k', ['0', 'y']], ['R', 'R2', '2k', ['y', '0']]], op, '.param k=4');
    expect(vec(r, 'v(x)')[0]).toBeCloseTo(7, 6); expect(vec(r, 'v(y)')[0]).toBeCloseTo(3, 6);
  });
  it('every part with a current can be probed, in operating point and transient', async () => {
    const specs: Spec[] = [['V', 'V1', '5', ['in', '0']],
      ['ZENER', 'D1', 'ZENER_5V1', ['in', 'a']], ['LED', 'D2', 'LED_RED', ['a', '0']],
      ['POT', 'RV1', '10k', ['in', '0', 'w']], ['R', 'R1', '1k', ['w', '0']],
      ['SW', 'SW1', 'closed', ['in', 'b']], ['R', 'R2', '1k', ['b', '0']],
      ['VSW', 'S1', 'SW_GEN', ['in', 'c', 'in', '0']], ['R', 'R3', '1k', ['c', '0']],
      ['XFMR', 'T1', '1 1', ['p', '0', 'q', '0']], ['R', 'R4', '100', ['in', 'p']], ['R', 'R5', '1k', ['q', '0']],
      ['VCVS', 'E1', '2', ['e', '0', 'in', '0']], ['R', 'R6', '1k', ['e', '0']],
      ['VCCS', 'G1', '1m', ['0', 'g', 'in', '0']], ['R', 'R7', '1k', ['g', '0']],
      ['CCCS', 'F1', 'V1 1', ['0', 'f']], ['R', 'R8', '1k', ['f', '0']],
      ['CCVS', 'H1', 'V1 1k', ['h', '0']], ['R', 'R9', '1k', ['h', '0']],
      ['BSRC', 'B1', 'V=v(in)', ['x', '0']], ['R', 'R10', '1k', ['x', '0']],
      ['BSRC', 'B2', 'I=1m', ['0', 'y']], ['R', 'R11', '1k', ['y', '0']],
      ['OPAMPS', 'U1', 'OPAMP_RAIL', ['b', 'o', 'o', 'in', '0']], ['R', 'R12', '1k', ['o', '0']]];
    for (const a of [op, { kind: 'tran', step: '10u', stop: '100u' } as Analysis]) {
      const r = await run(specs, a);
      for (const [kind, ref] of specs) expect(r.vectors.some((v) => currentNames({ kind, ref }).includes(v.name)), `${a.kind} ${ref}`).toBe(true);
    }
  });
  const amp = (model: string, input: string): Spec[] => [['V', 'V1', input, ['in', '0']], ['V', 'V2', '5', ['vcc', '0']], ['V', 'V3', '-5', ['vee', '0']],
    ['R', 'R1', '1k', ['in', 'n']], ['R', 'R2', '10k', ['n', 'out']], ['OPAMPS', 'U1', model, ['0', 'n', 'out', 'vcc', 'vee']]];
  const tran: Analysis = { kind: 'tran', step: '5u', stop: '3m' };
  it('op-amp with supplies: gain of -10 inside the rails', async () => {
    const r = await run(amp('OPAMP_RAIL', 'SIN(0 0.1 1k)'), tran);
    expect(max(vec(r, 'v(out)'))).toBeCloseTo(1, 1); expect(min(vec(r, 'v(out)'))).toBeCloseTo(-1, 1);
  });
  it('op-amp clips 1.5 V inside the rails; the rail-to-rail model reaches them', async () => {
    const a = await run(amp('OPAMP_RAIL', 'SIN(0 1 1k)'), tran);
    expect(max(vec(a, 'v(out)'))).toBeGreaterThan(3.3); expect(max(vec(a, 'v(out)'))).toBeLessThan(3.5);
    const b = await run(amp('OPAMP_RR', 'SIN(0 1 1k)'), tran);
    expect(max(vec(b, 'v(out)'))).toBeGreaterThan(4.8); expect(max(vec(b, 'v(out)'))).toBeLessThanOrEqual(5);
  });
  it('op-amp leaves the rail as soon as the input allows (no wind-up while clipped)', async () => {
    for (const [model, limit] of [['OPAMP_RAIL', 3.5], ['OPAMP_RR', 5]] as const) {
      for (const f of [100, 1000, 10000]) {
        const r = await run(amp(model, `SIN(0 1 ${f})`), { kind: 'tran', step: `${0.002 / f}`, stop: `${3 / f}` });
        const vin = vec(r, 'v(in)'), out = vec(r, 'v(out)');
        // Ideal: a clipped, inverted sine. The margin is the output resistance and, at 10 kHz, the
        // 91 kHz closed-loop corner. With a wound-up pole node the error was 7 V.
        const worst = r.x!.re.reduce((w, t, i) => (t < 0.25 / f ? w : Math.max(w, Math.abs(out[i] - Math.max(-limit, Math.min(limit, -10 * vin[i]))))), 0);
        expect(worst, `${model} at ${f} Hz`).toBeLessThan(f < 5000 ? 0.15 : 1.5);
      }
    }
  });
  it('op-amp AC: the closed-loop corner is near GBW / noise gain = 91 kHz', async () => {
    const r = await run(amp('OPAMP_RAIL', 'AC 1'), { kind: 'ac', points: '20', fstart: '100', fstop: '1meg' });
    const out = r.vectors.find((v) => v.name === 'v(out)')!;
    const mag = r.x!.re.map((_, i) => Math.hypot(out.re[i], out.im![i]));
    expect(mag[0]).toBeCloseTo(10, 1);
    const f = r.x!.re[mag.findIndex((m) => m < mag[0] * Math.SQRT1_2)];
    expect(f).toBeGreaterThan(70e3); expect(f).toBeLessThan(120e3);
  });
});
