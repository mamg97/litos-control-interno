# LITOS configuration registry

Updated: 2026-09-18

This file is the persistent inventory of non-code configuration required by production.

## 1. GitHub Actions secrets

| Secret | Purpose | Used by | Notes |
| --- | --- | --- | --- |
| `GOOGLE_OAUTH_USER_JSON` | Neutral Google OAuth for Drive/Sheets operations | M2 drafts, M5 folders, M6 albaranes, M7 public feed/pages and other non-Gmail flows | Private. Never print or commit its value. |
| `GOOGLE_OAUTH_CLIENT_JSON` | Dedicated OAuth with Gmail readonly + Drive + Sheets scopes for the primary-client intake | M3/M4 intake + handwriting cutover and M3 read-only intake | Private. Neutral replacement for the retired legacy-named intake OAuth secret. |
| `GEMINI_API_KEY` | Gemini API credential for handwriting extraction | M4 | Private. Keep zero-cost policy and model guardrails. |

### Retired secrets

The legacy-named intake OAuth secret and legacy-named authorized-sender secret were removed from GitHub Settings after the neutral intake verification succeeded.

Do not recreate legacy-named secrets.

## 2. GitHub Actions variables

Current production variables are kill switches / deployment controls only. Keep names neutral.

Known operational variables include:

| Variable | Purpose |
| --- | --- |
| `LITOS_HANDWRITING_KILL_SWITCH` | Disable scheduled M4 handwriting writes when true. |
| `LITOS_DRAFT_SYNC_KILL` | Optional M2 draft kill switch. If present and `true`, scheduled Draft Sync is disabled; if absent or `false`, it runs. Creating it explicitly as `false` is recommended for configuration clarity. |
| `LITOS_PUBLIC_FEED_KILL_SWITCH` | Disable bridged M7 publication when true. |
| `LITOS_ALBARAN_KILL_SWITCH` | Fail-closed control for bridged M6 albarán synchronization; production uses `false`. |
| `LITOS_ORGANIZE_KILL_SWITCH` | Fail-closed control for scheduled M5 folder organization; production uses `false`. |

The M3 primary-client intake kill switch no longer belongs in GitHub Variables. It lives in the private Sheet configuration as `intake_kill_switch`.

Any legacy variable whose name contains a real customer/client identifier is retired and must not be recreated.

## 3. Private master configuration

Private identity/configuration lives in the hidden Sheet tab:

`PEDIDOS M.S. → Configuracion privada`

Required keys currently include:

| Key | Purpose |
| --- | --- |
| `cliente_nombre` | Real customer/client name used in private invoice headers. |
| `cliente_direccion` | Private customer address. |
| `cliente_ciudad` | Private customer city. |
| `cliente_provincia` | Private customer province. |
| `intake_allowed_sender` | Authorized Gmail sender for M3. |
| `intake_kill_switch` | Private M3 emergency kill switch; `true` disables intake writes. |
| `issuer_company` | Workshop issuer name for private invoices. |
| `issuer_nif` | Workshop tax ID. |
| `issuer_address` | Workshop address. |
| `issuer_phone` | Workshop phone. |
| `issuer_city` | Workshop city. |
| `issuer_trade` | Workshop trade/activity text. |

The intake no longer depends on a client-identifying Gmail label.

## 4. Configuration rules

- Never commit real names, addresses, email addresses, OAuth JSON, refresh tokens, tax IDs or phone numbers.
- Public workflows may reference only neutral secret/variable names.
- If a secret/variable is renamed, update this file in the same change.
- If a private Sheet key is added/removed, update this file in the same change.
- GitHub Secrets are write-only from the UI; their values cannot be retrieved later.
- The public dashboard must never consume `Configuracion privada` directly.
