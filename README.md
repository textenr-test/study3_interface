# Text Enrichment Reader Study — Study 3

Static GitHub Pages experiment for a 42-participant Prolific cohort. Study version: `2026-09-07-study3-v1`.

## Study design

- 38 Korean-language documents and seven enriched conditions: D1, D2, W, D3, D4, D5, and model-optimal M. D0 is the baseline.
- Every participant completes 114 trials in three sets of 38 and sees three distinct enriched conditions for every document.
- Two break screens follow trials 38 and 76. One slot-specific attention check occurs within each set; every eligible within-set position is used twice across 42 slots.
- Each trial uses a 750 ms fixation, a 1,000 ms simultaneous display, and a −3…+3 rating normalized to the enriched version.

The locked allocation in `assignments/` has 4,788 rows and enforces:

- two participant-condition totals of 17 and five totals of 16;
- three participant-set-condition totals of 6 and four totals of 5;
- 18 readers per document-condition and 6 per document-condition-set;
- every unordered condition pair co-assigned exactly 6 times per document;
- D0 left/right 19/19 per participant-set and 3/3 per document-condition-set;
- three different positions for each participant-document, no last-five/first-five boundary overlap, no adjacent A/B documents by the same writer, and no consecutive enriched condition;
- condition-by-global-position frequency exactly 6; and
- D0 side runs no longer than 3.

The reproducible allocation artifacts record two deviations from the strongest targets in the Notion design: condition×global-position×D0-side cells are not uniformly 3/3, and the maximum D0-side run is 3 rather than 2. The exact document/condition/set and participant/set side balances above remain intact. The deployable repository keeps the canonical per-slot files plus `index.json`; the generator can reproduce the redundant combined JSON/CSV exports locally.

M is visually identical to an existing D condition for 27 of 38 documents (D2: 1, D3: 3, D4: 11, D5: 12) and is a novel prefix for 11. Preserving the exact Fano pair frequency creates 162 participant-document cases containing M and its visually equivalent D condition. These cases are flagged by `within_document_visual_duplicate`; analyses should pre-specify whether to retain, exclude, or model them.

## Stimuli and audit fields

`stimuli/` contains 38 self-contained packages with 304 HTML payloads imported from `Google Drive/CHI Text Enrichment/(for CHI) final output`. `scripts/finalize-stimuli.mjs` verifies source hashes and writes M's realized ink-mass ratio, retained-factor count, exact stimulus hash, normalized visual hash, factor-ID hash, and equivalent D condition.

Run `node scripts/verify-stimuli.mjs` to verify all packages and the expected M identity distribution.

## Data pipeline

The browser uploads idempotent trial/event records to the private Google Apps Script collector, confirms set checkpoints at 38, 76, and 114 trials, and resumes from local state after interruptions. The collector stores flat rows in `Trials`, canonical JSON in `TrialJSON`, participant state in `Participants`, and lifecycle/quality records in `Events`.

Study 3 adds stimulus/visual/factor hashes, M equivalence and novelty, Fano block, set permutation, assigned condition triple, and the within-document visual-duplicate flag. `apps-script/Code.gs` and `logs/` use schema `text-enrichment-trial-log-v3`.

## Launch configuration

Preview mode works without remote writes:

```text
http://localhost:4173/?preview=1&slot=1&fast=1
```

Before live recruitment, create a new private Sheet-bound Apps Script deployment from `apps-script/Code.gs`, run `setupStudyWorkbook()`, set Script Property `STUDY_VERSION=2026-09-07-study3-v1`, and put the new `/exec` URL in `study-config.js`. Verify all Prolific completion/return codes in the same file. Do not reuse the Study 2 collector endpoint.

The live interface intentionally refuses entry if the collector endpoint, Prolific parameters, redirects, or version handshake are missing or incompatible.

## Local checks

```sh
npm test
python3 -m http.server 4173
```

Published interface:

```text
https://textenr-test.github.io/study3_interface/
```

GitHub Pages serves only code and public stimuli. Keep participant data in the restricted researcher-controlled Sheet and Drive exports.
