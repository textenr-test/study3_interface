# Prolific and collector launch checklist

Applies to study `2026-09-07-study3-v1`, assignment `n42-study3-fano-v1`, and log schema `text-enrichment-trial-log-v3`.

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
3. Set Script Property `STUDY_VERSION = 2026-09-07-study3-v1`.
4. If needed, set `SPREADSHEET_ID` and restricted `EXPORT_FOLDER_ID`.
5. Run `setupStudyWorkbook()` once and authorize Sheet/Drive access.
6. Confirm `Participants`, `Trials`, `TrialJSON`, `Events`, and `README` tabs and the CSV/JSON exports are created.
7. Deploy a new web app as the owner, accessible to anyone with the deployment link.
8. Put the new `/exec` URL in `study-config.js` and verify the health handshake reports the Study 3 service, collector, assignment, and schema versions.

The collector reserves slots 1–42 under a lock, writes trials idempotently, confirms every stored row, and requires checkpoints at 38, 76, and 114 trials. Incomplete slots are never released automatically; use `releaseIncompleteSlot("PROLIFIC_PID", "STUDY_ID")` only under the approved replacement policy.

## Assignment and stimulus checks

Run:

```sh
npm test
```

Confirm 42 slot files, 4,788 master rows, 304 HTML stimuli, and the M identity distribution D2=1, D3=3, D4=11, D5=12, novel=11. Review warnings for `P6_DOC_A`, `P13_DOC_A`, and `P13_DOC_B`.

Read `assignments/master-assignment.json` before launch. It records the exact satisfied constraints and two deviations from the strongest Notion targets: condition×global-position×D0-side is not uniformly 3/3, and the maximum D0-side run is 3 instead of 2. It also flags 162 participant-document cases in which M and a visually identical D condition are both assigned. Pre-specify their analysis treatment.

## End-to-end checks

1. Complete fast previews for slots 1, 7, 14, 21, 28, 35, and 42.
2. Complete one full-duration preview, including both breaks and all three slot-specific attention checks.
3. With a staging collector, confirm matching `event_id` values in `Trials` and `TrialJSON`.
4. Verify checkpoints report 38/38, 76/76, and 114/114.
5. Change tabs during exposure and confirm the attempt is discarded and repeated.
6. Reopen the same Prolific session and confirm slot, progress, breaks, and pending uploads resume.
7. Verify the M audit fields and duplicate flag in exported rows.
8. Test all five Prolific exit paths before publishing.

Keep the Sheet, exports, and analysis files restricted under the approved retention plan.
