// Engine output, normalised: typed arrays, display labels, units. Pure, so the
// tests exercise it against the real engine without a browser.

import type { ResultType } from 'eecircuit-engine';
import type { Analysis } from '../core/types';

export interface Vector {
  /** ngspice's own name: v(out), i(v1), i(@r1[i]) */
  name: string;
  /** LTspice-style label: V(out), I(V1), I(R1) */
  label: string;
  unit: 'V' | 'A' | 's' | 'Hz' | '';
  re: Float64Array;
  /** Present for AC analysis only. */
  im?: Float64Array;
}

export interface SimResult {
  kind: Analysis['kind'];
  ok: boolean;
  /** Sweep variable (time, frequency, swept source). Null for an operating point. */
  x: Vector | null;
  vectors: Vector[];
  points: number;
  /** ngspice warnings and errors, cleaned up. */
  messages: string[];
  log: string;
  ms: number;
}

export function vectorLabel(name: string): string {
  const v = /^v\((.+)\)$/.exec(name);
  if (v) return `V(${v[1]})`;
  const dev = /^i\(@([^[]+)\[i([a-z]*)\]\)$/.exec(name);
  if (dev) {
    const ref = dev[1].toUpperCase();
    const terminal = dev[2] && !(dev[2] === 'd' && ref.startsWith('D')) ? `:${dev[2]}` : '';
    return `I(${ref}${terminal})`;
  }
  const i = /^i\((.+)\)$/.exec(name);
  if (i) return `I(${i[1].toUpperCase()})`;
  return name;
}

const UNIT = { voltage: 'V', current: 'A', time: 's', frequency: 'Hz', notype: '' } as const;

export function normalise(raw: ResultType | null, kind: Analysis['kind'], errors: string[], log: string, ms: number): SimResult {
  // Notes ("DC 0 assumed", "Starting source stepping") stay in the log; warnings and errors are surfaced.
  const messages = [...new Set(errors.map((e) => e.trim()).filter((e) => e && !/^note:/i.test(e)))];
  const failed = !raw || raw.numPoints === 0 || raw.data.length === 0 || messages.some((m) => /^error\b|circuit not parsed|simulation interrupted/i.test(m));
  if (failed || !raw) return { kind, ok: false, x: null, vectors: [], points: 0, messages: messages.length ? messages : ['ngspice produced no data'], log, ms };

  const all: Vector[] = raw.dataType === 'complex'
    ? raw.data.map((d) => ({
        name: d.name, label: vectorLabel(d.name), unit: UNIT[d.type],
        re: Float64Array.from(d.values, (c) => c.real), im: Float64Array.from(d.values, (c) => c.img),
      }))
    : raw.data.map((d) => ({ name: d.name, label: vectorLabel(d.name), unit: UNIT[d.type], re: Float64Array.from(d.values) }));

  if (kind === 'op') return { kind, ok: true, x: null, vectors: all, points: 1, messages, log, ms };
  const [x, ...vectors] = all;
  if (kind === 'dc') x.label = 'sweep';
  if (kind === 'ac') { x.im = undefined; x.unit = 'Hz'; }
  return { kind, ok: true, x, vectors, points: raw.numPoints, messages, log, ms };
}

/** Explain ngspice's terser messages in terms of the schematic. */
export function explain(message: string): string | null {
  const node = /singular matrix:\s+check node (\S+)/i.exec(message);
  if (node) return `Node "${node[1]}" has no DC path to ground (floating). Connect it, or add a large resistor to ground.`;
  if (/timestep too small/i.test(message)) return 'The solver could not converge. Try a smaller time step, add a little series resistance, or check for ideal loops of sources and capacitors.';
  if (/could not find a valid modelname|unknown model|unable to find definition of model/i.test(message)) return 'A part names a model that is not defined. Use a built-in model or add a .model line under SPICE directives.';
  if (/no dc path to ground/i.test(message)) return 'Part of the circuit is isolated from ground.';
  return null;
}
