from __future__ import annotations

import json
import re
import time
from collections import Counter

from auth import build_client_services
from intake_readonly import clean, group_attachment_indexes_by_order
from intake_sync import (
    find_order_folder,
    full_attachment_descriptors,
    save_missing_attachments,
)

TARGET_IDS = [
    "7816", "7818", "7824", "7828", "7841", "7856", "7858", "7859",
    "7862", "7869", "7885", "7887", "7904", "7913", "7915", "7916",
    "7918", "7919", "7920", "7921", "7923", "7924", "7926", "7927", "7928",
]


def search_message_ids(gmail, order_id: str) -> list[str]:
    queries = [
        f'in:sent has:attachment after:2025/12/01 before:2026/10/01 filename:{order_id}',
        f'in:sent has:attachment after:2025/12/01 before:2026/10/01 "{order_id}"',
    ]
    seen: set[str] = set()
    ids: list[str] = []
    for query in queries:
        response = gmail.users().messages().list(
            userId="me",
            q=query,
            maxResults=20,
        ).execute()
        for item in response.get("messages", []) or []:
            message_id = clean(item.get("id"))
            if message_id and message_id not in seen:
                seen.add(message_id)
                ids.append(message_id)
        if ids:
            break
        time.sleep(0.20)
    return ids


def main() -> int:
    services = build_client_services()
    counters = Counter(
        ids_targeted=len(TARGET_IDS),
        gmail_messages_matched=0,
        order_groups_found=0,
        files_created=0,
        ids_with_recovered_files=0,
        ids_without_sent_match=0,
        ids_without_matching_attachment=0,
        folders_missing=0,
    )
    recovered: list[str] = []

    for order_id in TARGET_IDS:
        message_ids = search_message_ids(services.gmail, order_id)
        counters["gmail_messages_matched"] += len(message_ids)
        if not message_ids:
            counters["ids_without_sent_match"] += 1
            time.sleep(0.20)
            continue

        folder = find_order_folder(services.drive, order_id)
        if not folder:
            counters["folders_missing"] += 1
            continue

        found_for_id = False
        for message_id in message_ids:
            descriptors = full_attachment_descriptors(services.gmail, message_id)
            groups, _ = group_attachment_indexes_by_order(
                "",
                [clean(item.get("filename")) for item in descriptors],
            )
            indexes = groups.get(order_id, [])
            if not indexes:
                continue
            counters["order_groups_found"] += 1
            grouped = [descriptors[index] for index in indexes]
            _all_files, created_ids = save_missing_attachments(
                services.gmail,
                services.drive,
                message_id,
                folder["id"],
                order_id,
                grouped,
            )
            counters["files_created"] += len(created_ids)
            found_for_id = True
            time.sleep(0.25)

        if found_for_id:
            counters["ids_with_recovered_files"] += 1
            recovered.append(order_id)
        else:
            counters["ids_without_matching_attachment"] += 1
        time.sleep(0.25)

    print("LITOS_2026_SENT_RECOVERY_OK")
    print(json.dumps(
        {**dict(counters), "recovered_ids": recovered},
        ensure_ascii=False,
        sort_keys=True,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
