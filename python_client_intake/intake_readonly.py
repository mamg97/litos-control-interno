from __future__ import annotations

import hashlib
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from email.utils import parseaddr
from typing import Iterable
from zoneinfo import ZoneInfo

MASTER_ID = os.environ.get("LITOS_SPREADSHEET_ID", "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q")
ROOT_FOLDER_ID = os.environ.get("LITOS_CLIENT_FOLDER_ID", "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_")
PRIVATE_CONFIG_SHEET = "Configuracion privada"
YEAR = int(os.environ.get("LITOS_CLIENT_YEAR", "2026"))
LOOKBACK_DAYS = int(os.environ.get("LITOS_CLIENT_LOOKBACK_DAYS", "30"))
TIMEZONE = ZoneInfo("Europe/Madrid")

HEADERS = {
    "id": "Pedido",
    "source_file": "Archivo de ficha",
    "read_status": "Estado de lectura",
    "receipt_date": "Fecha recepción (email)",
    "receipt_origin": "Origen fecha recepción",
    "note": "Notas",
    "attachments": "Imágenes anejas",
}

IMAGE_RE = re.compile(r"\.(jpe?g|png|heic|webp)$", re.IGNORECASE)


@dataclass(frozen=True)
class AttachmentMeta:
    filename: str
    mime_type: str
    attachment_id: str


@dataclass
class SheetSnapshot:
    headers: list[str]
    columns: dict[str, int]
    row_by_id: dict[str, list[str]]


def clean(value: object) -> str:
    return str("" if value is None else value).strip()




def load_private_intake_config(sheets) -> dict:
    values = sheets.spreadsheets().values().get(
        spreadsheetId=MASTER_ID,
        range=f"'{PRIVATE_CONFIG_SHEET}'!A1:B100",
        valueRenderOption="FORMATTED_VALUE",
    ).execute().get("values", [])
    config = {clean(row[0]): clean(row[1]) for row in values if len(row) >= 2 and clean(row[0])}
    sender = config.get("intake_allowed_sender", "").lower()
    kill_raw = config.get("intake_kill_switch", "true").lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", sender):
        raise RuntimeError("Private intake sender is missing or invalid")
    if kill_raw not in {"true", "false"}:
        raise RuntimeError("Private intake kill switch must be true or false")
    return {"allowed_sender": sender, "kill_switch": kill_raw == "true"}

def sender_address(value: str) -> str:
    return parseaddr(value or "")[1].strip().lower()


ORDER_ID_RE = re.compile(r"(?:^|\D)(\d{4})(?:\D|$)")


def explicit_order_id(value: object) -> str:
    match = ORDER_ID_RE.search(str(value or ""))
    return match.group(1) if match else ""


def extract_order_id(subject: str, attachment_names: Iterable[str]) -> str:
    for value in [subject, *attachment_names]:
        order_id = explicit_order_id(value)
        if order_id:
            return order_id
    return ""


def group_attachment_indexes_by_order(subject: str, attachment_names: Iterable[str]) -> tuple[dict[str, list[int]], list[int]]:
    """Partition attachments using the explicit four-digit work ID as canonical key."""
    names = list(attachment_names)
    explicit = [explicit_order_id(name) for name in names]
    explicit_ids = {order_id for order_id in explicit if order_id}
    groups: dict[str, list[int]] = {}
    unresolved: list[int] = []

    if explicit_ids:
        for index, order_id in enumerate(explicit):
            if order_id:
                groups.setdefault(order_id, []).append(index)
            else:
                unresolved.append(index)
        if len(explicit_ids) == 1:
            only = next(iter(explicit_ids))
            groups.setdefault(only, []).extend(unresolved)
            unresolved = []
        return groups, unresolved

    subject_id = explicit_order_id(subject)
    if subject_id:
        return {subject_id: list(range(len(names)))}, []
    return {}, list(range(len(names)))


def extension_from_mime(mime_type: str) -> str:
    value = (mime_type or "").lower()
    if "jpeg" in value:
        return ".jpg"
    if "png" in value:
        return ".png"
    if "pdf" in value:
        return ".pdf"
    if "heic" in value:
        return ".heic"
    return ""


def stored_attachment_name(order_id: str, attachment: AttachmentMeta, index: int) -> str:
    name = clean(attachment.filename)
    if not name:
        name = f"{order_id}-adjunto-{index + 1}{extension_from_mime(attachment.mime_type)}"
    if not re.search(rf"^{re.escape(order_id)}(?:\D|$)", name):
        name = f"{order_id}-{name}"
    return name


def classify_names(order_id: str, names: list[str]) -> tuple[str | None, list[str]]:
    note_pattern = re.compile(rf"^{re.escape(order_id)}[-_ ]0(?:[-_. ]|$)", re.IGNORECASE)
    note = next((name for name in names if note_pattern.search(name)), None)
    images = [name for name in names if IMAGE_RE.search(name) and name != note]
    if note is None and len(names) == 1 and IMAGE_RE.search(names[0]):
        note = names[0]
        images = []
    return note, images


def _header_value(headers: list[dict], name: str) -> str:
    target = name.lower()
    for item in headers or []:
        if str(item.get("name", "")).lower() == target:
            return str(item.get("value", ""))
    return ""


def _is_inline(part: dict) -> bool:
    disposition = _header_value(part.get("headers", []), "Content-Disposition").lower()
    return disposition.startswith("inline")


def _attachment_meta(payload: dict) -> list[AttachmentMeta]:
    result: list[AttachmentMeta] = []

    def visit(part: dict) -> None:
        body = part.get("body") or {}
        filename = clean(part.get("filename"))
        attachment_id = clean(body.get("attachmentId"))
        if (filename or attachment_id) and not _is_inline(part):
            result.append(
                AttachmentMeta(
                    filename=filename,
                    mime_type=clean(part.get("mimeType")),
                    attachment_id=attachment_id,
                )
            )
        for child in part.get("parts") or []:
            visit(child)

    visit(payload or {})
    return result


def load_sheet_snapshot(sheets) -> SheetSnapshot:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range="Pedidos!A:AN",
            valueRenderOption="FORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    values = response.get("values", [])
    header_index = next(
        (index for index, row in enumerate(values) if any(clean(cell) == HEADERS["id"] for cell in row)),
        None,
    )
    if header_index is None:
        raise RuntimeError("No se encontró la cabecera Pedido en la pestaña Pedidos")

    headers = [clean(cell) for cell in values[header_index]]
    columns = {header: index for index, header in enumerate(headers) if header}
    missing = [header for header in HEADERS.values() if header not in columns]
    if missing:
        raise RuntimeError("Faltan columnas requeridas en Pedidos: " + ", ".join(missing))

    row_by_id: dict[str, list[str]] = {}
    id_index = columns[HEADERS["id"]]
    for row in values[header_index + 1 :]:
        order_id = clean(row[id_index]) if len(row) > id_index else ""
        if order_id:
            row_by_id[order_id] = list(row)
    return SheetSnapshot(headers=headers, columns=columns, row_by_id=row_by_id)


def row_value(snapshot: SheetSnapshot, row: list[str], header: str) -> str:
    index = snapshot.columns[header]
    return clean(row[index]) if index < len(row) else ""


def list_candidate_messages(gmail, allowed_sender: str) -> list[dict]:
    query = f"from:{allowed_sender} newer_than:{LOOKBACK_DAYS}d"
    threads: list[dict] = []
    page_token = None
    while True:
        response = (
            gmail.users()
            .threads()
            .list(userId="me", q=query, maxResults=100, pageToken=page_token)
            .execute()
        )
        threads.extend(response.get("threads", []))
        page_token = response.get("nextPageToken")
        if not page_token or len(threads) >= 100:
            break

    messages: list[dict] = []
    for thread in threads[:100]:
        detail = (
            gmail.users()
            .threads()
            .get(
                userId="me",
                id=thread["id"],
                format="metadata",
                metadataHeaders=["From", "Subject", "Content-Disposition"],
            )
            .execute()
        )
        messages.extend(detail.get("messages", []))
    messages.sort(key=lambda message: int(message.get("internalDate", "0") or 0))
    return messages


def list_sent_messages(gmail) -> list[dict]:
    query = f"in:sent newer_than:{LOOKBACK_DAYS}d"
    threads: list[dict] = []
    page_token = None
    while True:
        response = (
            gmail.users()
            .threads()
            .list(userId="me", q=query, maxResults=100, pageToken=page_token)
            .execute()
        )
        threads.extend(response.get("threads", []))
        page_token = response.get("nextPageToken")
        if not page_token or len(threads) >= 100:
            break

    messages: list[dict] = []
    for thread in threads[:100]:
        detail = (
            gmail.users()
            .threads()
            .get(
                userId="me",
                id=thread["id"],
                format="metadata",
                metadataHeaders=["From", "Subject", "Content-Disposition"],
            )
            .execute()
        )
        messages.extend(detail.get("messages", []))
    messages.sort(key=lambda message: int(message.get("internalDate", "0") or 0))
    return messages


def _drive_list(drive, *, query: str, fields: str) -> list[dict]:
    items: list[dict] = []
    page_token = None
    while True:
        response = (
            drive.files()
            .list(
                q=query,
                spaces="drive",
                fields=f"nextPageToken, files({fields})",
                pageSize=1000,
                pageToken=page_token,
            )
            .execute()
        )
        items.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return items


def find_order_folder(drive, order_id: str) -> dict | None:
    query = (
        f"'{ROOT_FOLDER_ID}' in parents and trashed = false "
        f"and mimeType = 'application/vnd.google-apps.folder' and name = '{order_id}'"
    )
    folders = _drive_list(drive, query=query, fields="id,name,mimeType")
    return folders[0] if folders else None


def list_folder_files(drive, folder_id: str) -> list[dict]:
    query = f"'{folder_id}' in parents and trashed = false"
    return _drive_list(drive, query=query, fields="id,name,mimeType,md5Checksum,size")


def _message_fingerprint(message: dict) -> str:
    raw = f"{message.get('id','')}|{message.get('internalDate','')}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def build_read_only_plan(services, allowed_sender: str | None = None) -> dict:
    private_config = load_private_intake_config(services.sheets)
    allowed_sender = clean(allowed_sender or private_config["allowed_sender"]).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", allowed_sender):
        raise RuntimeError("Private intake sender is missing or invalid")

    snapshot = load_sheet_snapshot(services.sheets)
    messages = list_candidate_messages(services.gmail, allowed_sender)

    counts = Counter()
    candidates: list[dict] = []
    order_folder_cache: dict[str, dict | None] = {}
    folder_files_cache: dict[str, list[dict]] = {}
    ambiguous_attachments = 0

    for message in messages:
        headers = (message.get("payload") or {}).get("headers") or []
        shown_from = _header_value(headers, "From")
        subject = _header_value(headers, "Subject")
        internal_ms = int(message.get("internalDate", "0") or 0)
        local_date = datetime.fromtimestamp(internal_ms / 1000, tz=TIMEZONE)
        attachments = _attachment_meta(message.get("payload") or {})
        names = [item.filename for item in attachments]
        fingerprint = _message_fingerprint(message)

        if local_date.year != YEAR:
            counts["blocked_wrong_year"] += 1
            continue
        if sender_address(shown_from) != allowed_sender:
            counts["blocked_wrong_sender"] += 1
            continue

        groups, unresolved = group_attachment_indexes_by_order(subject, names)
        ambiguous_attachments += len(unresolved)
        if not groups:
            counts["blocked_no_order_id"] += 1
            continue

        for order_id, indexes in sorted(groups.items()):
            grouped = [attachments[index] for index in indexes]
            expected_names = [
                stored_attachment_name(order_id, attachment, index)
                for index, attachment in enumerate(grouped)
            ]
            note_name, image_names = classify_names(order_id, expected_names)
            row = snapshot.row_by_id.get(order_id)

            if order_id not in order_folder_cache:
                order_folder_cache[order_id] = find_order_folder(services.drive, order_id)
            folder = order_folder_cache[order_id]
            existing_names: set[str] = set()
            if folder:
                folder_id = folder["id"]
                if folder_id not in folder_files_cache:
                    folder_files_cache[folder_id] = list_folder_files(services.drive, folder_id)
                existing_names = {clean(item.get("name")) for item in folder_files_cache[folder_id]}

            missing_files = [name for name in expected_names if name not in existing_names]
            missing_fields: list[str] = []
            if row is not None:
                for header in (
                    HEADERS["receipt_date"],
                    HEADERS["receipt_origin"],
                    HEADERS["read_status"],
                ):
                    if not row_value(snapshot, row, header):
                        missing_fields.append(header)
                if note_name:
                    for header in (HEADERS["source_file"], HEADERS["note"]):
                        if not row_value(snapshot, row, header):
                            missing_fields.append(header)
                if image_names and not row_value(snapshot, row, HEADERS["attachments"]):
                    missing_fields.append(HEADERS["attachments"])

            if row is None:
                action = "would_create_order"
            elif missing_files or missing_fields or folder is None:
                action = "would_update_order"
            else:
                action = "already_materialized"

            counts[action] += 1
            candidates.append(
                {
                    "fingerprint": f"{fingerprint}-{order_id}",
                    "order_id": order_id,
                    "action": action,
                    "attachments": len(expected_names),
                    "missing_files": len(missing_files),
                    "missing_fields": len(missing_fields),
                    "folder_exists": bool(folder),
                    "row_exists": row is not None,
                    "has_note": bool(note_name),
                    "image_count": len(image_names),
                }
            )

    mutable = counts["would_create_order"] + counts["would_update_order"]
    return {
        "mode": "CLIENT_INTAKE_READ_ONLY_DISCOVERY",
        "year": YEAR,
        "lookback_days": LOOKBACK_DAYS,
        "messages_scanned": len(messages),
        "order_groups_scanned": len(candidates),
        "ambiguous_attachments": ambiguous_attachments,
        "orders_in_sheet": len(snapshot.row_by_id),
        "actions": dict(sorted(counts.items())),
        "mutable": mutable,
        "already_materialized": counts["already_materialized"],
        "state_bootstrap_candidates": counts["already_materialized"],
        "candidates": candidates,
        "write_operations": 0,
    }

def public_summary(plan: dict) -> dict:
    """Return a log-safe summary: no sender, subject, filename, Gmail id or Drive id."""
    return {
        "mode": plan["mode"],
        "year": plan["year"],
        "lookback_days": plan["lookback_days"],
        "messages_scanned": plan["messages_scanned"],
        "order_groups_scanned": plan.get("order_groups_scanned", 0),
        "ambiguous_attachments": plan.get("ambiguous_attachments", 0),
        "orders_in_sheet": plan["orders_in_sheet"],
        "actions": plan["actions"],
        "mutable": plan["mutable"],
        "already_materialized": plan["already_materialized"],
        "state_bootstrap_candidates": plan["state_bootstrap_candidates"],
        "write_operations": plan["write_operations"],
    }
