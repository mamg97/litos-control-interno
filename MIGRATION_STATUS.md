# LITOS migration status

Updated: 2026-09-17

## Goal

Retire Google Apps Script as an operational dependency while preserving the private Google Drive / Sheets / Gmail workflow, the public GitHub Pages dashboard, and the zero-cost policy.

## Current state

| Area | Replacement | Status | Exit condition |
| --- | --- | --- | --- |
| M2 · Draft invoices | Python + GitHub Actions (`draft-sync.yml`) | Production path certified; central schedule re-registration under observation | Observe a fresh post-re-registration `schedule` run |
| M3 · Saban Gmail intake | Python + GitHub Actions (`saban-handwriting-cutover.yml`) | Certified in scheduled production | Keep kill switch available |
| M4 · Handwriting | Python + GitHub Actions (`saban-handwriting-cutover.yml`) | Certified in scheduled production | Keep kill switch available |
| M5 · Organize order folders | Python + GitHub Actions (`organize-folders.yml`) | Migrated and manually converged; scheduled certification pending | Observe first successful real `schedule` run at 02:17 Europe/Madrid, then remove `continuarOrganizacionArchivos` |
| M6 · Albaranes sync | Python + GitHub Actions (`albaranes-cutover.yml`) | Bridge execution certified: production sync no-op and formula-aware parity green | Observe the same bridge from a fresh automatic Draft Sync schedule |
| M7 · Public feed / Pages | Python feed + GitHub Pages (`pages-cutover.yml`) | Bridge certified and static-only Pages runtime deployed | Observe the same bridge from a fresh automatic Draft Sync schedule; Apps Script web app is no longer a dashboard runtime dependency |
| M8 · Curated operational catalog | Read-only Python audit (`catalog-parity.yml`) | Protected and audited | Keep `Catálogo operativo` as the manually curated source of truth; do not auto-rebuild it |

## Scheduler bridge

M6 and M7 use successful scheduled `LITOS Draft Sync` executions as their central clock via `workflow_run`. The bridge is restricted to upstream runs whose event is `schedule`, conclusion is `success`, and branch is `main`; each component also remains behind its own kill switch.

The bridge mechanics have been production-certified by re-running a previously successful scheduled Draft Sync execution:

- M6 run `35265029624`: guarded production sync completed with `candidate_rows_before_sync=0`, `rows_written=0`, `write_operations=0`; post-run parity passed with 0 invoice-link mismatches, 0 draft-link mismatches, 0 total mismatches and 0 parse errors.
- M7 run `35265029652`: Pages build, artifact upload and deployment all completed successfully.
- Static-only M7 run `35265389013`: the deployed artifact was rebuilt after removing the Apps Script fallback; build and GitHub Pages deployment completed successfully. The uploaded artifact contains `data/feed.json` with 932 records and 241 expenses and contains no `script.google.com` URL or `LEGACY_DATA_FEED_URL` runtime constant.

A separate issue remains: after 19:09 local time no new native Draft Sync `schedule` events were observed despite multiple expected slots. The central Draft Sync cron was therefore re-registered at `:05/:20/:35/:50`. Automatic scheduling is not considered recovered until a new schedule event appears after that change.

## Catalog decision

`Catálogo operativo` is a curated production dictionary, not a generated mirror of historical invoice lines. It must not be overwritten by the historical catalog builder.

The two Apps Script invoice-catalog scanners are bootstrap / maintenance jobs started explicitly by `iniciarCatalogoAlbaranesHistorico()` and `iniciarCatalogoAlbaranesReciente()`. Their time-based triggers are only one-minute continuations created while an explicitly started scan is incomplete; there is no recurring daily/hourly installer in those files. Their disabled continuation triggers have therefore been retired rather than ported as production schedules.

## External dependency audit

Repository and Drive searches found no external Google Drive document referencing the deployed Apps Script URL or deployment ID. A one-off repository audit also found no Apps Script runtime APIs outside `apps-script/`. This reduces retirement risk but cannot prove the absence of browser bookmarks or consumers outside the connected Drive.

## Remaining Apps Script retirement gates

1. Confirm a fresh automatic Draft Sync schedule after the cron re-registration and verify it automatically bridges M6 and M7.
2. Certify M5's first real scheduled run and remove `continuarOrganizacionArchivos`.
3. Retire/undeploy the Apps Script web app now that M7 production is static-only; keep the project itself until M5 is certified and the final trigger is removed.
4. Remove/archive residual legacy Apps Script source, parity and deployment documentation only after the operational project is fully retired.

## Safety rules

- Do not place OAuth JSON, refresh tokens, private Drive links, or private business data in the public repository or Actions logs.
- Keep all production write paths fail-closed behind explicit write flags / kill switches.
- `workflow_run` bridges must remain restricted to successful scheduled runs from `main`; never broaden them to arbitrary upstream PR or push runs because downstream workflows have production credentials.
- Public feed output stays restricted to the sanctioned sanitized fields.
- Do not reintroduce paid infrastructure; `ZERO_COST_POLICY.md` remains authoritative.

## Repository cleanup policy

One-shot historical patch workflows should be removed once their changes are already present in `main`. Diagnostic/parity workflows may remain until the component they protect has completed its final cutover, then can be removed or archived in a later cleanup PR.
