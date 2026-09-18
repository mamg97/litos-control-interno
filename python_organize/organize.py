from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

FOLDER_MIME = "application/vnd.google-apps.folder"
YEAR_FOLDERS = [
    (2026, "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"),
    (2025, "1yicoADtD85yEWZ9Qevcn0mzhRqcYiXQU"),
    (2024, "1TD0z7lRXkDOx47-dq4ig5vmDGUDC3BH7"),
    (2023, "1d94eLfw6EOf0N9YOyJubpz1u4pCr_wsq"),
    (2022, "1jT8Mlq4aeLvL4pWcChUFlTPHK0xe_Ynq"),
    (2021, "1MitrqxWNS-ympuhRfoYr-fvMzbJCvyH1"),
    (2020, "1UMgVG8IvZSJkCSxxrumXoBLxKaN6h7BK"),
]
ID_RE = re.compile(r"(?:^|[^0-9])(\d{4})(?=[^0-9]|$)")
DEFAULT_MAX_MOVES = 120


@dataclass(frozen=True)
class MoveCandidate:
    year: int
    year_folder_id: str
    file_id: str
    order_id: str
    target_folder_id: str | None


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def assert_write_safety() -> None:
    if not _flag("LITOS_FREE_ONLY"):
        raise RuntimeError("LITOS_FREE_ONLY must be true")
    if not _flag("LITOS_ORGANIZE_WRITE_ENABLED"):
        raise RuntimeError("LITOS_ORGANIZE_WRITE_ENABLED must be true")
    if _flag("LITOS_ORGANIZE_KILL_SWITCH"):
        raise RuntimeError("LITOS_ORGANIZE_KILL_SWITCH is active")


def build_drive():
    raw = os.environ.get("GOOGLE_OAUTH_WORKSHOP_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_WORKSHOP_JSON is missing")
    info = json.loads(raw)
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not str(info.get(key, "")).strip())
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_WORKSHOP_JSON missing fields: " + ", ".join(missing))
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def extract_order_ids(name: str) -> list[str]:
    return sorted(set(ID_RE.findall(str(name or ""))))


def list_direct_children(drive, folder_id: str) -> list[dict]:
    out: list[dict] = []
    page_token = None
    while True:
        response = (
            drive.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="nextPageToken,files(id,name,mimeType,parents)",
                pageSize=1000,
                pageToken=page_token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        out.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return out


def build_plan(drive) -> tuple[list[MoveCandidate], dict]:
    plan: list[MoveCandidate] = []
    years: dict[str, dict] = {}
    create_folder_keys: set[tuple[int, str]] = set()

    for year, folder_id in YEAR_FOLDERS:
        children = list_direct_children(drive, folder_id)
        folders_by_name: dict[str, str] = {}
        direct_files: list[dict] = []
        for child in sorted(children, key=lambda item: (item.get("name", ""), item.get("id", ""))):
            if child.get("mimeType") == FOLDER_MIME:
                folders_by_name.setdefault(str(child.get("name", "")), str(child.get("id", "")))
            else:
                direct_files.append(child)

        summary = {
            "direct_files": len(direct_files),
            "candidate_moves": 0,
            "skipped_no_id": 0,
            "skipped_ambiguous": 0,
            "folders_to_create": 0,
        }

        for file in sorted(direct_files, key=lambda item: (item.get("name", ""), item.get("id", ""))):
            ids = extract_order_ids(file.get("name", ""))
            if not ids:
                summary["skipped_no_id"] += 1
                continue
            if len(ids) > 1:
                summary["skipped_ambiguous"] += 1
                continue

            order_id = ids[0]
            target_folder_id = folders_by_name.get(order_id) or None
            if not target_folder_id:
                create_folder_keys.add((year, order_id))
            plan.append(
                MoveCandidate(
                    year=year,
                    year_folder_id=folder_id,
                    file_id=str(file["id"]),
                    order_id=order_id,
                    target_folder_id=target_folder_id,
                )
            )
            summary["candidate_moves"] += 1

        years[str(year)] = summary

    for year, order_id in create_folder_keys:
        years[str(year)]["folders_to_create"] += 1

    public = {
        "mode": "ORGANIZE_READ_ONLY_DISCOVERY",
        "candidate_moves": len(plan),
        "folders_to_create": len(create_folder_keys),
        "years": years,
        "write_operations": 0,
    }
    return plan, public


def _find_existing_folder(drive, parent_id: str, order_id: str) -> str | None:
    response = (
        drive.files()
        .list(
            q=(
                f"'{parent_id}' in parents and trashed = false and "
                f"mimeType = '{FOLDER_MIME}' and name = '{order_id}'"
            ),
            fields="files(id)",
            pageSize=10,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    files = response.get("files", [])
    return str(files[0]["id"]) if files else None


def _ensure_folder(drive, parent_id: str, order_id: str) -> tuple[str, bool]:
    existing = _find_existing_folder(drive, parent_id, order_id)
    if existing:
        return existing, False
    created = (
        drive.files()
        .create(
            body={"name": order_id, "mimeType": FOLDER_MIME, "parents": [parent_id]},
            fields="id",
            supportsAllDrives=True,
        )
        .execute()
    )
    return str(created["id"]), True


def execute_plan(
    drive,
    plan: list[MoveCandidate],
    max_moves: int,
    require_folder_create: bool = False,
) -> dict:
    assert_write_safety()
    eligible = plan
    if require_folder_create:
        eligible = [candidate for candidate in plan if candidate.target_folder_id is None]
        if not eligible:
            raise RuntimeError("No M5 candidate currently requires a new folder")

    selected = eligible[: max(0, max_moves)]
    folder_cache: dict[tuple[str, str], str] = {}
    created_folders: list[str] = []
    moved: list[tuple[str, str, str]] = []
    skipped_race = 0

    try:
        for candidate in selected:
            key = (candidate.year_folder_id, candidate.order_id)
            target_id = candidate.target_folder_id or folder_cache.get(key)
            if not target_id:
                target_id, created = _ensure_folder(drive, candidate.year_folder_id, candidate.order_id)
                if require_folder_create and not created:
                    raise RuntimeError(
                        "Folder-create canary lost its creation condition before the move; no canary move performed"
                    )
                folder_cache[key] = target_id
                if created:
                    created_folders.append(target_id)

            live = (
                drive.files()
                .get(
                    fileId=candidate.file_id,
                    fields="id,parents,trashed",
                    supportsAllDrives=True,
                )
                .execute()
            )
            if live.get("trashed") or candidate.year_folder_id not in set(live.get("parents", [])):
                skipped_race += 1
                continue

            (
                drive.files()
                .update(
                    fileId=candidate.file_id,
                    addParents=target_id,
                    removeParents=candidate.year_folder_id,
                    fields="id,parents",
                    supportsAllDrives=True,
                )
                .execute()
            )
            moved.append((candidate.file_id, candidate.year_folder_id, target_id))

    except Exception:
        for file_id, original_parent, target_parent in reversed(moved):
            try:
                (
                    drive.files()
                    .update(
                        fileId=file_id,
                        addParents=original_parent,
                        removeParents=target_parent,
                        fields="id,parents",
                        supportsAllDrives=True,
                    )
                    .execute()
                )
            except Exception:
                pass
        for folder_id in reversed(created_folders):
            try:
                drive.files().update(
                    fileId=folder_id,
                    body={"trashed": True},
                    fields="id,trashed",
                    supportsAllDrives=True,
                ).execute()
            except Exception:
                pass
        raise

    if require_folder_create and len(created_folders) != 1:
        raise RuntimeError(
            f"Folder-create canary expected exactly 1 created folder, got {len(created_folders)}"
        )
    if require_folder_create and len(moved) != 1:
        raise RuntimeError(
            f"Folder-create canary expected exactly 1 moved file, got {len(moved)}"
        )

    return {
        "mode": "ORGANIZE_PRODUCTION_SYNC",
        "candidate_moves_before_sync": len(plan),
        "eligible_candidates": len(eligible),
        "move_limit": max_moves,
        "files_moved": len(moved),
        "folders_created": len(created_folders),
        "require_folder_create": require_folder_create,
        "skipped_race": skipped_race,
        "remaining_from_initial_plan": max(0, len(plan) - len(selected)),
        "write_operations": len(moved) + len(created_folders),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--sync", action="store_true")
    parser.add_argument("--max-moves", type=int, default=DEFAULT_MAX_MOVES)
    parser.add_argument(
        "--require-folder-create",
        action="store_true",
        help="For a guarded canary, select a candidate without an existing target folder and require one folder creation plus one move.",
    )
    args = parser.parse_args()

    if args.preflight:
        print("ORGANIZE_PREFLIGHT_OK")
        print(
            json.dumps(
                {
                    "component": "organize-job-folders",
                    "phase": "M5",
                    "mode": "FAIL_CLOSED",
                    "years": [year for year, _ in YEAR_FOLDERS],
                    "default_max_moves": DEFAULT_MAX_MOVES,
                    "write_enabled": False,
                },
                sort_keys=True,
            )
        )
        return 0

    if args.require_folder_create and not args.sync:
        raise RuntimeError("--require-folder-create is only valid with --sync")
    if args.require_folder_create and args.max_moves != 1:
        raise RuntimeError("--require-folder-create requires --max-moves 1")

    drive = build_drive()
    plan, summary = build_plan(drive)
    if args.dry_run:
        print("ORGANIZE_DRY_RUN_OK")
        print(json.dumps(summary, sort_keys=True))
        return 0

    result = execute_plan(
        drive,
        plan,
        args.max_moves,
        require_folder_create=args.require_folder_create,
    )
    _, post = build_plan(drive)
    result["candidate_moves_after_sync"] = post["candidate_moves"]
    result["folders_to_create_after_sync"] = post["folders_to_create"]
    print("ORGANIZE_SAFE_SYNC_OK")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
