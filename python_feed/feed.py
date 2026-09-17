from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import urllib.request
from datetime import datetime, timezone
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

MASTER_ID = os.environ.get(
    "LITOS_SPREADSHEET_ID",
    "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q",
)
PEDIDOS_SHEET = "Pedidos"
GASTOS_SHEET = "Gastos"
LEGACY_FEED_URL = os.environ.get(
    "LITOS_LEGACY_FEED_URL",
    "https://script.google.com/macros/s/AKfycbyhzZOwkeSuBLskOnjtPNUs1yElq6dcNb4UXmNAA0Bp38qBfFX7DEPi8rNkuOPnT4DlHw/exec",
)

FIELDS = {
    "id": "Pedido",
    "date": "Fecha para dashboard",
    "orderDate": "Fecha ficha",
    "receiptDate": "Fecha recepción (email)",
    "deliveredDate": "Fecha entrega (estadillo)",
    "amount": "Importe trabajo / Debe (€)",
    "finalPrice": "Precio final (€)",
    "materialCost": "Coste material est. (€)",
    "status": "Estado pedido",
    "model": "Modelo",
    "material": "Material",
    "materialNormalized": "Material normalizado",
    "width": "Ancho total (cm)",
    "height": "Alto total (cm)",
    "thickness": "Grosor (cm)",
    "baseWidth": "Ancho base (cm)",
    "baseHeight": "Alto base/croquis (cm)",
    "topWidth": "Ancho superior/remate (cm)",
    "stepMeasures": "Cotas/escalones (cm)",
    "voleo": "Voleo (cm)",
}

EXPENSE_FIELDS = {
    "month": "Mes",
    "category": "Categoría",
    "amount": "Importe (€)",
    "nature": "Naturaleza del dato",
}

DOCUMENT_FIELDS = {
    "invoiceFile": "Archivo factura / albarán (XLSX)",
    "invoiceDraftFile": "Factura borrador (XLSX)",
    "corelFile": "Archivo Corel (CDR)",
    "noteFile": "Notas",
    "attachmentFile": "Imágenes anejas",
}


def clean(value: Any) -> str:
    return str("" if value is None else value).strip()


def number_or_none(value: Any) -> float | int | None:
    raw = clean(value)
    if not raw:
        return None
    normalized = re.sub(r"[^0-9,.-]", "", raw)
    comma = normalized.rfind(",")
    dot = normalized.rfind(".")
    if comma != -1 and dot != -1:
        decimal = "," if comma > dot else "."
        thousands = "." if decimal == "," else ","
        normalized = normalized.replace(thousands, "").replace(decimal, ".")
    elif comma != -1:
        normalized = normalized.replace(",", ".")
    try:
        parsed = float(normalized)
    except ValueError:
        return None
    if not math.isfinite(parsed):
        return None
    if parsed.is_integer():
        return int(parsed)
    return parsed


def normalize_date(value: Any) -> str:
    raw = clean(value)
    match = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", raw)
    if not match:
        return raw
    day, month, year = match.groups()
    if len(year) == 2:
        year = f"20{year}"
    return f"{year}-{int(month):02d}-{int(day):02d}"


def normalize_month(value: Any) -> str:
    raw = clean(value)
    match = re.match(r"^(\d{4})[-/](\d{1,2})", raw)
    if not match:
        return ""
    year, month_raw = match.groups()
    month = int(month_raw)
    if month < 1 or month > 12:
        return ""
    return f"{year}-{month:02d}"


def column_letter(index_zero_based: int) -> str:
    number = index_zero_based + 1
    out = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        out = chr(65 + remainder) + out
    return out


def link_from_cell(cell: dict) -> str:
    direct = clean(cell.get("hyperlink"))
    if direct:
        return direct
    for run in cell.get("textFormatRuns", []) or []:
        uri = (((run or {}).get("format") or {}).get("link") or {}).get("uri")
        if uri:
            return str(uri)
    return ""


def build_sheets_service():
    raw = os.environ.get("GOOGLE_OAUTH_SABAN_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_SABAN_JSON is missing")
    info = json.loads(raw)
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not clean(info.get(key)))
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_SABAN_JSON missing fields: " + ", ".join(missing))
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def read_display_values(sheets, sheet_name: str) -> list[list[Any]]:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=f"'{sheet_name}'",
            valueRenderOption="FORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    return response.get("values", []) or []


def read_link_column(
    sheets,
    sheet_name: str,
    column_index: int,
    first_body_row_one_based: int,
    body_rows: int,
) -> list[str]:
    if body_rows <= 0:
        return []
    letter = column_letter(column_index)
    last_row = first_body_row_one_based + body_rows - 1
    response = (
        sheets.spreadsheets()
        .get(
            spreadsheetId=MASTER_ID,
            ranges=[f"'{sheet_name}'!{letter}{first_body_row_one_based}:{letter}{last_row}"],
            includeGridData=True,
            fields="sheets.data.rowData.values(hyperlink,textFormatRuns)",
        )
        .execute()
    )
    data = (((response.get("sheets") or [{}])[0].get("data") or [{}])[0])
    row_data = data.get("rowData", []) or []
    out: list[str] = []
    for row in row_data:
        values = row.get("values", []) or []
        out.append(link_from_cell(values[0] if values else {}))
    while len(out) < body_rows:
        out.append("")
    return out


def _read(row: list[Any], columns: dict[str, int], field: str) -> str:
    index = columns.get(field)
    if index is None or index >= len(row):
        return ""
    return clean(row[index])


def read_operational_records(sheets) -> list[dict]:
    values = read_display_values(sheets, PEDIDOS_SHEET)
    header_index = next(
        (
            index
            for index, row in enumerate(values)
            if any(clean(cell) == FIELDS["id"] for cell in row)
        ),
        -1,
    )
    if header_index < 0:
        raise RuntimeError("No se encontró la cabecera Pedido")

    headers = [clean(cell) for cell in values[header_index]]
    columns = {header: index for index, header in enumerate(headers)}
    required = set(FIELDS.values()) | set(DOCUMENT_FIELDS.values())
    missing = sorted(field for field in required if field not in columns)
    if missing:
        raise RuntimeError("Faltan columnas públicas en Pedidos: " + ", ".join(missing))

    body = values[header_index + 1 :]
    first_body_row = header_index + 2
    links = {
        public_name: read_link_column(
            sheets,
            PEDIDOS_SHEET,
            columns[column_name],
            first_body_row,
            len(body),
        )
        for public_name, column_name in DOCUMENT_FIELDS.items()
    }

    records: list[dict] = []
    for body_index, row in enumerate(body):
        order_id = _read(row, columns, FIELDS["id"])
        if not order_id:
            continue
        order_date = _read(row, columns, FIELDS["orderDate"])
        receipt_date = _read(row, columns, FIELDS["receiptDate"])
        delivered_date = _read(row, columns, FIELDS["deliveredDate"])
        dashboard_date = (
            _read(row, columns, FIELDS["date"])
            or delivered_date
            or receipt_date
            or order_date
        )
        raw_material = _read(row, columns, FIELDS["material"])
        record = {
            "id": order_id,
            "date": normalize_date(dashboard_date),
            "orderDate": normalize_date(order_date),
            "receiptDate": normalize_date(receipt_date),
            "deliveredDate": normalize_date(delivered_date),
            "amount": number_or_none(_read(row, columns, FIELDS["amount"])),
            "finalPrice": number_or_none(_read(row, columns, FIELDS["finalPrice"])),
            "materialCost": number_or_none(_read(row, columns, FIELDS["materialCost"])),
            "status": _read(row, columns, FIELDS["status"]),
            "model": _read(row, columns, FIELDS["model"]),
            "material": raw_material,
            "materialNormalized": _read(row, columns, FIELDS["materialNormalized"]) or raw_material,
            "width": number_or_none(_read(row, columns, FIELDS["width"])),
            "height": number_or_none(_read(row, columns, FIELDS["height"])),
            "thickness": number_or_none(_read(row, columns, FIELDS["thickness"])),
            "baseWidth": number_or_none(_read(row, columns, FIELDS["baseWidth"])),
            "baseHeight": number_or_none(_read(row, columns, FIELDS["baseHeight"])),
            "topWidth": number_or_none(_read(row, columns, FIELDS["topWidth"])),
            "stepMeasures": _read(row, columns, FIELDS["stepMeasures"]),
            "voleo": number_or_none(_read(row, columns, FIELDS["voleo"])),
        }
        for public_name in DOCUMENT_FIELDS:
            record[public_name] = links[public_name][body_index]
        records.append(record)
    return records


def read_expenses(sheets) -> list[dict]:
    values = read_display_values(sheets, GASTOS_SHEET)
    if not values:
        return []
    headers = [clean(cell) for cell in values[0]]
    columns = {header: index for index, header in enumerate(headers)}
    missing = sorted(field for field in EXPENSE_FIELDS.values() if field not in columns)
    if missing:
        raise RuntimeError("Faltan columnas públicas en Gastos: " + ", ".join(missing))

    expenses: list[dict] = []
    for row in values[1:]:
        month = normalize_month(_read(row, columns, EXPENSE_FIELDS["month"]))
        category = _read(row, columns, EXPENSE_FIELDS["category"])
        amount = number_or_none(_read(row, columns, EXPENSE_FIELDS["amount"]))
        if not month or not category or amount is None:
            continue
        expenses.append(
            {
                "month": month,
                "category": category,
                "amount": amount,
                "nature": _read(row, columns, EXPENSE_FIELDS["nature"]) or "Sin clasificar",
            }
        )
    return expenses


def build_payload(sheets) -> dict:
    return {
        "version": 6,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "records": read_operational_records(sheets),
        "expenses": read_expenses(sheets),
    }


def canonical_business_payload(payload: dict) -> dict:
    return {
        "version": payload.get("version"),
        "records": payload.get("records", []),
        "expenses": payload.get("expenses", []),
    }


def canonical_bytes(payload: dict) -> bytes:
    return json.dumps(
        canonical_business_payload(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def payload_hash(payload: dict) -> str:
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def fetch_legacy_payload() -> dict:
    request = urllib.request.Request(
        LEGACY_FEED_URL,
        headers={"User-Agent": "LITOS-M7-parity/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read().decode("utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise RuntimeError("Legacy Apps Script feed returned an invalid payload")
    return payload


def diff_summary(expected: dict, actual: dict) -> dict:
    expected_records = expected.get("records", [])
    actual_records = actual.get("records", [])
    expected_expenses = expected.get("expenses", [])
    actual_expenses = actual.get("expenses", [])

    record_mismatch_rows = 0
    record_mismatch_fields: set[str] = set()
    for left, right in zip(expected_records, actual_records):
        if left != right:
            record_mismatch_rows += 1
            for key in set(left) | set(right):
                if left.get(key) != right.get(key):
                    record_mismatch_fields.add(key)
    record_mismatch_rows += abs(len(expected_records) - len(actual_records))

    expense_mismatch_rows = sum(
        1 for left, right in zip(expected_expenses, actual_expenses) if left != right
    ) + abs(len(expected_expenses) - len(actual_expenses))

    return {
        "record_count_python": len(expected_records),
        "record_count_legacy": len(actual_records),
        "expense_count_python": len(expected_expenses),
        "expense_count_legacy": len(actual_expenses),
        "record_mismatch_rows": record_mismatch_rows,
        "record_mismatch_fields": sorted(record_mismatch_fields),
        "expense_mismatch_rows": expense_mismatch_rows,
        "python_hash": payload_hash(expected),
        "legacy_hash": payload_hash(actual),
    }


def preflight() -> dict:
    return {
        "mode": "M7_PUBLIC_FEED_PREFLIGHT",
        "phase": "M7",
        "master_configured": bool(MASTER_ID),
        "legacy_feed_configured": LEGACY_FEED_URL.startswith("https://"),
        "write_operations": 0,
    }


def parity() -> dict:
    sheets = build_sheets_service()
    generated = build_payload(sheets)
    legacy = fetch_legacy_payload()
    summary = diff_summary(generated, legacy)
    parity_ok = canonical_business_payload(generated) == canonical_business_payload(legacy)
    result = {
        "mode": "M7_PUBLIC_FEED_READ_ONLY_PARITY",
        "phase": "M7",
        "parity_ok": parity_ok,
        **summary,
        "write_operations": 0,
    }
    if not parity_ok:
        raise RuntimeError("M7 public-feed parity mismatch: " + json.dumps(result, ensure_ascii=False))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="LITOS M7 public feed parity")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--parity", action="store_true")
    args = parser.parse_args()

    if args.preflight:
        print("PUBLIC_FEED_PREFLIGHT_OK")
        print(json.dumps(preflight(), ensure_ascii=False, sort_keys=True))
        return

    result = parity()
    print("PUBLIC_FEED_PARITY_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
