from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from feed import build_payload, build_sheets_service, payload_hash

FORBIDDEN_PUBLIC_RECORD_KEYS = frozenset(
    {
        "invoiceFile",
        "invoiceDraftFile",
        "corelFile",
        "noteFile",
        "attachmentFile",
    }
)


def sanitize_public_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove private document locators before anything is written to Pages."""
    sanitized_records = []
    for raw_record in payload.get("records", []) or []:
        record = {
            key: value
            for key, value in dict(raw_record).items()
            if key not in FORBIDDEN_PUBLIC_RECORD_KEYS
        }
        sanitized_records.append(record)

    sanitized = {
        "version": 7,
        "generatedAt": payload.get("generatedAt"),
        "records": sanitized_records,
        "expenses": payload.get("expenses", []) or [],
    }
    assert_public_payload_safe(sanitized)
    return sanitized


def _walk_strings(value: Any):
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk_strings(child)
        return
    if isinstance(value, list):
        for child in value:
            yield from _walk_strings(child)


def assert_public_payload_safe(payload: dict[str, Any]) -> None:
    for index, record in enumerate(payload.get("records", []) or []):
        leaked_keys = sorted(FORBIDDEN_PUBLIC_RECORD_KEYS.intersection(record))
        if leaked_keys:
            raise RuntimeError(
                f"Public feed privacy guard: forbidden document fields at record {index}: {leaked_keys}"
            )

    leaked_urls = [
        value
        for value in _walk_strings(payload)
        if "http://" in value.lower() or "https://" in value.lower()
    ]
    if leaked_urls:
        raise RuntimeError(
            f"Public feed privacy guard: found {len(leaked_urls)} URL value(s) in exported payload"
        )


def export_feed(output: Path) -> dict:
    sheets = build_sheets_service()
    payload = sanitize_public_payload(build_payload(sheets))
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
        "public_schema_version": payload.get("version"),
        "records": len(payload.get("records", [])),
        "expenses": len(payload.get("expenses", [])),
        "payload_hash": payload_hash(payload),
        "private_document_fields_exported": 0,
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
