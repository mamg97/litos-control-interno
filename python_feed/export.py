from __future__ import annotations

import argparse
import json
from pathlib import Path

from feed import build_payload, build_sheets_service, payload_hash


def export_feed(output: Path) -> dict:
    sheets = build_sheets_service()
    payload = build_payload(sheets)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temp.replace(output)
    return {
        "mode": "M7_PUBLIC_FEED_EXPORT",
        "phase": "M7",
        "records": len(payload.get("records", [])),
        "expenses": len(payload.get("expenses", [])),
        "payload_hash": payload_hash(payload),
        "output": str(output),
        "external_write_operations": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the LITOS public feed to a local JSON file")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = export_feed(args.output)
    print("PUBLIC_FEED_EXPORT_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
