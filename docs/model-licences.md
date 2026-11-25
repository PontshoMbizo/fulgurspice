# Can fulgurspice ship vendor SPICE models?

Checked 2026-11-25. Engineering reading of published terms, not legal advice.

**Status: shelved (2026-11-25).** Real part models are future work; see `TASKS.md`.

The app sends model text to every visitor's browser, so the question is whether a vendor
allows redistribution to third parties in readable form.

**Decision basis: none of the terms read grants that. Do not bundle vendor model files.**

| Source | Parts | What the terms say (paraphrased) | Bundle? |
|---|---|---|---|
| Texas Instruments | LM358, TL072 | Site terms bar copying and distribution without written consent, apart from non-commercial or personal use. The default software licence (SSZO061), which applies when a download carries no terms of its own, is for internal evaluation on TI devices and requires a separate agreement before any distribution. | No |
| onsemi | 2N3904, 2N3906, 2N7000, 1N4148 | Content Use Agreement covers design models. Distribution only in machine-executable, not human-readable, form, with onsemi products, to customers under a licence. | No |
| Diodes Inc. (incl. Zetex) | 1N4148W, 2N7002 and others | Models may be used or copied intact, with the notice, for research and design only; all other rights reserved. | No |
| Nexperia | 1N4148 | Site refused automated access (HTTP 403). Unread. | Unknown: treat as no |
| KiCad-Spice-Library | various | GPL-3.0 covers its scripts only; the README disclaims any licence for the model files. | No |
| starlingcode/spice-models | 1N4148, 2N3904, TL072 | No licence file. Two headers point to PSpice tools as the origin. | No |
| ngspice model page | collections | No model licence stated; one collection comes from Micro-Cap. Archives not opened. | Not established |

## Not checked
- Licence headers inside the vendor model downloads (nothing was downloaded). A file's own
  terms would override the TI default. Whether the onsemi agreement is the one attached to
  its model downloads is not confirmed either, and the copy read uses the old company name.
- ST and Vishay model terms (only unrelated ST software licences turned up).
- Part numbers used as model names (trademark question).

## Options
1. Write our own models, fitted to datasheet figures, labelled as approximations and not
   vendor models, with a test per datasheet figure. Same approach as the current generic models.
2. Users paste a model they downloaded into SPICE directives. Nothing is redistributed by us.
   Op-amp macromodels may need a wrapper `.subckt` to match the symbol's pin order.
3. Ask a vendor for written redistribution permission.

## Sources
- https://www.ti.com/legal/terms-conditions/terms-of-use.html
- https://www.ti.com/lit/ml/sszo061/sszo061.pdf
- https://www.onsemi.com/terms-of-use
- https://www.onsemi.com/site/pdf/Collateral%20Use%20Agreement.pdf
- https://www.diodes.com/productcollection/spicemodels/8348/Small-Signal-Switching-Diodes.spice.txt?eid=307
- https://www.diodes.com/assets/Spice-Models/spicemodels-all.txt (read in part)
- https://github.com/kicad-spice-library/KiCad-Spice-Library
- https://github.com/starlingcode/spice-models
- https://ngspice.sourceforge.io/modelparams.html
