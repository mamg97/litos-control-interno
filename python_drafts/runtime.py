from __future__ import annotations

import base64
import gzip
import hashlib
from pathlib import Path

CERTIFIED_SOURCE_SHA256 = "5fd37023b10b61a1b26bc8573bf809c26bfce4001e98e8673d1de7328d8c0088"
_BLOB = Path(__file__).with_name("runtime_certified.py.gz.b64")

_encoded = _BLOB.read_text(encoding="utf-8").strip()
_source_bytes = gzip.decompress(base64.b64decode(_encoded))
_actual_sha = hashlib.sha256(_source_bytes).hexdigest()
if _actual_sha != CERTIFIED_SOURCE_SHA256:
    raise RuntimeError(
        f"Certified runtime SHA mismatch: expected {CERTIFIED_SOURCE_SHA256}, got {_actual_sha}"
    )

# Execute the exact source validated by M2B10/M2B11 into this module namespace.
exec(compile(_source_bytes.decode("utf-8"), str(_BLOB), "exec"), globals(), globals())

# Preserve an explicit immutable attestation for the server-side preflight.
_certified_contract = runtime_contract

def runtime_contract():
    out = dict(_certified_contract())
    out["certified_source_sha256"] = CERTIFIED_SOURCE_SHA256
    out["certified_source_verified"] = True
    return out
