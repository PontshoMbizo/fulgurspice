# fulgurspice tasks

## Phase 0 — engine spike
- [x] **DONE** ngspice-wasm (`eecircuit-engine`) runs in Node and in a Web Worker; measured load and run time (README)
- [x] **DONE** Result normalisation: typed arrays, LTspice-style labels, units (`src/sim/result.ts`)

## Phase 1 — schematic editor
- [x] **DONE** Grid canvas with pan/zoom, KiCad colours, palette, inspector
- [x] **DONE** Place, select, move, rotate, mirror, delete; undo/redo; autosave; open/save JSON
- [x] **DONE** Orthogonal wiring with automatic junction dots and open-pin markers
- [x] **DONE** Rubber-band wires when a part moves
- [x] **DONE** Marquee (box) selection (left-to-right = fully inside, right-to-left = touching) — *needs a browser check*
- [x] **DONE** Copy / cut / paste / duplicate (Ctrl+C/X/V/D)
- [x] **DONE** Split a wire where a new wire lands mid-segment, and merge collinear segments (`normalizeWires` in `store.ts`)
- [x] **DONE** Drag a wire segment (neighbours rubber-band); delete one segment of a run (Shift+Del, hover the segment)
- [x] **DONE** Editable label positions: drag the text of a selected part; Inspector has a reset button
- [x] **DONE** `A` opens the add-part search box

## Phase 2 — netlister
- [x] **DONE** Union-find connectivity, net labels, ground, deterministic node names
- [x] **DONE** Rule checks: no ground, unconnected pin, duplicate reference, bad value, AC without a source
- [x] **DONE** Rule check: loop of voltage sources / inductors (error), cut-set of current sources (error) — `src/core/rules.ts`
- [x] **DONE** Rule check: node with no DC path to ground (warning: ngspice adds gmin and carries on)
- [ ] Subcircuits / hierarchical sheets

## Phase 3 — analyses and waveform viewer
- [x] **DONE** `.tran`, `.ac`, `.dc`, `.op`; voltage and current probing from the schematic
- [x] **DONE** Dual axis (V left, A right), Bode magnitude + phase, hover cursor, drag-zoom
- [ ] Two measurement cursors with delta readout (dt, 1/dt, dV)
- [ ] Trace math: `V(a)-V(b)`, `V(out)/V(in)`, power `V*I`
- [ ] `.meas` support and a results panel (also needed for grading)
- [ ] Stacked plot panes; vertical zoom; export CSV / PNG
- [ ] Parameter sweeps (`.step`-style) with one trace per value
- [ ] Decimate very long traces before drawing (min/max per pixel column)

## Phase 4 — models and parts
- [ ] Real part models (1N4148, 2N3904/3906, 2N7000, LM358, TL072): check each vendor licence first
- [ ] Op-amp with supply pins and rail clipping
- [ ] More parts: potentiometer, switch, transformer, zener and LED symbols, controlled sources (E/G/F/H), behavioural source (B)
- [ ] Source editor dialog (SIN / PULSE / PWL / AC fields) in place of free text

## Phase 5 — scope.io integration
- [ ] Embed API: mount in an iframe / as a component with a template schematic and locked parts (mirror fulgurlab's `docs/embedding.md`)
- [ ] Problem format: template schematic + target spec (`f_-3dB = 1 kHz ± 5 %`, `ripple < 50 mV`)
- [ ] Server-side grading: same netlist through ngspice in fulgurlab's hardened container, `.meas`-based checks
- [ ] Netlist sanitiser for the server path (no `.control`, no file access, whitelisted directives)

## Phase 6 — stretch
- [ ] Service worker to cache the 20 MB engine; show download progress on first load
- [ ] Co-simulation with fulgurlab blocks (circuit as a plant model)
- [ ] Import LTspice `.asc` and KiCad netlists

## Housekeeping
- [ ] Create the GitHub repo and push (`gh repo create fulgurspice --private --source=. --remote=origin --push`)
- [ ] CI: `npm test` + `npm run build`
- [ ] Playwright smoke test checked into the repo (place parts, wire, run, probe)
