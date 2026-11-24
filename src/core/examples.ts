// Starter circuits. They double as test fixtures: test/engine.test.ts runs every
// one through the netlister and ngspice and checks the physics.

import type { Analysis, Part, PartKind, Rot, Schematic, Subckt, Wire } from './types';

let n = 0;
const part = (kind: PartKind, ref: string, x: number, y: number, value: string, rot: Rot = 0): Part =>
  ({ id: `e${++n}`, kind, ref, x, y, rot, mirror: false, value });
const wires = (...pts: [number, number, number, number][]): Wire[] =>
  pts.map(([x1, y1, x2, y2]) => ({ id: `e${++n}`, x1, y1, x2, y2 }));
const doc = (title: string, analysis: Analysis, parts: Part[], w: Wire[], directives = '', subckts: Subckt[] = []): Schematic =>
  ({ format: 'fulgurspice-schematic', version: 1, title, parts, wires: w, analysis, directives, subckts });

const rc = (title: string, source: string, analysis: Analysis) => doc(title, analysis, [
  part('V', 'V1', 10, 12, source),
  part('R', 'R1', 16, 8, '1k', 90),
  part('C', 'C1', 22, 12, '100n'),
  part('GND', '', 16, 16, ''),
  part('LABEL', '', 10, 8, 'in'),
  part('LABEL', '', 22, 8, 'out'),
], wires([10, 10, 10, 8], [10, 8, 14, 8], [18, 8, 22, 8], [22, 8, 22, 10], [10, 14, 10, 16], [22, 14, 22, 16], [10, 16, 22, 16]));

export const EXAMPLES: { name: string; build: () => Schematic }[] = [
  { name: 'RC low-pass — transient', build: () => rc('RC low-pass', 'SIN(0 1 1k)', { kind: 'tran', step: '10u', stop: '5m' }) },
  { name: 'RC low-pass — AC sweep (Bode)', build: () => rc('RC low-pass, AC', 'AC 1', { kind: 'ac', points: '20', fstart: '10', fstop: '1meg' }) },
  {
    name: 'Half-wave rectifier',
    build: () => doc('Half-wave rectifier', { kind: 'tran', step: '100u', stop: '60m' }, [
      part('V', 'V1', 10, 12, 'SIN(0 5 50)'),
      part('D', 'D1', 16, 8, 'DGEN', 270),
      part('C', 'C1', 22, 12, '10u'),
      part('R', 'R1', 28, 12, '1k'),
      part('GND', '', 16, 16, ''),
      part('LABEL', '', 10, 8, 'in'),
      part('LABEL', '', 28, 8, 'out'),
    ], wires([10, 10, 10, 8], [10, 8, 14, 8], [18, 8, 28, 8], [22, 8, 22, 10], [28, 8, 28, 10],
      [10, 14, 10, 16], [22, 14, 22, 16], [28, 14, 28, 16], [10, 16, 28, 16])),
  },
  {
    name: 'Inverting amplifier (gain −10)',
    build: () => doc('Inverting amplifier', { kind: 'tran', step: '10u', stop: '3m' }, [
      part('V', 'V1', 8, 14, 'SIN(0 0.1 1k)'),
      part('R', 'R1', 14, 10, '1k', 90),
      part('R', 'R2', 24, 5, '10k', 90),
      part('OPAMP', 'U1', 24, 11, '100k'),
      part('GND', '', 8, 16, ''),
      part('GND', '', 19, 14, ''),
      part('LABEL', '', 8, 10, 'in'),
      part('LABEL', '', 29, 11, 'out'),
    ], wires([8, 12, 8, 10], [8, 10, 12, 10], [16, 10, 21, 10], [19, 10, 19, 5], [19, 5, 22, 5],
      [26, 5, 29, 5], [29, 5, 29, 11], [27, 11, 29, 11], [21, 12, 19, 12], [19, 12, 19, 14])),
  },
  {
    name: 'Voltage divider — operating point',
    build: () => doc('Voltage divider', { kind: 'op' }, [
      part('V', 'V1', 10, 12, '9'),
      part('R', 'R1', 18, 10, '10k'),
      part('R', 'R2', 18, 16, '4k7'),
      part('GND', '', 14, 20, ''),
      part('LABEL', '', 18, 13, 'mid'),
    ], wires([10, 10, 10, 6], [10, 6, 18, 6], [18, 6, 18, 8], [18, 12, 18, 14], [10, 14, 10, 20], [18, 18, 18, 20], [10, 20, 18, 20])),
  },
  {
    name: 'Subcircuit with parameters — two dividers',
    build: () => {
      // One divider drawn once: the top resistor is the parameter R (default 1k), the bottom is 1k.
      const div: Subckt = {
        name: 'DIV',
        params: 'R=1k',
        parts: [
          { ...part('PORT', '', 6, 0, 'in'), mirror: true },
          part('R', 'R1', 10, 0, '{R}', 90),
          part('R', 'R2', 16, 4, '1k'),
          part('GND', '', 16, 6, ''),
          part('PORT', '', 20, 0, 'out'),
        ],
        wires: wires([6, 0, 8, 0], [12, 0, 20, 0], [16, 0, 16, 2]),
      };
      const inst = (ref: string, y: number, params?: string): Part => ({ ...part('SUBCKT', ref, 10, y, 'DIV'), ports: ['in', 'out'], ...(params ? { params } : {}) });
      return doc('Two dividers from one subcircuit', { kind: 'op' }, [
        part('V', 'V1', 0, 2, '10'),
        part('GND', '', 0, 4, ''),
        inst('X1', 0),            // default R = 1k: halves the input
        inst('X2', 8, 'R=3k'),    // R = 3k: a quarter of the input
        part('R', 'R1', 16, 2, '1G'), // negligible loads keep the output pins connected
        part('GND', '', 16, 4, ''),
        part('R', 'R2', 16, 10, '1G'),
        part('GND', '', 16, 12, ''),
        part('LABEL', '', 0, 0, 'in'),
        part('LABEL', '', 13, 0, 'half'),
        part('LABEL', '', 13, 8, 'quarter'),
      ], wires([0, 0, 7, 0], [3, 0, 3, 8], [3, 8, 7, 8], [13, 0, 16, 0], [13, 8, 16, 8]), '', [div]);
    },
  },
  {
    name: 'Two RC stages from one subcircuit — AC sweep',
    build: () => {
      // One RC section drawn once, placed twice. Its inner R1/C1 are local to it, so they
      // do not clash with the R1 on the top sheet.
      const rcstage: Subckt = {
        name: 'RCSTAGE',
        parts: [
          { ...part('PORT', '', 6, 0, 'in'), mirror: true }, // points left: its name sits clear of the resistor
          part('R', 'R1', 10, 0, '1k', 90),
          part('C', 'C1', 16, 4, '100n'),
          part('GND', '', 16, 6, ''),
          part('PORT', '', 20, 0, 'out'),
        ],
        wires: wires([6, 0, 8, 0], [12, 0, 20, 0], [16, 0, 16, 2]),
      };
      const inst = (ref: string, x: number): Part => ({ ...part('SUBCKT', ref, x, 0, 'RCSTAGE'), ports: ['in', 'out'] });
      return doc('Two RC stages', { kind: 'ac', points: '20', fstart: '10', fstop: '1meg' }, [
        part('V', 'V1', 0, 2, 'AC 1'),
        part('GND', '', 0, 4, ''),
        inst('X1', 10),
        inst('X2', 20),
        part('R', 'R1', 26, 2, '1G'), // negligible load: keeps the output pin connected without bending the closed form
        part('GND', '', 26, 4, ''),
        part('LABEL', '', 0, 0, 'in'),
        part('LABEL', '', 15, 0, 'mid'),
        part('LABEL', '', 23, 0, 'out'),
      ], wires([0, 0, 7, 0], [13, 0, 17, 0], [23, 0, 26, 0]), '', [rcstage]);
    },
  },
];
