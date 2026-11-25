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
- [x] **DONE** Subcircuit parts: draw a sheet with Subcircuit port parts, place it as an `X` instance; compiles to `.subckt` / `.ends`
- [x] **DONE** Subcircuits, follow-ups: rename a definition (instances follow); make a subcircuit from the selection (nets crossing the boundary become ports, ground stays global, outside connectivity verified); wires follow pins when ports change; `params:` defaults and per-instance overrides; run a subcircuit sheet on its own with test-bench-only parts
- [ ] Subcircuits, still open: choose which side each port is on; keep a symbol's pin order stable when ports are reordered; `.param` expressions that reference other params of the same definition

## Phase 3 — analyses and waveform viewer
- [x] **DONE** `.tran`, `.ac`, `.dc`, `.op`; voltage and current probing from the schematic
- [x] **DONE** Dual axis (V left, A right), Bode magnitude + phase, hover cursor, drag-zoom
- [x] **DONE** Two measurement cursors: click for A then B, readout with Δ and 1/Δt per trace (right-click or double-click clears)
- [x] **DONE** Trace math: `V(a)-V(b)`, `V(out)/V(in)`, `V(in)*I(V1)`, `abs db ph re im sqrt`; complex-aware for AC; units tracked (V·A = W)
- [x] **DONE** `.meas` support: write `.meas` lines under SPICE directives; a Measurements tab lists the values, failed ones flagged (`measurementsOf`, reused for grading)
- [x] **DONE** Stacked plot panes (one per unit), vertical zoom (wheel), shift+wheel x zoom, export CSV / PNG (download buttons not exercised in the browser)
- [x] **DONE** Parameter sweeps: Analysis → Sweep parameter and values (list, `lin`, `dec`; max 12 runs); one run per value, merged into one plot. ngspice has no `.step`, so the app repeats the run
- [x] **DONE** Decimate very long traces before drawing (min/max per pixel column; single-sample spikes survive)

- [ ] Phase 3 follow-ups: sweeps for operating-point analysis (a table per value); a swept subcircuit-parameter shortcut; vertical pan; cursor snap to data points; measurement helper dialog

## Phase 4 — models and parts
- [ ] Real part models (1N4148, 2N3904/3906, 2N7000, LM358, TL072): check each vendor licence first
- [x] **DONE** Op-amp with supply pins and rail clipping (`OPAMP_RAIL`, `OPAMP_RR`; no slew-rate or current limit)
- [x] **DONE** More parts: potentiometer, switches (manual and voltage controlled), transformer, zener and LED symbols, controlled sources (E/G/F/H), behavioural source (B); each checked against ngspice (`test/parts.test.ts`)
- [x] **DONE** Source editor (DC / SIN / PULSE / PWL / AC fields) in the Inspector, beside the free-text value
- [ ] Phase 4 follow-ups: example circuits for the new parts; centre-tapped transformer; EXP / SFFM in the source editor

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
