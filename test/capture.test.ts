// Grading capture against real ngspice: resampled traces must match the analytic answer.
import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from 'eecircuit-engine';
import { compile } from '../src/core/netlist';
import { EXAMPLES } from '../src/core/examples';
import type { Analysis, Schematic } from '../src/core/types';
import { normalise, type SimResult } from '../src/sim/result';
import { mergeSweep } from '../src/sim/analysis';
import { captureForGrading } from '../src/sim/capture';

const sim = new Simulation();
beforeAll(async () => { await sim.start(); });

async function run(sch: Schematic, sweepValue?: string): Promise<SimResult> {
  const c = compile(sch, sweepValue ? { sweepValue } : {});
  expect(c.ok, c.issues.map((i) => i.message).join('; ')).toBe(true);
  sim.setNetList(c.netlist);
  const raw = await sim.runSim();
  return normalise(raw, sch.analysis.kind, sim.getError(), sim.getInfo(), 0);
}

/** The RC low-pass example (R1 = 1k, C1 = 100n, so RC = 100 µs) driven by a 1 V step. */
function rcStep(analysis: Analysis = { kind: 'tran', step: '10u', stop: '1m' }): Schematic {
  const s = EXAMPLES.find((e) => /RC low-pass — transient/.test(e.name))!.build();
  return {
    ...s,
    analysis,
    parts: s.parts.map((p) => (p.ref === 'V1' ? { ...p, value: 'PULSE(0 1 0 1n 1n 1 2)' } : p)),
  };
}

describe('captureForGrading', () => {
  it('resamples a transient onto the uniform step grid: RC step is 1 - e^(-t/RC)', async () => {
    const sch = rcStep();
    const r = await run(sch);
    const c = captureForGrading(r, sch.analysis, { output: 'out', input: 'in' });
    expect(c.ok).toBe(true);
    if (!c.ok || c.capture.kind !== 'tran') return;
    const [one] = c.capture.runs;
    expect(one.sampleRate).toBeCloseTo(1e5, 6);
    expect(one.output).toHaveLength(101);
    expect(one.input).toHaveLength(101);
    let worst = 0;
    one.output.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - (1 - Math.exp(-(k * 10e-6) / 100e-6)))); });
    expect(worst).toBeLessThan(5e-3);
    expect(one.input[50]).toBeCloseTo(1, 6);
    expect(Array.isArray(one.output)).toBe(true);
  });

  it('gives one run per sweep value, tagged, for load-sweep problems', async () => {
    const base = rcStep();
    const sch: Schematic = { ...base, parts: base.parts.map((p) => (p.ref === 'R1' ? { ...p, value: '{RLOAD}' } : p)), sweep: { param: 'RLOAD', values: '1k 2k' } };
    const runs = [await run(sch, '1k'), await run(sch, '2k')];
    const c = captureForGrading(mergeSweep('RLOAD', ['1k', '2k'], runs), sch.analysis, { output: 'out' });
    expect(c.ok).toBe(true);
    if (!c.ok || c.capture.kind !== 'tran') return;
    expect(c.capture.runs.map((x) => x.tag)).toEqual(['1k', '2k']);
    // at t = RC(1k) = 100 µs: 1 - 1/e with 1k, 1 - e^(-1/2) with 2k
    expect(c.capture.runs[0].output[10]).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(c.capture.runs[1].output[10]).toBeCloseTo(1 - Math.exp(-0.5), 2);
    expect(c.capture.runs[0].input).toEqual([]);
  });

  it('AC: output / input is -3 dB and -45 degrees at the corner frequency', async () => {
    const sch = EXAMPLES.find((e) => /RC low-pass — AC/.test(e.name))!.build();
    const c = captureForGrading(await run(sch), sch.analysis, { output: 'out', input: 'in' });
    expect(c.ok).toBe(true);
    if (!c.ok || c.capture.kind !== 'ac') return;
    const { f, magDb, phaseDeg } = c.capture.runs[0];
    const fc = 1 / (2 * Math.PI * 1e3 * 100e-9);
    // interpolate on log f between the two points either side of fc
    const k = f.findIndex((x) => x >= fc);
    const w = (Math.log10(fc) - Math.log10(f[k - 1])) / (Math.log10(f[k]) - Math.log10(f[k - 1]));
    const at = (y: number[]) => y[k - 1] + w * (y[k] - y[k - 1]);
    expect(at(magDb)).toBeCloseTo(-3.01, 1);
    expect(at(phaseDeg)).toBeCloseTo(-45, 0);
    expect(magDb[0]).toBeCloseTo(0, 2);
  });

  it('explains a missing net label, and refuses operating points and too many samples', async () => {
    const sch = rcStep();
    const r = await run(sch);
    const miss = captureForGrading(r, sch.analysis, { output: 'vout' });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toMatch(/No net labelled "vout"/);
    expect(captureForGrading(r, { kind: 'op' }, { output: 'out' }).ok).toBe(false);
    const big = captureForGrading(r, { kind: 'tran', step: '1n', stop: '1m' }, { output: 'out' });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/at most 50,000/);
  });
});
