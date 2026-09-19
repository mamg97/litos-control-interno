from __future__ import annotations

import argparse
import base64
import json
import os
import re
from datetime import datetime
from email.utils import parseaddr
from zoneinfo import ZoneInfo

from googleapiclient.http import MediaInMemoryUpload

from auth import build_client_services
from intake_readonly import (
    AttachmentMeta,
    HEADERS,
    LOOKBACK_DAYS,
    MASTER_ID,
    ROOT_FOLDER_ID,
    YEAR,
    _attachment_meta,
    _header_value,
    classify_names,
    clean,
    extension_from_mime,
    extract_order_id,
    group_attachment_indexes_by_order,
    find_order_folder,
    list_candidate_messages,
    load_private_intake_config,
    list_folder_files,
    sender_address,
    stored_attachment_name,
)

TIMEZONE = ZoneInfo("Europe/Madrid")
REVIEW_SHEET = "Lecturas manuscritas"
REVIEW_REQUIRED_HEADERS = (
    "Pedido",
    "Fecha recepción",
    "Archivo de ficha",
    "Estado de revisión",
    "Fuente de lectura",
    "Actualizado",
)


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def assert_write_safety(private_kill_switch: bool) -> None:
    if not _flag("LITOS_FREE_ONLY"):
        raise RuntimeError("LITOS_FREE_ONLY must be true")
    if not _flag("LITOS_CLIENT_WRITE_ENABLED"):
        raise RuntimeError("LITOS_CLIENT_WRITE_ENABLED must be true")
    if private_kill_switch or _flag("LITOS_INTAKE_EMERGENCY_KILL_SWITCH"):
        raise RuntimeError("Primary-client intake kill switch is active")


def a1_col(index_zero: int) -> str:
    n = index_zero + 1
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


def load_values(sheets, range_name: str, render: str = "FORMATTED_VALUE") -> list[list]:
    return (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=range_name,
            valueRenderOption=render,
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
        .get("values", [])
    )


def find_header(values: list[list], marker: str) -> tuple[int, list[str], dict[str, int]]:
    idx = next((i for i, row in enumerate(values) if any(clean(c) == marker for c in row)), None)
    if idx is None:
        raise RuntimeError(f"Header {marker!r} not found")
    headers = [clean(c) for c in values[idx]]
    return idx, headers, {h: i for i, h in enumerate(headers) if h}


def load_orders_state(sheets) -> dict:
    values = load_values(sheets, "Pedidos!A:AN")
    header_index, headers, columns = find_header(values, HEADERS["id"])
    missing = [h for h in HEADERS.values() if h not in columns]
    if missing:
        raise RuntimeError("Missing Pedidos columns: " + ", ".join(missing))
    row_by_id: dict[str, int] = {}
    row_values: dict[int, list] = {}
    id_col = columns[HEADERS["id"]]
    for physical_row, row in enumerate(values[header_index + 1 :], start=header_index + 2):
        oid = clean(row[id_col]) if id_col < len(row) else ""
        if oid:
            row_by_id[oid] = physical_row
            row_values[physical_row] = list(row)
    next_row = max(row_by_id.values(), default=header_index + 1) + 1
    return {
        "headers": headers,
        "columns": columns,
        "row_by_id": row_by_id,
        "row_values": row_values,
        "next_row": next_row,
    }


def load_review_state(sheets) -> dict:
    values = load_values(sheets, f"'{REVIEW_SHEET}'!A:Y")
    if not values:
        raise RuntimeError("Lecturas manuscritas is missing or empty")
    headers = [clean(c) for c in values[0]]
    columns = {h: i for i, h in enumerate(headers) if h}
    missing = [h for h in REVIEW_REQUIRED_HEADERS if h not in columns]
    if missing:
        raise RuntimeError("Missing review columns: " + ", ".join(missing))
    row_by_id = {}
    for row_no, row in enumerate(values[1:], start=2):
        idx = columns["Pedido"]
        oid = clean(row[idx]) if idx < len(row) else ""
        if oid:
            row_by_id[oid] = row_no
    return {"headers": headers, "columns": columns, "row_by_id": row_by_id, "next_row": max(2, len(values) + 1)}


def cell_is_blank(row: list, col: int) -> bool:
    return col >= len(row) or not clean(row[col])


def update_value(sheets, sheet_name: str, row_no: int, col_zero: int, value) -> None:
    cell = f"'{sheet_name}'!{a1_col(col_zero)}{row_no}"
    sheets.spreadsheets().values().update(
        spreadsheetId=MASTER_ID,
        range=cell,
        valueInputOption="USER_ENTERED",
        body={"values": [[value]]},
    ).execute()


def drive_url(file_id: str, folder: bool = False) -> str:
    if folder:
        return f"https://drive.google.com/drive/folders/{file_id}"
    return f"https://drive.google.com/file/d/{file_id}/view"


def hyperlink_formula(url: str, label: str) -> str:
    safe_url = url.replace('"', '""')
    safe_label = label.replace('"', '""')
    return f'=HYPERLINK("{safe_url}";"{safe_label}")'


def get_or_create_order_folder(drive, order_id: str) -> tuple[dict, bool]:
    existing = find_order_folder(drive, order_id)
    if existing:
        return existing, False
    created = drive.files().create(
        body={
            "name": order_id,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [ROOT_FOLDER_ID],
        },
        fields="id,name,mimeType",
    ).execute()
    return created, True


def _decode_attachment_data(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


def attachment_bytes(gmail, message_id: str, attachment: dict) -> bytes:
    attachment_id = clean(attachment.get("attachment_id"))
    inline_data = clean(attachment.get("data"))
    if attachment_id:
        payload = gmail.users().messages().attachments().get(
            userId="me", messageId=message_id, id=attachment_id
        ).execute()
        return _decode_attachment_data(payload.get("data", ""))
    if inline_data:
        return _decode_attachment_data(inline_data)
    raise RuntimeError("Attachment has no downloadable body")


def full_attachment_descriptors(gmail, message_id: str) -> list[dict]:
    message = gmail.users().messages().get(userId="me", id=message_id, format="full").execute()
    result = []

    def visit(part: dict) -> None:
        body = part.get("body") or {}
        filename = clean(part.get("filename"))
        disposition = _header_value(part.get("headers") or [], "Content-Disposition").lower()
        if (filename or body.get("attachmentId")) and not disposition.startswith("inline"):
            result.append(
                {
                    "filename": filename,
                    "mime_type": clean(part.get("mimeType")),
                    "attachment_id": clean(body.get("attachmentId")),
                    "data": clean(body.get("data")),
                }
            )
        for child in part.get("parts") or []:
            visit(child)

    visit(message.get("payload") or {})
    return result


def save_missing_attachments(gmail, drive, message_id: str, folder_id: str, order_id: str, descriptors: list[dict]) -> tuple[list[dict], list[str]]:
    existing_files = list_folder_files(drive, folder_id)
    by_name = {clean(f.get("name")): f for f in existing_files}
    created_ids: list[str] = []
    all_files = list(existing_files)
    for index, item in enumerate(descriptors):
        filename = clean(item.get("filename"))
        if not filename:
            filename = f"{order_id}-adjunto-{index + 1}{extension_from_mime(item.get('mime_type', ''))}"
        if not re.search(rf"^{re.escape(order_id)}(?:\D|$)", filename):
            filename = f"{order_id}-{filename}"
        if filename in by_name:
            continue
        content = attachment_bytes(gmail, message_id, item)
        media = MediaInMemoryUpload(content, mimetype=item.get("mime_type") or "application/octet-stream", resumable=False)
        created = drive.files().create(
            body={"name": filename, "parents": [folder_id]},
            media_body=media,
            fields="id,name,mimeType",
        ).execute()
        created_ids.append(created["id"])
        all_files.append(created)
        by_name[filename] = created
    return all_files, created_ids


def set_if_blank(sheets, state: dict, row_no: int, header: str, value, counters: dict) -> None:
    col = state["columns"][header]
    row = state["row_values"].setdefault(row_no, [])
    if not cell_is_blank(row, col):
        return
    update_value(sheets, "Pedidos", row_no, col, value)
    while len(row) <= col:
        row.append("")
    row[col] = value
    counters["sheet_cells"] += 1


def ensure_review_row(sheets, review_state: dict, order_id: str, receipt_date: str, note_file_id: str, counters: dict) -> None:
    if order_id in review_state["row_by_id"]:
        return
    row_no = review_state["next_row"]
    review_state["next_row"] += 1
    review_state["row_by_id"][order_id] = row_no
    cols = review_state["columns"]
    values = {
        "Pedido": int(order_id),
        "Fecha recepción": receipt_date,
        "Archivo de ficha": hyperlink_formula(drive_url(note_file_id), "Abrir nota"),
        "Estado de revisión": "Pendiente de lectura automática",
        "Fuente de lectura": "Gmail · cliente",
        "Actualizado": datetime.now(TIMEZONE).strftime("%d/%m/%Y %H:%M"),
    }
    for header, value in values.items():
        update_value(sheets, REVIEW_SHEET, row_no, cols[header], value)
        counters["sheet_cells"] += 1
    counters["review_rows_created"] += 1


def sync_intake(*, max_mutations: int | None = None, multi_order_only: bool = False) -> dict:
    services = build_client_services()
    private_config = load_private_intake_config(services.sheets)
    assert_write_safety(private_config["kill_switch"])
    allowed_sender = private_config["allowed_sender"]
    orders = load_orders_state(services.sheets)
    review = load_review_state(services.sheets)
    messages = list_candidate_messages(services.gmail, allowed_sender)

    estimated_mutations = 0
    for message in messages:
        headers = (message.get("payload") or {}).get("headers") or []
        shown_from = _header_value(headers, "From")
        subject = _header_value(headers, "Subject")
        internal_ms = int(message.get("internalDate", "0") or 0)
        local_date = datetime.fromtimestamp(internal_ms / 1000, tz=TIMEZONE)
        if local_date.year != YEAR or sender_address(shown_from) != allowed_sender:
            continue

        metas = _attachment_meta(message.get("payload") or {})
        groups, _ = group_attachment_indexes_by_order(subject, [item.filename for item in metas])
        if multi_order_only and len(groups) < 2:
            continue

        for order_id, indexes in groups.items():
            grouped = [metas[index] for index in indexes]
            if order_id not in orders["row_by_id"]:
                estimated_mutations += 1
                continue
            folder = find_order_folder(services.drive, order_id)
            if not folder:
                estimated_mutations += 1
                continue
            expected = [
                stored_attachment_name(order_id, attachment, index)
                for index, attachment in enumerate(grouped)
            ]
            existing = {clean(item.get("name")) for item in list_folder_files(services.drive, folder["id"])}
            if any(name not in existing for name in expected):
                estimated_mutations += 1

    if max_mutations is not None and estimated_mutations > max_mutations:
        raise RuntimeError(f"Canary blocked: intake has {estimated_mutations} mutable order groups")

    counters = {
        "messages_scanned": len(messages),
        "order_groups_materialized": 0,
        "orders_created": 0,
        "folders_created": 0,
        "files_created": 0,
        "review_rows_created": 0,
        "sheet_cells": 0,
        "ambiguous_attachments": 0,
        "errors": 0,
    }

    for message in messages:
        headers = (message.get("payload") or {}).get("headers") or []
        shown_from = _header_value(headers, "From")
        subject = _header_value(headers, "Subject")
        internal_ms = int(message.get("internalDate", "0") or 0)
        local_date = datetime.fromtimestamp(internal_ms / 1000, tz=TIMEZONE)
        if local_date.year != YEAR or sender_address(shown_from) != allowed_sender:
            continue

        descriptors = full_attachment_descriptors(services.gmail, message["id"])
        groups, unresolved = group_attachment_indexes_by_order(
            subject,
            [clean(item.get("filename")) for item in descriptors],
        )
        counters["ambiguous_attachments"] += len(unresolved)
        if multi_order_only and len(groups) < 2:
            continue

        for order_id, indexes in sorted(groups.items()):
            grouped_descriptors = [descriptors[index] for index in indexes]
            created_file_ids: list[str] = []
            created_folder_id = ""
            try:
                folder, folder_created = get_or_create_order_folder(services.drive, order_id)
                if folder_created:
                    counters["folders_created"] += 1
                    created_folder_id = folder["id"]

                all_files, created_file_ids = save_missing_attachments(
                    services.gmail,
                    services.drive,
                    message["id"],
                    folder["id"],
                    order_id,
                    grouped_descriptors,
                )
                counters["files_created"] += len(created_file_ids)

                expected_names = [
                    stored_attachment_name(
                        order_id,
                        AttachmentMeta(
                            filename=clean(item.get("filename")),
                            mime_type=clean(item.get("mime_type")),
                            attachment_id=clean(item.get("attachment_id")),
                        ),
                        index,
                    )
                    for index, item in enumerate(grouped_descriptors)
                ]
                name_to_file = {clean(item.get("name")): item for item in all_files}
                note_name, image_names = classify_names(order_id, expected_names)
                note_file = name_to_file.get(note_name) if note_name else None

                row_no = orders["row_by_id"].get(order_id)
                if row_no is None:
                    row_no = orders["next_row"]
                    orders["next_row"] += 1
                    orders["row_by_id"][order_id] = row_no
                    orders["row_values"][row_no] = []
                    update_value(
                        services.sheets,
                        "Pedidos",
                        row_no,
                        orders["columns"][HEADERS["id"]],
                        int(order_id),
                    )
                    counters["sheet_cells"] += 1
                    counters["orders_created"] += 1

                receipt = local_date.strftime("%d/%m/%Y")
                set_if_blank(services.sheets, orders, row_no, HEADERS["receipt_date"], receipt, counters)
                set_if_blank(services.sheets, orders, row_no, HEADERS["receipt_origin"], "Gmail · cliente", counters)
                set_if_blank(
                    services.sheets,
                    orders,
                    row_no,
                    HEADERS["read_status"],
                    "Adjuntos recibidos · pendiente de lectura y validación",
                    counters,
                )

                if note_file:
                    set_if_blank(services.sheets, orders, row_no, HEADERS["source_file"], note_file["name"], counters)
                    update_value(
                        services.sheets,
                        "Pedidos",
                        row_no,
                        orders["columns"][HEADERS["note"]],
                        hyperlink_formula(drive_url(note_file["id"]), "Abrir"),
                    )
                    counters["sheet_cells"] += 1
                    ensure_review_row(services.sheets, review, order_id, receipt, note_file["id"], counters)

                if image_names:
                    update_value(
                        services.sheets,
                        "Pedidos",
                        row_no,
                        orders["columns"][HEADERS["attachments"]],
                        hyperlink_formula(drive_url(folder["id"], folder=True), "Ver adjuntos"),
                    )
                    counters["sheet_cells"] += 1

                counters["order_groups_materialized"] += 1
            except Exception:
                counters["errors"] += 1
                for file_id in reversed(created_file_ids):
                    try:
                        services.drive.files().delete(fileId=file_id).execute()
                    except Exception:
                        pass
                if created_folder_id:
                    try:
                        children = list_folder_files(services.drive, created_folder_id)
                        if not children:
                            services.drive.files().delete(fileId=created_folder_id).execute()
                    except Exception:
                        pass
                raise

    return {
        "phase": "M3",
        "mode": "CLIENT_INTAKE_PRODUCTION_SYNC",
        "multi_order_only": multi_order_only,
        "estimated_mutations": estimated_mutations,
        **counters,
        "write_operations": counters["sheet_cells"] + counters["files_created"] + counters["folders_created"],
    }

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-mutations", type=int, default=None)
    parser.add_argument("--multi-order-only", action="store_true")
    args = parser.parse_args()
    result = sync_intake(max_mutations=args.max_mutations, multi_order_only=args.multi_order_only)
    print("CLIENT_INTAKE_SYNC_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
