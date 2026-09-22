from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from zoneinfo import ZoneInfo
import hashlib
import json
import os
import re
import time

import pandas as pd
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

from runtime import build_target_xlsx, compare_target_actual, runtime_contract

SPREADSHEET_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q"
DRAFT_ROOT_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"
TEMPLATE_ID = "1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY"
EXPECTED_RUNTIME_SHA = "a9ef70f01bfa66a64656510e883b5311202d595f5ab26431957fc7fb36aa4709"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FOLDER_MIME = "application/vnd.google-apps.folder"
MAX_MUTATIONS = 8
MAX_RUNTIME_SECONDS = 240


@dataclass
class Services:
    drive: object
    sheets: object


def _clean(v):
    return str(v if v is not None else "").strip()


def _truthy(v):
    return str(v or "").strip().lower() in {"1", "true", "yes", "on"}


def _date(v):
    s = _clean(v)
    if not s:
        return pd.NaT
    return pd.to_datetime(s, dayfirst=True, errors="coerce")


def _validated(row):
    status = _clean(row.get("Estado de lectura", "")).lower()
    return (
        "validado manualmente" in status
        or "validado automáticamente" in status
        or "manuscrito revisado" in status
    )


def _quarter_bounds(now=None):
    now = now or datetime.now(ZoneInfo("Europe/Madrid"))
    sm = ((now.month - 1) // 3) * 3 + 1
    start = pd.Timestamp(now.year, sm, 1)
    end = pd.Timestamp(now.year + (1 if sm == 10 else 0), 1 if sm == 10 else sm + 3, 1)
    return start, end


def _credentials():
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is missing")
    info = json.loads(raw)
    return service_account.Credentials.from_service_account_info(
        info,
        scopes=[
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
        ],
    )


def build_services():
    cred = _credentials()
    return Services(
        drive=build("drive", "v3", credentials=cred, cache_discovery=False),
        sheets=build("sheets", "v4", credentials=cred, cache_discovery=False),
    )


def _download(drive, file_id):
    req = drive.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = BytesIO()
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def _export_xlsx(drive, file_id):
    req = drive.files().export_media(fileId=file_id, mimeType=XLSX_MIME)
    buf = BytesIO()
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def _upload_update(drive, file_id, payload):
    media = MediaIoBaseUpload(BytesIO(payload), mimetype=XLSX_MIME, resumable=False)
    return drive.files().update(
        fileId=file_id,
        media_body=media,
        fields="id,name,parents,modifiedTime,size",
        supportsAllDrives=True,
    ).execute()


def _upload_create(drive, parent_id, name, payload):
    media = MediaIoBaseUpload(BytesIO(payload), mimetype=XLSX_MIME, resumable=False)
    return drive.files().create(
        body={"name": name, "parents": [parent_id], "mimeType": XLSX_MIME},
        media_body=media,
        fields="id,name,parents,modifiedTime,size",
        supportsAllDrives=True,
    ).execute()


def _list_children(drive, folder_id):
    token = None
    out = []
    while True:
        res = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            spaces="drive",
            fields="nextPageToken,files(id,name,mimeType,parents,modifiedTime,size,webViewLink)",
            pageToken=token,
            pageSize=1000,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        out.extend(res.get("files", []))
        token = res.get("nextPageToken")
        if not token:
            return out


def _sheet_rows(sheets):
    values = sheets.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="Pedidos!A1:AN1000",
        valueRenderOption="FORMATTED_VALUE",
    ).execute().get("values", [])
    if len(values) < 5:
        raise RuntimeError("Pedidos header row 5 missing")
    headers = list(values[4])
    while len(headers) < 40:
        headers.append(f"_col_{len(headers)+1}")
    headers = headers[:40]
    rows = []
    for sheet_row, raw in enumerate(values[5:], start=6):
        padded = list(raw) + [""] * (40 - len(raw))
        rec = dict(zip(headers, padded[:40]))
        rec["_sheet_row"] = sheet_row
        rows.append(rec)
    return pd.DataFrame(rows)


def _catalog(sheets):
    values = sheets.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range="'Catálogo operativo'!A1:M81",
        valueRenderOption="FORMATTED_VALUE",
    ).execute().get("values", [])
    if len(values) < 2:
        raise RuntimeError("Catálogo operativo missing")
    headers = list(values[0])
    rows = []
    for raw in values[1:]:
        padded = list(raw) + [""] * (len(headers)-len(raw))
        rows.append(dict(zip(headers, padded[:len(headers)])))
    return pd.DataFrame(rows)


def _scope_rows(pedidos):
    q_start, q_end = _quarter_bounds()
    scoped = []
    for _, row in pedidos.iterrows():
        pedido = _clean(row.get("Pedido", ""))
        if not re.fullmatch(r"\d{4}", pedido):
            continue
        receipt = _date(row.get("Fecha recepción (email)", ""))
        if pd.isna(receipt):
            receipt = _date(row.get("Fecha ficha", ""))
        if pd.isna(receipt):
            receipt = _date(row.get("Fecha para dashboard", ""))
        if pd.isna(receipt) or not (q_start <= receipt < q_end):
            continue
        scoped.append(row.to_dict())
    return scoped


def _index_scope_drive(drive, order_ids):
    root_children = _list_children(drive, DRAFT_ROOT_FOLDER_ID)
    order_folders = {
        _clean(x.get("name")): x
        for x in root_children
        if x.get("mimeType") == FOLDER_MIME and re.fullmatch(r"\d{4}", _clean(x.get("name")))
    }
    index = {}
    for pedido in sorted(set(order_ids)):
        folder = order_folders.get(pedido)
        if not folder:
            index[pedido] = {"folder": None, "invoice": None, "invoiceDraft": None}
            continue
        docs = {"folder": folder, "invoice": None, "invoiceDraft": None}
        for item in sorted(_list_children(drive, folder["id"]), key=lambda x: (_clean(x.get("name")), x.get("id", ""))):
            name = _clean(item.get("name"))
            if not re.search(r"\.(xlsx|xls|xlsm)$", name, flags=re.I):
                continue
            normalized = name.lower()
            kind = "invoiceDraft" if re.search(r"(?:^|[-_ ])borrador(?:[-_ .]|$)", normalized) else "invoice"
            if docs[kind] is None:
                docs[kind] = item
        index[pedido] = docs
    return index


def _read_am_link(sheets, row_num):
    data = sheets.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"Pedidos!AM{row_num}"],
        includeGridData=True,
        fields="sheets(data(rowData(values(formattedValue,hyperlink,userEnteredValue,userEnteredFormat(textFormat(link))))))",
    ).execute()
    try:
        cell = data["sheets"][0]["data"][0]["rowData"][0]["values"][0]
    except Exception:
        return {"formattedValue": "", "hyperlink": "", "raw": {}}
    link = cell.get("hyperlink", "") or cell.get("userEnteredFormat", {}).get("textFormat", {}).get("link", {}).get("uri", "")
    return {"formattedValue": cell.get("formattedValue", ""), "hyperlink": link, "raw": cell}


def _set_am_link(sheets, row_num, file_id):
    uri = f"https://docs.google.com/spreadsheets/d/{file_id}/edit?usp=drivesdk"
    request = {
        "updateCells": {
            "start": {"sheetId": 1998075404, "rowIndex": row_num - 1, "columnIndex": 38},
            "rows": [{"values": [{
                "userEnteredValue": {"stringValue": "Abrir borrador"},
                "userEnteredFormat": {"textFormat": {"link": {"uri": uri}}},
            }]}],
            "fields": "userEnteredValue,userEnteredFormat.textFormat.link",
        }
    }
    sheets.spreadsheets().batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={"requests": [request]},
    ).execute()
    return uri


def _clear_am(sheets, row_num):
    request = {
        "updateCells": {
            "range": {"sheetId": 1998075404, "startRowIndex": row_num-1, "endRowIndex": row_num, "startColumnIndex": 38, "endColumnIndex": 39},
            "fields": "userEnteredValue,userEnteredFormat.textFormat.link",
        }
    }
    sheets.spreadsheets().batchUpdate(spreadsheetId=SPREADSHEET_ID, body={"requests":[request]}).execute()


def _backup_existing(drive, backup_folder_id, pedido, target_meta, original_bytes):
    sha = hashlib.sha256(original_bytes).hexdigest()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = f"{pedido}_{target_meta['id']}_{stamp}_PRE_PY_SYNC.xlsx"
    created = _upload_create(drive, backup_folder_id, name, original_bytes)
    downloaded = _download(drive, created["id"])
    if hashlib.sha256(downloaded).hexdigest() != sha:
        raise RuntimeError(f"Backup verification failed for {pedido}")
    return {"backup_file_id": created["id"], "backup_name": name, "raw_sha256": sha}


def build_plan(services):
    contract = runtime_contract()
    if contract.get("certified_source_sha256") != EXPECTED_RUNTIME_SHA or not contract.get("certified_source_verified"):
        raise RuntimeError("Certified runtime attestation failed")
    pedidos = _sheet_rows(services.sheets)
    catalog = _catalog(services.sheets)
    scope = _scope_rows(pedidos)

    # Optional fail-closed scope for targeted repairs. Scheduled production
    # remains unchanged when the variable is absent.
    only_order = os.environ.get("LITOS_DRAFT_ONLY_ORDER", "").strip()
    if only_order:
        if not re.fullmatch(r"\d{4}", only_order):
            raise RuntimeError(f"Invalid LITOS_DRAFT_ONLY_ORDER: {only_order!r}")
        scope = [row for row in scope if _clean(row.get("Pedido")) == only_order]
        if len(scope) != 1:
            raise RuntimeError(f"Scoped order {only_order} not found exactly once in current-quarter plan")

    drive_index = _index_scope_drive(services.drive, [_clean(r.get("Pedido")) for r in scope])
    template_bytes = _export_xlsx(services.drive, TEMPLATE_ID)
    plan = []
    for row in scope:
        pedido = _clean(row.get("Pedido"))
        docs = drive_index[pedido]
        definitive = docs.get("invoice")
        draft = docs.get("invoiceDraft")
        target = None
        comparison = None
        if definitive:
            action = "definitive"
        elif not _validated(row) and not draft:
            action = "pendingValidation"
        else:
            target = build_target_xlsx(row, catalog, template_bytes)
            if draft:
                actual = _download(services.drive, draft["id"])
                comparison = compare_target_actual(target["xlsx_bytes"], actual, pedido)
                action = "unchanged" if comparison["match"] else "updated"
            elif _validated(row):
                action = "created"
            else:
                action = "pendingValidation"
        plan.append({
            "pedido": pedido,
            "source_row": int(row["_sheet_row"]),
            "action": action,
            "row": row,
            "folder": docs.get("folder"),
            "draft": draft,
            "definitive": definitive,
            "target": target,
            "comparison": comparison,
        })
    return plan


def summarize_plan(plan):
    counts = {}
    for item in plan:
        counts[item["action"]] = counts.get(item["action"], 0) + 1
    mutable = [x for x in plan if x["action"] in {"created", "updated"}]
    return {"rows": len(plan), "actions": counts, "mutable": len(mutable), "orders": [x["pedido"] for x in mutable]}


def execute_sync(services, backup_folder_id):
    start = time.monotonic()
    plan = build_plan(services)
    summary = summarize_plan(plan)
    mutable = [x for x in plan if x["action"] in {"created", "updated"}]
    if len(mutable) > MAX_MUTATIONS:
        raise RuntimeError(f"Mutation cap exceeded: {len(mutable)} > {MAX_MUTATIONS}")
    results = []
    for item in mutable:
        if time.monotonic() - start > MAX_RUNTIME_SECONDS:
            raise RuntimeError("Runtime cap exceeded before completing mutation set")
        pedido = item["pedido"]
        row_num = item["source_row"]
        target_bytes = item["target"]["xlsx_bytes"]
        target_sha = hashlib.sha256(target_bytes).hexdigest()
        if item["action"] == "updated":
            draft = item["draft"]
            original = _download(services.drive, draft["id"])
            original_sha = hashlib.sha256(original).hexdigest()
            meta_before = services.drive.files().get(fileId=draft["id"], fields="id,name,parents,size,modifiedTime", supportsAllDrives=True).execute()
            link_before = _read_am_link(services.sheets, row_num)
            if draft["id"] not in link_before.get("hyperlink", ""):
                raise RuntimeError(f"Sheet hyperlink guard failed for {pedido}")
            backup = _backup_existing(services.drive, backup_folder_id, pedido, meta_before, original)
            mutated = False
            try:
                _upload_update(services.drive, draft["id"], target_bytes)
                mutated = True
                after = _download(services.drive, draft["id"])
                cmp = compare_target_actual(target_bytes, after, pedido)
                meta_after = services.drive.files().get(fileId=draft["id"], fields="id,name,parents,size,modifiedTime", supportsAllDrives=True).execute()
                link_after = _read_am_link(services.sheets, row_num)
                if not cmp["match"]:
                    raise RuntimeError("Post-write workbook parity failed")
                if meta_after.get("id") != meta_before.get("id") or meta_after.get("name") != meta_before.get("name") or meta_after.get("parents") != meta_before.get("parents"):
                    raise RuntimeError("Post-write Drive identity guard failed")
                if draft["id"] not in link_after.get("hyperlink", ""):
                    raise RuntimeError("Post-write Sheet hyperlink guard failed")
                results.append({"pedido": pedido, "action": "updated", "file_id": draft["id"], "target_sha256": target_sha, **backup})
            except Exception as exc:
                if mutated:
                    _upload_update(services.drive, draft["id"], original)
                    restored = _download(services.drive, draft["id"])
                    if hashlib.sha256(restored).hexdigest() != original_sha:
                        raise RuntimeError(f"SEVERE rollback verification failed for {pedido}") from exc
                raise
        else:
            folder = item.get("folder")
            if not folder:
                raise RuntimeError(f"No exact order folder found for create: {pedido}")
            link_before = _read_am_link(services.sheets, row_num)
            if link_before.get("formattedValue") not in {"", "No disponible"}:
                raise RuntimeError(f"AM cell not empty before create for {pedido}")
            created = None
            link_written = False
            try:
                created = _upload_create(services.drive, folder["id"], f"{pedido}_borrador.xlsx", target_bytes)
                downloaded = _download(services.drive, created["id"])
                cmp = compare_target_actual(target_bytes, downloaded, pedido)
                if not cmp["match"]:
                    raise RuntimeError("Created workbook parity failed")
                _set_am_link(services.sheets, row_num, created["id"])
                link_written = True
                link_after = _read_am_link(services.sheets, row_num)
                if created["id"] not in link_after.get("hyperlink", ""):
                    raise RuntimeError("Created Sheet hyperlink verification failed")
                results.append({"pedido": pedido, "action": "created", "file_id": created["id"], "target_sha256": target_sha})
            except Exception:
                if link_written:
                    try:
                        _clear_am(services.sheets, row_num)
                    except Exception:
                        pass
                if created:
                    try:
                        services.drive.files().delete(fileId=created["id"], supportsAllDrives=True).execute()
                    except Exception:
                        pass
                raise
    # Fresh post-run plan must be idempotent: no mutable actions remain.
    post = build_plan(services)
    post_summary = summarize_plan(post)
    if post_summary["mutable"] != 0:
        raise RuntimeError(f"Post-sync idempotence failed: {post_summary}")
    return {
        "phase": "PYTHON_DRAFT_SYNC",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "pre": summary,
        "mutations": results,
        "post": post_summary,
        "runtime_sha256": EXPECTED_RUNTIME_SHA,
    }
