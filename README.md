# Text Enrichment Reader Study — Study 3

Static GitHub Pages experiment for 35 valid completed allocation slots. Study version: `2026-09-08-study3-v2`.

## Study design

- 38 Korean-language documents and seven enriched conditions: D1, D2, W, D3, D4, D5, and model-optimal M. D0 is the baseline.
- Every participant completes 114 trials in three sets of 38 and sees three distinct enriched conditions for every document.
- Two break screens follow trials 38 and 76. One slot-specific attention check occurs within each set.
- Each trial uses a 750 ms fixation, a 1,000 ms simultaneous display, and a −3…+3 rating normalized to the enriched version.

The locked allocation in `assignments/` has 3,990 rows and guarantees, when slots 1–35 each have one valid completer:

- two participant-condition totals of 17 and five totals of 16;
- three participant-set-condition totals of 6 and four totals of 5;
- 15 readers per document-condition and 5 per document-condition-set;
- each condition exactly 5 times at every global trial position;
- all 42 ordered pairs of distinct conditions 94 or 95 times over the full sequence, and 92 or 93 times when transitions are pooled within sets (30 or 31 within each individual set);
- no consecutive repetition of an enriched condition;
- D0 left/right 19/19 per participant-set, 2/3 per document-condition-set, 2/3 per condition-position, and 17/18 per global position;
- D0-side runs no longer than 3;
- three different positions for each participant-document, no last-five/first-five boundary overlap, no adjacent A/B documents by the same writer, and 105 unique participant-set document orders; and
- each eligible attention-check position 1 or 2 times per set and exactly 5 times after pooling the three sets.

The browser assigns no fresh randomness during a session. It loads one of the 35 immutable, seed-reproducible schedules; collector locking ensures a slot is held by at most one active participant. Exact final balance requires one valid completion in every slot. If a participant is invalid or incomplete, use `releaseIncompleteSlot()` and recruit a replacement into that released slot rather than adding a 36th allocation.

## M-equivalent-D exclusion

M is visually identical to an existing D condition for 27 of 38 documents (D2: 1, D3: 3, D4: 11, D5: 12) and is a novel prefix for 11.

For every document with a visual equivalent, the participant-document triple is built under a hard constraint that forbids M and that D condition from co-occurring. The generated allocation contains zero such cases, every row carries `within_document_visual_duplicate=false`, and both the browser and collector reject a violating payload.

This hard exclusion changes pair balance by design:

- for each of the 11 M-novel documents, every unordered condition pair occurs exactly 5 times;
- for each of the 27 equivalence documents, the forbidden M–D pair occurs 0 times and every allowed pair occurs 4–6 times; and
- every document-condition marginal remains exactly 15 despite the exclusion.

Participant-level unordered-pair totals are not separately constrained; the guarantees are at the document-pair, participant-condition, and document-condition levels above.

## Stimuli and audit fields

`stimuli/` contains 38 self-contained packages with 304 HTML payloads imported from `Google Drive/CHI Text Enrichment/(for CHI) final output`. `scripts/finalize-stimuli.mjs` verifies source hashes and writes M's realized ink-mass ratio, retained-factor count, exact stimulus hash, normalized visual hash, factor-ID hash, and equivalent D condition.

Run `node scripts/verify-stimuli.mjs` to verify all packages and the expected M identity distribution.

## Data pipeline

The browser uploads idempotent trial/event records to the private Google Apps Script collector, confirms set checkpoints at 38, 76, and 114 trials, and resumes from local state after interruptions. The collector stores flat rows in `Trials`, canonical JSON in `TrialJSON`, participant state in `Participants`, and lifecycle/quality records in `Events`.

Study 3 records stimulus/visual/factor hashes, M equivalence and novelty, the legacy A–G rotation-group label in `fano_block_id`, set permutation, assigned condition triple, and the always-false within-document visual-duplicate flag. `apps-script/Code.gs` and `logs/` use schema `text-enrichment-trial-log-v3`.

## Launch configuration

Preview mode works without remote writes:

```text
http://localhost:4173/?preview=1&slot=1&fast=1
```

Before live recruitment, create a new private Sheet-bound Apps Script deployment from `apps-script/Code.gs`, run `setupStudyWorkbook()`, set Script Property `STUDY_VERSION=2026-09-08-study3-v2`, and put the new `/exec` URL in `study-config.js`. Verify all Prolific completion/return codes in the same file. Do not reuse the Study 2 collector endpoint or a v1 Study 3 workbook.

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
