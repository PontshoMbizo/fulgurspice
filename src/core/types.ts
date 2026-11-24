// The schematic document. Everything sits on an integer grid (1 unit = one grid
// cell = 10 px at 100 %), which is what keeps connectivity exact: two things are
// connected when their coordinates are equal, never "close enough".

export type Rot = 0 | 90 | 180 | 270;

export type PartKind =
  | 'R' | 'C' | 'L' | 'V' | 'I' | 'GND' | 'D' | 'NPN' | 'PNP' | 'NMOS' | 'PMOS' | 'OPAMP' | 'LABEL';

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

export interface Schematic {
  format: 'fulgurspice-schematic';
  version: 1;
  title: string;
  parts: Part[];
  wires: Wire[];
  analysis: Analysis;
  /** Extra SPICE lines (.model, .param, .options) appended verbatim. */
  directives: string;
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
});
