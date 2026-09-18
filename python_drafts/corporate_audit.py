from __future__ import annotations

import hashlib
import json
import sys

import executor
from client_header import CUSTOMER_PROFILE_VERSION, apply_client_header, load_private_header_profile
from corporate_style import LOGO_SHA256, STYLE_VERSION, apply_corporate_a4
from google_user_auth import build_user_services


def _key_hash(order_id: str) -> str:
    return hashlib.sha256(f"LITOS-CORPORATE:{order_id}".encode("utf-8")).hexdigest()[:12]


def audit() -> dict:
    services = build_user_services()
    private_profile = load_private_header_profile(services.sheets, executor.SPREADSHEET_ID)
    plan = executor.build_plan(services)

    action_counts: dict[str, int] = {}
    eligible = 0
    matching = 0
    mismatching = 0
    mismatch_hashes: list[str] = []

    for item in plan:
        action = str(item.get("action") or "unknown")
        action_counts[action] = action_counts.get(action, 0) + 1

        draft = item.get("draft")
        target = item.get("target")
        if not draft or not target or action not in {"updated", "unchanged"}:
            continue

        eligible += 1
        styled = apply_corporate_a4(bytes(target["xlsx_bytes"]))
        styled = apply_client_header(styled, customer=private_profile["customer"], issuer=private_profile["issuer"])
        actual = executor._download(services.drive, draft["id"])
        comparison = executor.compare_target_actual(styled, actual, item["pedido"])
        if comparison.get("match"):
            matching += 1
        else:
            mismatching += 1
            mismatch_hashes.append(_key_hash(str(item["pedido"])))

    result = {
        "status": "CORPORATE_DRAFT_COVERAGE_OK" if mismatching == 0 else "CORPORATE_DRAFT_COVERAGE_MISMATCH",
        "mode": "READ_ONLY",
        "write_operations": 0,
        "scope_rows": len(plan),
        "semantic_actions": action_counts,
        "eligible_existing_drafts": eligible,
        "corporate_current": matching,
        "corporate_mismatch": mismatching,
        "mismatch_key_hashes": sorted(mismatch_hashes),
        "style_version": STYLE_VERSION,
        "customer_profile_version": CUSTOMER_PROFILE_VERSION,
        "logo_sha256": LOGO_SHA256,
    }
    return result


def main() -> int:
    try:
        result = audit()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["corporate_mismatch"] == 0 else 2
    except Exception as exc:
        print(json.dumps({"status": "CORPORATE_DRAFT_COVERAGE_AUDIT_FAILED", "error": repr(exc)}, ensure_ascii=False), file=sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
