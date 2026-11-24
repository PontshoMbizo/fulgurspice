// Shared pure geometry helpers: where two points coincide, and how to route an
// orthogonal wire between them. Used by the netlister (connectivity) and the UI
// (drawing wires, rubber-banding, splitting) so both agree on one definition.

import type { Point } from './types';

/** A fresh element id. Not cryptographic: ids only need to be unique within one document. */
export const newId = () => Math.random().toString(36).slice(2, 10);

export const pointKey = (x: number, y: number) => `${x},${y}`;

/** One bend: along x first, then y. Degenerate (zero-length) segments are dropped. */
export function route(a: Point, b: Point): { x1: number; y1: number; x2: number; y2: number }[] {
  return [
    { x1: a.x, y1: a.y, x2: b.x, y2: a.y },
    { x1: b.x, y1: a.y, x2: b.x, y2: b.y },
  ].filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2);
}
