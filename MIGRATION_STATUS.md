# LITOS migration status

Updated: 2026-09-18

## Status

**Migration closed. Production is Python + GitHub Actions + Google Drive/Sheets/Gmail + GitHub Pages.**

Google Apps Script has been retired from production. Installed triggers and active deployments were removed/archived, and the legacy Apps Script source was removed from the public repository during privacy hardening.

## Final component state

| Area | Replacement | Final state |
| --- | --- | --- |
| M2 · Draft invoices | Python + GitHub Actions | Production certified; corporate A4 style active |
| M3 · Authorized client Gmail intake | Python + GitHub Actions | Scheduled production certified |
| M4 · Handwriting | Python + GitHub Actions | Scheduled production certified |
| M5 · Organize order folders | Python + GitHub Actions | Scheduled production certified; 0 remaining candidate moves |
| M6 · Albaranes sync | Python + GitHub Actions | Production/bridge certified |
| M7 · Public feed / Pages | Python feed + GitHub Pages | Static-only runtime deployed |
| M8 · Curated operational catalog | Read-only/protected automation | Protected curated source |

## Closure evidence

- Corporate draft rollout and coverage audit completed.
- Historical master enrichment completed with internal-order validation and conflict annotation.
- Historical PVP reconciliation completed using `BUSINESS_LOGIC.md`.
- M5 scheduled organizer converged to no pending moves/folders.
- M6 bridge and production synchronization certified.
- M7 feed parity and GitHub Pages deployment certified.
- Apps Script triggers removed.
- Apps Script deployments archived.
- Public dashboard has no Apps Script runtime dependency.

## Privacy hardening

The public repository uses neutral vocabulary only.

- Real client identity and address are stored privately in the master Sheet configuration, not in GitHub.
- Authorized sender and OAuth credentials live only in GitHub Secrets.
- Public source/workflow names use `client`, `authorized sender` and `private running account`.
- Retired Apps Script source is no longer stored in this public repository.
- Historical Git history must also be sanitized before the privacy-hardening task is considered fully closed.

## Safety

- Repository is public.
- Never commit personal names, addresses, private emails, OAuth JSON, refresh tokens or private document contents.
- Keep production writes fail-closed.
- Keep `ZERO_COST_POLICY.md` authoritative.
