from __future__ import annotations

import argparse
import json
from pathlib import Path

from reader import build_read_only_report

FORBIDDEN_WRITE_TOKENS = (
    ".values().update(",
    ".values().append(",
    ".batchUpdate(",
    ".files().create(",
    ".files().update(",
    ".files().delete(",
)


def preflight() -> dict:
    source = Path(__file__).with_name("reader.py").read_text(encoding="utf-8")
    found = [token for token in FORBIDDEN_WRITE_TOKENS if token in source]
    if found:
        raise RuntimeError("M4 read-only code contains write operations: " + ", ".join(found))
    return {
        "phase": "M4",
        "component": "handwriting-readings",
        "mode": "READ_ONLY_ONLY",
        "sheet_writes": False,
        "drive_writes": False,
        "gemini_calls": False,
        "schedule_enabled": False,
        "sync_mode_present": False,
        "forbidden_write_tokens_found": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="LITOS M4 handwriting migration discovery")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.preflight:
        print("HANDWRITING_PREFLIGHT_OK")
        print(json.dumps(preflight(), ensure_ascii=False, sort_keys=True))
        return 0

    preflight()
    report = build_read_only_report()
    print("HANDWRITING_DRY_RUN_OK")
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
