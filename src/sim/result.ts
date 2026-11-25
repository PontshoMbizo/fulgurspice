// Engine output, normalised: typed arrays, display labels, units. Pure, so the
// tests exercise it against the real engine without a browser.

import type { ResultType } from 'eecircuit-engine';
import type { Analysis, Part } from '../core/types';

export interface Vector {
  /** ngspice's own name: v(out), i(v1), i(@r1[i]) */
  name: string;
  /** LTspice-style label: V(out), I(V1), I(R1) */
  label: string;
  unit: 'V' | 'A' | 's' | 'Hz' | 'W' | 'Ω' | 'dB' | '°' | '';
  re: Float64Array;
  /** Present for AC analysis only. */
  im?: Float64Array;
  /** Its own sweep values, when they differ from the result's (one run of a parameter sweep). */
  x?: Float64Array;
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
  /** A parameter sweep: one full result per value. The fields above are those of the first run. */
  sweep?: { param: string; tags: string[]; runs: SimResult[] };
}

/** Names ngspice may have saved a part's current under, most specific first. */
export function currentNames(part: Pick<Part, 'kind' | 'ref'>): string[] {
  const ref = part.ref.toLowerCase();
  switch (part.kind) {
    case 'V': return [`i(${ref})`];
    case 'OPAMP': return [`i(e_${ref})`];
    case 'OPAMPS': return [`i(@r.x_${ref}.rout[i])`];
    case 'D': case 'ZENER': case 'LED': return [`i(@${ref}[id])`];
    case 'SW': return [`i(@r_${ref}[i])`];
    case 'VSW': return [`i(v_${ref})`];
    case 'POT': return [`i(@r_${ref}_1[i])`];
    case 'XFMR': return [`i(l_${ref}_p)`];
    case 'VCVS': case 'CCVS': return [`i(${ref})`];
    case 'BSRC': return [`i(@${ref}[i])`, `i(${ref})`];
    case 'NPN': case 'PNP': return [`i(@${ref}[ic])`];
    case 'NMOS': case 'PMOS': return [`i(@${ref}[id])`];
    default: return [`i(@${ref}[i])`, `i(@${ref}[c])`];
  }
}

/** Vectors that exist only because of how a part is built, or that ngspice gets wrong: the
 * node inside a voltage-controlled switch, and the switch's own saved current. */
const HIDDEN = /^v\((?:.*\.)?sense_[^.)]*_\)$|^i\(@(?:s\.[^[]*\.)?s[^.[]*\[i\]\)$/;

/** Parts built from several SPICE elements, shown under the part's own reference. */
const BUILT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^i\(@r_(rv\w*)_([12])\[i\]\)$/, (m) => `I(${m[1].toUpperCase()}:${m[2]})`],
  [/^i\(@r_(sw\w*)\[i\]\)$/, (m) => `I(${m[1].toUpperCase()})`],
  [/^i\(v_(s\w*)\)$/, (m) => `I(${m[1].toUpperCase()})`],
  [/^i\(@?l_(t\w*)_([ps])(?:\[i\])?\)$/, (m) => `I(${m[1].toUpperCase()}:${m[2]})`],
  [/^i\(@r\.x_(u\w*)\.rout\[i\]\)$/, (m) => `I(${m[1].toUpperCase()}:out)`],
];

export function vectorLabel(name: string): string {
  for (const [re, label] of BUILT) { const m = re.exec(name); if (m) return label(m); }
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
  // A .meas that cannot be evaluated is reported as an error line but the run itself is fine: keep the data.
  const failed = !raw || raw.numPoints === 0 || raw.data.length === 0 || messages.some((m) => /circuit not parsed|simulation interrupted/i.test(m) || (/^error\b/i.test(m) && !/^error:\s*measure\b/i.test(m)));
  if (failed || !raw) return { kind, ok: false, x: null, vectors: [], points: 0, messages: messages.length ? messages : ['ngspice produced no data'], log, ms };

  const all: Vector[] = (raw.dataType === 'complex'
    ? raw.data.map((d) => ({
        name: d.name, label: vectorLabel(d.name), unit: UNIT[d.type],
        re: Float64Array.from(d.values, (c) => c.real), im: Float64Array.from(d.values, (c) => c.img),
      }))
    : raw.data.map((d) => ({ name: d.name, label: vectorLabel(d.name), unit: UNIT[d.type], re: Float64Array.from(d.values) }))
  ).filter((v) => !HIDDEN.test(v.name));

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
  if (/could not find a valid modelname|unknown model|unknown subckt|can't find model|unable to find definition of model/i.test(message)) return 'A part names a model that is not defined. Use a built-in model or add a .model line under SPICE directives.';
  const meas = /^error:\s*measure\s+(\S+)/i.exec(message);
  if (meas) return `Measurement "${meas[1]}" could not be evaluated: the event it looks for never happens in this run, or its syntax is wrong. The waveforms are fine.`;
  if (/unimplemented dot command '\.step'/i.test(message)) return 'ngspice has no .step. Use the Sweep setting under Analysis to repeat the run for several values.';
  if (/^Simulation stopped after/i.test(message)) return 'ngspice stopped answering. This usually means a value or expression it cannot read, or a net name that does not exist: check the values and any behavioural sources. In a behavioural source, sqrt() of a signal that goes negative also does this.';
  if (/no dc path to ground/i.test(message)) return 'Part of the circuit is isolated from ground.';
  return null;
}
