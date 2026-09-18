# LITOS client intake

M3 is the production Gmail intake for the recurring external client/account.

## Production state

- Scheduled production is active through GitHub Actions.
- Gmail is read with `gmail.readonly`.
- Drive/Sheets writes are guarded and fail-closed.
- The authorized sender address is stored only in the private GitHub secret `CLIENT_ALLOWED_SENDER`.
- The OAuth credential is stored only in `GOOGLE_OAUTH_WORKSHOP_JSON`.
- No client-identifying Gmail label is required by the production query.
- No Gmail message contents, sender address, subjects, attachment names, Drive IDs or Gmail IDs are printed to public Actions logs.

## OAuth

The workshop OAuth credential must include Gmail read-only, Drive and Sheets scopes.

```bash
python python_client_intake/bootstrap_google_oauth.py /path/to/client_secret.json
```

The generated authorized-user JSON belongs only in the GitHub Actions secret `GOOGLE_OAUTH_WORKSHOP_JSON`.

## Intake contract

For the configured lookback window:

- only the explicitly authorized sender is accepted;
- four-digit order IDs are extracted from subject or attachment names;
- each order maps to its private Drive folder;
- attachments are materialized idempotently;
- existing authoritative master fields are never overwritten blindly;
- ambiguous or incomplete handwriting is routed through the protected review flow.

Public logs expose aggregate counters only.
