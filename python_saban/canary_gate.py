from __future__ import annotations

import json
import os

from auth import build_saban_services
from intake_readonly import build_read_only_plan, public_summary


def main() -> int:
    services = build_saban_services()
    sender = os.environ.get("SABAN_ALLOWED_SENDER", "")
    plan = build_read_only_plan(services, sender)
    summary = public_summary(plan)
    if int(summary.get("mutable") or 0) > 1:
        raise RuntimeError(f"Cutover canary blocked: M3 mutable={summary['mutable']}")
    print("SABAN_CANARY_GATE_OK")
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
