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

## Historical reconciliation completed

Historical work was enriched from archived XLS/XLSX files and private accounting/ledger data.

Key safeguards used:

- validate the order number inside the workbook, not only the file/folder name;
- reject or annotate impossible dates;
- fill missing master fields without blindly overwriting existing authoritative values;
- preserve ambiguous cases for review;
- record reconciliation provenance in the master.

Historical PVP reconciliation was also completed. See `BUSINESS_LOGIC.md` for price semantics and precedence.

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
- use repository secrets for authorized sender and OAuth credentials;
- use neutral role names in comments, docs and UI copy;
- public dashboard output must stay limited to the approved sanitized schema.

The public Git history was rewritten to a privacy-safe neutral baseline on 2026-09-18. Current and future commits must not add personal identifiers.

Any local clone created before that history rewrite must be re-synchronized or freshly cloned before it is allowed to push again. Do not merge or push an old local history back into the sanitized repository.
