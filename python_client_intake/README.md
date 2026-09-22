# LITOS primary-client intake

M3 is the production Gmail intake for the workshop's **primary recurring client account**.

The client's real identity is deliberately absent from this public repository. Public code uses neutral roles such as `primary client`, `authorized sender` and `client account`.

## Production state

- Gmail is read with `gmail.readonly`.
- The authorized sender is read from the private `Configuracion privada` sheet; intake no longer depends on a client-identifying Gmail label.
- Drive and Sheets materialize order folders, attachments and master-sheet fields.
- Production M3 intake polls the authorized mailbox every 15 minutes at minute 02/17/32/47 Europe/Madrid. M4 handwriting remains on the lower-frequency 07:07/11:07/15:07/19:07 schedule. M3 is deliberately independent of the handwriting kill switch and Gemini credential so email intake cannot be blocked by M4.
- Public Actions logs must not print sender addresses, subjects, attachment names, Gmail IDs, Drive IDs or private message contents.

## Private authentication

The Gmail-capable OAuth credential is exposed to Python only as the neutral runtime variable `GOOGLE_OAUTH_CLIENT_JSON`.

Its value is private and must never be committed.

The real client identity, sender address and invoice-header identity live outside this public repository.

## Intake contract

- Process only the explicitly authorized sender from private configuration.
- Apply the runtime operating year and lookback window; production currently queries the authorized sender directly.
- Extract a four-digit order ID from subject or attachment names.
- Maintain one Drive order folder per order ID.
- Preserve existing materialization and fill only missing master data.
- Fail closed on missing or invalid private configuration.

See `BUSINESS_LOGIC.md`, `PROJECT_CONTEXT.md` and `AGENTS.md` for persistent project rules.


## Multi-order attachment batches

The four-digit work ID is the canonical routing key.

When one authorized email contains attachments for several work IDs, M3 partitions the message attachment by attachment and materializes each attachment only in the Drive folder whose name matches that work ID.

If several explicit work IDs exist in the same email, an attachment without an explicit ID is treated as ambiguous and is not guessed into any order. Subject-based routing is only a fallback for ordinary single-order emails whose attachments do not carry an explicit ID.


## Sent definitive-document archive

On production M3 cycles, the workshop Gmail Sent folder is also checked for attachments that carry an explicit four-digit work ID.

These sent attachments are routed only to an already-existing work ID and archived in that work's Drive folder. Sent-mail processing never creates a new order and never changes the original receipt date. It provides documentary traceability for definitive delivery documents; financial reconciliation remains governed by `BUSINESS_LOGIC.md`.
