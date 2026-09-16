from __future__ import annotations

from dataclasses import dataclass

import google.auth
from googleapiclient.discovery import build

FULL_SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]


@dataclass
class Services:
    drive: object
    sheets: object


def build_user_services() -> Services:
    """Build Google services from Application Default Credentials.

    In GitHub Actions these credentials are created ephemerally by
    google-github-actions/auth using Workload Identity Federation (OIDC).
    No long-lived Google credential is stored in the repository.
    """
    credentials, _ = google.auth.default(scopes=FULL_SCOPES)
    return Services(
        drive=build("drive", "v3", credentials=credentials, cache_discovery=False),
        sheets=build("sheets", "v4", credentials=credentials, cache_discovery=False),
    )
