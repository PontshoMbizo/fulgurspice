// The schematic document. Everything sits on an integer grid (1 unit = one grid
// cell = 10 px at 100 %), which is what keeps connectivity exact: two things are
// connected when their coordinates are equal, never "close enough".

export type Rot = 0 | 90 | 180 | 270;

export type PartKind =
  | 'R' | 'C' | 'L' | 'V' | 'I' | 'GND' | 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'OPAMP' | 'LABEL'
  /** A subcircuit's connection to the outside: only meaningful inside a subcircuit sheet. */
  | 'ZENER' | 'LED' | 'POT' | 'SW' | 'VSW' | 'XFMR'
  /** Dependent sources: voltage-, current-controlled voltage / current (SPICE E, G, F, H) */
  | 'VCVS' | 'VCCS' | 'CCCS' | 'CCVS'
  /** Behavioural source (SPICE B): V=expression or I=expression. */
  | 'BSRC'
  /** Op-amp with supply pins, which clips at the rails. */
  | 'OPAMPS'
  | 'PORT'
  /** An instance of a user-defined subcircuit; `value` is the subcircuit's name. */
  | 'SUBCKT';

export interface Part {
  id: string;
  kind: PartKind;
  /** Reference designator (R1, C3). Empty for GND and LABEL. */
  ref: string;
  x: number;
  y: number;
  rot: Rot;
  mirror: boolean;
  /** value / model / net name, depending on the kind. Free text, as in LTspice. */
  value: string;
  /** Where the reference / value text sits relative to its default spot, in grid
   * units. Absent = default placement. Set by dragging the text in the editor. */
  refOffset?: Point;
  valueOffset?: Point;
  /** SUBCKT only: the subcircuit's port names, in pin order, as of the last sync. Pins are
   * laid out from this list, so geometry needs nothing but the part. */
  ports?: string[];
  /** SUBCKT only: parameter overrides, "R=2k C=47n". */
  params?: string;
  /** Inside a subcircuit sheet only: part of the test bench, drawn and simulated when the
   * sheet is run on its own but left out of the definition and every instance. */
  bench?: boolean;
  /** Fixed by a problem author (scope.io). While a learner solves the problem the part can be moved
   * and wired but not deleted or given another value. Editor-only: the netlist ignores it. */
  locked?: boolean;
}

export interface Wire {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Analysis =
  | { kind: 'tran'; step: string; stop: string }
  | { kind: 'ac'; points: string; fstart: string; fstop: string }
  | { kind: 'dc'; source: string; start: string; stop: string; step: string }
  | { kind: 'op' };

/** A user-defined subcircuit: a sheet of its own. Its ports are the PORT parts on it,
 * in the order they appear in `parts`. Compiles to `.subckt NAME ... .ends`. */
export interface Subckt {
  name: string;
  /** Parameters and their defaults, "R=1k C=100n". Use them in values as {R}. */
  params?: string;
  parts: Part[];
  wires: Wire[];
}

export interface Schematic {
  format: 'fulgurspice-schematic';
  version: 1;
  title: string;
  parts: Part[];
  wires: Wire[];
  analysis: Analysis;
  /** Extra SPICE lines (.model, .param, .options) appended verbatim. */
  directives: string;
  /** Subcircuit definitions that instances (kind SUBCKT) refer to by name. */
  subckts: Subckt[];
  /** Repeat the analysis once per value of a parameter used as {name} in the schematic. ngspice has no
   * .step, so the app runs the netlist several times. */
  sweep?: SweepSpec;
}

export interface SweepSpec {
  /** Parameter name, as written in {name}. */
  param: string;
  /** A list ("1k 2k 5k"), "lin start stop count", or "dec start stop pointsPerDecade". */
  values: string;
}

export interface Point { x: number; y: number }

export const emptySchematic = (): Schematic => ({
  format: 'fulgurspice-schematic',
  version: 1,
  title: 'untitled',
  parts: [],
  wires: [],
  analysis: { kind: 'tran', step: '10u', stop: '10m' },
  directives: '',
  subckts: [],
});
