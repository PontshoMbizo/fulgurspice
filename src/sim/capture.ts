// What a grader needs from a run, in plain arrays. Pure (no engine, no DOM), so the tests run it
// against real ngspice output in Node and a server can reuse it later.
//
// Transient: ngspice picks its own time steps (shorter around edges), so traces are resampled onto
// a uniform grid at the analysis step. Sample k is at k·step, from 0 to stop. That grid is what
// scope.io's waveform grader compares sample by sample, at sampleRate = 1/step.
// AC: magnitude (dB) and phase (degrees) of the output, or of output / input when an input net is
// given, at ngspice's own frequency points. Only spec checks (f-3dB, gain at f) use it.

import { netName } from '../core/netlist';
import { parseSI } from '../core/units';
import type { Analysis } from '../core/types';
import { interpAt } from './analysis';
import type { SimResult, Vector } from './result';

/** Net labels to grade: `output` is required, `input` is optional (a reference, or the AC denominator). */
export interface Probes { output: string; input?: string }

export interface TranRun {
  /** The sweep value for this run (a load-sweep problem), absent for a single run. */
  tag?: string;
  sampleRate: number;
  output: number[];
  /** Empty when no input net was given. */
  input: number[];
}

export interface AcRun {
  tag?: string;
  f: number[];
  magDb: number[];
  phaseDeg: number[];
}

export type GradingCapture = { kind: 'tran'; runs: TranRun[] } | { kind: 'ac'; runs: AcRun[] };

export const MAX_GRADING_POINTS = 50_000;

const runsOf = (r: SimResult): { tag?: string; run: SimResult }[] =>
  r.sweep ? r.sweep.runs.map((run, i) => ({ tag: r.sweep!.tags[i], run })) : [{ run: r }];

const voltage = (r: SimResult, net: string): Vector | undefined => r.vectors.find((v) => v.name === `v(${netName(net)})`);

/** A run's x values for vector v: its own when it has them (one run of a sweep), else the result's. */
const xOf = (r: SimResult, v: Vector) => v.x ?? r.x?.re;

export function captureForGrading(result: SimResult, analysis: Analysis, probes: Probes): { ok: true; capture: GradingCapture } | { ok: false; error: string } {
  if (!result.ok) return { ok: false, error: result.messages[0] ?? 'The simulation failed' };
  if (!probes.output.trim()) return { ok: false, error: 'The problem names no output net to grade' };
  const missing = (net: string, tag?: string) =>
    `No net labelled "${net}"${tag ? ` in the run with ${result.sweep?.param} = ${tag}` : ''}. Put a Net label called ${net} on the wire to grade.`;

  if (analysis.kind === 'tran') {
    const step = parseSI(analysis.step), stop = parseSI(analysis.stop);
    if (!step || !stop || step <= 0 || stop <= 0) return { ok: false, error: 'The transient analysis needs a positive step and stop time' };
    const n = Math.floor(stop / step + 1e-9) + 1;
    if (n > MAX_GRADING_POINTS) return { ok: false, error: `Stop / step gives ${n.toLocaleString()} samples; the grader takes at most ${MAX_GRADING_POINTS.toLocaleString()}` };
    const runs: TranRun[] = [];
    for (const { tag, run } of runsOf(result)) {
      const out = voltage(run, probes.output);
      if (!out) return { ok: false, error: missing(probes.output, tag) };
      const inp = probes.input ? voltage(run, probes.input) : undefined;
      if (probes.input && !inp) return { ok: false, error: missing(probes.input, tag) };
      const sample = (v: Vector) => {
        const x = xOf(run, v)!;
        return Array.from({ length: n }, (_, k) => interpAt(x, v.re, k * step));
      };
      runs.push({ ...(tag !== undefined ? { tag } : {}), sampleRate: 1 / step, output: sample(out), input: inp ? sample(inp) : [] });
    }
    return { ok: true, capture: { kind: 'tran', runs } };
  }

  if (analysis.kind === 'ac') {
    const runs: AcRun[] = [];
    for (const { tag, run } of runsOf(result)) {
      const out = voltage(run, probes.output);
      if (!out) return { ok: false, error: missing(probes.output, tag) };
      const inp = probes.input ? voltage(run, probes.input) : undefined;
      if (probes.input && !inp) return { ok: false, error: missing(probes.input, tag) };
      const f = Array.from(xOf(run, out)!);
      const magDb: number[] = [], phaseDeg: number[] = [];
      for (let k = 0; k < f.length; k++) {
        let re = out.re[k], im = out.im?.[k] ?? 0;
        if (inp) {
          // out / in, as complex numbers
          const a = inp.re[k], b = inp.im?.[k] ?? 0, d = a * a + b * b;
          [re, im] = d > 0 ? [(re * a + im * b) / d, (im * a - re * b) / d] : [NaN, NaN];
        }
        magDb.push(20 * Math.log10(Math.hypot(re, im)));
        phaseDeg.push((Math.atan2(im, re) * 180) / Math.PI);
      }
      runs.push({ ...(tag !== undefined ? { tag } : {}), f, magDb, phaseDeg });
    }
    return { ok: true, capture: { kind: 'ac', runs } };
  }

  return { ok: false, error: `${analysis.kind === 'op' ? 'An operating point' : 'A DC sweep'} cannot be graded: use a transient or AC analysis` };
}
