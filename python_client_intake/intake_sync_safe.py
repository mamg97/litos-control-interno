from __future__ import annotations

import argparse
import json

import intake_sync as base
from intake_readonly import build_read_only_plan, load_private_intake_config

_actual_sheet_writes = 0
_original_update_value = base.update_value


def _current_formula_value(sheets, sheet_name: str, row_no: int, col_zero: int):
    cell = f"'{sheet_name}'!{base.a1_col(col_zero)}{row_no}"
    values = (
        sheets.spreadsheets().values().get(
            spreadsheetId=base.MASTER_ID,
            range=cell,
            valueRenderOption="FORMULA",
            dateTimeRenderOption="FORMATTED_STRING",
        ).execute().get("values", [])
    )
    if not values or not values[0]:
        return ""
    return values[0][0]


def _write_only_if_blank(sheets, sheet_name: str, row_no: int, col_zero: int, value) -> None:
    """Never overwrite an existing cell during Client intake.

    This matches the intake contract: existing manual/rich-text/formula data is
    authoritative. A message already materialized must therefore be a true no-op.
    """
    global _actual_sheet_writes
    if base.clean(_current_formula_value(sheets, sheet_name, row_no, col_zero)):
        return
    _original_update_value(sheets, sheet_name, row_no, col_zero, value)
    _actual_sheet_writes += 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-mutations", type=int, default=None)
    parser.add_argument("--multi-order-only", action="store_true")
    args = parser.parse_args()

    services = base.build_client_services()
    private_config = load_private_intake_config(services.sheets)
    if private_config["kill_switch"]:
        print("CLIENT_INTAKE_DISABLED_BY_PRIVATE_KILL_SWITCH")
        return 0
    base.assert_write_safety(False)
    plan = build_read_only_plan(services)
    if args.max_mutations is not None and int(plan.get("mutable", 0)) > args.max_mutations:
        raise RuntimeError(f"Canary blocked by full read-only plan: {plan['mutable']} mutable messages")

    # Patch only the primitive cell writer. Folder/file creation still retains
    # the original guarded behavior and rollback logic.
    base.update_value = _write_only_if_blank
    result = base.sync_intake(max_mutations=None, multi_order_only=args.multi_order_only)

    originally_reported = int(result.get("sheet_cells", 0))
    result["logical_write_attempts"] = originally_reported
    result["sheet_cells"] = _actual_sheet_writes
    result["write_operations"] = (
        _actual_sheet_writes
        + int(result.get("files_created", 0))
        + int(result.get("folders_created", 0))
    )
    result["read_only_mutable_before_sync"] = int(plan.get("mutable", 0))

    if int(plan.get("mutable", 0)) == 0 and result["write_operations"] != 0:
        raise RuntimeError("Idempotency violation: zero-mutation plan produced writes")

    print("CLIENT_INTAKE_SAFE_SYNC_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
