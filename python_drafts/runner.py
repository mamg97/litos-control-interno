from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone

from .runtime import runtime_contract

EXPECTED_CERTIFIED_RUNTIME_SHA = "5fd37023b10b61a1b26bc8573bf809c26bfce4001e98e8673d1de7328d8c0088"
EXPECTED_SPREADSHEET_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q"
EXPECTED_DRAFT_ROOT_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class CutoverConfig:
    kill_switch: bool
    write_enabled: bool
    spreadsheet_id: str
    draft_root_folder_id: str
    google_service_account_json_present: bool

    @classmethod
    def from_env(cls) -> "CutoverConfig":
        return cls(
            kill_switch=_truthy(os.getenv("LITOS_KILL_SWITCH", "true")),
            write_enabled=_truthy(os.getenv("LITOS_WRITE_ENABLED", "false")),
            spreadsheet_id=os.getenv("LITOS_SPREADSHEET_ID", EXPECTED_SPREADSHEET_ID),
            draft_root_folder_id=os.getenv("LITOS_DRAFT_ROOT_FOLDER_ID", EXPECTED_DRAFT_ROOT_FOLDER_ID),
            google_service_account_json_present=bool(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()),
        )


def preflight(cfg: CutoverConfig) -> dict:
    contract = runtime_contract()
    checks = {
        "certified_runtime_sha_pinned": contract.get("certified_source_sha256") == EXPECTED_CERTIFIED_RUNTIME_SHA,
        "spreadsheet_id_pinned": cfg.spreadsheet_id == EXPECTED_SPREADSHEET_ID,
        "draft_root_id_pinned": cfg.draft_root_folder_id == EXPECTED_DRAFT_ROOT_FOLDER_ID,
        "kill_switch_present": isinstance(cfg.kill_switch, bool),
        "write_guard_consistent": not (cfg.kill_switch and cfg.write_enabled),
        "server_google_identity_present": cfg.google_service_account_json_present,
    }
    ready_for_write = all(checks.values()) and (not cfg.kill_switch) and cfg.write_enabled
    return {
        "phase": "PYTHON_DRAFT_CUTOVER_EXECUTOR",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "contract": contract,
        "config": {
            "kill_switch": cfg.kill_switch,
            "write_enabled": cfg.write_enabled,
            "spreadsheet_id": cfg.spreadsheet_id,
            "draft_root_folder_id": cfg.draft_root_folder_id,
            "google_service_account_json_present": cfg.google_service_account_json_present,
        },
        "checks": checks,
        "ready_for_write": ready_for_write,
    }


def main() -> int:
    cfg = CutoverConfig.from_env()
    result = preflight(cfg)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    mode = (sys.argv[1] if len(sys.argv) > 1 else "--preflight").strip()
    if mode == "--preflight":
        # A disabled deployment is healthy even before server credentials are installed.
        return 0 if result["checks"]["certified_runtime_sha_pinned"] else 2

    if mode != "--sync":
        print(f"Unknown mode: {mode}", file=sys.stderr)
        return 64

    # Fail closed: production sync may only start once all cutover guards are green.
    if not result["ready_for_write"]:
        print("CUTOVER BLOCKED: kill switch / write flag / Google server identity not ready.", file=sys.stderr)
        return 3

    # Intentionally blocked until the exact certified M2B11 runtime blob is committed and
    # its end-to-end write/rollback executor is reviewed in this branch.
    print("CUTOVER BLOCKED: operational sync implementation not armed yet.", file=sys.stderr)
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
