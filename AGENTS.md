# AGENTS.md — LITOS persistent context

This repository is the persistent technical source of truth for LITOS.

Before changing production behavior, read:

1. `PROJECT_CONTEXT.md`
2. `BUSINESS_LOGIC.md`
3. `MIGRATION_STATUS.md`
4. `ZERO_COST_POLICY.md`

## Non-negotiable rules

- `PEDIDOS LITOS` is the private operational master; the public site is derived and sanitized.
- Do not infer business meaning from file names alone; validate internal order IDs.
- Historical enrichment is fill-only by default.
- `Precio final (€)` means final sale price with applicable taxes included.
- Keep write paths fail-closed behind write flags/kill switches.
- Never place personal names, postal addresses, private emails, OAuth material, refresh tokens, private document contents or identifying customer notes in this public repository or public Actions logs.
- Use neutral public roles: `workshop owner`, `authorized sender`, `client/external account`, `private running account`.
- Client legal identity must be read at runtime from the private master configuration, never hardcoded in public source.
- Apps Script is retired. Do not reintroduce it as a normal production path.
- Preserve the 0 € operating-cost policy.

## Handoff rule

When operational behavior or business logic changes, update the relevant Markdown file in the same change. Important knowledge must not live only in chat history.
