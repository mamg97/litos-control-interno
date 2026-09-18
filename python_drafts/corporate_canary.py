from __future__ import annotations

import argparse
import json
import os
import re
from typing import Callable

import executor
from client_header import CUSTOMER_PROFILE_VERSION, apply_client_header, load_private_header_profile
from corporate_style import LOGO_SHA256, STYLE_VERSION, apply_corporate_a4
from google_user_auth import build_user_services

BACKUP_FOLDER_ID = "1weWKeCLjQnrL2Qg2rPt1BYHGJhfZtKrv"

_ORIGINAL_SCOPE_ROWS: Callable = executor._scope_rows
_ORIGINAL_BUILD_TARGET: Callable = executor.build_target_xlsx


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _activate_corporate_style(order_id: str, private_profile: dict) -> None:
    if not re.fullmatch(r"\d{4}", order_id):
        raise RuntimeError("Canary order must be exactly four digits")

    def scoped_rows(pedidos):
        rows = _ORIGINAL_SCOPE_ROWS(pedidos)
        return [row for row in rows if str(row.get("Pedido", "")).strip() == order_id]

    def styled_target(row, catalog, template_bytes):
        target = _ORIGINAL_BUILD_TARGET(row, catalog, template_bytes)
        raw_bytes = target.get("xlsx_bytes")
        if not isinstance(raw_bytes, (bytes, bytearray)) or not raw_bytes:
            raise RuntimeError("Semantic draft builder returned no XLSX bytes")
        styled = apply_corporate_a4(bytes(raw_bytes))
        styled = apply_client_header(styled, customer=private_profile["customer"], issuer=private_profile["issuer"])
        out = dict(target)
        out["xlsx_bytes"] = styled
        out["style_version"] = STYLE_VERSION
        out["logo_sha256"] = LOGO_SHA256
        out["customer_profile_version"] = CUSTOMER_PROFILE_VERSION
        return out

    executor._scope_rows = scoped_rows
    executor.build_target_xlsx = styled_target


def _build_plan(order_id: str):
    services = build_user_services()
    private_profile = load_private_header_profile(services.sheets, executor.SPREADSHEET_ID)
    _activate_corporate_style(order_id, private_profile)
    plan = executor.build_plan(services)
    if len(plan) != 1:
        raise RuntimeError(f"Canary scope expected exactly one order, got {len(plan)}")
    item = plan[0]
    if item.get("pedido") != order_id:
        raise RuntimeError("Canary scope returned an unexpected order")
    return services, plan


def dry_run(order_id: str) -> dict:
    _, plan = _build_plan(order_id)
    summary = executor.summarize_plan(plan)
    item = plan[0]
    return {
        "status": "CORPORATE_DRAFT_CANARY_DRY_RUN_OK",
        "order": order_id,
        "style_version": STYLE_VERSION,
        "logo_sha256": LOGO_SHA256,
        "customer_profile_version": CUSTOMER_PROFILE_VERSION,
        "action": item.get("action"),
        "mutable": summary.get("mutable"),
        "write_operations": 0,
    }


def sync(order_id: str) -> dict:
    if os.getenv("LITOS_STYLE_CONFIRM", "") != "STYLE_CANARY":
        raise RuntimeError("Corporate style canary blocked: missing STYLE_CANARY confirmation")
    if _truthy(os.getenv("LITOS_DRAFT_STYLE_KILL_SWITCH", "true")):
        raise RuntimeError("Corporate style canary blocked by kill switch")
    if not _truthy(os.getenv("LITOS_DRAFT_STYLE_WRITE_ENABLED", "false")):
        raise RuntimeError("Corporate style canary write flag is disabled")

    services, plan = _build_plan(order_id)
    item = plan[0]
    if item.get("action") in {"definitive", "pendingValidation"}:
        raise RuntimeError(f"Corporate style canary cannot write action={item.get('action')}")

    before = executor.summarize_plan(plan)
    if before.get("mutable", 0) > 1:
        raise RuntimeError(f"Corporate style canary mutation guard failed: {before}")

    outcome = executor.execute_sync(services, BACKUP_FOLDER_ID)
    return {
        "status": "CORPORATE_DRAFT_CANARY_SYNC_OK",
        "order": order_id,
        "style_version": STYLE_VERSION,
        "logo_sha256": LOGO_SHA256,
        "customer_profile_version": CUSTOMER_PROFILE_VERSION,
        "sync": outcome,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LITOS single-order corporate draft style canary")
    parser.add_argument("--order", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--sync", action="store_true")
    args = parser.parse_args()

    try:
        result = sync(args.order) if args.sync else dry_run(args.order)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "FAILED", "error": repr(exc)}, ensure_ascii=False), file=os.sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
