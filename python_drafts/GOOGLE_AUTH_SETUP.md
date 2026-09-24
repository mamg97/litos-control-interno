# Google OAuth setup for LITOS Draft Sync

This document bootstraps the neutral Drive/Sheets credential used by non-Gmail LITOS components. M3/M4 use a separate Gmail-capable OAuth credential documented in `python_client_intake/bootstrap_google_oauth.py`.

## 1. Create a Google OAuth Desktop client

Create an OAuth 2.0 Client ID of type **Desktop app** in a Google Cloud project that has access to the Google Drive and Google Sheets APIs. Do not put the downloaded JSON in this repository.

## 2. Generate the authorized-user credential locally

From the repository root:

```bash
python -m pip install -r python_drafts/requirements.txt
python python_drafts/bootstrap_google_oauth.py /path/to/client_secret_....json
```

A browser window will ask you to authorize the same Google account that owns/uses the LITOS Drive and Sheet resources. The script writes `google_oauth_user.json` locally. That file is ignored by Git.

## 3. Add the GitHub Actions secret

In repository **mamg97/litos-control-interno**:

`Settings -> Secrets and variables -> Actions -> New repository secret`

Name:

`GOOGLE_OAUTH_USER_JSON`

Value: paste the **complete contents** of `google_oauth_user.json`.

Never commit this JSON or paste it into issues, pull requests, source files, or chat.

## 4. Validation and production state

The initial cutover validation has already been completed and `LITOS Draft Sync` is in production.

For credential re-bootstrap or troubleshooting, run the workflow manually in `dry-run` before any write-enabled execution. The dry-run must remain fail-closed and report no write operations.

The same `GOOGLE_OAUTH_USER_JSON` credential is the standard non-Gmail OAuth for M2, M5, M6, M7 and M8. Do not create client-named or legacy-named replacements for these components.


## Operational credential state · 2026-09-24

The historical repository secret `GOOGLE_OAUTH_USER_JSON` is currently revoked/expired and must not be used by production workflows.

Production non-Gmail workflows currently receive the still-valid `GOOGLE_OAUTH_CLIENT_JSON` secret through the runtime environment name `GOOGLE_OAUTH_USER_JSON`. That credential was originally authorized for Gmail + Drive + Sheets; the non-Gmail Python components still request only their own Drive/Sheets scopes and do not call Gmail.

This bridge avoids duplicated refresh-token failure points and restores M2/M5/M6/M7/M8 without exposing credential contents. If a least-privilege neutral Drive/Sheets credential is re-authorized later, it can replace the bridge after a dry-run validation.
