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

EXPECTED_CERTIFIED_RUNTIME_SHA = "a9ef70f01bfa66a64656510e883b5311202d595f5ab26431957fc7fb36aa4709"
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
    ready_for_write = all(checks.values()) and cfg.free_only and (not cfg.kill_switch) and cfg.write_enabled
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
            "corporate_style_enabled": _truthy(os.getenv("LITOS_DRAFT_CORPORATE_STYLE", "false")),
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
        from . import executor as executor_module
    except ImportError:
        import executor as executor_module

    if _truthy(os.getenv("LITOS_DRAFT_CORPORATE_STYLE", "false")):
        try:
            from .corporate_style import LOGO_SHA256, STYLE_VERSION, apply_corporate_a4
            from .client_header import CUSTOMER_PROFILE_VERSION, apply_client_header, load_private_header_profile
        except ImportError:
            from corporate_style import LOGO_SHA256, STYLE_VERSION, apply_corporate_a4
            from client_header import CUSTOMER_PROFILE_VERSION, apply_client_header, load_private_header_profile

        original_build_plan = executor_module.build_plan

        def corporate_build_plan(services):
            private_profile = load_private_header_profile(services.sheets, executor_module.SPREADSHEET_ID)

            def _styled_target(target: dict) -> dict:
                raw_bytes = target.get("xlsx_bytes")
                if not isinstance(raw_bytes, (bytes, bytearray)) or not raw_bytes:
                    raise RuntimeError("Corporate production style: semantic builder returned no XLSX bytes")
                styled = apply_corporate_a4(bytes(raw_bytes))
                styled = apply_client_header(
                    styled,
                    customer=private_profile["customer"],
                    issuer=private_profile["issuer"],
                )
                out = dict(target)
                out["xlsx_bytes"] = styled
                out["style_version"] = STYLE_VERSION
                out["logo_sha256"] = LOGO_SHA256
                out["customer_profile_version"] = CUSTOMER_PROFILE_VERSION
                return out

            plan = original_build_plan(services)
            for item in plan:
                semantic_action = item.get("action")
                target = item.get("target")
                if semantic_action not in {"created", "updated", "unchanged"} or not target:
                    continue

                styled_target = _styled_target(target)

                if semantic_action == "created":
                    item["target"] = styled_target
                    item["corporate_style_applied"] = True
                    continue

                draft = item.get("draft")
                if not draft:
                    continue

                actual = executor_module._download(services.drive, draft["id"])
                styled_cmp = executor_module.compare_target_actual(
                    styled_target["xlsx_bytes"], actual, item["pedido"]
                )

                if styled_cmp.get("match"):
                    item["target"] = styled_target
                    item["comparison"] = styled_cmp
                    item["action"] = "unchanged"
                    item["corporate_style_applied"] = True
                elif semantic_action == "updated":
                    # When business data really changed, write the new content using
                    # the approved corporate A4/customer presentation at the same time.
                    item["target"] = styled_target
                    item["comparison"] = styled_cmp
                    item["corporate_style_applied"] = True
                else:
                    # Do not turn a semantically unchanged historical draft into a
                    # production mutation merely to restyle it. Existing backlog is
                    # migrated separately in guarded batches.
                    item["corporate_style_deferred"] = True

            return plan

        executor_module.build_plan = corporate_build_plan

    return executor_module.build_plan, executor_module.summarize_plan, executor_module.execute_sync


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
                "corporate_style_enabled": _truthy(os.getenv("LITOS_DRAFT_CORPORATE_STYLE", "false")),
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
