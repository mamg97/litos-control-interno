from __future__ import annotations

import json

from intake_sync import sync_intake


def main() -> int:
    result = sync_intake(delivery_batches_only=True)
    print("LITOS_2026_SENT_RECOVERY_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
