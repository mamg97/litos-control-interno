from __future__ import annotations

from copy import copy
from io import BytesIO

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

CUSTOMER_PROFILE_VERSION = "primary-client-private-v2"
PRIVATE_CONFIG_SHEET = "Configuracion privada"
CUSTOMER_KEYS = {
    "name": "cliente_nombre",
    "address": "cliente_direccion",
    "city": "cliente_ciudad",
    "province": "cliente_provincia",
}
ISSUER_KEYS = {
    "company": "issuer_company",
    "nif": "issuer_nif",
    "address": "issuer_address",
    "phone": "issuer_phone",
    "city": "issuer_city",
    "trade": "issuer_trade",
}

NAVY = "16227A"
DARK = "1F2937"
MUTED = "667085"
LINE = "D6DCE3"
WHITE = "FFFFFF"
RED = "D9272E"

THIN = Side(style="thin", color=LINE)
NAVY_SIDE = Side(style="medium", color=NAVY)
RED_SIDE = Side(style="medium", color=RED)


def _text(value) -> str:
    return str(value if value is not None else "").strip()


def load_private_header_profile(sheets, spreadsheet_id: str) -> dict:
    values = sheets.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=f"'{PRIVATE_CONFIG_SHEET}'!A1:B100",
        valueRenderOption="FORMATTED_VALUE",
    ).execute().get("values", [])
    config = {}
    for row in values:
        if len(row) >= 2 and _text(row[0]):
            config[_text(row[0])] = _text(row[1])

    customer = {key: config.get(source, "") for key, source in CUSTOMER_KEYS.items()}
    issuer = {key: config.get(source, "") for key, source in ISSUER_KEYS.items()}
    missing_customer = [k for k, v in customer.items() if not _text(v)]
    missing_issuer = [k for k, v in issuer.items() if not _text(v)]
    if missing_customer or missing_issuer:
        raise RuntimeError(
            "Private header configuration is incomplete: "
            + ", ".join([*(f"customer.{k}" for k in missing_customer), *(f"issuer.{k}" for k in missing_issuer)])
        )
    return {"customer": customer, "issuer": issuer}


def _find_title_row(ws) -> int:
    for row in range(1, ws.max_row + 1):
        if _text(ws.cell(row, 1).value).upper() == "ALBARÁN":
            return row
    raise RuntimeError("Client header contract changed: ALBARÁN row not found")


def _transaction_state(ws, start_row: int) -> tuple:
    out = []
    for row in ws.iter_rows(min_row=start_row, max_row=ws.max_row, min_col=1, max_col=7):
        for cell in row:
            out.append((cell.coordinate, cell.data_type, cell.value))
    return tuple(out)


def _unmerge_header(ws) -> None:
    for merged in list(ws.merged_cells.ranges):
        if merged.min_row >= 1 and merged.max_row <= 5:
            ws.unmerge_cells(str(merged))


def _merge_value(ws, cell_range: str, value: str, *, font: Font, alignment: Alignment,
                 fill: str = WHITE, border: Border | None = None) -> None:
    ws.merge_cells(cell_range)
    top_left = ws[cell_range.split(":", 1)[0]]
    top_left.value = value
    top_left.font = copy(font)
    top_left.alignment = copy(alignment)
    for row in ws[cell_range]:
        for cell in row:
            cell.fill = PatternFill("solid", fgColor=fill)
            if border:
                cell.border = copy(border)


def apply_client_header(xlsx_bytes: bytes, *, customer: dict, issuer: dict) -> bytes:
    """Render private issuer/client identity without storing it in the public repository."""
    customer = {k: _text(v) for k, v in customer.items()}
    issuer = {k: _text(v) for k, v in issuer.items()}
    if any(not customer.get(key) for key in CUSTOMER_KEYS):
        raise RuntimeError("Customer header requires name, address, city and province")
    if any(not issuer.get(key) for key in ISSUER_KEYS):
        raise RuntimeError("Issuer header configuration is incomplete")

    wb = load_workbook(BytesIO(xlsx_bytes), data_only=False)
    ws = wb.worksheets[0]
    title_row = _find_title_row(ws)
    if title_row < 6:
        raise RuntimeError("Client header contract changed: expected five-row issuer header")

    before = _transaction_state(ws, title_row)
    _unmerge_header(ws)
    for row in range(1, 6):
        for col in range(1, 8):
            cell = ws.cell(row, col)
            cell.value = None
            cell.fill = PatternFill("solid", fgColor=WHITE)
            cell.border = Border()
            cell.alignment = Alignment(vertical="center")

    _merge_value(ws, "B1:D1", issuer["company"], font=Font(name="Arial", size=11.5, bold=True, color=NAVY), alignment=Alignment(horizontal="left", vertical="center"))
    _merge_value(ws, "B2:D2", issuer["nif"], font=Font(name="Arial", size=8.2, color=MUTED), alignment=Alignment(horizontal="left", vertical="center"))
    _merge_value(ws, "B3:C3", issuer["address"], font=Font(name="Arial", size=8.2, color=DARK), alignment=Alignment(horizontal="left", vertical="center"))
    ws["D3"] = issuer["phone"]
    ws["D3"].font = Font(name="Arial", size=7.5, color=DARK)
    ws["D3"].alignment = Alignment(horizontal="right", vertical="center", shrink_to_fit=True)
    _merge_value(ws, "B4:D4", issuer["city"], font=Font(name="Arial", size=8.5, bold=True, color=DARK), alignment=Alignment(horizontal="left", vertical="center"))
    _merge_value(ws, "B5:D5", issuer["trade"], font=Font(name="Arial", size=8.8, bold=True, color=NAVY), alignment=Alignment(horizontal="left", vertical="center"))

    _merge_value(ws, "E1:G1", "CLIENTE", font=Font(name="Arial", size=8.5, bold=True, color=WHITE), alignment=Alignment(horizontal="left", vertical="center"), fill=NAVY, border=Border(left=NAVY_SIDE, right=NAVY_SIDE, top=NAVY_SIDE, bottom=THIN))
    customer_rows = ((2, customer["name"], True), (3, customer["address"], False), (4, customer["city"], False), (5, customer["province"], False))
    for row, value, bold in customer_rows:
        bottom = RED_SIDE if row == 5 else THIN
        _merge_value(ws, f"E{row}:G{row}", value, font=Font(name="Arial", size=8.4 if row != 2 else 8.6, bold=bold, color=DARK), alignment=Alignment(horizontal="left", vertical="center", shrink_to_fit=True), border=Border(left=NAVY_SIDE, right=NAVY_SIDE, top=THIN, bottom=bottom))

    ws.row_dimensions[1].height = max(ws.row_dimensions[1].height or 0, 25)
    for row, minimum in ((2, 16), (3, 18), (4, 18), (5, 18)):
        ws.row_dimensions[row].height = max(ws.row_dimensions[row].height or 0, minimum)

    after = _transaction_state(ws, title_row)
    if after != before:
        raise RuntimeError("Customer header guard: transactional cell values/formulas changed")

    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def _build_self_test_workbook() -> bytes:
    wb = Workbook()
    ws = wb.active
    for rng, value in (("A1:G1", "TALLER DE PRUEBA"), ("A2:G2", "N.I.F. TEST"), ("A3:E3", "DIRECCIÓN TEST"), ("F3:G3", "TELÉFONO TEST"), ("A4:G4", "LOCALIDAD TEST"), ("A5:G5", "ACTIVIDAD TEST"), ("A6:G6", "ALBARÁN")):
        ws.merge_cells(rng); ws[rng.split(":")[0]] = value
    ws["A7"] = "BORRADOR"
    ws["A8"] = "PEDIDO Nº"; ws["B8"] = 9999; ws["G9"] = "=1+1"
    buf = BytesIO(); wb.save(buf); return buf.getvalue()


def self_test() -> dict:
    customer = {"name": "CLIENTE TEST", "address": "DIRECCIÓN CLIENTE", "city": "CIUDAD CLIENTE", "province": "PROVINCIA CLIENTE"}
    issuer = {"company": "TALLER TEST", "nif": "NIF TEST", "address": "DIRECCIÓN TALLER", "phone": "TEL TEST", "city": "CIUDAD TALLER", "trade": "ACTIVIDAD TEST"}
    result = apply_client_header(_build_self_test_workbook(), customer=customer, issuer=issuer)
    wb = load_workbook(BytesIO(result), data_only=False); ws = wb.active
    assert ws["E1"].value == "CLIENTE"
    assert ws["E2"].value == customer["name"]
    assert ws["B1"].value == issuer["company"]
    assert ws["A6"].value == "ALBARÁN"
    assert ws["G9"].value == "=1+1"
    return {"status": "CLIENT_HEADER_VALIDATION_OK", "customer_profile_version": CUSTOMER_PROFILE_VERSION}


if __name__ == "__main__":
    print(self_test())
