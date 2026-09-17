from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

import openpyxl
import xlrd

import parity as p

MASTER_ID = p.MASTER_ID
SHEET_NAME = p.SHEET_NAME

RAW_SHEETS = (
    "Catálogo albaranes · bruto",
    "Catálogo albaranes 2023-2026 · bruto",
)

H = {
    "id": "Pedido",
    "date": "Fecha ficha",
    "model": "Modelo",
    "material": "Material",
    "measures": "Notas de medidas y croquis",
    "specs": "Especificaciones",
    "text": "Texto conmemorativo",
    "state": "Estado de lectura",
    "delivery": "Fecha entrega (estadillo)",
    "dashboard": "Fecha para dashboard",
    "observation": "Observación de conciliación",
    "received": "Fecha recepción (email)",
    "invoice": "Archivo factura / albarán (XLSX)",
}

TARGET_STATE = "Sin ficha disponible en correo"
RECOVERED_STATE = "Recuperado de albarán histórico"
ORDER_RE = re.compile(r"(?<!\d)(\d{4})(?!\d)")


def clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", clean(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", text).strip().lower()


def bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def assert_write_allowed(confirm: str) -> None:
    if not bool_env("LITOS_FREE_ONLY"):
        raise RuntimeError("LITOS_FREE_ONLY must be true")
    if not bool_env("LITOS_HISTORY_WRITE_ENABLED"):
        raise RuntimeError("LITOS_HISTORY_WRITE_ENABLED must be true")
    if confirm != "HISTORY_BACKFILL_V1":
        raise RuntimeError("Explicit confirmation token required")


def as_date(value: Any, *, datemode: int | None = None) -> date | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        number = float(value)
        if datemode is not None and 1 <= number <= 100000:
            try:
                return xlrd.xldate_as_datetime(number, datemode).date()
            except Exception:
                pass
        if 20000 <= number <= 80000:
            try:
                return (datetime(1899, 12, 30) + timedelta(days=number)).date()
            except Exception:
                pass
    raw = clean(value)
    if not raw:
        return None
    raw = raw.split(" 00:00:00")[0].strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d-%m-%y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.date()
    except ValueError:
        return None


def excel_serial(d: date) -> float:
    return float((d - date(1899, 12, 30)).days)


def read_master(sheets):
    response = sheets.spreadsheets().values().get(
        spreadsheetId=MASTER_ID,
        range=f"'{SHEET_NAME}'",
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()
    rows = response.get("values", [])
    header_index = next(
        (i for i, row in enumerate(rows) if any(clean(cell) == H["id"] for cell in row)),
        -1,
    )
    if header_index < 0:
        raise RuntimeError("Master header not found")
    headers = [clean(cell) for cell in rows[header_index]]
    columns = {header: i for i, header in enumerate(headers)}
    missing = [header for header in H.values() if header not in columns]
    if missing:
        raise RuntimeError("Master header contract changed: " + ", ".join(missing))
    return rows, header_index, columns


def read_raw_catalog_metadata(sheets) -> dict[tuple[str, str], dict[str, str]]:
    exact: dict[tuple[str, str], dict[str, str]] = {}
    fallback: dict[str, dict[str, str]] = {}

    for sheet_name in RAW_SHEETS:
        try:
            values = sheets.spreadsheets().values().get(
                spreadsheetId=MASTER_ID,
                range=f"'{sheet_name}'!A:Q",
                valueRenderOption="FORMATTED_VALUE",
            ).execute().get("values", [])
        except Exception:
            continue
        if not values:
            continue
        headers = [clean(v) for v in values[0]]
        idx = {h: i for i, h in enumerate(headers)}
        required = ("File ID", "Pedido")
        if any(h not in idx for h in required):
            continue

        def cell(row, header):
            i = idx.get(header)
            return clean(row[i]) if i is not None and i < len(row) else ""

        for row in values[1:]:
            order_id = cell(row, "Pedido")
            file_id = cell(row, "File ID")
            if not re.fullmatch(r"\d{4}", order_id) or not file_id:
                continue
            meta = {
                "model": cell(row, "Modelo"),
                "material": cell(row, "Material"),
                "specs": cell(row, "Especificaciones"),
                "measures": cell(row, "Medidas / croquis"),
                "text": cell(row, "Texto conmemorativo"),
            }
            key = (order_id, file_id)
            target = exact.setdefault(key, {})
            for k, v in meta.items():
                if v and not target.get(k):
                    target[k] = v
            target2 = fallback.setdefault(order_id, {})
            for k, v in meta.items():
                if v and not target2.get(k):
                    target2[k] = v

    exact[("__fallback__", "__fallback__")] = fallback  # type: ignore[assignment]
    return exact


def matrix_openxml(content: bytes):
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            yield ws.title, [list(row) for row in ws.iter_rows(values_only=True)], None
    finally:
        wb.close()


def matrix_xls(content: bytes):
    wb = xlrd.open_workbook(file_contents=content, on_demand=True)
    try:
        for ws in wb.sheets():
            yield ws.name, [ws.row_values(i) for i in range(ws.nrows)], wb.datemode
    finally:
        wb.release_resources()


def first_right(row: list[Any], start: int, predicate, *, max_cells: int = 8):
    for value in row[start + 1 : start + 1 + max_cells]:
        if predicate(value):
            return value
    return None


def join_right(row: list[Any], start: int) -> str:
    stop = {
        "precio", "cantidad", "largo", "ancho", "grueso", "m/2", "m2",
        "suma", "iva", "i.v.a.", "r.e.", "total",
    }
    out: list[str] = []
    for value in row[start + 1 :]:
        text = clean(value)
        if not text:
            continue
        norm = normalize(text)
        if norm in stop or norm.startswith("precio"):
            break
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if out:
                break
            continue
        out.append(text)
        if len(out) >= 4:
            break
    return " ".join(out).strip()


def parse_workbook(content: bytes, name: str) -> dict[str, Any]:
    lower = name.lower()
    matrices = matrix_xls(content) if lower.endswith(".xls") and not lower.endswith(".xlsx") else matrix_openxml(content)
    result: dict[str, Any] = {"order_id": "", "date": None, "model": "", "material": ""}

    for _sheet_name, rows, datemode in matrices:
        for row in rows:
            for col, value in enumerate(row):
                norm = normalize(value)
                if not norm:
                    continue

                if not result["order_id"] and "pedido" in norm:
                    candidate = first_right(
                        row, col,
                        lambda x: bool(ORDER_RE.fullmatch(clean(x))) or (
                            isinstance(x, (int, float)) and 1000 <= float(x) <= 9999
                        ),
                        max_cells=6,
                    )
                    if candidate is not None:
                        m = ORDER_RE.search(clean(candidate))
                        if m:
                            result["order_id"] = m.group(1)
                        elif isinstance(candidate, (int, float)):
                            result["order_id"] = str(int(candidate))

                if result["date"] is None and norm == "fecha":
                    candidate = first_right(
                        row, col,
                        lambda x: as_date(x, datemode=datemode) is not None,
                        max_cells=6,
                    )
                    if candidate is not None:
                        result["date"] = as_date(candidate, datemode=datemode)

                if not result["model"] and norm in {"concepto", "modelo"}:
                    result["model"] = join_right(row, col)

                if not result["material"] and norm == "material":
                    result["material"] = join_right(row, col)

        if result["order_id"] and result["date"] and result["model"] and result["material"]:
            break

    return result


def normalize_model(value: str) -> str:
    n = normalize(value)
    if not n:
        return ""
    if "reforma" in n:
        return "Reforma"
    if "tapanicho" in n or "tapa nicho" in n:
        return "Tapa nicho"
    if "lapida" in n:
        return "Lápida"
    if "columbario" in n:
        return "Columbario"
    return value.strip()


def plausible_ficha_date(ficha: date | None, delivery: date | None) -> bool:
    if ficha is None:
        return False
    today = datetime.now().date()
    if ficha < date(2000, 1, 1) or ficha > today + timedelta(days=1):
        return False
    if delivery and ficha > delivery:
        return False
    return True


def append_observation(current: Any, note: str) -> str:
    base = clean(current)
    if not note:
        return base
    if note in base:
        return base
    if not base:
        return note
    return base + " · " + note


def build_plan(drive, sheets) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows, header_index, columns = read_master(sheets)
    body_rows = max(0, len(rows) - header_index - 1)
    first_body_row = header_index + 2
    invoice_links = p.read_link_column(
        sheets, columns[H["invoice"]], first_body_row, body_rows
    )
    catalog = read_raw_catalog_metadata(sheets)
    fallback = catalog.get(("__fallback__", "__fallback__"), {})  # type: ignore[assignment]

    plans: list[dict[str, Any]] = []
    stats = defaultdict(int)
    cache: dict[str, tuple[str, dict[str, Any]]] = {}

    for body_index, row_index in enumerate(range(header_index + 1, len(rows))):
        row = rows[row_index]
        order_id = clean(row[columns[H["id"]]]) if columns[H["id"]] < len(row) else ""
        if not re.fullmatch(r"\d{4}", order_id):
            continue

        state = clean(row[columns[H["state"]]]) if columns[H["state"]] < len(row) else ""
        missing_target = (
            state == TARGET_STATE
            or not clean(row[columns[H["date"]]] if columns[H["date"]] < len(row) else "")
            or not clean(row[columns[H["material"]]] if columns[H["material"]] < len(row) else "")
        )
        if not missing_target:
            continue
        stats["candidate_rows"] += 1

        link = invoice_links[body_index] if body_index < len(invoice_links) else p.LinkCell("", "")
        file_id = p._extract_drive_id(link.url)
        if not file_id:
            stats["no_invoice_link"] += 1
            continue

        if file_id not in cache:
            try:
                meta = drive.files().get(
                    fileId=file_id,
                    fields="id,name,mimeType",
                    supportsAllDrives=True,
                ).execute()
                name = clean(meta.get("name"))
                content = p._download_file(drive, file_id)
                parsed = parse_workbook(content, name)
                cache[file_id] = (name, parsed)
                stats["files_parsed"] += 1
            except Exception:
                stats["parse_errors"] += 1
                continue

        _name, parsed = cache[file_id]
        internal_order = clean(parsed.get("order_id"))
        if internal_order and internal_order != order_id:
            stats["order_mismatches"] += 1
            continue

        raw_meta = catalog.get((order_id, file_id)) or fallback.get(order_id, {})
        updates: dict[str, Any] = {}

        current_date = row[columns[H["date"]]] if columns[H["date"]] < len(row) else ""
        current_model = row[columns[H["model"]]] if columns[H["model"]] < len(row) else ""
        current_material = row[columns[H["material"]]] if columns[H["material"]] < len(row) else ""
        current_measures = row[columns[H["measures"]]] if columns[H["measures"]] < len(row) else ""
        current_specs = row[columns[H["specs"]]] if columns[H["specs"]] < len(row) else ""
        current_text = row[columns[H["text"]]] if columns[H["text"]] < len(row) else ""
        delivery = as_date(row[columns[H["delivery"]]] if columns[H["delivery"]] < len(row) else None)
        received = as_date(row[columns[H["received"]]] if columns[H["received"]] < len(row) else None)
        dashboard = as_date(row[columns[H["dashboard"]]] if columns[H["dashboard"]] < len(row) else None)
        ficha = parsed.get("date")

        if not clean(current_date):
            if plausible_ficha_date(ficha, delivery):
                updates[H["date"]] = excel_serial(ficha)
                stats["dates_recovered"] += 1
                if received is None and (dashboard is None or dashboard == delivery):
                    updates[H["dashboard"]] = excel_serial(ficha)
                    stats["dashboard_dates_improved"] += 1
            elif ficha is not None:
                stats["date_conflicts"] += 1

        if not clean(current_model):
            model = clean(raw_meta.get("model")) or clean(parsed.get("model"))
            model = normalize_model(model)
            if model:
                updates[H["model"]] = model
                stats["models_recovered"] += 1

        if not clean(current_material):
            material = clean(raw_meta.get("material")) or clean(parsed.get("material"))
            if material:
                updates[H["material"]] = material
                stats["materials_recovered"] += 1

        if not clean(current_measures):
            measures = clean(raw_meta.get("measures"))
            if measures:
                updates[H["measures"]] = measures
                stats["measures_recovered"] += 1

        if not clean(current_specs):
            specs = clean(raw_meta.get("specs"))
            if specs:
                updates[H["specs"]] = specs
                stats["specs_recovered"] += 1

        if not clean(current_text):
            text = clean(raw_meta.get("text"))
            if text and normalize(text) not in {"sin texto", "sin texto."}:
                updates[H["text"]] = text
                stats["texts_recovered"] += 1

        if updates:
            if state == TARGET_STATE:
                updates[H["state"]] = RECOVERED_STATE
            note = "Histórico enriquecido desde albarán XLS/XLSX validado"
            if ficha is not None and not plausible_ficha_date(ficha, delivery):
                note += "; fecha interna no usada por ser posterior/incompatible con la entrega"
            current_obs = row[columns[H["observation"]]] if columns[H["observation"]] < len(row) else ""
            updates[H["observation"]] = append_observation(current_obs, note)
            plans.append({
                "row_index_zero": row_index,
                "order_id": order_id,
                "updates": updates,
            })
            stats["rows_backfillable"] += 1

    summary = {
        "mode": "HISTORICAL_MASTER_BACKFILL_PLAN",
        **dict(sorted(stats.items())),
        "write_operations": 0,
    }
    return plans, summary


def col_letter(index_zero: int) -> str:
    n = index_zero + 1
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


def sync(confirm: str) -> dict[str, Any]:
    assert_write_allowed(confirm)
    drive, sheets = p.build_services()
    rows, header_index, columns = read_master(sheets)
    plans, before = build_plan(drive, sheets)

    data = []
    for plan in plans:
        row_number = plan["row_index_zero"] + 1
        for header, value in plan["updates"].items():
            letter = col_letter(columns[header])
            data.append({
                "range": f"'{SHEET_NAME}'!{letter}{row_number}",
                "values": [[value]],
            })

    if data:
        sheets.spreadsheets().values().batchUpdate(
            spreadsheetId=MASTER_ID,
            body={
                "valueInputOption": "RAW",
                "data": data,
            },
        ).execute()

    _post_plans, after = build_plan(drive, sheets)
    result = {
        "mode": "HISTORICAL_MASTER_BACKFILL_SYNC",
        "rows_written": len(plans),
        "cells_written": len(data),
        "remaining_backfillable": after.get("rows_backfillable", 0),
        "remaining_no_invoice_link": after.get("no_invoice_link", 0),
        "remaining_date_conflicts": after.get("date_conflicts", 0),
        "remaining_order_mismatches": after.get("order_mismatches", 0),
        "before": before,
    }
    print("HISTORICAL_MASTER_BACKFILL_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return result


def dry_run() -> dict[str, Any]:
    drive, sheets = p.build_services()
    _plans, summary = build_plan(drive, sheets)
    print("HISTORICAL_MASTER_BACKFILL_DRY_RUN_OK")
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--sync", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()

    if args.dry_run:
        dry_run()
        return 0
    sync(args.confirm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
