# Prolific and collector launch checklist

Applies to study `2026-09-08-study3-v2`, assignment `n35-study3-carryover-v2`, and log schema `text-enrichment-trial-log-v3`.

## Prolific configuration

Use this external-study URL after GitHub Pages and the collector are live:

```text
https://textenr-test.github.io/study3_interface/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

Enable desktop compatibility only. The public description should disclose two practice trials, 114 one-second comparisons in three sets, two break screens, one clearly labeled attention check per set, normal/corrected vision, weekly creator-led reading, English instructions, and exclusion of people who speak Korean. Pilot the duration and reward before launch.

Create or verify five Prolific redirect paths and paste the complete URLs into `study-config.js`:

1. successful completion;
2. paid eligibility screen-out;
3. incompatible-device return;
4. failed instruction-check return; and
5. no-consent return.

Never include `preview=1` in the live URL.

## Private collector

Do not reuse the Study 2 Sheet or Apps Script deployment.

1. Create a private Google Sheet for Study 3.
2. Open **Extensions → Apps Script** and replace `Code.gs` with `apps-script/Code.gs`.
3. Set Script Property `STUDY_VERSION = 2026-09-08-study3-v2`.
4. If needed, set `SPREADSHEET_ID` and restricted `EXPORT_FOLDER_ID`.
5. Run `setupStudyWorkbook()` once and authorize Sheet/Drive access.
6. Confirm `Participants`, `Trials`, `TrialJSON`, `Events`, and `README` tabs and the CSV/JSON exports are created.
7. Deploy a new web app as the owner, accessible to anyone with the deployment link.
8. Put the new `/exec` URL in `study-config.js` and verify the health handshake reports the Study 3 service, collector, assignment, and schema versions.

The collector reserves slots 1–35 under a lock, writes trials idempotently, confirms every stored row, and requires checkpoints at 38, 76, and 114 trials. Exact balance requires one valid completion in every slot. Incomplete or invalid slots are never released automatically; use `releaseIncompleteSlot("PROLIFIC_PID", "STUDY_ID")` under the approved replacement policy, then recruit a replacement into that released slot.

## Assignment and stimulus checks

Run:

```sh
npm test
```

Confirm 35 slot files, 3,990 master rows, 304 HTML stimuli, and the M identity distribution D2=1, D3=3, D4=11, D5=12, novel=11. Review warnings for `P6_DOC_A`, `P13_DOC_A`, and `P13_DOC_B`.

Run the assignment generator and read `assignments/master-assignment.json` before launch. Confirm zero M–equivalent-D co-assignments, document-condition=15, document-condition-set=5, ordered transitions=94/95, condition-position=5, condition-position-side=2/3, global-position-side=17/18, and maximum side run=3.

## End-to-end checks

1. Complete fast previews for slots 1, 7, 14, 21, 28, and 35.
2. Complete one full-duration preview, including both breaks and all three slot-specific attention checks.
3. With a staging collector, confirm matching `event_id` values in `Trials` and `TrialJSON`.
4. Verify checkpoints report 38/38, 76/76, and 114/114.
5. Change tabs during exposure and confirm the attempt is discarded and repeated.
6. Reopen the same Prolific session and confirm slot, progress, breaks, and pending uploads resume.
7. Verify the M audit fields and confirm the duplicate flag is false in every exported row.
8. Test all five Prolific exit paths before publishing.

Keep the Sheet, exports, and analysis files restricted under the approved retention plan.
