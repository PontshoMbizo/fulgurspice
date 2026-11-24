// Subcircuit parameters: "R=1k C=100n" on a definition (defaults) and on an
// instance (overrides). Leaf module: no imports, so symbols and netlist can both use it.
//
// Values are restricted to a number or a {expression} because anything else is a
// risk: ngspice silently ignores unknown parameter names, and a value such as 4k7
// (fine in LTspice) makes the engine spin forever. Numbers are rewritten into the
// form ngspice reads.

import { parseSI, toSpice } from './units';

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
