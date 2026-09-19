from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime
from typing import Any

import parity as p
import pvp_backfill as pv
import delivery_date_backfill as ddb
from total_parser import read_total_from_bytes

TARGET_YEAR = 2026
FINAL_HEADER = "Precio final (€)"
TOTAL_HEADER = "Total sheet (€)"
OBS_HEADER = "Observación de conciliación"
INVOICE_HEADER = "Archivo factura / albarán (XLSX)"


def clean(v: Any) -> str:
    return str("" if v is None else v).strip()


def parse_internal_order(content: bytes, name: str, mime_type: str) -> str:
    lower = name.lower()
    if lower.endswith(".pdf"):
        parsed = ddb.parse_pdf_all(content, name)
        if not parsed:
            return ""
        # Prefer an explicit internal order read from document content.
        for item in parsed.values():
            if item.internal_order:
                return item.internal_order
        return ""
    workbook_name = name
    if mime_type == p.GOOGLE_SHEETS_MIME and not re.search(r"\.(xls|xlsx|xlsm)$", lower):
        workbook_name += ".xlsx"
    return clean(pv.parse_workbook(content, workbook_name).internal_order)


def same_money(current: Any, expected: float) -> bool:
    return p._same_number(current, expected)


def link_cell_unavailable() -> dict:
    return {"userEnteredValue": {"stringValue": "No disponible"}, "textFormatRuns": []}


def cell_request(sheet_id: int, row_zero: int, col_zero: int, cell: dict, fields: str) -> dict:
    return {
        "updateCells": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": row_zero,
                "endRowIndex": row_zero + 1,
                "startColumnIndex": col_zero,
                "endColumnIndex": col_zero + 1,
            },
            "rows": [{"values": [cell]}],
            "fields": fields,
        }
    }


def append_obs(current: Any, note: str) -> str:
    base = clean(current)
    if note in base:
        return base
    return note if not base else base + " · " + note


def sheet_id(sheets) -> int:
    response = sheets.spreadsheets().get(
        spreadsheetId=p.MASTER_ID,
        fields="sheets(properties(sheetId,title))",
    ).execute()
    for sheet in response.get("sheets", []) or []:
        props = sheet.get("properties", {}) or {}
        if props.get("title") == p.SHEET_NAME:
            return int(props["sheetId"])
    raise RuntimeError("Pedidos sheetId not found")


def build_plan():
    drive, sheets = p.build_services()
    rows, header_index, columns = p.read_sheet_values(sheets)
    for h in (FINAL_HEADER, TOTAL_HEADER, OBS_HEADER, INVOICE_HEADER):
        if h not in columns:
            raise RuntimeError(f"Missing master header: {h}")

    body_rows = max(0, len(rows) - header_index - 1)
    first_body_row = header_index + 2
    links = p.read_link_column(sheets, columns[INVOICE_HEADER], first_body_row, body_rows)

    plans = []
    stats = {
        "target_year": TARGET_YEAR,
        "rows_in_phase": 0,
        "invoice_links": 0,
        "valid_documents": 0,
        "internal_id_mismatch": 0,
        "internal_id_missing": 0,
        "total_missing": 0,
        "price_updates": 0,
        "total_updates": 0,
        "invalid_link_clears": 0,
        "already_correct_price": 0,
        "write_operations": 0,
    }

    for body_index, row_index in enumerate(range(header_index + 1, len(rows))):
        row = rows[row_index]
        order_id = clean(row[columns[p.HEADERS["id"]]] if columns[p.HEADERS["id"]] < len(row) else "")
        if not re.fullmatch(r"\d{4}", order_id):
            continue
        if ddb.row_year(row, columns) != TARGET_YEAR:
            continue
        stats["rows_in_phase"] += 1

        link = links[body_index] if body_index < len(links) else p.LinkCell("", "")
        file_id = p._extract_drive_id(link.url)
        if not file_id:
            continue
        stats["invoice_links"] += 1

        meta = drive.files().get(
            fileId=file_id,
            fields="id,name,mimeType,webViewLink",
            supportsAllDrives=True,
        ).execute()
        name = clean(meta.get("name"))
        mime = clean(meta.get("mimeType"))
        if p.NOTE_RE.search(name.lower()) or p.DRAFT_RE.search(name.lower()):
            internal = ""
            total = None
            invalid_reason = f"documento activo no definitivo: {name}"
        else:
            content = p._download_file(drive, file_id, mime)
            try:
                internal = parse_internal_order(content, name, mime)
            except Exception:
                internal = ""
            total = read_total_from_bytes(name if name.lower().endswith((".pdf",".xls",".xlsx",".xlsm")) else name + ".xlsx", content)
            invalid_reason = ""

        current_obs = row[columns[OBS_HEADER]] if columns[OBS_HEADER] < len(row) else ""
        current_final = row[columns[FINAL_HEADER]] if columns[FINAL_HEADER] < len(row) else None
        current_total = row[columns[TOTAL_HEADER]] if columns[TOTAL_HEADER] < len(row) else None

        if not internal:
            stats["internal_id_missing"] += 1
            plans.append({
                "row": row_index,
                "order_id": order_id,
                "action": "invalidate",
                "observation": append_obs(current_obs, f"REVISAR ALBARÁN: {invalid_reason or 'el documento enlazado no contiene un ID de pedido interno validable'}"),
            })
            stats["invalid_link_clears"] += 1
            continue

        if internal != order_id:
            stats["internal_id_mismatch"] += 1
            plans.append({
                "row": row_index,
                "order_id": order_id,
                "action": "invalidate",
                "observation": append_obs(current_obs, f"REVISAR ALBARÁN: el documento enlazado corresponde internamente al pedido {internal}, no al {order_id}"),
            })
            stats["invalid_link_clears"] += 1
            continue

        if total is None:
            stats["total_missing"] += 1
            continue

        stats["valid_documents"] += 1
        update_price = not same_money(current_final, total)
        update_total = not same_money(current_total, total)
        if update_price:
            stats["price_updates"] += 1
        else:
            stats["already_correct_price"] += 1
        if update_total:
            stats["total_updates"] += 1
        if update_price or update_total:
            plans.append({
                "row": row_index,
                "order_id": order_id,
                "action": "price",
                "total": total,
                "update_price": update_price,
                "update_total": update_total,
                "observation": append_obs(current_obs, f"Precio final validado desde albarán definitivo {name}: {total:.2f} €"),
            })

    return sheets, columns, plans, stats


def run(sync: bool):
    sheets, columns, plans, stats = build_plan()
    if not sync:
        print("FINAL_PRICE_2026_AUDIT_OK")
        print(json.dumps({**stats, "planned_rows": len(plans)}, ensure_ascii=False, sort_keys=True))
        return

    if not (p._bool_env("LITOS_FREE_ONLY") if hasattr(p, "_bool_env") else True):
        pass
    sid = sheet_id(sheets)
    requests = []
    for plan in plans:
        row = plan["row"]
        if plan["action"] == "invalidate":
            requests.append(cell_request(sid, row, columns[INVOICE_HEADER], link_cell_unavailable(), "userEnteredValue,textFormatRuns"))
            requests.append(cell_request(sid, row, columns[TOTAL_HEADER], {}, "userEnteredValue"))
            requests.append(cell_request(sid, row, columns[FINAL_HEADER], {}, "userEnteredValue"))
            requests.append(cell_request(sid, row, columns[OBS_HEADER], {"userEnteredValue":{"stringValue":plan["observation"]}}, "userEnteredValue"))
        else:
            if plan["update_total"]:
                requests.append(cell_request(sid, row, columns[TOTAL_HEADER], {"userEnteredValue":{"numberValue":float(plan["total"])}}, "userEnteredValue"))
            if plan["update_price"]:
                requests.append(cell_request(
                    sid, row, columns[FINAL_HEADER],
                    {
                        "userEnteredValue":{"numberValue":float(plan["total"])},
                        "userEnteredFormat":{"numberFormat":{"type":"NUMBER","pattern":'#,##0.00 [$€-es-ES]'}}
                    },
                    "userEnteredValue,userEnteredFormat.numberFormat"
                ))
            requests.append(cell_request(sid, row, columns[OBS_HEADER], {"userEnteredValue":{"stringValue":plan["observation"]}}, "userEnteredValue"))

    for start in range(0, len(requests), 150):
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=p.MASTER_ID,
            body={"requests": requests[start:start+150]},
        ).execute()

    print("FINAL_PRICE_2026_REPAIR_OK")
    print(json.dumps({**stats, "planned_rows": len(plans), "write_operations": len(requests)}, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync", action="store_true")
    args = parser.parse_args()
    run(args.sync)


if __name__ == "__main__":
    main()
