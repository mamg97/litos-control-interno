# LITOS Saban intake — Python migration

M3 migrates the current Apps Script Gmail intake (`ImportarSaban.gs`) to Python/GitHub Actions.

Current state: **read-only discovery only**.

- Gmail is read with `gmail.readonly`.
- Drive and Sheets are inspected to reconstruct whether each recent Saban message is already materialized.
- No Gmail message contents, supplier addresses, subjects, attachment names, Drive IDs or Gmail IDs are printed to public GitHub Actions logs.
- No schedule or production sync exists yet.
- The current Apps Script triggers remain active until an explicit later cutover.

## Dedicated OAuth

Use the same Google Cloud project and Desktop OAuth client already created for LITOS, but generate a separate credential for this component:

```bash
python python_saban/bootstrap_google_oauth.py /path/to/client_secret.json
```

The output `google_oauth_saban.json` must be stored as the repository Actions secret `GOOGLE_OAUTH_SABAN_JSON` and must never be committed.

The authorized sender is stored separately as the repository Actions secret `SABAN_ALLOWED_SENDER`. The address itself must never be committed.

## Dry-run contract

The dry-run reproduces the relevant Apps Script rules for the last 30 days:

- Gmail label `saban` and the explicitly authorized sender.
- Year 2026.
- Four-digit order ID extracted from subject or attachment names.
- One order folder per order ID.
- Existing attachment names are used to infer whether a message was already materialized by Apps Script.
- Required master-sheet intake fields are checked without modifying them.

The output intentionally contains aggregate counts only.
