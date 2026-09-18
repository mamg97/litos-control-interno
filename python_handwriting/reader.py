from __future__ import annotations

import json
import os
import re
from collections import Counter
from dataclasses import dataclass

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

MASTER_ID = os.environ.get("LITOS_SPREADSHEET_ID", "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q")
REVIEW_SHEET = "Lecturas manuscritas"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

REQUIRED_HEADERS = (
    "Pedido",
    "Estado de revisión",
    "Confianza global (0-100)",
    "Evidencia y dudas",
    "Fuente de lectura",
    "Aplicado al maestro",
)


@dataclass
class Snapshot:
    headers: list[str]
    columns: dict[str, int]
    rows: list[list[str]]


def clean(value: object) -> str:
    return str("" if value is None else value).strip()


def build_services():
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_JSON is missing")
    info = json.loads(raw)
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    return (
        build("sheets", "v4", credentials=credentials, cache_discovery=False),
        build("drive", "v3", credentials=credentials, cache_discovery=False),
    )


def load_snapshot(sheets) -> Snapshot:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=f"'{REVIEW_SHEET}'!A:Y",
            valueRenderOption="FORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    values = response.get("values", [])
    if not values:
        return Snapshot(headers=[], columns={}, rows=[])

    headers = [clean(cell) for cell in values[0]]
    columns = {header: index for index, header in enumerate(headers) if header}
    missing = [header for header in REQUIRED_HEADERS if header not in columns]
    if missing:
        raise RuntimeError("Faltan columnas requeridas en Lecturas manuscritas: " + ", ".join(missing))
    return Snapshot(headers=headers, columns=columns, rows=[list(row) for row in values[1:]])


def value(snapshot: Snapshot, row: list[str], header: str) -> str:
    index = snapshot.columns[header]
    return clean(row[index]) if index < len(row) else ""


def status_bucket(raw: str) -> str:
    state = clean(raw).lower()
    if not state:
        return "empty"
    if "pendiente de lectura" in state:
        return "pending_read"
    if "error temporal" in state:
        return "temporary_error"
    if "leyendo" in state:
        return "reading"
    if "aplicado" in state:
        return "applied"
    if "revis" in state or "valid" in state or "duda" in state:
        return "manual_review"
    return "other"


def error_bucket(message: str) -> str:
    text = clean(message).lower()
    if not text:
        return "no_message"
    if "http 429" in text or "quota" in text or "resource_exhausted" in text:
        return "gemini_429_or_quota"
    if re.search(r"http 50[0-4]", text):
        return "gemini_5xx"
    if "gemini_api_key" in text or "falta la propiedad privada" in text:
        return "missing_gemini_key"
    if "modelo" in text and ("no encontrado" in text or "not found" in text or "404" in text):
        return "gemini_model_not_found"
    if "enlace de drive" in text or "drive válido" in text or "drive valido" in text:
        return "invalid_drive_link"
    if "formato" in text and "compatible" in text:
        return "unsupported_file_format"
    if "json" in text or "lectura estructurada" in text:
        return "structured_response_error"
    return "other"


def parse_confidence(raw: str) -> float | None:
    text = clean(raw).replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def build_read_only_report() -> dict:
    sheets, _drive = build_services()
    snapshot = load_snapshot(sheets)
    status_counts = Counter()
    error_counts = Counter()
    source_counts = Counter()
    confidences: list[float] = []
    valid_order_rows = 0
    applied_flag_true = 0

    for row in snapshot.rows:
        order_id = value(snapshot, row, "Pedido")
        if not order_id:
            continue
        valid_order_rows += 1
        bucket = status_bucket(value(snapshot, row, "Estado de revisión"))
        status_counts[bucket] += 1
        if bucket == "temporary_error":
            error_counts[error_bucket(value(snapshot, row, "Evidencia y dudas"))] += 1

        source = value(snapshot, row, "Fuente de lectura")
        if source:
            if source.lower().startswith("gemini"):
                source_counts["gemini"] += 1
            else:
                source_counts["other"] += 1

        confidence = parse_confidence(value(snapshot, row, "Confianza global (0-100)"))
        if confidence is not None:
            confidences.append(confidence)

        applied = value(snapshot, row, "Aplicado al maestro").lower()
        if applied in {"sí", "si", "true", "1", "yes"}:
            applied_flag_true += 1

    pending_or_error = status_counts["pending_read"] + status_counts["temporary_error"]
    return {
        "phase": "M4",
        "mode": "HANDWRITING_READ_ONLY_DISCOVERY",
        "review_rows": valid_order_rows,
        "status_counts": dict(sorted(status_counts.items())),
        "error_categories": dict(sorted(error_counts.items())),
        "source_categories": dict(sorted(source_counts.items())),
        "confidence_values": len(confidences),
        "confidence_min": min(confidences) if confidences else None,
        "confidence_max": max(confidences) if confidences else None,
        "applied_flag_true": applied_flag_true,
        "pending_or_error": pending_or_error,
        "write_operations": 0,
    }
