from __future__ import annotations

import json

import parity as p
from total_parser import read_total_from_bytes


def _read_total_formula_aware(drive, file: p.DriveFile) -> float | None:
    content = p._download_file(drive, file.file_id, file.mime_type)
    return read_total_from_bytes(file.name, content)


def main() -> int:
    p.read_total = _read_total_formula_aware
    result = p.dry_run(max_total_reads=0)
    print("ALBARANES_PARITY_V2_OK")
    print(json.dumps(result, sort_keys=True))
    if (
        result["invoice_link_mismatches"]
        or result["draft_link_mismatches"]
        or result["total_mismatches"]
        or result["parser_unavailable_with_sheet_total"]
        or result["parse_errors"]
    ):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
