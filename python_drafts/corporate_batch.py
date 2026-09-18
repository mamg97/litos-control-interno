from __future__ import annotations

import argparse
import json
import os
import re
from typing import Callable

import executor
from client_header import CUSTOMER_PROFILE_VERSION, apply_client_header
from corporate_style import LOGO_SHA256, STYLE_VERSION, apply_corporate_a4
from google_user_auth import build_user_services

BACKUP_FOLDER_ID = "1weWKeCLjQnrL2Qg2rPt1BYHGJhfZtKrv"
MAX_BATCH = 8

_ORIGINAL_SCOPE_ROWS: Callable = executor._scope_rows
_ORIGINAL_BUILD_TARGET: Callable = executor.build_target_xlsx


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_orders(raw: str) -> list[str]:
    orders = [part.strip() for part in str(raw or "").split(",") if part.strip()]
    if not orders:
        raise RuntimeError("At least one order is required")
    if len(orders) > MAX_BATCH:
        raise RuntimeError(f"Corporate style batch accepts at most {MAX_BATCH} orders")
    if len(set(orders)) != len(orders):
        raise RuntimeError("Corporate style batch contains duplicate orders")
    if any(not re.fullmatch(r"\d{4}", order) for order in orders):
        raise RuntimeError("Corporate style batch accepts only four-digit order IDs")
    return orders


def _activate_batch(orders: list[str]) -> None:
    allowed = set(orders)

    def scoped_rows(pedidos):
        rows = _ORIGINAL_SCOPE_ROWS(pedidos)
        return [row for row in rows if str(row.get("Pedido", "")).strip() in allowed]

    def styled_target(row, catalog, template_bytes):
        target = _ORIGINAL_BUILD_TARGET(row, catalog, template_bytes)
        raw_bytes = target.get("xlsx_bytes")
        if not isinstance(raw_bytes, (bytes, bytearray)) or not raw_bytes:
            raise RuntimeError("Semantic draft builder returned no XLSX bytes")
        styled = apply_corporate_a4(bytes(raw_bytes))
        styled = apply_client_header(styled)
        out = dict(target)
        out["xlsx_bytes"] = styled
        out["style_version"] = STYLE_VERSION
        out["logo_sha256"] = LOGO_SHA256
        out["customer_profile_version"] = CUSTOMER_PROFILE_VERSION
        return out

    executor._scope_rows = scoped_rows
    executor.build_target_xlsx = styled_target


def _build_plan(orders: list[str]):
    _activate_batch(orders)
    services = build_user_services()
    plan = executor.build_plan(services)

    found = {str(item.get("pedido", "")).strip() for item in plan}
    missing = sorted(set(orders) - found)
    if missing:
        raise RuntimeError(
            "Corporate style batch could not resolve all requested orders inside the current draft scope: "
            + ",".join(missing)
        )

    blocked = {
        item["pedido"]: item.get("action")
        for item in plan
        if item.get("action") not in {"updated", "unchanged"}
    }
    if blocked:
        raise RuntimeError(f"Corporate style batch only accepts existing mutable drafts: {blocked}")

    return services, plan


def dry_run(orders: list[str]) -> dict:
    _, plan = _build_plan(orders)
    summary = executor.summarize_plan(plan)
    return {
        "status": "CORPORATE_DRAFT_BATCH_DRY_RUN_OK",
        "orders_requested": orders,
        "style_version": STYLE_VERSION,
        "customer_profile_version": CUSTOMER_PROFILE_VERSION,
        "logo_sha256": LOGO_SHA256,
        "plan": summary,
        "write_operations": 0,
    }


def sync(orders: list[str]) -> dict:
    if os.getenv("LITOS_STYLE_BATCH_CONFIRM", "") != "STYLE_BATCH":
        raise RuntimeError("Corporate style batch blocked: missing STYLE_BATCH confirmation")
    if _truthy(os.getenv("LITOS_DRAFT_STYLE_BATCH_KILL_SWITCH", "true")):
        raise RuntimeError("Corporate style batch blocked by kill switch")
    if not _truthy(os.getenv("LITOS_DRAFT_STYLE_BATCH_WRITE_ENABLED", "false")):
        raise RuntimeError("Corporate style batch write flag is disabled")

    services, plan = _build_plan(orders)
    before = executor.summarize_plan(plan)
    if before.get("mutable", 0) > MAX_BATCH:
        raise RuntimeError(f"Corporate style batch mutation guard failed: {before}")

    outcome = executor.execute_sync(services, BACKUP_FOLDER_ID)

    # Rebuild from fresh Drive state and require convergence. Re-activate because
    # execute_sync internally rebuilds the plan and the same explicit scope must hold.
    services_after, plan_after = _build_plan(orders)
    del services_after
    after = executor.summarize_plan(plan_after)
    if after.get("mutable", 0) != 0:
        raise RuntimeError(f"Corporate style batch did not converge: {after}")

    return {
        "status": "CORPORATE_DRAFT_BATCH_SYNC_OK",
        "orders_requested": orders,
        "style_version": STYLE_VERSION,
        "customer_profile_version": CUSTOMER_PROFILE_VERSION,
        "logo_sha256": LOGO_SHA256,
        "before": before,
        "sync": outcome,
        "after": after,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LITOS guarded corporate draft batch restyler")
    parser.add_argument("--orders", required=True, help="Comma-separated order IDs, max 8")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--sync", action="store_true")
    args = parser.parse_args()

    try:
        orders = parse_orders(args.orders)
        result = sync(orders) if args.sync else dry_run(orders)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "FAILED", "error": repr(exc)}, ensure_ascii=False), file=os.sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
