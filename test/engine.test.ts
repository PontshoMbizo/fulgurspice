// Runs the real ngspice (WebAssembly) in Node: schematic -> netlist -> engine -> numbers.
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { compile } from '../src/core/netlist';
import { EXAMPLES } from '../src/core/examples';
import { MODELS } from '../src/core/symbols';
import type { Analysis } from '../src/core/types';
import { normalise, type SimResult } from '../src/sim/result';

const sim = new Simulation();
beforeAll(async () => { await sim.start(); });

async function runNetlist(netlist: string, kind: Analysis['kind']): Promise<SimResult> {
  sim.setNetList(netlist);
  const raw = await sim.runSim();
  return normalise(raw, kind, sim.getError(), sim.getInfo(), 0);
}
async function runExample(name: RegExp) {
  const s = EXAMPLES.find((e) => name.test(e.name))!.build();
  const c = compile(s);
  expect(c.ok).toBe(true);
  return runNetlist(c.netlist, s.analysis.kind);
}
const vec = (r: SimResult, name: string) => {
  const v = r.vectors.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}: have ${r.vectors.map((x) => x.name)} / ${r.messages}`);
  return v;
};
const peak = (a: Float64Array, from = 0) => a.slice(from).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('ngspice end to end', () => {
  it('RC low-pass transient: 1 kHz through fc = 1.59 kHz comes out at 0.847', async () => {
    const r = await runExample(/transient/);
    expect(r.ok).toBe(true);
    expect(r.x!.unit).toBe('s');
    expect(r.x!.re[r.points - 1]).toBeCloseTo(5e-3, 6);
    const settled = Math.floor(r.points * 0.6);
    expect(peak(vec(r, 'v(out)').re, settled)).toBeCloseTo(1 / Math.hypot(1, 2 * Math.PI * 1e3 * 1e3 * 100e-9), 2);
    expect(vec(r, 'i(@r1[i])').unit).toBe('A');
  });
  it('RC low-pass AC: -3 dB at 1.59 kHz, -45 degrees', async () => {
    const r = await runExample(/AC sweep/);
    expect(r.ok).toBe(true);
    const out = vec(r, 'v(out)');
    const f = r.x!.re;
    let k = 0;
    while (Math.hypot(out.re[k], out.im![k]) > Math.SQRT1_2) k++;
    expect(f[k]).toBeGreaterThan(1400); expect(f[k - 1]).toBeLessThan(1700);
    const phase = (Math.atan2(out.im![k], out.re[k]) * 180) / Math.PI;
    expect(phase).toBeGreaterThan(-52); expect(phase).toBeLessThan(-40);
  });
  it('half-wave rectifier: output peaks one diode drop below 5 V and never goes negative', async () => {
    const r = await runExample(/rectifier/);
    const out = vec(r, 'v(out)').re;
    const max = out.reduce((m, v) => Math.max(m, v), -Infinity);
    expect(max).toBeGreaterThan(4.0); expect(max).toBeLessThan(4.6);
    expect(out.reduce((m, v) => Math.min(m, v), Infinity)).toBeGreaterThan(-0.01);
  });
  it('inverting amplifier: gain is -10', async () => {
    const r = await runExample(/Inverting/);
    const out = vec(r, 'v(out)').re, inp = vec(r, 'v(in)').re;
    expect(peak(out)).toBeCloseTo(1.0, 2);
    const k = inp.indexOf(inp.reduce((m, v) => Math.max(m, v), -Infinity));
    expect(out[k]).toBeLessThan(-0.95);
  });
  it('voltage divider operating point: 9 V * 4.7k / 14.7k', async () => {
    const r = await runExample(/divider/);
    expect(r.x).toBeNull();
    expect(vec(r, 'v(mid)').re[0]).toBeCloseTo((9 * 4.7) / 14.7, 6);
  });
  it('every built-in model parses and biases', async () => {
    const r = await runNetlist(`* models
V1 vcc 0 5
R1 vcc a 1k
D1 a 0 DGEN
R2 vcc b 1k
D2 b 0 LED_RED
R3 vcc z 1k
D3 0 z ZENER_5V1
R4 vcc c 1k
R5 vcc bb 100k
Q1 c bb 0 NPN_GEN
R7 vcc b2 100k
R8 b2 0 100k
Q2 0 b2 e2 PNP_GEN
R9 vcc e2 1k
R10 vcc d 1k
M1 d vcc 0 0 NMOS_GEN
R11 d2 0 1k
M2 d2 0 vcc vcc PMOS_GEN
${Object.values(MODELS).join('\n')}
.op
.end
`, 'op');
    expect(r.messages).toEqual([]);
    expect(r.ok).toBe(true);
    const v = (name: string) => vec(r, `v(${name})`).re[0];
    expect(v('a')).toBeGreaterThan(0.55); expect(v('a')).toBeLessThan(0.8);
    expect(v('b')).toBeGreaterThan(1.6); expect(v('b')).toBeLessThan(2.2);
    expect(v('c')).toBeLessThan(0.3);
    expect(v('e2') - v('b2')).toBeGreaterThan(0.5);
    expect(v('d')).toBeLessThan(0.5);
    expect(v('d2')).toBeGreaterThan(4);
  });
  it('a parse error comes back as a failed result, and the next run is clean', async () => {
    const bad = await runNetlist('* bad\nV1 a 0 5\nQ1 a\n.op\n.end\n', 'op');
    expect(bad.ok).toBe(false);
    expect(bad.messages.join(' ')).toMatch(/model/i);
    const good = await runNetlist('* good\nV1 a 0 5\nR1 a 0 1k\n.op\n.end\n', 'op');
    expect(good.ok).toBe(true);
    expect(good.messages).toEqual([]);
  });
});
