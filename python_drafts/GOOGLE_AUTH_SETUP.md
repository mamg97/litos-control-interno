# Google OAuth setup for LITOS Draft Sync

This is the only manual credential bootstrap required for the GitHub Actions cutover.

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

## 4. First autonomous validation

Run the workflow **LITOS Draft Sync** manually with mode `dry-run`.

Expected safety state:

- `LITOS_FREE_ONLY=true`
- `LITOS_KILL_SWITCH=true`
- `LITOS_WRITE_ENABLED=false`
- `write_operations=0`
- planner result consistent with the certified Colab validation

Only after the dry-run is independently verified should the workflow gain a production `sync` mode and schedule.
