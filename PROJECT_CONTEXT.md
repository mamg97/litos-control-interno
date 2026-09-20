# LITOS project context

Updated: 2026-09-18

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

Historical work is undergoing a second controlled reconciliation pass, working backwards through the archive in small chronological blocks. The current review frontier has reached **November 2020**. The 2021 historical block is fully reviewed month by month, and the same controlled pass is now progressing through 2020.

For each historical month the process closes the full chain:

1. inspect the linked XLS/XLSX itself and validate the internal four-digit work ID, document date and exact `SUMA`/amount;
2. compare those values with the private master and estadillo, correcting transcription errors, rounded historical bases and wrong document links only when the evidence is strong;
3. write the authoritative `Precio final (€)`, documentary date, reconciliation status and provenance back to the private master;
4. preserve unresolved cases as explicit conflicts or pending items instead of guessing;
5. add an M7 propagation guard for the reviewed month and require a successful sanitized-feed build and GitHub Pages deploy before considering the block closed.

The definitive document takes precedence over a rounded estadillo amount for PVP recovery. The working multiplier remains `base × 1.262` when the document contains a validated pre-tax base rather than a tax-inclusive total.

This second pass has already recovered/corrected cases such as wrong internal links, missing canonical IDs and historical PVP values that had been documented in notes but not materialized in `Precio final (€)`. See `BUSINESS_LOGIC.md` for the detailed precedence and conflict rules.

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
