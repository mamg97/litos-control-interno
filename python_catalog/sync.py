from __future__ import annotations

import argparse
import json
from typing import Any

from parity import (
    HEADERS,
    MASTER_ID,
    OPERATIONAL_SHEET,
    PEDIDOS_SHEET,
    RAW_SHEET,
    build_sheets_service,
    clean,
    generate_rows,
    normalize_row,
    padded,
    parity_report,
    read_values,
    row_key,
)


def duplicate_keys(rows: list[list[Any]]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for row in rows:
        if not clean(padded(row, 0)):
            continue
        key = row_key(row)
        if key in seen:
            duplicates.add(key)
        seen.add(key)
    return sorted(duplicates)


def load_state():
    sheets = build_sheets_service()
    raw_values = read_values(sheets, RAW_SHEET, formatted=False)
    current = read_values(sheets, OPERATIONAL_SHEET, formatted=False)
    pedidos = read_values(sheets, PEDIDOS_SHEET, formatted=True)

    if not raw_values:
        raise RuntimeError("Raw catalog sheet is empty")
    if not current:
        raise RuntimeError("Operational catalog sheet is empty")

    current_headers = [clean(value) for value in current[0][:13]]
    if current_headers != HEADERS:
        raise RuntimeError("Operational catalog header contract changed")

    current_body = [row for row in current[1:] if clean(padded(row, 0))]
    generated, stats = generate_rows(raw_values, pedidos, current_body)

    generated_duplicates = duplicate_keys(generated)
    current_duplicates = duplicate_keys(current_body)
    if generated_duplicates or current_duplicates:
        raise RuntimeError(
            "Duplicate operational catalog keys detected: "
            + json.dumps(
                {
                    "generated": len(generated_duplicates),
                    "current": len(current_duplicates),
                },
                sort_keys=True,
            )
        )

    return sheets, generated, current_body, stats


def change_plan(generated: list[list[Any]], current_body: list[list[Any]]) -> dict[str, Any]:
    generated_map = {row_key(row): normalize_row(row) for row in generated}
    current_map = {row_key(row): normalize_row(row) for row in current_body}

    missing = sorted(set(generated_map) - set(current_map))
    extra = sorted(set(current_map) - set(generated_map))
    modified = sorted(
        key
        for key in set(generated_map) & set(current_map)
        if generated_map[key] != current_map[key]
    )

    return {
        "missing_rows": len(missing),
        "extra_rows": len(extra),
        "modified_rows": len(modified),
        "candidate_changes": len(missing) + len(extra) + len(modified),
    }


def preserve_current_order(
    generated: list[list[Any]], current_body: list[list[Any]]
) -> list[list[Any]]:
    """Keep the existing human-facing row order whenever possible.

    Apps Script historically rebuilt and sorted the whole catalog. During cutover we
    deliberately stabilize the current order so manual prices/validation remain easy
    for the workshop to review. New catalog keys are appended deterministically.
    """
    generated_map = {row_key(row): row for row in generated}
    current_keys = [row_key(row) for row in current_body]
    ordered = [generated_map[key] for key in current_keys if key in generated_map]
    new_keys = sorted(set(generated_map) - set(current_keys))
    ordered.extend(generated_map[key] for key in new_keys)
    return ordered


def write_full_catalog(sheets, rows: list[list[Any]]) -> int:
    values = [HEADERS] + rows
    sheets.spreadsheets().values().clear(
        spreadsheetId=MASTER_ID,
        range=f"'{OPERATIONAL_SHEET}'!A:M",
        body={},
    ).execute()
    sheets.spreadsheets().values().update(
        spreadsheetId=MASTER_ID,
        range=f"'{OPERATIONAL_SHEET}'!A1:M{len(values)}",
        valueInputOption="RAW",
        body={"values": values},
    ).execute()
    return 2


def write_canary(sheets, generated: list[list[Any]], current_body: list[list[Any]]) -> int:
    report = parity_report(generated, current_body, {
        "raw_occurrences": 0,
        "operational_items": len(generated),
        "orders_covered": 0,
    })
    if not report["parity_ok"]:
        raise RuntimeError("Canary requires clean read-only parity before writing")
    if not current_body:
        raise RuntimeError("Operational catalog has no body rows for canary")

    # Exercise the real Sheets write path without changing business data.
    row = current_body[0]
    padded_row = [padded(row, idx) for idx in range(13)]
    sheets.spreadsheets().values().update(
        spreadsheetId=MASTER_ID,
        range=f"'{OPERATIONAL_SHEET}'!A2:M2",
        valueInputOption="RAW",
        body={"values": [padded_row]},
    ).execute()
    return 1


def preflight() -> int:
    print("M8_CATALOG_SYNC_PREFLIGHT_OK")
    print(json.dumps({
        "target_sheet": OPERATIONAL_SHEET,
        "writes_enabled": False,
        "write_operations": 0,
    }, ensure_ascii=False, sort_keys=True))
    return 0


def dry_run() -> int:
    _sheets, generated, current_body, stats = load_state()
    plan = change_plan(generated, current_body)
    report = {
        "mode": "M8_CATALOG_DRY_RUN",
        **stats,
        **plan,
        "generated_rows": len(generated),
        "current_rows": len(current_body),
        "write_operations": 0,
    }
    print("M8_CATALOG_DRY_RUN_OK")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def canary(confirm: str) -> int:
    if confirm != "CUTOVER_M8":
        raise RuntimeError("Canary confirmation token must be CUTOVER_M8")
    sheets, generated, current_body, stats = load_state()
    writes = write_canary(sheets, generated, current_body)
    report = {
        "mode": "M8_CATALOG_CANARY",
        **stats,
        "rows_written": 1,
        "write_operations": writes,
        "business_data_changed": False,
    }
    print("M8_CATALOG_CANARY_OK")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def sync(confirm: str) -> int:
    if confirm != "SYNC_M8":
        raise RuntimeError("Production sync confirmation token must be SYNC_M8")
    sheets, generated, current_body, stats = load_state()
    plan = change_plan(generated, current_body)

    writes = 0
    if plan["candidate_changes"]:
        ordered = preserve_current_order(generated, current_body)
        writes = write_full_catalog(sheets, ordered)

    report = {
        "mode": "M8_CATALOG_PRODUCTION_SYNC",
        **stats,
        **plan,
        "rows_written": len(generated) if writes else 0,
        "write_operations": writes,
    }
    print("M8_CATALOG_SYNC_OK")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Guarded M8 operational catalog synchronizer")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--canary", action="store_true")
    group.add_argument("--sync", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()

    if args.preflight:
        return preflight()
    if args.dry_run:
        return dry_run()
    if args.canary:
        return canary(args.confirm)
    if args.sync:
        return sync(args.confirm)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
