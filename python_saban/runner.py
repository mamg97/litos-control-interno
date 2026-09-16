from __future__ import annotations

import argparse
import json
from pathlib import Path

from auth import build_saban_services
from intake_readonly import build_read_only_plan, public_summary

FORBIDDEN_WRITE_TOKENS = (
    ".files().create(",
    ".files().update(",
    ".files().delete(",
    ".values().update(",
    ".values().append(",
    ".batchUpdate(",
    ".batch_update(",
    ".permissions().create(",
)


def preflight() -> dict:
    source = Path(__file__).with_name("intake_readonly.py").read_text(encoding="utf-8")
    found = [token for token in FORBIDDEN_WRITE_TOKENS if token in source]
    if found:
        raise RuntimeError("Read-only intake contains forbidden write operations: " + ", ".join(found))
    return {
        "phase": "M3",
        "component": "saban-intake",
        "mode": "READ_ONLY_ONLY",
        "gmail_scope": "gmail.readonly",
        "drive_writes": False,
        "sheet_writes": False,
        "schedule_enabled": False,
        "sync_mode_present": False,
        "forbidden_write_tokens_found": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LITOS Saban intake migration runner")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.preflight:
        print("SABAN_PREFLIGHT_OK")
        print(json.dumps(preflight(), ensure_ascii=False, sort_keys=True))
        return 0

    preflight()
    from os import environ

    allowed_sender = environ.get("SABAN_ALLOWED_SENDER", "")
    services = build_saban_services()
    plan = build_read_only_plan(services, allowed_sender)
    print("SABAN_DRY_RUN_OK")
    print(json.dumps(public_summary(plan), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
