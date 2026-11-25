// Parsing and checking the value field of the parts whose value is more than one number:
// potentiometer ("10k 0.3"), transformer ("1 2 0.99"), switch ("closed"), current-controlled
// sources ("V1 10") and behavioural sources ("V=v(in)*2").
//
// Leaf module (imports only units), so symbols and netlist can both use it. The checks exist
// because ngspice fails badly on some bad input: an unknown net in a behavioural source makes
// the engine's promise never resolve, and 4k7 is silently read as 4k.

import { parseSI, toSpice } from './units';

/** A number, or a {expression} that ngspice evaluates. */
export type Term = { lit: number } | { expr: string };

const BRACES = /^\{([^{}\s]+)\}$/;

function term(text: string): Term | null {
  const b = BRACES.exec(text);
  if (b) return { expr: b[1] };
  const n = parseSI(text);
  return n === null ? null : { lit: n };
}

/** The term as it appears inside an expression. */
const inner = (t: Term) => ('lit' in t ? toSpice(t.lit) : `(${t.expr})`);

const words = (value: string) => value.trim().split(/[\s,]+/).filter(Boolean);

/** Notation such as 4k7 (LTspice, resistor colour codes): ngspice reads 4k and drops the 7. */
export const DIGIT_LETTER_DIGIT = /(?:^|[\s(,=*/+\-])\d+(?:\.\d+)?[a-df-zA-DF-Z][a-zA-Z]*\d/;

// ---------------------------------------------------------------- potentiometer

export type PotResult = { ok: true; total: Term; pos: Term } | { ok: false; error: string };

/** "10k 0.3": total resistance, wiper position from pin 1 (0 to 1, default 0.5). */
export function parsePot(value: string): PotResult {
  const w = words(value);
  if (!w.length || w.length > 2) return { ok: false, error: 'write the resistance and, optionally, the wiper position: 10k 0.3' };
  const total = term(w[0]);
  if (!total) return { ok: false, error: `"${w[0]}" is not a resistance` };
  if ('lit' in total && !(total.lit > 0)) return { ok: false, error: 'the resistance must be greater than zero' };
  const pos = w[1] === undefined ? { lit: 0.5 } : term(w[1]);
  if (!pos) return { ok: false, error: `"${w[1]}" is not a wiper position` };
  if ('lit' in pos && !(pos.lit > 0 && pos.lit < 1)) return { ok: false, error: 'the wiper position must be between 0 and 1, not including the ends (a 0 ohm part cannot be simulated)' };
  return { ok: true, total, pos };
}

/** The two resistances of a potentiometer: pin 1 to wiper, wiper to pin 2. */
export function potResistances(p: Extract<PotResult, { ok: true }>): [string, string] {
  if ('lit' in p.total && 'lit' in p.pos) return [toSpice(p.total.lit * p.pos.lit), toSpice(p.total.lit * (1 - p.pos.lit))];
  return [`{${inner(p.total)}*${inner(p.pos)}}`, `{${inner(p.total)}*(1-${inner(p.pos)})}`];
}

// ---------------------------------------------------------------- switch

export function parseSwitch(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === 'closed' || v === 'on') return true;
  if (v === 'open' || v === 'off') return false;
  return null;
}

// ---------------------------------------------------------------- transformer

export type XfmrResult = { ok: true; lp: number; ratio: number; k: number } | { ok: false; error: string };

/** "Lp n k": primary inductance, secondary/primary turns ratio, coupling (default 0.999). */
export function parseXfmr(value: string): XfmrResult {
  const w = words(value);
  if (w.length < 2 || w.length > 3) return { ok: false, error: 'write the primary inductance, the turns ratio and optionally the coupling: 1 2 0.99' };
  const [lp, ratio, k] = [parseSI(w[0]), parseSI(w[1]), w[2] === undefined ? 0.999 : parseSI(w[2])];
  if (lp === null || !(lp > 0)) return { ok: false, error: 'the primary inductance must be a number greater than zero' };
  if (ratio === null || !(ratio > 0)) return { ok: false, error: 'the turns ratio must be a number greater than zero (secondary turns per primary turn)' };
  if (k === null || !(k > 0 && k < 1)) return { ok: false, error: 'the coupling must be above 0 and below 1 (ngspice refuses 1 exactly): try 0.999' };
  return { ok: true, lp, ratio, k };
}

// ---------------------------------------------------------------- current-controlled sources

export type SenseResult = { ok: true; source: string; gain: Term } | { ok: false; error: string };

/** "V1 10": the voltage source whose current controls this one, and the gain. */
export function parseSense(value: string): SenseResult {
  const w = words(value);
  if (w.length !== 2) return { ok: false, error: 'write the controlling voltage source and the gain: V1 10' };
  const gain = term(w[1]);
  if (!gain) return { ok: false, error: `"${w[1]}" is not a number` };
  return { ok: true, source: w[0], gain };
}

export const gainText = (t: Term) => ('lit' in t ? toSpice(t.lit) : `{${t.expr}}`);

// ---------------------------------------------------------------- behavioural source

export type BehaviouralResult = { ok: true; kind: 'V' | 'I'; expr: string } | { ok: false; error: string };

export function parseBehavioural(value: string): BehaviouralResult {
  const m = /^\s*([VvIi])\s*=\s*(.+?)\s*$/.exec(value);
  if (!m) return { ok: false, error: 'write V=… or I=…, for example V=v(in)*2' };
  return { ok: true, kind: m[1].toUpperCase() as 'V' | 'I', expr: m[2] };
}

/** Functions measured to work in a B source, with their argument counts. Left out on purpose:
 * `int` and `atan2`, because ngspice-wasm never returns from them, and `limit`, because it does not
 * clamp (limit(0.2,-1,1) gives -0.8). test/parts.test.ts checks the value of every one listed. */
const FUNCTIONS: Record<string, number> = {
  abs: 1, sqrt: 1, sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1, sinh: 1, cosh: 1, tanh: 1, exp: 1, ln: 1, log: 1, log10: 1,
  sgn: 1, u: 1, uramp: 1, floor: 1, ceil: 1, nint: 1, pow: 2, pwr: 2, min: 2, max: 2,
};
const CONSTANTS = new Set(['time', 'temper', 'pi', 'e']);

/** What an expression may refer to: the nets and voltage sources of its sheet. */
export interface ExprScope { nets: Set<string>; vsources: Set<string> }

/** Nets an expression reads through v(a) or v(a,b), lower-cased. */
export function referencedNets(expr: string): string[] {
  return [...expr.matchAll(/(?<![A-Za-z0-9_])v\s*\(([^()]*)\)/gi)].flatMap((m) => m[1].split(',').map((a) => a.trim().toLowerCase()));
}

class BadExpression extends Error {}

const TOKEN = /\s*(?:((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z]*)|([a-z_][a-z0-9_]*)|(\{[^{}]*\})|(\*\*|\|\||&&|==|!=|<>|<=|>=|[-+*/^()<>!?:,]))/iy;

/** Problems with a behavioural expression, or null. This is a full parse, not a spot check:
 * ngspice-wasm never returns from many malformed expressions (`v(a)*`, a missing bracket,
 * a wrong argument count), so only what parses here may reach it. */
export function checkExpression(expr: string, scope: ExprScope): string | null {
  let at = 0;
  let tok: { kind: 'num' | 'name' | 'param' | 'op' | 'end'; text: string } = { kind: 'end', text: '' };
  const fail = (why: string): never => { throw new BadExpression(why); };
  const next = () => {
    if (!expr.slice(at).trim()) { tok = { kind: 'end', text: '' }; at = expr.length; return; }
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(expr) ?? fail(`ngspice cannot read "${expr.slice(at).trim()[0]}" in an expression`);
    at = TOKEN.lastIndex;
    tok = m[1] ? { kind: 'num', text: m[1] } : m[2] ? { kind: 'name', text: m[2] } : m[3] ? { kind: 'param', text: m[3] } : { kind: 'op', text: m[4] };
    if (tok.kind === 'num' && /^[\d.]/.test(expr.slice(at))) fail('it has a number written like 4k7, which ngspice reads as 4k: write 4.7k');
  };
  const found = () => (tok.kind === 'end' ? 'the end' : `"${tok.text}"`);
  const is = (...ops: string[]) => tok.kind === 'op' && ops.includes(tok.text);
  const expect = (op: string) => { if (!is(op)) fail(`expected "${op}" but found ${found()}`); next(); };

  /** The text between the brackets of v(…) / i(…): net names, which need not be identifiers. */
  const names = (fn: string): string[] => {
    const close = expr.indexOf(')', at);
    if (close < 0) fail(`${fn}( is not closed`);
    const args = expr.slice(at, close).split(',').map((a) => a.trim().toLowerCase());
    at = close + 1;
    next();
    return args;
  };

  const ternary = (): void => { or(); if (is('?')) { next(); ternary(); expect(':'); ternary(); } };
  const or = (): void => { and(); while (is('||')) { next(); and(); } };
  const and = (): void => { compare(); while (is('&&')) { next(); compare(); } };
  const compare = (): void => { sum(); if (is('<', '>', '<=', '>=', '==', '!=', '<>')) { next(); sum(); } };
  const sum = (): void => { product(); while (is('+', '-')) { next(); product(); } };
  const product = (): void => {
    unary();
    while (is('*', '/')) {
      const divide = tok.text === '/';
      next();
      if (divide && tok.kind === 'num' && Number.parseFloat(tok.text) === 0) fail('it divides by zero');
      unary();
    }
  };
  const unary = (): void => { if (is('-', '+', '!')) { next(); unary(); return; } primary(); if (is('^', '**')) { next(); unary(); } };
  const primary = (): void => {
    if (tok.kind === 'num' || tok.kind === 'param') { next(); return; } // {param} is also checked as every value is
    if (is('(')) { next(); ternary(); expect(')'); return; }
    if (tok.kind !== 'name') fail(`expected a number, v(net) or a function but found ${found()}`);
    const written = tok.text, name = written.toLowerCase();
    next();
    if (!is('(')) {
      if (!CONSTANTS.has(name)) fail(`"${written}" is not a net or a function. Write nets as v(name), and parameters as {name}`);
      return;
    }
    if (name === 'v' || name === 'i') {
      const args = names(written);
      if (args.length > (name === 'v' ? 2 : 1)) fail(`${written}( takes ${name === 'v' ? 'one or two nets' : 'one voltage source'}`);
      for (const a of args) {
        if (name === 'v' && !(scope.nets.has(a) || a === '0' || a === 'gnd')) fail(`there is no net called "${a}" (nets are named by their labels, or n1, n2… when unlabelled)`);
        if (name === 'i' && !scope.vsources.has(a)) fail(`i(${a}) needs a voltage source called ${a.toUpperCase()}: ngspice only measures current through voltage sources`);
      }
      return;
    }
    if (name === 'limit') fail('limit() does not clamp in ngspice: write min(max(x, lo), hi) instead');
    const arity = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : fail(`"${written}(" is not a function ngspice knows`);
    next();
    let count = 0;
    if (!is(')')) { ternary(); count++; while (is(',')) { next(); ternary(); count++; } }
    expect(')');
    if (count !== arity) fail(`${written}() takes ${arity} argument${arity === 1 ? '' : 's'}`);
  };

  try {
    next();
    ternary();
    if (tok.kind !== 'end') fail(`unexpected ${found()}`);
    return null;
  } catch (err) {
    if (err instanceof BadExpression) return err.message;
    throw err;
  }
}
