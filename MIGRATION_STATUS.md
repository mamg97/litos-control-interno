# LITOS migration status

Updated: 2026-09-19

## Status

**Migration closed. Production is now Python + GitHub Actions + Google Drive/Sheets/Gmail + GitHub Pages.**

Google Apps Script is retained only as historical rollback/reference source and is not an operational dependency.

## Final component state

| Area | Replacement | Final state |
| --- | --- | --- |
| M2 · Draft invoices | Python + GitHub Actions | Production certified; corporate A4 style active for current/future drafts |
| M3 · Authorized Gmail intake | Python + GitHub Actions | Scheduled production certified |
| M4 · Handwriting | Python + GitHub Actions | Scheduled production certified |
| M5 · Organize order folders | Python + GitHub Actions | Scheduled production certified; post-run discovery converged to 0 candidate moves / 0 folders to create |
| M6 · Albaranes sync | Python + GitHub Actions | Production/bridge certified |
| M7 · Public feed / Pages | Python feed + GitHub Pages | Static-only runtime deployed; no Apps Script runtime dependency |
| M8 · Curated operational catalog | Read-only/protected automation | Keep curated source protected; do not auto-rebuild |

## Migration closure evidence

- Draft corporate-style rollout completed and coverage audited.
- Historical master enrichment completed with internal-order validation and conflict annotation.
- Historical delivery-date repair completed in phased annual cleanup (2026→2020): false order-header dates removed, note/albarán classification separated, and only differentiated validated delivery dates retained.
- Historical PVP backfill completed using the precedence documented in `BUSINESS_LOGIC.md`.
- M5 scheduled organizer completed with no remaining candidate moves.
- M6 production synchronization and bridge executions completed successfully.
- M7 sanitized feed build and GitHub Pages deployment completed successfully.
- The obsolete Apps Script feed-parity path was retired; the auxiliary M7 workflow now audits the current sanitized static feed only.
- Apps Script installed triggers were retired.
- Apps Script active deployments were archived/retired.
- The public dashboard no longer calls `script.google.com`.

## Operational architecture

See `PROJECT_CONTEXT.md`.

## Business semantics

See `BUSINESS_LOGIC.md`.

## Legacy Apps Script policy

Legacy Apps Script source has been removed from the public repository. The sanitized public Git history must not be used to recover pre-migration Apps Script. Any rollback source must come from an explicitly privacy-reviewed private backup.

Do not:

- reinstall legacy triggers;
- redeploy the legacy public Web App;
- use Apps Script as the normal path for Gmail intake, drafts, organization, albaranes or dashboard data.

A rollback to Apps Script requires a deliberate documented decision.

## Safety and privacy

- Repository is public.
- Do not commit personal/customer names, private emails, OAuth JSON, refresh tokens, private Drive document contents or customer-identifying notes.
- Use neutral public vocabulary and GitHub Secrets for private identifiers.
- Keep all production write paths fail-closed.
- Keep `ZERO_COST_POLICY.md` authoritative.
