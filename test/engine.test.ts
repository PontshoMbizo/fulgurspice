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
  it('two RC stages from one subcircuit match the closed-form cascade 1/(s²τ²+3sτ+1)', async () => {
    const r = await runExample(/Two RC stages/);
    expect(r.ok).toBe(true);
    expect(r.messages).toEqual([]);
    const out = vec(r, 'v(out)');
    const tau = 1e3 * 100e-9;
    r.x!.re.forEach((f, i) => {
      const s = 2 * Math.PI * f * tau;
      const dr = 1 - s * s, di = 3 * s; // denominator = (1 - s²) + j3s
      const mag = 1 / Math.hypot(dr, di);
      expect(Math.hypot(out.re[i], out.im![i]), `|H| at ${f} Hz`).toBeCloseTo(mag, 3);
    });
    // The two stages load each other, so the middle node sits above out and below in.
    const mid = vec(r, 'v(mid)');
    const k = r.x!.re.findIndex((f) => f > 1500);
    expect(Math.hypot(mid.re[k], mid.im![k])).toBeGreaterThan(Math.hypot(out.re[k], out.im![k]));
    expect(Math.hypot(mid.re[k], mid.im![k])).toBeLessThan(1);
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

  // The rule checks in src/core/rules.ts call some topologies errors and one a warning.
  // Measured against the real solver, so the messages say what actually happens.
  it('voltage-source / inductor loops: ngspice cannot solve them', async () => {
    const bad: Record<string, string> = {
      'parallel voltage sources': 'V1 a 0 5\nV2 a 0 3\nR1 a 0 1k\n',
      'voltage source across an inductor': 'V1 a 0 5\nL1 a 0 1m\n',
    };
    for (const [name, body] of Object.entries(bad)) {
      const r = await runNetlist(`* ${name}\n${body}.op\n.end\n`, 'op');
      const broke = !r.ok || r.messages.length > 0 || r.vectors.some((v) => !Number.isFinite(v.re[0]));
      expect(broke, `${name}: ${r.ok ? 'solved cleanly' : r.messages.join(' ')}`).toBe(true);
    }
  });
  it('current-source cut-sets: ngspice either says nothing and returns nonsense, or warns and returns ~1e8 V', async () => {
    // I1 pushes 1 mA into n and I2 pulls 2 mA out: impossible, yet ngspice reports a calm -1 mV.
    const series = await runNetlist('* series\nI1 0 n 1m\nI2 n 0 2m\nR1 x 0 1k\nV1 x 0 1\n.op\n.end\n', 'op');
    expect(series.ok).toBe(true);
    expect(series.messages).toEqual([]);
    expect(Math.abs(vec(series, 'v(n)').re[0])).toBeLessThan(1);
    // A resistor island fed by a current source and tied to nothing else.
    const island = await runNetlist('* island\nI1 0 a 1m\nR1 a b 1k\nR2 b a 1k\n.op\n.end\n', 'op');
    expect(island.messages.join(' ')).toMatch(/singular matrix/i);
    expect(Math.abs(vec(island, 'v(a)').re[0])).toBeGreaterThan(1e6);
  });
  it('ngspice carries on, with a plausible answer, past a net with no DC path (so that is only a warning)', async () => {
    const r = await runNetlist('* floating via cap\nV1 in 0 5\nC1 in x 1u\nR1 x y 1k\nC2 y 0 1u\n.op\n.end\n', 'op');
    expect(r.ok).toBe(true);
    expect(Math.abs(vec(r, 'v(x)').re[0])).toBeLessThan(10);
  });
});
