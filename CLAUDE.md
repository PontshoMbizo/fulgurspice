# fulgurspice — context for Claude

## What this is
A browser circuit simulator for scope.io (Pontsho's LeetCode-style platform for electronics
engineers). KiCad-style schematic capture, ngspice (WebAssembly, via `eecircuit-engine`) as the
engine, LTspice-style waveform viewer. It is the electronics sibling of fulgurlab (the
Simulink-style block simulator backed by Scilab) and deliberately shares its desktop chrome.

## Stack
- TypeScript, React 19, Vite 6, Vitest. No UI library, no state library, no CSS framework.
- `eecircuit-engine` 1.9.0 (pinned): ngspice + wasm inlined in one 20 MB ES module.
- Fonts: IBM Plex Sans / Mono via `@fontsource`.

## Architecture rules (keep these)
1. **The SPICE netlist is the interface.** The editor never talks to the solver; `compile()` in
   `src/core/netlist.ts` turns a `Schematic` into netlist text plus issues. Anything a grader or a
   server needs must be derivable from that text.
2. **`src/core/` is pure.** No DOM, no React, no engine import. It must run in Node for tests and
   later on a server.
3. **Only `src/sim/worker.ts` imports the engine**, so it stays in its own lazily loaded chunk.
4. **Everything is on an integer grid** (1 unit = 10 px at 100 %). Connectivity is coordinate
   equality: a pin or wire end anywhere on a wire connects; crossing wires do not.
5. **One table for parts.** A new part is one entry in `SYMBOLS` (`src/core/symbols.ts`): geometry,
   pins, default value, SPICE card. Palette, canvas and netlister read from it.
5b. **Subcircuits are sheets.** `Schematic.subckts` holds definitions (parts + wires, ports are `PORT`
   parts); an instance is a `SUBCKT` part whose `value` is the definition's name and whose `ports`
   snapshot (kept in step by `syncInstances`) lays out its pins. The one exception to "geometry comes
   from `SYMBOLS`": use `symbolFor(part)` / `pinPositions(part)`, never `SYMBOLS[part.kind]`, for
   anything placed. `compile()` emits each used definition once; `compile(sch, { sheet })` checks one.
6. Catch mistakes in `compile()` (rule checks) before ngspice sees them; translate ngspice
   messages in `explain()` (`src/sim/result.ts`). The audience is learners.

## Conventions
- SPICE number rules, not SI: `m` = milli, `meg` = mega, case-insensitive. See `src/core/units.ts`.
- ngspice lower-cases everything; node names from labels are lower-cased in `netName()`.
- **Engine hazards (measured): ngspice-wasm never returns for a `{name}` that is not defined, or for a
  parameter value written `4k7`.** There is no timeout inside the engine, so a tab freezes and a
  grader would hang. `compile()` refuses undefined `{names}` (`exprNames`) and rewrites parameter
  numbers through `spiceValue`; keep it that way. ngspice also silently ignores unknown instance
  parameters, so those are checked in `compile()` too.
- Vector names stay as ngspice reports them (`v(out)`, `i(@r1[i])`); `vectorLabel()` makes the
  display form (`V(out)`, `I(R1)`).
- Visual language: grey desktop chrome (from fulgurlab), KiCad default colours on the sheet
  (green wires, dark-red symbols, teal text, cream background), black LTspice plot. Tokens are at
  the top of `src/styles.css`.
- Every example in `src/core/examples.ts` is also a test fixture; a new example needs a physics
  assertion in `test/engine.test.ts`.

## How to help effectively
- Run `npm test` and `npm run build` before calling anything done. Engine tests run real ngspice.
- Verify UI changes in a browser; the core tests do not cover the canvas.
- Pontsho wants the "why" before the "how": explain trade-offs, measure before claiming.
- Dev machine is Fedora (dnf). `gh` CLI is installed.
- Security note for later: part values and directives are free text that goes into the netlist.
  Harmless in the browser, but a grading server must not run user netlists unsandboxed
  (ngspice has `.control` blocks with shell access). Reuse fulgurlab's hardened container.

## Where notes live
Project notes, decisions and learnings: `~/Workspace/second brain/10 - Projects/fulgurspice/`.
Task state: `TASKS.md` in this folder.
