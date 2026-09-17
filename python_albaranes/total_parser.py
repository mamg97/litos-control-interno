from __future__ import annotations

import io
import math
import re
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

import openpyxl
import xlrd
from openpyxl.utils.cell import range_boundaries

SUM_RANGE_RE = re.compile(
    r"^=SUM\((?:(?:'([^']+)'|([^'!]+))!)?(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)\)$",
    re.IGNORECASE,
)


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


def _decimal(value: Any) -> Decimal | None:
    number = _number(value)
    if number is None:
        return None
    try:
        return Decimal(str(number))
    except InvalidOperation:
        return None


def _currency(value: Decimal | float | int | None) -> float | None:
    if value is None:
        return None
    decimal = value if isinstance(value, Decimal) else Decimal(str(value))
    if decimal <= 0:
        return None
    return float(decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _sum_formula(
    formula: str,
    current_formula_sheet,
    value_book,
) -> Decimal | None:
    compact = formula.replace(" ", "")
    match = SUM_RANGE_RE.match(compact)
    if not match:
        return None

    quoted_sheet, plain_sheet, start_ref, end_ref = match.groups()
    target_title = quoted_sheet or plain_sheet or current_formula_sheet.title
    if target_title not in value_book.sheetnames:
        return None
    value_sheet = value_book[target_title]

    start_ref = start_ref.replace("$", "")
    end_ref = end_ref.replace("$", "")
    min_col, min_row, max_col, max_row = range_boundaries(f"{start_ref}:{end_ref}")

    total = Decimal("0")
    saw_number = False
    for row in value_sheet.iter_rows(
        min_row=min_row,
        max_row=max_row,
        min_col=min_col,
        max_col=max_col,
    ):
        for cell in row:
            decimal = _decimal(cell.value)
            if decimal is None:
                if cell.value in (None, ""):
                    continue
                return None
            total += decimal
            saw_number = True
    return total if saw_number else None


def read_total_openxml(content: bytes) -> float | None:
    formula_book = openpyxl.load_workbook(io.BytesIO(content), read_only=False, data_only=False)
    value_book = openpyxl.load_workbook(io.BytesIO(content), read_only=False, data_only=True)
    try:
        for formula_sheet in formula_book.worksheets:
            value_sheet = value_book[formula_sheet.title]
            for row in formula_sheet.iter_rows():
                for cell in row:
                    if _normalize(cell.value) != "total":
                        continue

                    for column in range(cell.column + 1, formula_sheet.max_column + 1):
                        formula_cell = formula_sheet.cell(row=cell.row, column=column)
                        cached_cell = value_sheet.cell(row=cell.row, column=column)

                        if formula_cell.data_type == "f" and isinstance(formula_cell.value, str):
                            evaluated = _sum_formula(formula_cell.value, formula_sheet, value_book)
                            if evaluated is not None:
                                return _currency(evaluated)

                        cached = _decimal(cached_cell.value)
                        if cached is not None:
                            return _currency(cached)

                        literal = _decimal(formula_cell.value)
                        if literal is not None:
                            return _currency(literal)
        return None
    finally:
        formula_book.close()
        value_book.close()


def read_total_xls(content: bytes) -> float | None:
    workbook = xlrd.open_workbook(file_contents=content, on_demand=True)
    try:
        for sheet in workbook.sheets():
            for row_index in range(sheet.nrows):
                values = sheet.row_values(row_index)
                for col, value in enumerate(values):
                    if _normalize(value) != "total":
                        continue
                    for candidate in values[col + 1 :]:
                        decimal = _decimal(candidate)
                        if decimal is not None:
                            return _currency(decimal)
        return None
    finally:
        workbook.release_resources()


def read_total_from_bytes(file_name: str, content: bytes) -> float | None:
    lower = file_name.lower()
    if lower.endswith(".xls") and not lower.endswith(".xlsx"):
        return read_total_xls(content)
    return read_total_openxml(content)
