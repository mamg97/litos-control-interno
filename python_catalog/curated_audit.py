from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from collections import Counter
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

MASTER_ID = os.environ.get(
    "LITOS_SPREADSHEET_ID",
    "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q",
)
SHEET = "Catálogo operativo"
EXPECTED_HEADERS = [
    "Ítem canónico",
    "Variante / detalle",
    "Categoría",
    "Unidad",
    "Material / condición",
    "Precio actual PROVISIONAL (€) · REVISAR",
    "Validado por padre",
    "Nº apariciones",
    "Precio histórico reciente",
    "Rango histórico depurado",
    "Pedidos ejemplo",
    "Regla de generación",
    "Observaciones",
]


def clean(value: Any) -> str:
    return str("" if value is None else value).strip()


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", clean(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", text.lower()).strip()


def build_service():
    raw = os.environ.get("GOOGLE_OAUTH_USER_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_USER_JSON is missing")
    info = json.loads(raw)
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not clean(info.get(key)))
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_USER_JSON missing fields: " + ", ".join(missing))
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def read_catalog(sheets) -> list[list[Any]]:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=f"'{SHEET}'!A1:M1000",
            valueRenderOption="UNFORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    return response.get("values", []) or []


def preflight() -> dict[str, Any]:
    return {
        "mode": "M8_CURATED_CATALOG_READ_ONLY_AUDIT",
        "sheet": SHEET,
        "range": "A1:M1000",
        "source_of_truth": "curated_live_sheet",
        "rebuild_from_raw": False,
        "write_operations": 0,
    }


def audit(values: list[list[Any]]) -> dict[str, Any]:
    if not values:
        raise RuntimeError("Catálogo operativo is empty")

    headers = [clean(x) for x in values[0][:13]]
    if headers != EXPECTED_HEADERS:
        raise RuntimeError("Curated catalog header contract changed")

    rows = []
    for raw in values[1:]:
        padded = list(raw) + [""] * (13 - len(raw))
        row = padded[:13]
        if any(clean(cell) for cell in row):
            rows.append(row)

    if not rows:
        raise RuntimeError("Curated catalog has no operational rows")
    if len(rows) > 500:
        raise RuntimeError(f"Curated catalog sanity cap exceeded: {len(rows)} > 500")

    missing_canonical = 0
    missing_unit = 0
    invalid_price = 0
    invalid_validated = 0
    priced = 0
    unpriced = 0
    validated = 0
    keys: list[str] = []

    for row in rows:
        canonical = clean(row[0])
        variant = clean(row[1])
        unit = clean(row[3])
        material = clean(row[4])
        price = row[5]
        validated_value = row[6]

        if not canonical:
            missing_canonical += 1
        if not unit:
            missing_unit += 1

        if price in (None, ""):
            unpriced += 1
        elif isinstance(price, bool) or not isinstance(price, (int, float)):
            invalid_price += 1
        else:
            priced += 1

        if isinstance(validated_value, bool):
            if validated_value:
                validated += 1
        elif validated_value not in (None, ""):
            invalid_validated += 1

        if canonical:
            keys.append("|".join(map(normalize, [canonical, variant, unit, material])))

    duplicate_keys = sum(count - 1 for count in Counter(keys).values() if count > 1)

    summary = {
        "mode": "M8_CURATED_CATALOG_READ_ONLY_AUDIT",
        "source_of_truth": "curated_live_sheet",
        "rows": len(rows),
        "priced_rows": priced,
        "unpriced_rows": unpriced,
        "validated_rows": validated,
        "duplicate_keys": duplicate_keys,
        "missing_canonical": missing_canonical,
        "missing_unit": missing_unit,
        "invalid_price_cells": invalid_price,
        "invalid_validated_cells": invalid_validated,
        "write_operations": 0,
    }

    blockers = {
        "duplicate_keys": duplicate_keys,
        "missing_canonical": missing_canonical,
        "missing_unit": missing_unit,
        "invalid_price_cells": invalid_price,
        "invalid_validated_cells": invalid_validated,
    }
    if any(blockers.values()):
        print("M8_CURATED_CATALOG_AUDIT_BLOCKED")
        print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
        raise SystemExit(1)

    print("M8_CURATED_CATALOG_AUDIT_OK")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--audit", action="store_true")
    args = parser.parse_args()

    if args.preflight:
        print("M8_CURATED_CATALOG_PREFLIGHT_OK")
        print(json.dumps(preflight(), ensure_ascii=False, sort_keys=True))
        return 0
    if args.audit:
        audit(read_catalog(build_service()))
        return 0
    raise SystemExit("Use --preflight or --audit")


if __name__ == "__main__":
    raise SystemExit(main())
