from __future__ import annotations

# Privacy-safe public feed production baseline; public output remains sanitized.

import argparse
import hashlib
import json
import math
import os
import re
from datetime import datetime, timezone
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# Private identities are resolved outside public source.
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
]

MASTER_ID = os.environ.get(
    "LITOS_SPREADSHEET_ID",
    "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q",
)
PEDIDOS_SHEET = "Pedidos"
GASTOS_SHEET = "Gastos"
MOVEMENTS_SHEET = "Movimientos cliente"
FIELDS = {
    "id": "Pedido",
    "date": "Fecha para dashboard",
    "orderDate": "Fecha ficha",
    "receiptDate": "Fecha recepción (email)",
    "deliveredDate": "Fecha entrega (estadillo)",
    "deliveryDocumentDate": "Fecha entrega albarán",
    "deliveryReviewStatus": "Estado conciliación definitivo",
    "amount": "Importe trabajo / Debe (€)",
    "finalPrice": "Precio final (€)",  # PVP final: IVA y recargo de equivalencia incluidos.
    "materialCost": "Coste material est. (€)",
    "directCostActual": "Coste directo real (€)",
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
    "source": "Fuente",
    "invoiceDate": "Fecha factura",
    "reference": "Referencia factura",
    "emailEvidence": "Referencia email fuente",
}

EXPENSE_LINK_FIELDS = {
    "folderUrl": "Carpeta Drive",
    "documentUrl": "Documento Drive",
}

MOVEMENT_FIELDS = {
    "year": "Año",
    "date": "Fecha contable",
    "sourceDate": "Fecha escrita en fuente",
    "type": "Tipo de movimiento",
    "ref": "ID de trabajo / ref.",
    "line": "Nº línea estadillo",
    "concept": "Concepto de origen",
    "debit": "Debe (€)",
    "credit": "Entrega a cuenta / Haber (€)",
    "balance": "Saldo acumulado (€)",
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
    base_uri = (
        (((cell.get("userEnteredFormat") or {}).get("textFormat") or {}).get("link") or {})
        .get("uri")
    )
    if base_uri:
        return str(base_uri)
    for run in cell.get("textFormatRuns", []) or []:
        uri = (((run or {}).get("format") or {}).get("link") or {}).get("uri")
        if uri:
            return str(uri)
    return clean(cell.get("hyperlink"))


def build_sheets_service():
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
            fields="sheets.data.rowData.values(hyperlink,textFormatRuns,userEnteredFormat.textFormat.link)",
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
            "deliveryDocumentDate": normalize_date(_read(row, columns, FIELDS["deliveryDocumentDate"])),
            "deliveryReviewStatus": _read(row, columns, FIELDS["deliveryReviewStatus"]),
            "amount": number_or_none(_read(row, columns, FIELDS["amount"])),
            "finalPrice": number_or_none(_read(row, columns, FIELDS["finalPrice"])),
            "materialCost": number_or_none(_read(row, columns, FIELDS["materialCost"])),
            "directCostActual": number_or_none(_read(row, columns, FIELDS["directCostActual"])),
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
    required = set(EXPENSE_FIELDS.values()) | set(EXPENSE_LINK_FIELDS.values())
    missing = sorted(field for field in required if field not in columns)
    if missing:
        raise RuntimeError("Faltan columnas públicas en Gastos: " + ", ".join(missing))

    body = values[1:]
    links = {
        public_name: read_link_column(
            sheets,
            GASTOS_SHEET,
            columns[column_name],
            2,
            len(body),
        )
        for public_name, column_name in EXPENSE_LINK_FIELDS.items()
    }

    expenses: list[dict] = []
    for body_index, row in enumerate(body):
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
                "source": _read(row, columns, EXPENSE_FIELDS["source"]),
                "invoiceDate": normalize_date(_read(row, columns, EXPENSE_FIELDS["invoiceDate"])),
                "reference": _read(row, columns, EXPENSE_FIELDS["reference"]),
                "emailEvidence": _read(row, columns, EXPENSE_FIELDS["emailEvidence"]),
                "folderUrl": links["folderUrl"][body_index],
                "documentUrl": links["documentUrl"][body_index],
            }
        )
    return expenses

def read_movements(sheets) -> list[dict]:
    """Read the private running account exactly as reconciled in the master Sheet."""
    values = read_display_values(sheets, MOVEMENTS_SHEET)
    if not values:
        return []
    header_index = next(
        (
            index
            for index, row in enumerate(values)
            if any(clean(cell) == MOVEMENT_FIELDS["date"] for cell in row)
        ),
        -1,
    )
    if header_index < 0:
        raise RuntimeError("No se encontró la cabecera de Movimientos cliente")
    headers = [clean(cell) for cell in values[header_index]]
    columns = {header: index for index, header in enumerate(headers)}
    missing = sorted(field for field in MOVEMENT_FIELDS.values() if field not in columns)
    if missing:
        raise RuntimeError("Faltan columnas en Movimientos cliente: " + ", ".join(missing))

    movements: list[dict] = []
    for row in values[header_index + 1 :]:
        date = _read(row, columns, MOVEMENT_FIELDS["date"])
        movement_type = _read(row, columns, MOVEMENT_FIELDS["type"])
        balance = number_or_none(_read(row, columns, MOVEMENT_FIELDS["balance"]))
        if not date or not movement_type or balance is None:
            continue
        movements.append(
            {
                "year": number_or_none(_read(row, columns, MOVEMENT_FIELDS["year"])),
                "date": normalize_date(date),
                "sourceDate": _read(row, columns, MOVEMENT_FIELDS["sourceDate"]),
                "type": movement_type,
                "ref": _read(row, columns, MOVEMENT_FIELDS["ref"]),
                "line": number_or_none(_read(row, columns, MOVEMENT_FIELDS["line"])),
                "concept": _read(row, columns, MOVEMENT_FIELDS["concept"]),
                "debit": number_or_none(_read(row, columns, MOVEMENT_FIELDS["debit"])),
                "credit": number_or_none(_read(row, columns, MOVEMENT_FIELDS["credit"])),
                "balance": balance,
            }
        )
    return movements


def build_payload(sheets) -> dict:
    return {
        "version": 6,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "records": read_operational_records(sheets),
        "expenses": read_expenses(sheets),
        "movements": read_movements(sheets),
    }


def payload_hash(payload: dict) -> str:
    """Stable hash of the current business payload, excluding generation time."""
    business_payload = {
        "version": payload.get("version"),
        "records": payload.get("records", []),
        "expenses": payload.get("expenses", []),
        "movements": payload.get("movements", []),
    }
    raw = json.dumps(
        business_payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def preflight() -> dict:
    return {
        "mode": "M7_PUBLIC_FEED_PREFLIGHT",
        "phase": "M7",
        "master_configured": bool(MASTER_ID),
        "write_operations": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="LITOS M7 public feed preflight")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()

    if not args.preflight:
        parser.error("Use --preflight")

    print("PUBLIC_FEED_PREFLIGHT_OK")
    print(json.dumps(preflight(), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
