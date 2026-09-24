from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from typing import Any

import parity as p
from total_parser import read_total_from_bytes


@dataclass
class RowPlan:
    row_index_zero: int
    body_index: int
    order_id: str
    invoice: p.DriveFile | None
    draft: p.DriveFile | None
    expected_total: float | None
    invoice_update: bool
    draft_update: bool
    total_update: bool
    final_price_update: bool

    @property
    def changed(self) -> bool:
        return self.invoice_update or self.draft_update or self.total_update or self.final_price_update


def _bool_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def _assert_write_allowed() -> None:
    if not _bool_env("LITOS_FREE_ONLY"):
        raise RuntimeError("LITOS_FREE_ONLY must be true")
    if not _bool_env("LITOS_ALBARAN_WRITE_ENABLED"):
        raise RuntimeError("LITOS_ALBARAN_WRITE_ENABLED must be true")
    if os.environ.get("LITOS_ALBARAN_KILL_SWITCH", "").strip().lower() != "false":
        raise RuntimeError("LITOS_ALBARAN_KILL_SWITCH must be explicitly false")


def _drive_url(file: p.DriveFile | None) -> str:
    if file is None:
        return ""
    return file.web_view_link or f"https://drive.google.com/open?id={file.file_id}"


def _sheet_id(sheets) -> int:
    response = (
        sheets.spreadsheets()
        .get(
            spreadsheetId=p.MASTER_ID,
            fields="sheets(properties(sheetId,title))",
        )
        .execute()
    )
    for sheet in response.get("sheets", []) or []:
        props = sheet.get("properties", {}) or {}
        if props.get("title") == p.SHEET_NAME:
            return int(props["sheetId"])
    raise RuntimeError(f"No se encontró la hoja {p.SHEET_NAME}")


def _read_total_formula_aware(drive, file: p.DriveFile) -> float | None:
    content = p._download_file(drive, file.file_id, file.mime_type)
    return read_total_from_bytes(file.name, content)


def _total_matches(current: Any, expected: float | None) -> bool:
    if expected is None:
        return p._number(current) is None and not p._clean(current)
    return p._same_number(current, expected)


def build_plan(*, links_only: bool = False) -> tuple[Any, Any, list[RowPlan], dict]:
    drive, sheets = p.build_services()
    index = p.scan_albaranes(drive)
    rows, header_index, columns = p.read_sheet_values(sheets)

    body_rows = max(0, len(rows) - header_index - 1)
    first_body_row = header_index + 2
    invoice_links = p.read_link_column(
        sheets, columns[p.HEADERS["invoice"]], first_body_row, body_rows
    )
    draft_links = p.read_link_column(
        sheets, columns[p.HEADERS["draft"]], first_body_row, body_rows
    )

    parsed_by_file: dict[str, float | None] = {}
    parse_errors = 0
    parse_error_orders: list[str] = []
    rows_matched = 0
    plans: list[RowPlan] = []

    for body_index, row_index in enumerate(range(header_index + 1, len(rows))):
        row = rows[row_index]
        id_col = columns[p.HEADERS["id"]]
        order_id = p._clean(row[id_col]) if id_col < len(row) else ""
        if not order_id or order_id not in index:
            continue

        rows_matched += 1
        entry = index[order_id]
        invoice = entry.get("invoice")
        draft = entry.get("draft")
        active = invoice or draft

        expected_total: float | None = None
        total_update = False
        final_price_update = False
        if not links_only and active is not None:
            try:
                if active.file_id not in parsed_by_file:
                    parsed_by_file[active.file_id] = _read_total_formula_aware(drive, active)
                expected_total = parsed_by_file[active.file_id]
            except Exception:
                # Fail closed: never write a partial plan if an active workbook
                # could not be interpreted. Keep diagnostics privacy-safe by
                # logging only the four-digit work ID, never document contents.
                parse_errors += 1
                parse_error_orders.append(order_id)
                continue

            total_col = columns[p.HEADERS["total"]]
            current_total = row[total_col] if total_col < len(row) else None
            # Fail closed: an unparseable definitive document must never erase
            # a previously validated total from the master.
            total_update = expected_total is not None and not _total_matches(current_total, expected_total)

            # Precio final is a canonical business field consumed by M7.
            # Populate it only from a definitive invoice/albarán, never from a draft.
            if invoice is not None and expected_total is not None:
                final_col = columns[p.HEADERS["final"]]
                current_final = row[final_col] if final_col < len(row) else None
                final_price_update = not _total_matches(current_final, expected_total)

        plans.append(
            RowPlan(
                row_index_zero=row_index,
                body_index=body_index,
                order_id=order_id,
                invoice=invoice,
                draft=draft,
                expected_total=expected_total,
                invoice_update=not p.link_matches(
                    invoice_links[body_index], invoice, "Abrir"
                ),
                draft_update=not p.link_matches(
                    draft_links[body_index], draft, "Abrir borrador"
                ),
                total_update=total_update,
                final_price_update=final_price_update,
            )
        )

    if parse_errors:
        unique_orders = sorted(set(parse_error_orders))
        raise RuntimeError(
            f"Aborted before writes: {parse_errors} active workbook(s) could not be parsed; "
            f"orders={','.join(unique_orders)}"
        )

    changed = [plan for plan in plans if plan.changed]
    summary = {
        "mode": "ALBARANES_LINKS_ONLY_PLAN" if links_only else "ALBARANES_FULL_PLAN",
        "phase": "M6",
        "files_indexed": len(index),
        "rows_matched": rows_matched,
        "candidate_rows": len(changed),
        "invoice_updates": sum(1 for plan in plans if plan.invoice_update),
        "draft_updates": sum(1 for plan in plans if plan.draft_update),
        "total_updates": sum(1 for plan in plans if plan.total_update),
        "final_price_updates": sum(1 for plan in plans if plan.final_price_update),
        "total_reads": len(parsed_by_file),
        "write_operations": 0,
    }
    return drive, sheets, plans, summary


def _link_cell(label: str, url: str) -> dict:
    if not url:
        return {
            "userEnteredValue": {"stringValue": "No disponible"},
            "textFormatRuns": [],
        }
    return {
        "userEnteredValue": {"stringValue": label},
        "textFormatRuns": [
            {
                "startIndex": 0,
                "format": {"link": {"uri": url}},
            }
        ],
    }


def _update_cell_request(sheet_id: int, row: int, col: int, cell: dict, fields: str) -> dict:
    return {
        "updateCells": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": row,
                "endRowIndex": row + 1,
                "startColumnIndex": col,
                "endColumnIndex": col + 1,
            },
            "rows": [{"values": [cell]}],
            "fields": fields,
        }
    }


def _requests_for_plan(sheet_id: int, columns: dict[str, int], plan: RowPlan) -> list[dict]:
    requests: list[dict] = []
    if plan.invoice_update:
        requests.append(
            _update_cell_request(
                sheet_id,
                plan.row_index_zero,
                columns[p.HEADERS["invoice"]],
                _link_cell("Abrir", _drive_url(plan.invoice)),
                "userEnteredValue,textFormatRuns",
            )
        )
    if plan.draft_update:
        requests.append(
            _update_cell_request(
                sheet_id,
                plan.row_index_zero,
                columns[p.HEADERS["draft"]],
                _link_cell("Abrir borrador", _drive_url(plan.draft)),
                "userEnteredValue,textFormatRuns",
            )
        )
    if plan.total_update:
        if plan.expected_total is None:
            cell = {}
        else:
            cell = {"userEnteredValue": {"numberValue": float(plan.expected_total)}}
        requests.append(
            _update_cell_request(
                sheet_id,
                plan.row_index_zero,
                columns[p.HEADERS["total"]],
                cell,
                "userEnteredValue",
            )
        )
    if plan.final_price_update and plan.expected_total is not None:
        requests.append(
            _update_cell_request(
                sheet_id,
                plan.row_index_zero,
                columns[p.HEADERS["final"]],
                {
                    "userEnteredValue": {"numberValue": float(plan.expected_total)},
                    "userEnteredFormat": {
                        "numberFormat": {
                            "type": "NUMBER",
                            "pattern": '#,##0.00 [$€-es-ES]',
                        }
                    },
                },
                "userEnteredValue,userEnteredFormat.numberFormat",
            )
        )
    return requests


def _force_canary_plan(plans: list[RowPlan]) -> RowPlan | None:
    # If Apps Script has already left production perfectly synchronized, rewrite
    # one semantically identical row so the canary still exercises both rich-link
    # and numeric write paths without changing the visible/business result.
    for plan in plans:
        active = plan.invoice or plan.draft
        if active is not None and plan.expected_total is not None:
            return RowPlan(
                row_index_zero=plan.row_index_zero,
                body_index=plan.body_index,
                order_id=plan.order_id,
                invoice=plan.invoice,
                draft=plan.draft,
                expected_total=plan.expected_total,
                invoice_update=True,
                draft_update=True,
                total_update=True,
                final_price_update=plan.invoice is not None,
            )
    return None


def sync(*, max_rows: int, links_only: bool, force_rewrite_one: bool) -> dict:
    _assert_write_allowed()
    _, sheets, plans, before = build_plan(links_only=links_only)

    changed = [plan for plan in plans if plan.changed]
    forced = False
    if force_rewrite_one and not changed:
        canary = _force_canary_plan(plans)
        if canary is None:
            raise RuntimeError("No safe row available for forced canary rewrite")
        changed = [canary]
        forced = True

    if max_rows > 0:
        selected = changed[:max_rows]
    else:
        selected = changed

    # Re-read header metadata after planning so we never rely on guessed column
    # positions for production writes.
    _, _, columns = p.read_sheet_values(sheets)
    sheet_id = _sheet_id(sheets)
    requests: list[dict] = []
    for plan in selected:
        requests.extend(_requests_for_plan(sheet_id, columns, plan))

    if requests:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=p.MASTER_ID,
            body={"requests": requests},
        ).execute()

    result = {
        "mode": "ALBARANES_PRODUCTION_LINKS_SYNC" if links_only else "ALBARANES_PRODUCTION_SYNC",
        "phase": "M6",
        "candidate_rows_before_sync": before["candidate_rows"],
        "rows_written": len(selected),
        "write_operations": len(requests),
        "forced_canary_rewrite": forced,
        "remaining_from_initial_plan": max(0, len(changed) - len(selected)),
        "max_rows": max_rows,
    }
    print("ALBARANES_SAFE_SYNC_OK")
    print(json.dumps(result, sort_keys=True))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--sync", action="store_true")
    parser.add_argument("--links-only", action="store_true")
    parser.add_argument("--max-rows", type=int, default=120)
    parser.add_argument("--force-rewrite-one", action="store_true")
    args = parser.parse_args()

    if args.preflight:
        print("ALBARANES_SYNC_PREFLIGHT_OK")
        print(
            json.dumps(
                {
                    "phase": "M6",
                    "component": "sync-albaranes-2026",
                    "mode": "FAIL_CLOSED",
                    "write_enabled": False,
                    "links_every_minutes": 15,
                    "totals_every_minutes": 60,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.dry_run:
        _, _, _, summary = build_plan(links_only=args.links_only)
        print("ALBARANES_SYNC_DRY_RUN_OK")
        print(json.dumps(summary, sort_keys=True))
        return 0

    sync(
        max_rows=max(0, args.max_rows),
        links_only=args.links_only,
        force_rewrite_one=args.force_rewrite_one,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
