// The value of an independent source as fields: a DC level, an AC stimulus and at most one
// waveform. `parseSource` and `formatSource` back the source editor. Anything they do not
// model (EXP, SFFM, …) parses to null and stays free text. Pure: imports only units.

import { parseSI } from './units';

export type Wave = 'SIN' | 'PULSE' | 'PWL';
export interface SourceSpec {
  /** Empty string: not given. */
  dc: string;
  ac: { mag: string; phase: string } | null;
  wave: { type: Wave; args: string[] } | null;
}

export const WAVE_FIELDS: Record<'SIN' | 'PULSE', string[]> = {
  SIN: ['Offset', 'Amplitude', 'Frequency (Hz)', 'Delay (s)', 'Damping (1/s)', 'Phase (deg)'],
  PULSE: ['Low level', 'High level', 'Delay (s)', 'Rise time (s)', 'Fall time (s)', 'On time (s)', 'Period (s)'],
};
export const WAVE_DEFAULTS: Record<Wave, string[]> = {
  SIN: ['0', '1', '1k'], PULSE: ['0', '5', '0', '1u', '1u', '0.5m', '1m'], PWL: ['0', '0', '1m', '5'],
};

const isTerm = (t: string) => parseSI(t) !== null || /^\{[^{}\s]+\}$/.test(t);
const TOKENS = /\{[^{}]*\}|[()]|[^\s,(){}]+/g;

export function parseSource(value: string): SourceSpec | null {
  const t: string[] = value.match(TOKENS) ?? [];
  const spec: SourceSpec = { dc: '', ac: null, wave: null };
  let i = 0;
  const term = () => (i < t.length && isTerm(t[i]) ? t[i++] : null);
  while (i < t.length) {
    const word = t[i].toUpperCase();
    if (word === 'DC' && !spec.dc) { i++; const v = term(); if (v === null) return null; spec.dc = v; }
    else if (word === 'AC' && !spec.ac) { i++; const mag = term() ?? ''; spec.ac = { mag, phase: mag ? term() ?? '' : '' }; }
    else if (['SIN', 'SINE', 'PULSE', 'PWL'].includes(word) && !spec.wave) {
      i++;
      const open = t[i] === '(';
      if (open) i++;
      const args: string[] = [];
      for (let v = term(); v !== null; v = term()) args.push(v);
      if (open) { if (t[i] !== ')') return null; i++; }
      spec.wave = { type: word === 'SINE' ? 'SIN' : (word as Wave), args };
    } else if (i === 0 && isTerm(t[i])) spec.dc = t[i++];
    else return null;
  }
  return spec;
}

export function formatSource({ dc, ac, wave }: SourceSpec): string {
  const out: string[] = [];
  if (dc) out.push(ac || wave ? `DC ${dc}` : dc);
  if (ac) out.push(['AC', ac.mag || (ac.phase ? '1' : ''), ac.phase].filter(Boolean).join(' '));
  if (wave) {
    const args = [...wave.args];
    while (args.length && !args[args.length - 1]) args.pop();
    // Position matters, so a field left empty before a filled one is a zero.
    out.push(`${wave.type}(${args.map((a) => a || '0').join(' ')})`);
  }
  return out.join(' ') || '0';
}

/** Waveform mistakes ngspice reports tersely, or accepts without a word. */
export function waveProblem(value: string): string | null {
  const wave = parseSource(value)?.wave;
  if (!wave) return null;
  const n = wave.args.length;
  if (wave.type === 'SIN' && n < 2) return 'SIN needs at least an offset and an amplitude: SIN(0 1 1k)';
  if (wave.type === 'PULSE' && n < 2) return 'PULSE needs at least a low and a high level: PULSE(0 5 0 1u 1u 0.5m 1m)';
  if (wave.type !== 'PWL') return null;
  if (n < 2 || n % 2) return 'PWL needs pairs of time and value: PWL(0 0 1m 5)';
  const times = wave.args.filter((_, i) => i % 2 === 0).map((a) => parseSI(a));
  return times.some((x, i) => i > 0 && x !== null && times[i - 1] !== null && x <= times[i - 1]!) ? 'PWL times must increase from one pair to the next' : null;
}
