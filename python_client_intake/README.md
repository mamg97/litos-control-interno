# LITOS primary-client intake

M3 is the production Gmail intake for the workshop's **primary recurring client account**.

The client's real identity is deliberately absent from this public repository. Public code uses neutral roles such as `primary client`, `authorized sender` and `client account`.

## Production state

- Gmail is read with `gmail.readonly`.
- The authorized sender and Gmail label are read from the private `Configuracion privada` sheet.
- Drive and Sheets materialize order folders, attachments and master-sheet fields.
- Production execution is scheduled together with M4 handwriting processing.
- Public Actions logs must not print sender addresses, subjects, attachment names, Gmail IDs, Drive IDs or private message contents.

## Private authentication

The Gmail-capable OAuth credential is exposed to Python only as the neutral runtime variable `GOOGLE_OAUTH_CLIENT_JSON`.

Its value is private and must never be committed.

The real client identity, sender address, Gmail label and invoice-header identity live outside this public repository.

## Intake contract

- Process only the explicitly authorized sender from private configuration.
- Use the private Gmail label from configuration.
- Apply the configured operating year and lookback window.
- Extract a four-digit order ID from subject or attachment names.
- Maintain one Drive order folder per order ID.
- Preserve existing materialization and fill only missing master data.
- Fail closed on missing or invalid private configuration.

See `BUSINESS_LOGIC.md`, `PROJECT_CONTEXT.md` and `AGENTS.md` for persistent project rules.
