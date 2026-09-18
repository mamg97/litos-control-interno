# LITOS privacy status

Updated: 2026-09-18

## Objective

Keep the public repository useful and fully operational while ensuring that real people remain private.

Public code must identify roles, not individuals. The recurring external party is represented as the **primary client / client account**. The workshop proprietor is represented as the **workshop owner / issuer**.

## Completed hardening

- Public source uses neutral technical naming (`client`, `primary_client`, `python_client_intake`).
- Real client and issuer identity is loaded at runtime from the hidden private master configuration, not from Git.
- The authorized email sender is stored in the hidden private master configuration; M3 no longer depends on a client-identifying Gmail label.
- OAuth remains in GitHub Secrets and is never printed.
- Retired Apps Script source was removed from the public repository.
- Historical GitHub Actions runs and their artifacts/logs were cleared.
- `main` history was rewritten onto a privacy-safe production baseline.
- Public code search and active commit-history searches were checked after the rewrite.
- Repository currently has no forks.

## Business identity rule

The system may always refer to the recurring party as:

- primary client
- client account
- external account/customer
- private running account / estadillo

The system must never require a real personal name to identify that role in public source.

Private presentation data used in generated documents belongs only in the hidden `Configuracion privada` sheet.

## GitHub server-side residuals

A history rewrite removes sensitive commits from active branches and normal repository search, but GitHub may temporarily retain unreachable objects in cached views or pull-request refs.

The repository owner should request GitHub Support to purge cached views / affected pull-request references after a sensitive-data history rewrite.

At the time of this cleanup, historical pull requests created on the old history may require Support-side dereferencing.

## Local clone safety

**Do not merge or push from a clone created before the privacy rewrite.**

An old clone still contains the discarded history and can accidentally reintroduce it.

Preferred recovery:

1. Preserve only uncommitted working files that are genuinely needed.
2. Move/delete the old local repository clone.
3. Clone `main` again from GitHub.
4. Reconnect Codex/IDE to the fresh clone.

If an old clone must be retained for forensic/reference purposes, it must never be pushed to the public repository.

## Future rule

Any change that introduces a new private identifier must keep it in one of:

- hidden/private Google Sheets configuration;
- GitHub Secrets;
- another explicitly private store.

Never put personal names, addresses, tax IDs, phone numbers, email addresses or customer-identifying free text into public code, docs, commit messages, workflow names or Actions logs.
