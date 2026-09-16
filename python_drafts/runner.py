from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

try:
    from .runtime import runtime_contract
except ImportError:
    from runtime import runtime_contract

EXPECTED_CERTIFIED_RUNTIME_SHA = "5fd37023b10b61a1b26bc8573bf809c26bfce4001e98e8673d1de7328d8c0088"
EXPECTED_SPREADSHEET_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q"
EXPECTED_DRAFT_ROOT_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"
EXPECTED_BACKUP_FOLDER_ID = "1weWKeCLjQnrL2Qg2rPt1BYHGJhfZtKrv"


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class CutoverConfig:
    kill_switch: bool
    write_enabled: bool
    free_only: bool
    spreadsheet_id: str
    draft_root_folder_id: str
    backup_folder_id: str
    google_oauth_user_json_present: bool

    @classmethod
    def from_env(cls) -> "CutoverConfig":
        return cls(
            kill_switch=_truthy(os.getenv("LITOS_KILL_SWITCH", "true")),
            write_enabled=_truthy(os.getenv("LITOS_WRITE_ENABLED", "false")),
            free_only=_truthy(os.getenv("LITOS_FREE_ONLY", "true")),
            spreadsheet_id=os.getenv("LITOS_SPREADSHEET_ID", EXPECTED_SPREADSHEET_ID),
            draft_root_folder_id=os.getenv("LITOS_DRAFT_ROOT_FOLDER_ID", EXPECTED_DRAFT_ROOT_FOLDER_ID),
            backup_folder_id=os.getenv("LITOS_BACKUP_FOLDER_ID", EXPECTED_BACKUP_FOLDER_ID),
            google_oauth_user_json_present=bool(os.getenv("GOOGLE_OAUTH_USER_JSON", "").strip()),
        )


def preflight(cfg: CutoverConfig) -> dict:
    contract = runtime_contract()
    checks = {
        "certified_runtime_sha_pinned": contract.get("certified_source_sha256") == EXPECTED_CERTIFIED_RUNTIME_SHA,
        "certified_runtime_blob_verified": contract.get("certified_source_verified") is True,
        "spreadsheet_id_pinned": cfg.spreadsheet_id == EXPECTED_SPREADSHEET_ID,
        "draft_root_id_pinned": cfg.draft_root_folder_id == EXPECTED_DRAFT_ROOT_FOLDER_ID,
        "backup_folder_id_pinned": cfg.backup_folder_id == EXPECTED_BACKUP_FOLDER_ID,
        "free_only_policy_enabled": cfg.free_only is True,
        "kill_switch_present": isinstance(cfg.kill_switch, bool),
        "write_guard_consistent": not (cfg.kill_switch and cfg.write_enabled),
        "google_user_identity_present": cfg.google_oauth_user_json_present,
    }
    ready_for_write = (
        all(checks.values())
        and cfg.free_only
        and (not cfg.kill_switch)
        and cfg.write_enabled
    )
    return {
        "phase": "PYTHON_DRAFT_CUTOVER_EXECUTOR",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "contract": contract,
        "config": {
            "kill_switch": cfg.kill_switch,
            "write_enabled": cfg.write_enabled,
            "free_only": cfg.free_only,
            "spreadsheet_id": cfg.spreadsheet_id,
            "draft_root_folder_id": cfg.draft_root_folder_id,
            "backup_folder_id": cfg.backup_folder_id,
            "google_oauth_user_json_present": cfg.google_oauth_user_json_present,
        },
        "checks": checks,
        "ready_for_write": ready_for_write,
    }


def _build_user_services():
    try:
        from .google_user_auth import build_user_services
    except ImportError:
        from google_user_auth import build_user_services
    return build_user_services()


def _planner_api():
    try:
        from .executor import build_plan, summarize_plan, execute_sync
    except ImportError:
        from executor import build_plan, summarize_plan, execute_sync
    return build_plan, summarize_plan, execute_sync


def main() -> int:
    cfg = CutoverConfig.from_env()
    result = preflight(cfg)
    mode = (sys.argv[1] if len(sys.argv) > 1 else "--preflight").strip()

    if mode == "--preflight":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        immutable_ok = (
            result["checks"]["certified_runtime_sha_pinned"]
            and result["checks"]["certified_runtime_blob_verified"]
            and result["checks"]["free_only_policy_enabled"]
        )
        return 0 if immutable_ok else 2

    if mode == "--dry-run":
        if not cfg.google_oauth_user_json_present:
            print("DRY RUN BLOCKED: GOOGLE_OAUTH_USER_JSON is missing.", file=sys.stderr)
            return 3
        try:
            build_plan, summarize_plan, _ = _planner_api()
            services = _build_user_services()
            plan = build_plan(services)
            summary = summarize_plan(plan)
            outcome = {
                "status": "DRY_RUN_OK",
                "write_operations": 0,
                "kill_switch": cfg.kill_switch,
                "write_enabled": cfg.write_enabled,
                "free_only": cfg.free_only,
                "plan": summary,
            }
            print(json.dumps(outcome, ensure_ascii=False, indent=2, default=str))
            return 0
        except Exception as exc:
            print(json.dumps({"status": "DRY_RUN_FAILED", "error": repr(exc)}, ensure_ascii=False), file=sys.stderr)
            return 5

    if mode != "--sync":
        print(f"Unknown mode: {mode}", file=sys.stderr)
        return 64

    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["ready_for_write"]:
        print("CUTOVER BLOCKED: kill switch / write flag / Google user identity / pins not ready.", file=sys.stderr)
        return 3

    try:
        _, _, execute_sync = _planner_api()
        services = _build_user_services()
        outcome = execute_sync(services, cfg.backup_folder_id)
        print(json.dumps(outcome, ensure_ascii=False, indent=2, default=str))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "FAILED", "error": repr(exc)}, ensure_ascii=False), file=sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
