// Subcircuit parameters: "R=1k C=100n" on a definition (defaults) and on an
// instance (overrides). Leaf module: no imports, so symbols and netlist can both use it.
//
// Values are restricted to a number or a {expression} because anything else is a
// risk: ngspice silently ignores unknown parameter names, and a value such as 4k7
// (fine in LTspice) makes the engine spin forever. Numbers are rewritten into the
// form ngspice reads.

import type { SweepSpec } from './types';
import { formatSI, parseSI, toSpice } from './units';

export interface Param { name: string; value: string }

export interface ParamList { items: Param[]; error: string | null }

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse "R=1k  C = 100n" into name/value pairs, or say what is wrong with it. */
export function parseParams(text: string | undefined): ParamList {
  const items: Param[] = [];
  const t = (text ?? '').trim().replace(/\s*=\s*/g, '=');
  if (!t) return { items, error: null };
  for (const token of t.split(/\s+/)) {
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : '';
    const raw = eq > 0 ? token.slice(eq + 1) : '';
    if (!NAME.test(name) || !raw) return { items, error: `"${token}" is not written NAME=value` };
    if (items.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { items, error: `Parameter ${name} is given twice` };
    let value: string;
    if (/^\{[^{}\s]+\}$/.test(raw)) value = raw;
    else {
      const n = parseSI(raw);
      if (n === null) return { items, error: `${name}: "${raw}" is not a number (or a {expression} with no spaces)` };
      value = toSpice(n);
    }
    items.push({ name, value });
  }
  return { items, error: null };
}

export const formatParams = (items: Param[]) => items.map((p) => `${p.name}=${p.value}`).join(' ');

/** Names a {expression} refers to: identifiers that are not function calls or constants. */
export function exprNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const id of m[1].matchAll(/(?<![\w.])[A-Za-z_]\w*(?!\w*\s*\()/g)) if (id[0].toLowerCase() !== 'pi') out.add(id[0].toLowerCase());
  }
  return [...out];
}

/** Parameters defined with .param lines in a block of directives (names, lower case). */
export function dotParamNames(directives: string): string[] {
  const out: string[] = [];
  for (const line of directives.split(/\r?\n/)) {
    const m = /^\s*\.param\b(.*)$/i.exec(line);
    if (m) for (const n of m[1].matchAll(/([A-Za-z_]\w*)\s*=/g)) out.push(n[1].toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------- sweeps

export const MAX_SWEEP = 12;

export interface Sweep {
  param: string;
  /** `tag` is for people ("2k"), `value` is what goes after `.param NAME=`. */
  values: { tag: string; value: string }[];
}

/** Read a sweep setting. `sweep` is null when none is set (not an error). */
export function parseSweep(spec: SweepSpec | undefined): { sweep: Sweep | null; error: string | null } {
  const param = (spec?.param ?? '').trim();
  const text = (spec?.values ?? '').trim();
  if (!param && !text) return { sweep: null, error: null };
  const fail = (error: string) => ({ sweep: null, error });
  if (!NAME.test(param)) return fail(param ? `"${param}" is not a valid parameter name` : 'Name the parameter to sweep');
  if (!text) return fail('List the values to sweep, e.g. 1k 2k 5k, or lin 1k 10k 4');
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const nums: number[] = [];
  const kind = tokens[0].toLowerCase();
  if (kind === 'lin' || kind === 'dec') {
    const [a, b, n] = tokens.slice(1).map((t) => parseSI(t));
    if (tokens.length !== 4 || a === null || b === null || n === null || n === undefined) return fail(`Write ${kind} start stop ${kind === 'lin' ? 'count' : 'pointsPerDecade'}, e.g. ${kind === 'lin' ? 'lin 1k 10k 4' : 'dec 100 10k 3'}`);
    if (!Number.isInteger(n) || n < 1) return fail('The count must be a whole number of at least 1');
    if (kind === 'lin') {
      if (n < 2) return fail('lin needs at least 2 points');
      for (let i = 0; i < n; i++) nums.push(a + ((b - a) * i) / (n - 1));
    } else {
      if (!(a > 0) || !(b > a)) return fail('dec needs 0 < start < stop');
      for (let k = 0; a * 10 ** (k / n) <= b * (1 + 1e-9); k++) nums.push(a * 10 ** (k / n));
    }
  } else {
    for (const t of tokens) {
      const v = parseSI(t);
      if (v === null) return fail(`"${t}" is not a number`);
      nums.push(v);
    }
  }
  if (nums.length > MAX_SWEEP) return fail(`That is ${nums.length} runs; the limit is ${MAX_SWEEP}`);
  return { sweep: { param, values: nums.map((v) => ({ tag: formatSI(v, '', 4), value: toSpice(v) })) }, error: null };
}
