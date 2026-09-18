from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the authorized-user OAuth JSON used by LITOS GitHub Actions.")
    parser.add_argument("client_secret_json", help="Path to the OAuth Desktop client JSON downloaded from Google Cloud")
    parser.add_argument("--out", default="google_oauth_user.json", help="Output credential file; never commit this file")
    args = parser.parse_args()

    client_path = Path(args.client_secret_json).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not client_path.exists():
        raise SystemExit(f"Client JSON not found: {client_path}")

    flow = InstalledAppFlow.from_client_secrets_file(str(client_path), SCOPES)
    credentials = flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
        authorization_prompt_message="Open this URL in your browser to authorize LITOS:\n{url}",
        success_message="LITOS authorization completed. You can close this browser tab.",
    )
    if not credentials.refresh_token:
        raise SystemExit("Google did not return a refresh token. Revoke the app grant and retry with prompt=consent.")

    payload = json.loads(credentials.to_json())
    payload["type"] = "authorized_user"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(out_path, 0o600)
    except OSError:
        pass

    print(f"Credential created: {out_path}")
    print("Do NOT commit this file. Store its full contents as the GitHub Actions secret GOOGLE_OAUTH_USER_JSON.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
