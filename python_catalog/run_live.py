from __future__ import annotations

import sys

from live_contract import apply_live_header_contract


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in {"parity", "sync"}:
        raise SystemExit("Usage: run_live.py parity|sync [arguments...]")

    mode = sys.argv[1]
    forwarded = [sys.argv[0], *sys.argv[2:]]
    parity, sync = apply_live_header_contract()
    sys.argv = forwarded

    if mode == "parity":
        return parity.main()
    if sync is None:
        raise RuntimeError("sync module is unavailable")
    return sync.main()


if __name__ == "__main__":
    raise SystemExit(main())
