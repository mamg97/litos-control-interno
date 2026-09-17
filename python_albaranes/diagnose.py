from __future__ import annotations

import io
import json
import re
from typing import Any

import openpyxl
import xlrd

import parity as p


def _safe_formula(value: Any) -> str:
    text = p._clean(value)
    if not text.startswith("="):
        return ""
    text = re.sub(r'"[^"]*"', '"…"', text)
    return text[:200]


def _inspect_openxml(content: bytes) -> dict:
    formula_book = openpyxl.load_workbook(io.BytesIO(content), read_only=False, data_only=False)
    value_book = openpyxl.load_workbook(io.BytesIO(content), read_only=False, data_only=True)
    try:
        hits = []
        for formula_sheet in formula_book.worksheets:
            value_sheet = value_book[formula_sheet.title]
            for row in formula_sheet.iter_rows():
                for cell in row:
                    if p._normalize(cell.value) != "total":
                        continue
                    adjacent = []
                    for offset in range(1, 7):
                        col = cell.column + offset
                        formula_cell = formula_sheet.cell(row=cell.row, column=col)
                        value_cell = value_sheet.cell(row=cell.row, column=col)
                        if formula_cell.value is None and value_cell.value is None:
                            continue
                        item = {
                            "coord": formula_cell.coordinate,
                            "formula_type": formula_cell.data_type,
                            "cached_value": value_cell.value,
                        }
                        formula = _safe_formula(formula_cell.value)
                        if formula:
                            item["formula"] = formula
                        elif formula_cell.value is not None:
                            number = p._number(formula_cell.value)
                            item["literal_number"] = number
                            item["literal_type"] = type(formula_cell.value).__name__
                        adjacent.append(item)
                    hits.append(
                        {
                            "sheet": formula_sheet.title[:80],
                            "total_label_coord": cell.coordinate,
                            "adjacent": adjacent,
                        }
                    )
        calc = getattr(formula_book, "calculation", None)
        calc_info = {}
        if calc is not None:
            for attr in ("calcMode", "fullCalcOnLoad", "forceFullCalc", "calcOnSave"):
                value = getattr(calc, attr, None)
                if value is not None:
                    calc_info[attr] = value
        return {"format": "openxml", "total_hits": hits, "calculation": calc_info}
    finally:
        formula_book.close()
        value_book.close()


def _inspect_xls(content: bytes) -> dict:
    book = xlrd.open_workbook(file_contents=content, on_demand=True)
    try:
        hits = []
        for sheet in book.sheets():
            for row_index in range(sheet.nrows):
                values = sheet.row_values(row_index)
                for col, value in enumerate(values):
                    if p._normalize(value) != "total":
                        continue
                    adjacent = []
                    for offset, candidate in enumerate(values[col + 1 : col + 7], start=1):
                        if candidate in (None, ""):
                            continue
                        adjacent.append(
                            {
                                "col_offset": offset,
                                "value": candidate,
                                "number": p._number(candidate),
                                "type": type(candidate).__name__,
                            }
                        )
                    hits.append(
                        {
                            "sheet": sheet.name[:80],
                            "row_one_based": row_index + 1,
                            "col_one_based": col + 1,
                            "adjacent": adjacent,
                        }
                    )
        return {"format": "xls", "total_hits": hits}
    finally:
        book.release_resources()


def inspect_file(drive, file: p.DriveFile) -> dict:
    content = p._download_file(drive, file.file_id)
    lower = file.name.lower()
    if lower.endswith(".xls") and not lower.endswith(".xlsx"):
        return _inspect_xls(content)
    return _inspect_openxml(content)


def main() -> int:
    drive, sheets = p.build_services()
    index = p.scan_albaranes(drive)
    rows, header_index, columns = p.read_sheet_values(sheets)

    mismatches = []
    parsed_by_file: dict[str, float | None] = {}

    for row_index in range(header_index + 1, len(rows)):
        row = rows[row_index]
        id_col = columns[p.HEADERS["id"]]
        order_id = p._clean(row[id_col]) if id_col < len(row) else ""
        if not order_id or order_id not in index:
            continue

        entry = index[order_id]
        invoice = entry.get("invoice")
        draft = entry.get("draft")
        active = invoice or draft
        if active is None:
            continue

        if active.file_id not in parsed_by_file:
            parsed_by_file[active.file_id] = p.read_total(drive, active)
        python_total = parsed_by_file[active.file_id]

        total_col = columns[p.HEADERS["total"]]
        sheet_raw = row[total_col] if total_col < len(row) else None
        sheet_total = p._number(sheet_raw)

        reason = ""
        if python_total is None:
            if sheet_total is not None or p._clean(sheet_raw):
                reason = "parser_unavailable_with_sheet_total"
        elif not p._same_number(sheet_raw, python_total):
            reason = "numeric_mismatch"

        if not reason:
            continue

        extension = active.name.lower().rsplit(".", 1)[-1] if "." in active.name else "unknown"
        detail = {
            "order_id": order_id,
            "active_kind": "invoice" if invoice is not None else "draft",
            "extension": extension,
            "reason": reason,
            "sheet_total": sheet_total,
            "python_total": python_total,
            "workbook": inspect_file(drive, active),
        }
        mismatches.append(detail)

    print("ALBARANES_DIAGNOSTIC_OK")
    print(
        json.dumps(
            {
                "phase": "M6",
                "mode": "READ_ONLY_TOTAL_DIAGNOSTIC",
                "mismatch_count": len(mismatches),
                "mismatches": mismatches,
                "write_operations": 0,
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
