from __future__ import annotations

import json
import os
from dataclasses import dataclass

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

CLIENT_INTAKE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]


@dataclass
class ClientIntakeServices:
    gmail: object
    drive: object
    sheets: object


def _authorized_user_info() -> dict:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_JSON is missing")
    info = json.loads(raw)
    if info.get("type") not in {None, "authorized_user"}:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_JSON must contain authorized-user OAuth credentials")
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not str(info.get(key, "")).strip())
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_JSON missing fields: " + ", ".join(missing))
    return info


def build_client_services() -> ClientIntakeServices:
    """Build Gmail/Drive/Sheets clients from the dedicated primary-client intake OAuth credential."""
    info = _authorized_user_info()
    credentials = Credentials.from_authorized_user_info(info, scopes=CLIENT_INTAKE_SCOPES)
    return ClientIntakeServices(
        gmail=build("gmail", "v1", credentials=credentials, cache_discovery=False),
        drive=build("drive", "v3", credentials=credentials, cache_discovery=False),
        sheets=build("sheets", "v4", credentials=credentials, cache_discovery=False),
    )
