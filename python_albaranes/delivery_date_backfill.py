from __future__ import annotations

# 2026 workbook-header cleanup rerun.
# Historical phased cleanup trigger: 2025.
# Historical phased cleanup trigger: 2025 retry.
# Historical phased cleanup trigger: 2024.
# Global historical differentiated-date refill after phased cleanup.
# Historical phased cleanup trigger: 2022.
# Historical phased cleanup trigger: 2021.
# Historical phased cleanup trigger: 2020.
# Historical PDF scan repair phase: 2025.
# Historical PDF scan repair phase: 2025 retry 2.
# Historical PDF scan repair phase: 2025 retry 3.
# Historical PDF scan repair phase: 2024.
# Historical PDF scan repair phase: 2023.
# Historical PDF scan repair phase: 2022.
# Historical PDF scan repair phase: 2021.

import argparse
import io
import json
import os
import threading
import re
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import openpyxl
import xlrd
from pypdf import PdfReader
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

import parity as p
from history_backfill import as_date, excel_serial, normalize

DELIVERY_HEADER = "Fecha entrega albarán"
STAT_DELIVERY_HEADER = "Fecha entrega (estadillo)"
ORDER_DATE_HEADER = "Fecha ficha"
RECEIPT_DATE_HEADER = "Fecha recepción (email)"
DASHBOARD_DATE_HEADER = "Fecha para dashboard"
OBSERVATION_HEADER = "Observación de conciliación"
INVOICE_HEADER = "Archivo factura / albarán (XLSX)"

SUPPORTED_EXTENSIONS = {".pdf", ".xls", ".xlsx", ".xlsm"}
YEAR_ROOT_FOLDER_IDS = {
    2020: "1UMgVG8IvZSJkCSxxrumXoBLxKaN6h7BK",
    2021: "1MitrqxWNS-ympuhRfoYr-fvMzbJCvyH1",
    2022: "1jT8Mlq4aeLvL4pWcChUFlTPHK0xe_Ynq",
    2023: "1d94eLfw6EOf0N9YOyJubpz1u4pCr_wsq",
    2024: "1TD0z7lRXkDOx47-dq4ig5vmDGUDC3BH7",
    2025: "1yicoADtD85yEWZ9Qevcn0mzhRqcYiXQU",
    2026: p.ROOT_FOLDER_ID,
}
RAW_CATALOG_SHEETS = ("Catálogo albaranes · bruto", "Catálogo albaranes 2023-2026 · bruto")
ORDER_RE = re.compile(r"(?<!\d)(\d{4})(?!\d)")
PDF_ORDER_RE = re.compile(r"(?i)pedido\s*(?:n[º°o.]*)?\s*(\d{4})(?!\d)")
MACHINE_DELIVERY_MARKER = "Fecha entrega albarán recuperada del documento definitivo"

PDF_DELIVERY_RE = re.compile(
    r"(?im)^\s*fecha(?:\s+de\s+entrega)?\s*[.:]*\s*(?:\r?\n\s*)?"
    r"(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b"
)


@dataclass(frozen=True)
class CandidateFile:
    file_id: str
    name: str
    modified_time: str
    web_view_link: str
    mime_type: str = ""


@dataclass(frozen=True)
class ParsedDocument:
    internal_order: str
    delivery_date: date | None
    raw_delivery_date: date | None
    parser: str


def clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def assert_write_allowed(confirm: str) -> None:
    if not bool_env("LITOS_FREE_ONLY"):
        raise RuntimeError("LITOS_FREE_ONLY must be true")
    if not bool_env("LITOS_DELIVERY_DATE_WRITE_ENABLED"):
        raise RuntimeError("LITOS_DELIVERY_DATE_WRITE_ENABLED must be true")
    if confirm != "DELIVERY_DATE_BACKFILL_V1":
        raise RuntimeError("Explicit confirmation token required")


def extension(name: str) -> str:
    lower = clean(name).lower()
    for ext in sorted(SUPPORTED_EXTENSIONS, key=len, reverse=True):
        if lower.endswith(ext):
            return ext
    return "." + lower.rsplit(".", 1)[-1] if "." in lower else ""


def is_draft(name: str) -> bool:
    return bool(p.DRAFT_RE.search(clean(name).lower()))


def supported_candidate(file: CandidateFile) -> bool:
    return extension(file.name) in SUPPORTED_EXTENSIONS or file.mime_type == p.GOOGLE_SHEETS_MIME


def list_children(drive, folder_id: str) -> list[dict]:
    return p._list_children(drive, folder_id)


def scan_definitive_documents(
    drive,
    *,
    target_year: int | None = None,
) -> tuple[dict[str, list[CandidateFile]], Counter[str]]:
    index: dict[str, list[CandidateFile]] = defaultdict(list)
    extensions: Counter[str] = Counter()
    visited: set[str] = set()

    if target_year is not None:
        root_id = YEAR_ROOT_FOLDER_IDS.get(target_year)
        if not root_id:
            return index, extensions
        stack: list[tuple[str, str]] = [(root_id, "")]
    else:
        stack = [(folder_id, "") for folder_id in YEAR_ROOT_FOLDER_IDS.values()]

    while stack:
        folder_id, inherited_order_id = stack.pop()
        if folder_id in visited:
            continue
        visited.add(folder_id)

        for item in list_children(drive, folder_id):
            item_id = clean(item.get("id"))
            name = clean(item.get("name"))
            mime = clean(item.get("mimeType"))

            if mime == "application/vnd.google-apps.folder":
                if item_id == p.SYSTEM_FOLDER_ID or name == "_sistema":
                    continue
                folder_order = inherited_order_id
                if re.fullmatch(r"\d{4}", name):
                    folder_order = name
                stack.append((item_id, folder_order))
                continue

            if is_draft(name) or p.NOTE_RE.search(name.lower()):
                continue

            ext = extension(name)
            extensions[ext or "<sin_extension>"] += 1
            if ext not in SUPPORTED_EXTENSIONS:
                continue

            match = p.ORDER_ID_RE.search(name)
            order_id = match.group(1) if match else inherited_order_id
            if not order_id or not re.fullmatch(r"\d{4}", order_id):
                continue

            index[order_id].append(
                CandidateFile(
                    file_id=item_id,
                    name=name,
                    modified_time=clean(item.get("modifiedTime")),
                    web_view_link=clean(item.get("webViewLink")),
                    mime_type=mime,
                )
            )

    for files in index.values():
        files.sort(key=lambda item: (extension(item.name) != ".pdf", item.modified_time or ""))

    return index, extensions


def read_master(sheets):
    response = sheets.spreadsheets().values().get(
        spreadsheetId=p.MASTER_ID,
        range=f"'{p.SHEET_NAME}'",
        valueRenderOption="UNFORMATTED_VALUE",
        dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    rows = response.get("values", [])
    header_index = next(
        (i for i, row in enumerate(rows) if any(clean(cell) == p.HEADERS["id"] for cell in row)),
        -1,
    )
    if header_index < 0:
        raise RuntimeError("Master header not found")
    headers = [clean(cell) for cell in rows[header_index]]
    columns = {header: i for i, header in enumerate(headers) if header}
    required = {
        p.HEADERS["id"],
        ORDER_DATE_HEADER,
        RECEIPT_DATE_HEADER,
        DASHBOARD_DATE_HEADER,
        OBSERVATION_HEADER,
        INVOICE_HEADER,
        DELIVERY_HEADER,
        STAT_DELIVERY_HEADER,
    }
    missing = sorted(required - set(columns))
    if missing:
        raise RuntimeError("Master header contract changed: " + ", ".join(missing))
    return rows, header_index, columns


def link_column(sheets, column_index: int, first_body_row: int, body_rows: int):
    return p.read_link_column(sheets, column_index, first_body_row, body_rows)


def get_file_meta(drive, file_id: str) -> CandidateFile | None:
    try:
        item = drive.files().get(
            fileId=file_id,
            fields="id,name,modifiedTime,webViewLink,mimeType",
            supportsAllDrives=True,
        ).execute()
    except Exception:
        return None
    name = clean(item.get("name"))
    if not name or is_draft(name) or p.NOTE_RE.search(name.lower()):
        return None
    return CandidateFile(
        file_id=clean(item.get("id")),
        name=name,
        modified_time=clean(item.get("modifiedTime")),
        web_view_link=clean(item.get("webViewLink")),
        mime_type=clean(item.get("mimeType")),
    )


def matrix_openxml(content: bytes):
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            yield [list(row) for row in ws.iter_rows(values_only=True)], None
    finally:
        wb.close()


def matrix_xls(content: bytes):
    wb = xlrd.open_workbook(file_contents=content, on_demand=True)
    try:
        for ws in wb.sheets():
            yield [ws.row_values(i) for i in range(ws.nrows)], wb.datemode
    finally:
        wb.release_resources()


def date_near_label(rows: list[list[Any]], row_index: int, col_index: int, datemode: int | None) -> date | None:
    positions: list[tuple[int, int]] = []
    for col in range(col_index + 1, min(len(rows[row_index]), col_index + 9)):
        positions.append((row_index, col))
    for r in range(row_index + 1, min(len(rows), row_index + 4)):
        for col in range(col_index, min(len(rows[r]), col_index + 9)):
            positions.append((r, col))
    for r, col in positions:
        candidate = as_date(rows[r][col], datemode=datemode)
        if candidate is not None:
            return candidate
    return None


def order_id_in_row(row: list[Any]) -> str:
    legacy_labels = {"num", "numero", "número", "nº", "n°", "nro"}
    for col_index, value in enumerate(row):
        norm = normalize(value).rstrip(".:")
        if "pedido" not in norm and norm not in legacy_labels:
            continue
        direct = ORDER_RE.search(clean(value))
        if direct:
            return direct.group(1)
        for candidate in row[col_index + 1 : col_index + 8]:
            match = ORDER_RE.search(clean(candidate))
            if match:
                return match.group(1)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                number = int(candidate)
                if 1000 <= number <= 9999:
                    return str(number)
    return ""


def delivery_date_in_segment(
    rows: list[list[Any]],
    start_row: int,
    end_row: int,
    datemode: int | None,
) -> date | None:
    candidates: list[date] = []
    # The row that identifies the order is the albarán header. Its FECHA is
    # the source/order date, not the differentiated delivery date. Only scan
    # subsequent rows for a delivery/footer FECHA.
    for row_index in range(start_row + 1, end_row):
        row = rows[row_index]
        for col_index, value in enumerate(row):
            norm = normalize(value).rstrip(".:")
            if norm not in {"fecha", "fecha de entrega"}:
                continue
            candidate = date_near_label(rows, row_index, col_index, datemode)
            if candidate is not None:
                candidates.append(candidate)
    return candidates[-1] if candidates else None

def parse_workbook_all(content: bytes, name: str) -> dict[str, ParsedDocument]:
    lower = name.lower()
    matrices = matrix_xls(content) if lower.endswith(".xls") and not lower.endswith(".xlsx") else matrix_openxml(content)
    result: dict[str, ParsedDocument] = {}

    for rows, datemode in matrices:
        starts: list[tuple[int, str]] = []
        for row_index, row in enumerate(rows):
            order_id = order_id_in_row(row)
            if order_id:
                starts.append((row_index, order_id))

        for index, (start_row, order_id) in enumerate(starts):
            end_row = starts[index + 1][0] if index + 1 < len(starts) else len(rows)
            raw = delivery_date_in_segment(rows, start_row, end_row, datemode)
            # If the same ID appears more than once, prefer the last block with
            # an actual delivery date; otherwise preserve the latest occurrence.
            parsed = ParsedDocument(
                internal_order=order_id,
                delivery_date=raw,
                raw_delivery_date=raw,
                parser="spreadsheet",
            )
            if order_id not in result or raw is not None:
                result[order_id] = parsed

    return result


def parse_pdf_all(content: bytes, name: str) -> dict[str, ParsedDocument]:
    reader = PdfReader(io.BytesIO(content))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    order_match = PDF_ORDER_RE.search(text)
    filename_match = p.ORDER_ID_RE.search(name)
    internal = order_match.group(1) if order_match else ""
    routing_id = internal or (filename_match.group(1) if filename_match else "")
    dates = [as_date(value) for value in PDF_DELIVERY_RE.findall(text)]
    dates = [value for value in dates if value is not None]
    raw = dates[-1] if dates else None
    if not routing_id:
        return {}
    return {
        routing_id: ParsedDocument(
            internal_order=internal,
            delivery_date=raw,
            raw_delivery_date=raw,
            parser="pdf",
        )
    }


_THREAD_LOCAL = threading.local()


def worker_drive_service():
    service = getattr(_THREAD_LOCAL, "drive", None)
    if service is not None:
        return service
    raw = os.environ.get("GOOGLE_OAUTH_USER_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_USER_JSON is missing")
    info = json.loads(raw)
    credentials = Credentials.from_authorized_user_info(info, scopes=p.SCOPES)
    service = build("drive", "v3", credentials=credentials, cache_discovery=False)
    _THREAD_LOCAL.drive = service
    return service


def parse_file_worker(file: CandidateFile) -> tuple[str, dict[str, ParsedDocument] | Exception]:
    try:
        return file.file_id, parse_document_all(worker_drive_service(), file)
    except Exception as exc:
        return file.file_id, exc


def parse_document_all(drive, file: CandidateFile) -> dict[str, ParsedDocument]:
    content = p._download_file(drive, file.file_id, file.mime_type)
    ext = extension(file.name)
    if ext == ".pdf":
        return parse_pdf_all(content, file.name)
    if ext in {".xls", ".xlsx", ".xlsm"} or file.mime_type == p.GOOGLE_SHEETS_MIME:
        workbook_name = file.name if ext else file.name + ".xlsx"
        return parse_workbook_all(content, workbook_name)
    raise RuntimeError("unsupported document type")

def read_catalog_candidates(sheets) -> dict[str, list[CandidateFile]]:
    result: dict[str, list[CandidateFile]] = defaultdict(list)
    seen: dict[str, set[str]] = defaultdict(set)
    for sheet_name in RAW_CATALOG_SHEETS:
        try:
            values = sheets.spreadsheets().values().get(
                spreadsheetId=p.MASTER_ID,
                range=f"'{sheet_name}'!A:C,F:F",
                valueRenderOption="FORMATTED_VALUE",
            ).execute().get("values", [])
        except Exception:
            # The Sheets API does not support discontiguous A1 here on every
            # client version; fall back to the compact A:F range.
            values = sheets.spreadsheets().values().get(
                spreadsheetId=p.MASTER_ID,
                range=f"'{sheet_name}'!A:F",
                valueRenderOption="FORMATTED_VALUE",
            ).execute().get("values", [])
        if not values:
            continue
        headers = [clean(value) for value in values[0]]
        columns = {header: index for index, header in enumerate(headers)}
        required = {"File ID", "Archivo", "URL", "Pedido"}
        if not required.issubset(columns):
            # Fallback path when the discontiguous request is represented
            # differently: reload A:F with canonical columns.
            values = sheets.spreadsheets().values().get(
                spreadsheetId=p.MASTER_ID,
                range=f"'{sheet_name}'!A:F",
                valueRenderOption="FORMATTED_VALUE",
            ).execute().get("values", [])
            if not values:
                continue
            headers = [clean(value) for value in values[0]]
            columns = {header: index for index, header in enumerate(headers)}
            if not required.issubset(columns):
                continue

        for row in values[1:]:
            def cell(header: str) -> str:
                index = columns[header]
                return clean(row[index]) if index < len(row) else ""

            file_id = cell("File ID")
            order_id = cell("Pedido")
            name = cell("Archivo")
            url = cell("URL")
            if not file_id or not re.fullmatch(r"\d{4}", order_id):
                continue
            if file_id in seen[order_id]:
                continue
            seen[order_id].add(file_id)
            result[order_id].append(
                CandidateFile(
                    file_id=file_id,
                    name=name,
                    modified_time="",
                    web_view_link=url,
                    mime_type="",
                )
            )
    return result

def plausible_delivery(
    candidate: date | None,
    order_date: date | None,
    stat_delivery_date: date | None = None,
) -> bool:
    if candidate is None:
        return False
    today = datetime.now().date()
    if candidate < date(2000, 1, 1) or candidate > today + timedelta(days=1):
        return False
    if order_date is not None and candidate < order_date:
        return False
    # The documentary albarán date cannot occur after a delivery already
    # recorded in the customer ledger. Fail closed instead of accepting
    # a later header/order date from a stale or reused document.
    if stat_delivery_date is not None and candidate > stat_delivery_date:
        return False
    return True


def append_observation(current: Any, note: str) -> str:
    base = clean(current)
    if not note or note in base:
        return base
    return note if not base else base + " · " + note



def strip_machine_delivery_notes(current: Any) -> str:
    parts = [
        part.strip()
        for part in clean(current).split(" · ")
        if part.strip()
    ]
    kept = [
        part for part in parts
        if not part.startswith(MACHINE_DELIVERY_MARKER)
        and not part.startswith("Fecha entrega albarán corregida tras revisión")
        and not part.startswith("Fecha entrega albarán retirada tras revisión")
    ]
    return " · ".join(kept)

def row_year(row: list[Any], columns: dict[str, int]) -> int | None:
    # Phase year follows operational/archive evidence first. This avoids
    # excluding rows whose source-note year was stale or mistyped.
    for header in (STAT_DELIVERY_HEADER, RECEIPT_DATE_HEADER, DASHBOARD_DATE_HEADER, ORDER_DATE_HEADER):
        index = columns.get(header)
        if index is None or index >= len(row):
            continue
        value = as_date(row[index])
        if value is not None:
            return value.year
    return None


def build_plan(drive, sheets, *, target_year: int | None = None):
    rows, header_index, columns = read_master(sheets)
    body_rows = max(0, len(rows) - header_index - 1)
    first_body_row = header_index + 2
    invoice_links = link_column(
        sheets,
        columns[INVOICE_HEADER],
        first_body_row,
        body_rows,
    )
    scan_unlinked = bool_env("LITOS_DELIVERY_SCAN_UNLINKED")
    if scan_unlinked:
        scanned, ext_counts = scan_definitive_documents(drive, target_year=target_year)
    else:
        scanned, ext_counts = {}, Counter()
    catalog_candidates = read_catalog_candidates(sheets)

    cache: dict[str, dict[str, ParsedDocument] | Exception] = {}
    meta_cache: dict[str, CandidateFile | None] = {}
    plans: list[dict[str, Any]] = []

    # Historical catalogs contain hundreds of definitive files. Read them in
    # parallel with separate Drive clients per worker, but keep all writes
    # single-threaded and deferred until after the complete plan is validated.
    relevant_order_ids: set[str] | None = None
    if target_year is not None:
        relevant_order_ids = set()
        for row_index in range(header_index + 1, len(rows)):
            row = rows[row_index]
            id_col = columns[p.HEADERS["id"]]
            order_id = clean(row[id_col]) if id_col < len(row) else ""
            if re.fullmatch(r"\d{4}", order_id) and row_year(row, columns) == target_year:
                relevant_order_ids.add(order_id)

    unique_catalog_files: dict[str, CandidateFile] = {}
    for order_id, files in catalog_candidates.items():
        if relevant_order_ids is not None and order_id not in relevant_order_ids:
            continue
        for file in files:
            if supported_candidate(file) and not is_draft(file.name):
                unique_catalog_files.setdefault(file.file_id, file)

    # Historical PDFs discovered from the annual archive are also preparsed
    # in parallel; otherwise hundreds of PDF downloads happen serially later.
    for order_id, files in scanned.items():
        if relevant_order_ids is not None and order_id not in relevant_order_ids:
            continue
        for file in files:
            if supported_candidate(file) and not is_draft(file.name):
                unique_catalog_files.setdefault(file.file_id, file)

    workers = max(1, min(8, int(os.environ.get("LITOS_DELIVERY_READ_WORKERS", "8"))))
    if unique_catalog_files:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(parse_file_worker, file)
                for file in unique_catalog_files.values()
            ]
            for future in as_completed(futures):
                file_id, parsed_or_exc = future.result()
                cache[file_id] = parsed_or_exc
    stats: Counter[str] = Counter()
    conflicts: Counter[str] = Counter()
    stats["catalog_files_preparsed"] = len(unique_catalog_files)
    stats["catalog_parse_errors"] = sum(1 for value in cache.values() if isinstance(value, Exception))

    for body_index, row_index in enumerate(range(header_index + 1, len(rows))):
        row = rows[row_index]
        id_col = columns[p.HEADERS["id"]]
        order_id = clean(row[id_col]) if id_col < len(row) else ""
        if not re.fullmatch(r"\d{4}", order_id):
            continue
        if target_year is not None and row_year(row, columns) != target_year:
            continue

        current = row[columns[DELIVERY_HEADER]] if columns[DELIVERY_HEADER] < len(row) else ""
        current_obs = row[columns[OBSERVATION_HEADER]] if columns[OBSERVATION_HEADER] < len(row) else ""
        machine_managed = MACHINE_DELIVERY_MARKER in clean(current_obs)
        if clean(current) and not machine_managed:
            stats["already_filled_manual_or_validated"] += 1
            continue

        current_date = as_date(current)
        order_date_raw = row[columns[ORDER_DATE_HEADER]] if columns[ORDER_DATE_HEADER] < len(row) else None
        order_date = as_date(order_date_raw)
        stat_delivery_raw = row[columns[STAT_DELIVERY_HEADER]] if columns.get(STAT_DELIVERY_HEADER, -1) >= 0 and columns[STAT_DELIVERY_HEADER] < len(row) else None
        stat_delivery_date = as_date(stat_delivery_raw)

        candidates: list[CandidateFile] = []
        linked = invoice_links[body_index] if body_index < len(invoice_links) else p.LinkCell("", "")
        linked_id = p._extract_drive_id(linked.url)
        if linked_id:
            if linked_id not in meta_cache:
                meta_cache[linked_id] = get_file_meta(drive, linked_id)
            meta = meta_cache[linked_id]
            if meta is not None and supported_candidate(meta):
                candidates.append(meta)

        seen = {item.file_id for item in candidates}
        for meta in catalog_candidates.get(order_id, []):
            if meta.file_id in seen:
                continue
            if supported_candidate(meta) and not is_draft(meta.name):
                candidates.append(meta)
                seen.add(meta.file_id)

        for item in scanned.get(order_id, []):
            if item.file_id not in seen:
                candidates.append(item)
                seen.add(item.file_id)

        # Prefer the rendered definitive PDF when available. Workshop XLS/XLSX
        # files often keep only the order date in the header, while the PDF
        # contains the actual delivery date in the footer.
        candidates.sort(key=lambda item: (extension(item.name) != ".pdf", item.modified_time or ""))

        if not candidates:
            stats["no_definitive_document"] += 1
            if machine_managed:
                base_obs = strip_machine_delivery_notes(current_obs)
                note = "Fecha entrega albarán retirada tras revisión: no se localizó documento definitivo validable"
                plans.append({
                    "row_index_zero": row_index,
                    "order_id": order_id,
                    "delivery_date": None,
                    "clear_delivery": True,
                    "observation": append_observation(base_obs, note),
                    "conflict_only": False,
                })
                stats["machine_dates_cleared"] += 1
            continue

        stats["rows_with_candidate"] += 1
        accepted: tuple[CandidateFile, ParsedDocument] | None = None
        row_conflicts: list[str] = []

        for candidate in candidates:
            stats[f"candidate_ext_{extension(candidate.name) or 'none'}"] += 1
            parsed_map_or_exc = cache.get(candidate.file_id)
            if parsed_map_or_exc is None:
                try:
                    parsed_map_or_exc = parse_document_all(drive, candidate)
                    cache[candidate.file_id] = parsed_map_or_exc
                    stats["documents_parsed"] += 1
                except Exception as exc:
                    parsed_map_or_exc = exc
                    cache[candidate.file_id] = exc
                    stats["parse_errors"] += 1

            if isinstance(parsed_map_or_exc, Exception):
                continue
            parsed = parsed_map_or_exc.get(order_id)
            if parsed is None:
                if parsed_map_or_exc:
                    conflicts["internal_id_mismatch"] += 1
                    row_conflicts.append("ID interno no coincide/no aparece en el documento")
                else:
                    stats["documents_without_internal_order"] += 1
                continue
            if parsed.internal_order and parsed.internal_order != order_id:
                conflicts["internal_id_mismatch"] += 1
                row_conflicts.append("ID interno no coincide")
                continue
            if parsed.raw_delivery_date is None:
                stats["documents_without_delivery_date"] += 1
                continue
            if not plausible_delivery(parsed.delivery_date, order_date, stat_delivery_date):
                conflicts["implausible_delivery_date"] += 1
                detail = "fecha de entrega documental incompatible " + parsed.raw_delivery_date.isoformat()
                if stat_delivery_date is not None and parsed.delivery_date and parsed.delivery_date > stat_delivery_date:
                    detail += " (posterior al estadillo " + stat_delivery_date.isoformat() + ")"
                row_conflicts.append(detail)
                continue
            accepted = (candidate, parsed)
            break

        if accepted is None:
            stats["rows_unresolved"] += 1
            if machine_managed:
                base_obs = strip_machine_delivery_notes(current_obs)
                reason = (
                    "; ".join(sorted(set(row_conflicts)))
                    if row_conflicts
                    else "el documento definitivo no contiene una fecha documental utilizable"
                )
                note = "Fecha entrega albarán retirada tras revisión: " + reason
                plans.append({
                    "row_index_zero": row_index,
                    "order_id": order_id,
                    "delivery_date": None,
                    "clear_delivery": True,
                    "observation": append_observation(base_obs, note),
                    "conflict_only": False,
                })
                stats["machine_dates_cleared"] += 1
            elif row_conflicts:
                note = "Fecha entrega albarán no aplicada: " + "; ".join(sorted(set(row_conflicts)))
                updated_obs = append_observation(current_obs, note)
                if updated_obs != clean(current_obs):
                    plans.append({
                        "row_index_zero": row_index,
                        "order_id": order_id,
                        "delivery_date": None,
                        "clear_delivery": False,
                        "observation": updated_obs,
                        "conflict_only": True,
                    })
            continue

        candidate, parsed = accepted
        base_obs = strip_machine_delivery_notes(current_obs)
        note = (
            "Fecha entrega albarán recuperada del documento definitivo "
            f"({extension(candidate.name).lstrip('.') or 'archivo'}; ID interno validado; fecha de entrega diferenciada de la cabecera PEDIDO)"
        )
        plans.append({
            "row_index_zero": row_index,
            "order_id": order_id,
            "delivery_date": parsed.delivery_date,
            "clear_delivery": False,
            "observation": append_observation(base_obs, note),
            "conflict_only": False,
        })
        stats["dates_backfillable"] += 1
        if machine_managed and current_date != parsed.delivery_date:
            stats["machine_dates_corrected"] += 1

    summary = {
        "mode": "DELIVERY_DATE_BACKFILL_PLAN",
        "target_year": target_year,
        "supported_extensions": sorted(SUPPORTED_EXTENSIONS),
        "unlinked_recursive_scan": scan_unlinked,
        "drive_candidate_extensions": dict(sorted(ext_counts.items())),
        "conflicts": dict(sorted(conflicts.items())),
        **dict(sorted(stats.items())),
        "planned_rows": len(plans),
        "write_operations": 0,
    }
    return rows, header_index, columns, plans, summary


def sheet_id(sheets) -> int:
    response = sheets.spreadsheets().get(
        spreadsheetId=p.MASTER_ID,
        fields="sheets(properties(sheetId,title))",
    ).execute()
    for item in response.get("sheets", []):
        props = item.get("properties", {})
        if props.get("title") == p.SHEET_NAME:
            return int(props["sheetId"])
    raise RuntimeError("Pedidos sheet not found")


def update_request(sheet_id_value: int, row_zero: int, col_zero: int, cell: dict, fields: str):
    return {
        "updateCells": {
            "range": {
                "sheetId": sheet_id_value,
                "startRowIndex": row_zero,
                "endRowIndex": row_zero + 1,
                "startColumnIndex": col_zero,
                "endColumnIndex": col_zero + 1,
            },
            "rows": [{"values": [cell]}],
            "fields": fields,
        }
    }


def sync(confirm: str, *, target_year: int | None = None):
    assert_write_allowed(confirm)
    drive, sheets = p.build_services()
    _rows, _header_index, columns, plans, before = build_plan(drive, sheets, target_year=target_year)
    sid = sheet_id(sheets)
    requests: list[dict] = []

    for plan in plans:
        if plan.get("clear_delivery"):
            requests.append(
                update_request(
                    sid,
                    plan["row_index_zero"],
                    columns[DELIVERY_HEADER],
                    {},
                    "userEnteredValue",
                )
            )
        elif plan["delivery_date"] is not None:
            requests.append(
                update_request(
                    sid,
                    plan["row_index_zero"],
                    columns[DELIVERY_HEADER],
                    {
                        "userEnteredValue": {"numberValue": excel_serial(plan["delivery_date"])},
                        "userEnteredFormat": {"numberFormat": {"type": "DATE", "pattern": "yyyy-mm-dd"}},
                    },
                    "userEnteredValue,userEnteredFormat.numberFormat",
                )
            )
        requests.append(
            update_request(
                sid,
                plan["row_index_zero"],
                columns[OBSERVATION_HEADER],
                {"userEnteredValue": {"stringValue": plan["observation"]}},
                "userEnteredValue",
            )
        )

    if requests:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=p.MASTER_ID,
            body={"requests": requests},
        ).execute()

    result = {
        "mode": "DELIVERY_DATE_BACKFILL_SYNC",
        "target_year": target_year,
        "planned_rows_before_sync": before["planned_rows"],
        "dates_backfillable_before_sync": before.get("dates_backfillable", 0),
        "rows_written": len(plans),
        "write_operations": len(requests),
    }
    print("DELIVERY_DATE_BACKFILL_OK")
    print(json.dumps(result, sort_keys=True))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--sync", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--year", type=int, default=None)
    args = parser.parse_args()

    drive, sheets = p.build_services()
    if args.dry_run:
        _rows, _header_index, _columns, _plans, summary = build_plan(drive, sheets, target_year=args.year)
        print("DELIVERY_DATE_BACKFILL_DRY_RUN_OK")
        print(json.dumps(summary, sort_keys=True))
        return 0

    sync(args.confirm, target_year=args.year)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
