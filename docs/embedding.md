# Using fulgurspice inside scope.io

scope.io frames the app in an iframe and drives it with the `scopeio:*` messages it uses for all of
its embedded simulators (fpgasim, mcusim, fulgurlab). The code is in `src/ui/scopeio.ts`. Framed
without those messages (scope.io's `/tools/spice` page) it behaves like the standalone app.

| Direction | Message | When |
|---|---|---|
| app → host | `{ type: 'scopeio:ready' }` | the listener is registered; the host (re)sends init |
| host → app | `{ type: 'scopeio:init', protocol: 2, mode, starterCode, config }` | once the app is ready |
| app → host | `{ type: 'scopeio:change', code }` | 0.8 s after an edit (the host keeps the draft; no local autosave) |
| app → host | `{ type: 'scopeio:result', payload }` | the host's action button was pressed |

## Modes

| mode | button | runs first | locked parts | analysis |
|---|---|---|---|---|
| `export` | Save starter | no | editable, with a *Locked for learners* checkbox | editable |
| `capture` | Capture golden | yes | editable, with the checkbox | locked |
| `solve` | Submit | yes | can be moved and wired, not changed or deleted | locked |

Under a host, File > New / Open / Examples are hidden. Duplicate inits are ignored: the app seeds
from the first one only.

## `config`

| Field | Meaning |
|---|---|
| `probes` | `{ output, input? }`: the net labels to grade. Default output `out`. |
| `analysis` | Replaces the schematic's analysis, so every answer runs on the problem's grid. |
| `sweep` | `{ param, values }`: a load-sweep problem. The locked load resistor's value is `{RLOAD}`, and the app runs once per value. |
| `lockAnalysis` | Analysis and sweep read-only. Default: on except in `export`. |
| `theme` | `'light'` ignores the system dark setting. |

## `payload`

```jsonc
{
  "code": "{…schematic JSON…}",
  "ok": true,
  "netlist": "* …the SPICE netlist that ran…",
  "log": "why it failed (only when ok is false)",
  "capture": {
    // transient: the output (and input) net resampled at k·step, k = 0 … stop/step (at most 50,000 samples)
    "kind": "tran", "runs": [{ "tag": "1k", "sampleRate": 100000, "output": [/*…*/], "input": [/*…*/] }]
    // AC: { "kind": "ac", "runs": [{ "f": [], "magDb": [], "phaseDeg": [] }] }, output/input when input is given
  }
}
```

`runs` has one entry per sweep value (with its `tag`), or a single entry without one.

## Trust

The capture comes from the learner's browser, so scope.io grades it the way it grades its other
in-browser simulators: it trusts it. Locked parts and the locked analysis are conveniences, not
checks. The next step is a grading server that re-runs `code` through `compile()` and ngspice in
a hardened container (see TASKS.md, Phase 5).

## Deployment

The site must be frameable by scope.io. If nginx sends `X-Frame-Options` or a CSP, allow scope.io's
origins: `add_header Content-Security-Policy "frame-ancestors 'self' https://<scope.io origin>";`
