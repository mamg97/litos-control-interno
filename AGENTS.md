# AGENTS.md — LITOS persistent context

This repository is the persistent technical source of truth for LITOS.

Before changing production behavior, read these files in order:

1. `PROJECT_CONTEXT.md` — current architecture, schedules and component ownership.
2. `BUSINESS_LOGIC.md` — business semantics and data precedence rules.
3. `MIGRATION_STATUS.md` — migration closure and residual legacy policy.
4. `CONFIGURATION.md` — GitHub Secrets/Variables and private Sheet configuration registry.\n5. `PRIVACY_STATUS.md` — public-repository privacy and clone-safety rules.\n6. `ZERO_COST_POLICY.md` — mandatory zero-cost constraint.

## Non-negotiable rules

- `PEDIDOS M.S.` is the private operational master. The public site is a derived, sanitized view.
- Do not infer business meaning from file names alone. Historical XLS/XLSX files can be misnamed; validate the internal order ID.
- Never overwrite authoritative non-empty master cells during historical enrichment unless a migration rule explicitly says otherwise.
- `Precio final (€)` means final public sale price, taxes included.
- Keep production write paths fail-closed behind write flags / kill switches.
- Do not put personal names, private email addresses, OAuth data, refresh tokens, private document contents or customer-identifying notes in this public repository or public Actions logs.
- Use neutral roles in public code/docs: `workshop owner`, `authorized sender`, `external account/customer`, `private running account`.
- Legacy Apps Script code is archive/reference only. Do not reinstall Apps Script triggers or redeploy the old Web App without a deliberate rollback decision.
- Preserve the 0 € operating-cost policy.

## Handoff rule

When a migration, reconciliation or business-rule change is completed, update the relevant Markdown file in the same change. Do not leave important operational logic only in chat history.
