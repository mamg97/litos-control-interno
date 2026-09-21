# LITOS project context

Updated: 2026-09-20

## Purpose

LITOS is the workshop's internal control system. It consolidates incoming order information, private Drive documents, the operational master spreadsheet, draft/final invoice files, historical reconciliation and a public sanitized dashboard.

## Current production architecture

```
Authorized Gmail intake
        ↓
Google Drive private order folders
        ↓
PEDIDOS M.S. (private operational master)
        ↓
Python / GitHub Actions
   ├─ handwriting enrichment
   ├─ draft generation
   ├─ folder organization
   ├─ invoice/albarán synchronization
   └─ public-feed generation
        ↓
GitHub Pages static dashboard
```

Google Apps Script is no longer a production dependency.

## Production components

| Component | Role | Production mechanism |
| --- | --- | --- |
| M2 | Draft generation and corporate A4 styling | Python + GitHub Actions |
| M3 | Authorized Gmail intake | Python + GitHub Actions |
| M4 | Handwriting extraction/review | Python + GitHub Actions |
| M5 | Order-folder organization | Python + GitHub Actions |
| M6 | Final/draft albarán reconciliation | Python + GitHub Actions |
| M7 | Sanitized public feed and dashboard | Python + GitHub Pages |
| M8 | Curated operational catalog | Protected/read-only automation |

## Main schedules

- M3+M4 intake/handwriting: 07:07, 11:07, 15:07 and 19:07 Europe/Madrid.
- M2 Draft Sync: approximately every 15 minutes at :05, :20, :35 and :50.
- M6 and M7 are bridged from successful scheduled Draft Sync executions.
- M5 folder organizer: 02:17 Europe/Madrid daily.
- Workflows that need a wall-clock local time use GitHub Actions `schedule.timezone: Europe/Madrid`, so CET/CEST transitions are handled by GitHub.

All schedules remain behind repository kill switches where applicable.

## Data source of truth

`PEDIDOS M.S.` is authoritative for operational reporting.

The website does not scrape Drive or Apps Script at runtime. M7 reads the private master, builds a sanitized static `feed.json`, validates it, and deploys GitHub Pages.

## Historical reconciliation status

Historical work is undergoing a second controlled reconciliation pass, working backwards through the archive in small chronological blocks. The current review frontier has reached **July 2020**. The 2021 historical block is fully reviewed month by month, and the controlled 2020 pass has now reached the start of the available master/estadillo history: no July-2020 records are present, while the first available 2020 orders are in August.

A second-pass cleanup of unresolved historical records is now in progress. August and December 2020 were re-inspected against the available XLSX contents, order folders and alternative-file search. The FECHA found in those files is the PEDIDO/header date and is not accepted as a differentiated delivery date. No PDF or alternative definitive version with a separate delivery FECHA was located. Those records therefore keep validated PVP/document provenance while both documentary-delivery fields stay blank. August 2020 has now been closed as a documented historical limitation with status `Cerrado histórico · sin fecha de entrega documental`; no synthetic delivery date is introduced.

October 2020 second-pass cleanup also recovered the previously orphaned 08/10/2020 ledger row as canonical order **7041**: `7041.xlsx` matches the concept (`junquillo de champagne`) and definitive base/SUMA of `0 €`. The header date `15/10/2020` is stored as `Fecha ficha`; no differentiated delivery date was found, so delivery-document fields remain blank while PVP is explicitly `0,00 €`.

October contains **23 canonical orders**, including the single recovered 7041 row. The earlier 22-order/ledger-only interpretation was superseded by that document recovery; do not delete 7041 or recreate the orphan row. The original accounting movement remains in the private ledger.

For each historical month the process closes the full chain:

1. inspect the linked XLS/XLSX itself and validate the internal four-digit work ID, document date and exact `SUMA`/amount;
2. compare those values with the private master and estadillo, correcting transcription errors, rounded historical bases and wrong document links only when the evidence is strong;
3. write the authoritative `Precio final (€)`, documentary date, reconciliation status and provenance back to the private master;
4. preserve unresolved cases as explicit conflicts or pending items instead of guessing;
5. add an M7 propagation guard for the reviewed month and require a successful sanitized-feed build and GitHub Pages deploy before considering the block closed.

The definitive document takes precedence over a rounded estadillo amount for PVP recovery. The working multiplier remains `base × 1.262` when the document contains a validated pre-tax base rather than a tax-inclusive total.

This second pass has already recovered/corrected cases such as wrong internal links, missing canonical IDs and historical PVP values that had been documented in notes but not materialized in `Precio final (€)`. See `BUSINESS_LOGIC.md` for the detailed precedence and conflict rules.

## Active handoff — audit and December 2020 block (2026-09-20)

- M6 incident corrected on 2026-09-21: scheduled bridge synchronization itself completed, but post-bridge parity repeatedly exited 2 after 116 successful document reads because `parity_v2.py` omitted the MIME type when downloading one native Google Sheet. The verifier now passes `file.mime_type`, matching the production synchronizer, and M6 code changes trigger a formula-aware read-only parity run.

- Current block: **SEP 2020**, 13 documents inspected by internal NUM, worksheet dates, SUMA and drawing/media inventory; only header dates, no alternative files in order folders or exact filename search. All PVP validated and preserved. Both documentary-delivery columns are cleared and exact historical-close status is required. Publication pending; next block after successful deployment: **AUG 2020 final verification**.

- Current block: **OCT 2020**, 23 documents inspected by internal NUM, worksheet dates, SUMA and drawing/media inventory; only header dates, no alternative files in order folders or filename search. All PVP validated and preserved. Both documentary-delivery columns are cleared and exact historical-close status is required. Publication pending; next block after successful deployment: **SEP 2020**.

- Current block: **NOV 2020**, 6 documents inspected by internal NUM, worksheet dates, SUMA and drawing/media inventory; only header dates, no alternative files in order folders or filename search. All PVP validated and preserved. Both documentary-delivery columns are cleared and exact historical-close status is required. Publication pending; next block after successful deployment: **OCT 2020**.

- Local `main` started clean at `07faad5`, 289 commits behind GitHub. It was advanced with `--ff-only` to `44fecc6`; no history rewrite, reset, clean or discarded working changes.
- Confirmed remote work: `a748446` recovered 7041; `abdf2c3` documented recovery; `d18acdb` closed August; `44fecc6` documented August. Baseline M7 build/deploy succeeded in run `35530612966` and its public feed was checked.
- Master audit: no duplicate four-digit work IDs; 7041 occurs once, PVP zero, both documentary-delivery dates blank. August has the exact nine historical-close statuses and materialized PVP, including 7003 = 372.06 and 7005 = 368.81. Do not reopen those nine limitations without new evidence.
- December: all 11 linked XLSX were downloaded and inspected for internal NUM, worksheet dates, SUMA and DrawingML. Every file has only a NUM/header date; 7043 and 7053 are explicitly titled HOJA DE PEDIDO. No separate delivery date or drawing date was found. Each of the 11 order folders contains only that XLSX; an accessible-Drive filename search found no alternative document for those IDs.
- December correction: remove header dates from `Fecha entrega documental` and `Fecha entrega albarán` for 7059, 7062, 7057, 7068, 7063, 7067, 7043, 7061 and 7053. 7060 and 7069 already had blanks. Retain all 11 validated `Precio final (€)` values and document links. All 11 use `Cerrado histórico · sin fecha de entrega documental`, with corrective provenance preserved in the private master. The date's agreement with the ledger is not independent delivery evidence.
- M7 December guards now require 11 exact IDs, unchanged PVP, blank delivery dates and exact historical-close status. The web distinguishes historical closure from a pending review. Business date rules have been reconciled in BUSINESS_LOGIC.md.
- **December block closed and published** by commit `2d42231`. M7 [run 35533089684](https://github.com/mamg97/litos-control-interno/actions/runs/35533089684) completed with both build and deploy successful. Public feed generated `2026-09-20T19:41:03.959029Z`: all 61 checked August–December master rows match; 7041 remains unique. The only changes versus the preceding public feed are documentary-delivery dates/statuses on the 11 December orders; prices, expenses and movements are unchanged. Local static build, all staged workflow guards and focused historical-close/pending-warning checks passed. Google Sheets and the deployed historical label were also checked in the browser.
- **Next block: November 2020 only**, six orders. Check the NUM/header-date provenance directly in the XLSX before relying on existing date guards. September/October guards currently match the feed, but that proves propagation, not independent date semantics. Do not redo 2021; its completed monthly review is retained.
- Other audit findings left unchanged: `Total sheet (€)` disagrees with AJ in some earlier corrected orders (including the August combined document and 7045); 7003 has a pre-existing `P.V.P. (€)` formula error. Neither auxiliary column supplies public `finalPrice`. Review those with their source documents in a separate bounded block. The drawing-date fallback also accepts dates from comments and selects the last date without a delivery label; it needs a separate parser review before broad historical automation is rerun.

Handoff protocol: after each single-month block, record evidence, changed fields, unresolved limitations, relevant commits, validation/deploy result and exactly one next block here. Read Git status/history and these MD files before writing. Keep private source contents and identifiers out of Git and Actions logs.

## Legacy Apps Script state

As of 2026-09-18:

- installed Apps Script triggers: retired;
- active Apps Script deployments: retired/archived;
- legacy Apps Script source has been removed from the public repository;
- the old Web App is archived and is not required by the dashboard.

Do not recreate or reactivate legacy Apps Script unless performing a deliberate, documented rollback.

## Public-repository privacy

This repository is public because the zero-cost architecture relies on public-repository GitHub Actions policy.

Therefore:

- never commit personal names for customers/contacts or the workshop owner;
- never commit email addresses, OAuth credentials, tokens or private document contents;
- keep OAuth credentials in repository secrets; keep the authorized sender and other real identities only in the hidden private Sheet configuration;
- use neutral role names in comments, docs and UI copy;
- public dashboard output must stay limited to the approved sanitized schema.

The public Git history was rewritten to a privacy-safe neutral baseline on 2026-09-18. Current and future commits must not add personal identifiers.

Any local clone created before that history rewrite must be re-synchronized or freshly cloned before it is allowed to push again. Do not merge or push an old local history back into the sanitized repository.
