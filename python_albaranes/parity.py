from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import openpyxl
import xlrd
from pypdf import PdfReader
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q"
ROOT_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"
SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb"
SHEET_NAME = "Pedidos"

HEADERS = {
    "id": "Pedido",
    "invoice": "Archivo factura / albarán (XLSX)",
    "draft": "Factura borrador (XLSX)",
    "total": "Total sheet (€)",
    "final": "Precio final (€)",
}

ORDER_ID_RE = re.compile(r"(?:^|[^0-9])(\d{4})(?:[^0-9]|$)")
DRAFT_RE = re.compile(r"(?:^|[_ -])borrador(?:[_ .-]|$)", re.IGNORECASE)
NOTE_RE = re.compile(r"(?:^|[_ -])nota(?:[_ .-]|$)", re.IGNORECASE)
VARIANT_RE = re.compile(r"(?:^|[_ .-])(?:bis|reposicion|repuesto|reemplazo)(?:[_ .-]|$)", re.IGNORECASE)
GOOGLE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DRIVE_ID_RE = re.compile(r"[-\w]{20,}")


@dataclass(frozen=True)
class DriveFile:
    file_id: str
    name: str
    modified_time: str
    web_view_link: str
    mime_type: str = ""


@dataclass(frozen=True)
class LinkCell:
    text: str
    url: str


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", _clean(value))
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn").lower()


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None

    raw = re.sub(r"[^0-9,.-]", "", _clean(value))
    if not raw:
        return None
    comma = raw.rfind(",")
    dot = raw.rfind(".")
    if comma != -1 and dot != -1:
        decimal = "," if comma > dot else "."
        raw = raw.replace("." if decimal == "," else ",", "")
        raw = raw.replace(decimal, ".")
    elif comma != -1:
        raw = raw.replace(",", ".")
    try:
        number = float(raw)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _same_number(current: Any, expected: float) -> bool:
    number = _number(current)
    return number is not None and abs(number - expected) < 0.005


def _column_letter(index_zero_based: int) -> str:
    number = index_zero_based + 1
    out = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        out = chr(65 + remainder) + out
    return out


def _extract_drive_id(url: str) -> str:
    match = DRIVE_ID_RE.search(url or "")
    return match.group(0) if match else ""


def build_services():
    raw = os.environ.get("GOOGLE_OAUTH_USER_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_USER_JSON is missing")
    info = json.loads(raw)
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not str(info.get(key, "")).strip())
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_USER_JSON missing fields: " + ", ".join(missing))
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    drive = build("drive", "v3", credentials=credentials, cache_discovery=False)
    sheets = build("sheets", "v4", credentials=credentials, cache_discovery=False)
    return drive, sheets


def _list_children(drive, folder_id: str) -> list[dict]:
    out: list[dict] = []
    token = None
    while True:
        response = (
            drive.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields=(
                    "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)"
                ),
                pageSize=1000,
                pageToken=token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        out.extend(response.get("files", []))
        token = response.get("nextPageToken")
        if not token:
            return out


def _is_variant_candidate(name: str, order_id: str) -> bool:
    normalized = _normalize(name)
    if VARIANT_RE.search(normalized):
        return True
    match = re.search(rf"(?:^|[^0-9]){re.escape(order_id)}(?P<tail>.*)", normalized)
    if not match:
        return False
    tail = match.group("tail")
    return bool(re.match(r"\s*[-_]\s*\d+(?:\D|$)", tail))


def scan_albaranes(drive) -> dict[str, dict[str, DriveFile]]:
    index: dict[str, dict[str, DriveFile]] = {}
    visited: set[str] = set()
    stack = [ROOT_FOLDER_ID]

    while stack:
        folder_id = stack.pop()
        if folder_id in visited:
            continue
        visited.add(folder_id)

        for item in _list_children(drive, folder_id):
            item_id = str(item.get("id", ""))
            name = _clean(item.get("name", ""))
            mime = str(item.get("mimeType", ""))

            if mime == "application/vnd.google-apps.folder":
                if item_id == SYSTEM_FOLDER_ID or name == "_sistema":
                    continue
                stack.append(item_id)
                continue

            lower = name.lower()
            is_native_sheet = mime == GOOGLE_SHEETS_MIME
            if not is_native_sheet and not re.search(r"\.(pdf|xlsx|xls|xlsm)$", lower):
                continue
            match = ORDER_ID_RE.search(name)
            if not match or NOTE_RE.search(lower):
                continue

            order_id = match.group(1)
            # Fail closed: BIS/replacement/revision files must never be promoted
            # automatically to the canonical work document. Historical and current
            # folders can contain a reused four-digit ID for a later variant.
            if _is_variant_candidate(name, order_id):
                continue
            kind = "draft" if DRAFT_RE.search(lower) else "invoice"
            candidate = DriveFile(
                file_id=item_id,
                name=name,
                modified_time=str(item.get("modifiedTime", "")),
                web_view_link=str(item.get("webViewLink", "")),
                mime_type=mime,
            )
            entry = index.setdefault(order_id, {})
            existing = entry.get(kind)
            if existing is None or candidate.modified_time > existing.modified_time:
                entry[kind] = candidate

    return index


def read_sheet_values(sheets) -> tuple[list[list[Any]], int, dict[str, int]]:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=f"'{SHEET_NAME}'",
            valueRenderOption="UNFORMATTED_VALUE",
        )
        .execute()
    )
    rows = response.get("values", [])
    header_index = next(
        (
            i
            for i, row in enumerate(rows)
            if any(_clean(cell) == HEADERS["id"] for cell in row)
        ),
        -1,
    )
    if header_index < 0:
        raise RuntimeError("No se encontró la cabecera Pedido")

    headers = [_clean(cell) for cell in rows[header_index]]
    columns = {header: i for i, header in enumerate(headers)}
    for required in HEADERS.values():
        if required not in columns:
            raise RuntimeError(f"Falta la columna '{required}' en Pedidos")
    return rows, header_index, columns


def _link_from_cell(cell: dict) -> str:
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
    return str(cell.get("hyperlink", "") or "")


def read_link_column(
    sheets,
    column_index: int,
    first_body_row_one_based: int,
    body_rows: int,
) -> list[LinkCell]:
    if body_rows <= 0:
        return []
    letter = _column_letter(column_index)
    last_row = first_body_row_one_based + body_rows - 1
    response = (
        sheets.spreadsheets()
        .get(
            spreadsheetId=MASTER_ID,
            ranges=[f"'{SHEET_NAME}'!{letter}{first_body_row_one_based}:{letter}{last_row}"],
            includeGridData=True,
            fields=(
                "sheets.data.rowData.values(formattedValue,hyperlink,textFormatRuns,userEnteredFormat.textFormat.link)"
            ),
        )
        .execute()
    )
    data = (((response.get("sheets") or [{}])[0].get("data") or [{}])[0])
    row_data = data.get("rowData", []) or []
    out: list[LinkCell] = []
    for row in row_data:
        values = row.get("values", []) or []
        cell = values[0] if values else {}
        out.append(
            LinkCell(
                text=str(cell.get("formattedValue", "") or ""),
                url=_link_from_cell(cell),
            )
        )
    while len(out) < body_rows:
        out.append(LinkCell(text="", url=""))
    return out


def _download_file(drive, file_id: str, mime_type: str = "") -> bytes:
    if mime_type == GOOGLE_SHEETS_MIME:
        return (
            drive.files()
            .export_media(fileId=file_id, mimeType=XLSX_MIME)
            .execute()
        )
    return drive.files().get_media(fileId=file_id, supportsAllDrives=True).execute()


def _read_total_openxml(content: bytes) -> float | None:
    workbook = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows(values_only=True):
                values = list(row)
                for col, value in enumerate(values):
                    if _normalize(value) != "total":
                        continue
                    for candidate in values[col + 1 :]:
                        number = _number(candidate)
                        if number is not None:
                            return round(number, 2) if number > 0 else None
        return None
    finally:
        workbook.close()


def _read_total_xls(content: bytes) -> float | None:
    workbook = xlrd.open_workbook(file_contents=content, on_demand=True)
    try:
        for sheet in workbook.sheets():
            for row_index in range(sheet.nrows):
                values = sheet.row_values(row_index)
                for col, value in enumerate(values):
                    if _normalize(value) != "total":
                        continue
                    for candidate in values[col + 1 :]:
                        number = _number(candidate)
                        if number is not None:
                            return round(number, 2) if number > 0 else None
        return None
    finally:
        workbook.release_resources()



def _read_total_pdf(content: bytes) -> float | None:
    reader = PdfReader(io.BytesIO(content))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    matches = re.findall(
        r"(?im)^\s*total\s+(-?\d[\d.]*?(?:,\d{1,2}|\.\d{1,2})?)\s*€?\s*$",
        text,
    )
    for raw in reversed(matches):
        number = _number(raw)
        if number is not None and number > 0:
            return round(number, 2)
    return None

def read_total(drive, file: DriveFile) -> float | None:
    content = _download_file(drive, file.file_id, file.mime_type)
    lower = file.name.lower()
    if lower.endswith(".pdf"):
        return _read_total_pdf(content)
    if lower.endswith(".xls") and not lower.endswith(".xlsx"):
        return _read_total_xls(content)
    return _read_total_openxml(content)


def link_matches(cell: LinkCell, expected: DriveFile | None, label: str) -> bool:
    if expected is None:
        return cell.text == "No disponible" and not cell.url
    return cell.text == label and _extract_drive_id(cell.url) == expected.file_id


def dry_run(max_total_reads: int = 0) -> dict:
    drive, sheets = build_services()
    index = scan_albaranes(drive)
    rows, header_index, columns = read_sheet_values(sheets)

    body_rows = max(0, len(rows) - header_index - 1)
    first_body_row = header_index + 2
    invoice_links = read_link_column(
        sheets, columns[HEADERS["invoice"]], first_body_row, body_rows
    )
    draft_links = read_link_column(
        sheets, columns[HEADERS["draft"]], first_body_row, body_rows
    )

    rows_matched = 0
    invoice_link_mismatches = 0
    draft_link_mismatches = 0
    totals_equal = 0
    total_mismatches = 0
    totals_unavailable_both = 0
    parser_unavailable_with_sheet_total = 0
    parse_errors = 0
    total_reads = 0
    total_reads_deferred = 0
    error_categories: Counter[str] = Counter()
    parsed_by_file: dict[str, tuple[bool, float | None]] = {}

    for body_index, row_index in enumerate(range(header_index + 1, len(rows))):
        row = rows[row_index]
        order_id = _clean(row[columns[HEADERS["id"]]]) if columns[HEADERS["id"]] < len(row) else ""
        if not order_id or order_id not in index:
            continue

        entry = index[order_id]
        rows_matched += 1
        invoice = entry.get("invoice")
        draft = entry.get("draft")

        if not link_matches(invoice_links[body_index], invoice, "Abrir"):
            invoice_link_mismatches += 1
        if not link_matches(draft_links[body_index], draft, "Abrir borrador"):
            draft_link_mismatches += 1

        active = invoice or draft
        if active is None:
            continue

        if active.file_id not in parsed_by_file:
            if max_total_reads > 0 and total_reads >= max_total_reads:
                parsed_by_file[active.file_id] = (False, None)
                total_reads_deferred += 1
            else:
                try:
                    parsed_by_file[active.file_id] = (True, read_total(drive, active))
                    total_reads += 1
                except Exception as exc:  # no identifiers in public Actions logs
                    parsed_by_file[active.file_id] = (True, None)
                    parse_errors += 1
                    extension = active.name.lower().rsplit(".", 1)[-1] if "." in active.name else "unknown"
                    error_categories[f"{extension}:{type(exc).__name__}"] += 1
                    continue

        attempted, expected_total = parsed_by_file[active.file_id]
        if not attempted:
            continue

        total_col = columns[HEADERS["total"]]
        current_total = row[total_col] if total_col < len(row) else None
        current_number = _number(current_total)

        if expected_total is None:
            if current_number is None and not _clean(current_total):
                totals_unavailable_both += 1
            else:
                parser_unavailable_with_sheet_total += 1
        elif _same_number(current_total, expected_total):
            totals_equal += 1
        else:
            total_mismatches += 1

    return {
        "mode": "ALBARANES_READ_ONLY_PARITY",
        "phase": "M6",
        "files_indexed": len(index),
        "rows_matched": rows_matched,
        "invoice_link_mismatches": invoice_link_mismatches,
        "draft_link_mismatches": draft_link_mismatches,
        "total_reads": total_reads,
        "total_reads_deferred": total_reads_deferred,
        "totals_equal": totals_equal,
        "total_mismatches": total_mismatches,
        "totals_unavailable_both": totals_unavailable_both,
        "parser_unavailable_with_sheet_total": parser_unavailable_with_sheet_total,
        "parse_errors": parse_errors,
        "parse_error_categories": dict(sorted(error_categories.items())),
        "write_operations": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-total-reads", type=int, default=0)
    args = parser.parse_args()

    if args.preflight:
        print("ALBARANES_PREFLIGHT_OK")
        print(
            json.dumps(
                {
                    "component": "sync-albaranes-2026",
                    "phase": "M6",
                    "mode": "READ_ONLY_PARITY",
                    "write_enabled": False,
                    "root_folder": "2026",
                },
                sort_keys=True,
            )
        )
        return 0

    result = dry_run(max_total_reads=max(0, args.max_total_reads))
    print("ALBARANES_DRY_RUN_OK")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
