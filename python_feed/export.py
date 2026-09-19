from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from feed import build_payload, build_sheets_service, payload_hash

EXPENSE_KEYS = frozenset({"month", "category", "amount", "nature", "source", "invoiceDate", "reference", "emailEvidence", "folderUrl", "documentUrl"})
EXPENSE_LINK_KEYS = frozenset({"folderUrl", "documentUrl"})
MOVEMENT_KEYS = frozenset({"year", "date", "sourceDate", "type", "ref", "line", "concept", "debit", "credit", "balance"})

DOCUMENT_LINK_KEYS = frozenset(
    {
        "invoiceFile",
        "invoiceDraftFile",
        "corelFile",
        "noteFile",
        "attachmentFile",
    }
)

ALLOWED_GOOGLE_DOCUMENT_HOSTS = frozenset(
    {
        "drive.google.com",
        "docs.google.com",
    }
)


def _is_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    lowered = value.strip().lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def _is_allowed_google_document_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = urlparse(value.strip())
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() in ALLOWED_GOOGLE_DOCUMENT_HOSTS
    )


def sanitize_public_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Publish only the approved operational schema and Google document links.

    Document URLs are intentionally retained because the dashboard has always
    exposed them as navigation targets while Google Drive itself enforces
    access. Both drive.google.com file links and docs.google.com links are
    legitimate forms returned by Google for Drive-backed documents. Arbitrary
    external URLs are rejected before the Pages artifact is created.
    """
    sanitized_records: list[dict[str, Any]] = []
    for raw_record in payload.get("records", []) or []:
        record = dict(raw_record)
        for key in DOCUMENT_LINK_KEYS:
            value = record.get(key)
            if value in (None, ""):
                record[key] = ""
                continue
            if not _is_allowed_google_document_url(value):
                raise RuntimeError(
                    f"Public feed privacy guard: non-Google document URL in field {key}"
                )
        sanitized_records.append(record)

    sanitized_expenses: list[dict[str, Any]] = []
    for index, raw_expense in enumerate(payload.get("expenses", []) or []):
        if not isinstance(raw_expense, dict):
            raise RuntimeError(f"Public feed privacy guard: invalid expense at index {index}")
        extra = set(raw_expense) - EXPENSE_KEYS
        if extra:
            raise RuntimeError(
                "Public feed privacy guard: unexpected expense fields: " + ", ".join(sorted(extra))
            )
        for key in EXPENSE_LINK_KEYS:
            value = raw_expense.get(key)
            if value in (None, ""):
                continue
            if not _is_allowed_google_document_url(value):
                raise RuntimeError(
                    f"Public feed privacy guard: non-Google supplier link at expense {index}, field {key}"
                )
        sanitized_expenses.append({key: raw_expense.get(key) for key in EXPENSE_KEYS})

    sanitized_movements: list[dict[str, Any]] = []
    for index, raw_movement in enumerate(payload.get("movements", []) or []):
        if not isinstance(raw_movement, dict):
            raise RuntimeError(f"Public feed privacy guard: invalid movement at index {index}")
        extra = set(raw_movement) - MOVEMENT_KEYS
        if extra:
            raise RuntimeError(
                "Public feed privacy guard: unexpected movement fields: " + ", ".join(sorted(extra))
            )
        sanitized_movements.append({key: raw_movement.get(key) for key in MOVEMENT_KEYS})

    sanitized = {
        "version": 11,
        "generatedAt": payload.get("generatedAt"),
        "records": sanitized_records,
        "expenses": sanitized_expenses,
        "movements": sanitized_movements,
    }
    assert_public_payload_safe(sanitized)
    return sanitized


def _walk_non_document_values(value: Any, *, parent_key: str | None = None):
    if isinstance(value, str):
        if parent_key not in (DOCUMENT_LINK_KEYS | EXPENSE_LINK_KEYS):
            yield value
        return
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk_non_document_values(child, parent_key=str(key))
        return
    if isinstance(value, list):
        for child in value:
            yield from _walk_non_document_values(child, parent_key=parent_key)


def assert_public_payload_safe(payload: dict[str, Any]) -> None:
    records = payload.get("records", []) or []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise RuntimeError(f"Public feed privacy guard: invalid record at index {index}")
        for key in DOCUMENT_LINK_KEYS:
            value = record.get(key)
            if value in (None, ""):
                continue
            if not _is_allowed_google_document_url(value):
                raise RuntimeError(
                    f"Public feed privacy guard: non-Google document URL at record {index}, field {key}"
                )

    expenses = payload.get("expenses", []) or []
    for index, expense in enumerate(expenses):
        if not isinstance(expense, dict):
            raise RuntimeError(f"Public feed privacy guard: invalid expense at index {index}")
        extra = set(expense) - EXPENSE_KEYS
        if extra:
            raise RuntimeError(
                "Public feed privacy guard: unexpected expense fields: " + ", ".join(sorted(extra))
            )
        for key in EXPENSE_LINK_KEYS:
            value = expense.get(key)
            if value in (None, ""):
                continue
            if not _is_allowed_google_document_url(value):
                raise RuntimeError(
                    f"Public feed privacy guard: non-Google supplier link at expense {index}, field {key}"
                )

    movements = payload.get("movements", []) or []
    for index, movement in enumerate(movements):
        if not isinstance(movement, dict):
            raise RuntimeError(f"Public feed privacy guard: invalid movement at index {index}")
        extra = set(movement) - MOVEMENT_KEYS
        if extra:
            raise RuntimeError(
                "Public feed privacy guard: unexpected movement fields: " + ", ".join(sorted(extra))
            )

    leaked_urls = [
        value
        for value in _walk_non_document_values(payload)
        if _is_url(value)
    ]
    if leaked_urls:
        raise RuntimeError(
            f"Public feed privacy guard: found {len(leaked_urls)} non-document URL value(s) in exported payload"
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
    document_links = sum(
        1
        for record in payload.get("records", [])
        for key in DOCUMENT_LINK_KEYS
        if record.get(key)
    )
    return {
        "mode": "M7_PUBLIC_FEED_EXPORT",
        "phase": "M7",
        "public_schema_version": payload.get("version"),
        "records": len(payload.get("records", [])),
        "expenses": len(payload.get("expenses", [])),
        "movements": len(payload.get("movements", [])),
        "payload_hash": payload_hash(payload),
        "google_document_links_exported": document_links,
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
