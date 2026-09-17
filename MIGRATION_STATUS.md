# LITOS migration status

Updated: 2026-09-17

## Goal

Retire Google Apps Script as an operational dependency while preserving the private Google Drive / Sheets / Gmail workflow, the public GitHub Pages dashboard, and the zero-cost policy.

## Current state

| Area | Replacement | Status | Exit condition |
| --- | --- | --- | --- |
| M2 · Draft invoices | Python + GitHub Actions (`draft-sync.yml`) | Certified in scheduled production | Keep monitoring normal scheduled runs |
| M3 · Saban Gmail intake | Python + GitHub Actions (`saban-handwriting-cutover.yml`) | Certified in scheduled production | Keep kill switch available |
| M4 · Handwriting | Python + GitHub Actions (`saban-handwriting-cutover.yml`) | Certified in scheduled production | Keep kill switch available |
| M5 · Organize order folders | Python + GitHub Actions (`organize-folders.yml`) | Migrated and manually converged; scheduled certification pending | Observe first successful real `schedule` run at 02:17 Europe/Madrid, then remove the last Apps Script organization continuation trigger |
| M6 · Albaranes sync | Python + GitHub Actions (`albaranes-cutover.yml`) | Manual parity and production sync certified; scheduler bridge prepared from certified `LITOS Draft Sync` runs | Observe first successful bridged `workflow_run` and verify post-run parity |
| M7 · Public feed / Pages | Python feed + GitHub Pages (`pages-cutover.yml`) | Manual parity and deploy certified; scheduler bridge prepared from certified `LITOS Draft Sync` runs | Observe first successful bridged Pages deployment, then merge the static-only runtime and retire `Code.gs` after validation |
| M8 · Curated operational catalog | Read-only Python audit (`catalog-parity.yml`) | Protected and audited | Keep `Catálogo operativo` as the manually curated source of truth; do not auto-rebuild it |

## Scheduler bridge

The native `schedule` triggers newly added to M6 and M7 did not produce observable runs even though older repository schedules continued to work. To avoid leaving the migration blocked on scheduler registration, M6 and M7 now use the already-certified `LITOS Draft Sync` schedule as their clock.

A completed `LITOS Draft Sync` run can activate the bridge only when all of the following are true:

- the upstream event was `schedule`, not `push`, `pull_request` or manual dispatch;
- the upstream conclusion is `success`;
- the upstream branch is `main`;
- the component-specific kill switch is explicitly `false`.

M6 performs a guarded full sync and then formula-aware parity. M7 builds and deploys the sanitized Pages artifact. The old independent M6/M7 cron entries are removed to avoid duplicate writes/deployments if GitHub later re-registers them.

## Catalog decision

`Catálogo operativo` is a curated production dictionary, not a generated mirror of historical invoice lines. It must not be overwritten by the historical catalog builder.

The two Apps Script invoice-catalog scanners are bootstrap / maintenance jobs started explicitly by `iniciarCatalogoAlbaranesHistorico()` and `iniciarCatalogoAlbaranesReciente()`. Their time-based triggers are only one-minute continuations created while an explicitly started scan is incomplete; there is no recurring daily/hourly installer in those files. Their disabled continuation triggers have therefore been retired rather than ported as production schedules.

## Remaining Apps Script retirement gates

1. Certify M5's first real scheduled run and remove `continuarOrganizacionArchivos`.
2. Certify M6's first bridged production run from a successful scheduled `LITOS Draft Sync` run.
3. Certify M7's first bridged GitHub Pages deployment from a successful scheduled `LITOS Draft Sync` run.
4. Merge and deploy the prepared M7 static-only runtime; verify the public dashboard reads only `data/feed.json`.
5. Audit for any external consumers of the Apps Script web-app URL.
6. Retire the Apps Script web app and finally the Apps Script project only after all previous gates are green.

## Safety rules

- Do not place OAuth JSON, refresh tokens, private Drive links, or private business data in the public repository or Actions logs.
- Keep all production write paths fail-closed behind explicit write flags / kill switches.
- `workflow_run` bridges must remain restricted to successful scheduled runs from `main`; never broaden them to arbitrary upstream PR or push runs because downstream workflows have production credentials.
- Public feed output stays restricted to the sanctioned sanitized fields.
- Do not reintroduce paid infrastructure; `ZERO_COST_POLICY.md` remains authoritative.

## Repository cleanup policy

One-shot historical patch workflows should be removed once their changes are already present in `main`. Diagnostic/parity workflows may remain until the component they protect has completed its final cutover, then can be removed or archived in a later cleanup PR.
