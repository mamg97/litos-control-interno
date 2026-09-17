from __future__ import annotations

import argparse
import json
import re
import time

import sync as base


TRANSIENT_CODES = {429, 500, 502, 503, 504}
RETRY_DELAYS_SECONDS = (2, 5, 10)


def _sanitize_error(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").replace("\r", " ")
    # Avoid leaking common credential-like query/header material if an SDK ever
    # includes it in an exception. Keep only a short technical diagnostic.
    text = re.sub(r"(?i)(key|api[_-]?key|token|authorization)=?[^\s,&]+", r"\1=[REDACTED]", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:800]


def _status_code(exc: Exception) -> int | None:
    for attr in ("code", "status_code"):
        value = getattr(exc, attr, None)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass
    match = re.search(r"\b(429|500|502|503|504)\b", str(exc))
    return int(match.group(1)) if match else None


def _gemini_read_json_schema(file_bytes: bytes, mime: str) -> tuple[dict, dict]:
    """Read one handwriting file with bounded retry for transient API failures.

    Uses the SDK JSON-Schema field because the LITOS schema contains nullable
    JSON Schema types. Only rate-limit/server failures are retried; validation,
    authentication and other permanent errors fail immediately.
    """
    client = base.genai.Client()
    max_attempts = 1 + len(RETRY_DELAYS_SECONDS)

    for attempt in range(1, max_attempts + 1):
        try:
            response = client.models.generate_content(
                model=base.MODEL,
                contents=[base.types.Part.from_bytes(data=file_bytes, mime_type=mime), base.prompt()],
                config=base.types.GenerateContentConfig(
                    temperature=0,
                    response_mime_type="application/json",
                    response_json_schema=base.response_schema(),
                ),
            )
            print("HANDWRITING_GEMINI_CALL_RETURNED")
            print(json.dumps({"attempt": attempt}, sort_keys=True))
            proposal = json.loads(response.text or "{}")
            technical = {
                "model": getattr(response, "model_version", None) or base.MODEL,
                "attempts": attempt,
            }
            return proposal, technical
        except Exception as exc:
            code = _status_code(exc)
            diagnostic = {
                "attempt": attempt,
                "exception_type": type(exc).__name__,
                "status_code": code,
                "message": _sanitize_error(exc),
            }
            if code in TRANSIENT_CODES and attempt < max_attempts:
                delay = RETRY_DELAYS_SECONDS[attempt - 1]
                diagnostic["retry_in_seconds"] = delay
                print("HANDWRITING_GEMINI_TRANSIENT_RETRY")
                print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
                time.sleep(delay)
                continue

            print("HANDWRITING_GEMINI_CALL_FAILED")
            print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
            raise

    raise RuntimeError("Unreachable Gemini retry state")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-items", type=int, default=4)
    args = parser.parse_args()
    if args.max_items < 1 or args.max_items > 4:
        raise RuntimeError("max-items must be between 1 and 4")

    base.gemini_read = _gemini_read_json_schema
    result = base.process(max_items=args.max_items)
    print("HANDWRITING_SAFE_SYNC_RESULT")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))

    # A production run that merely catches a Gemini error is not considered a
    # successful canary/cutover. Fail the Action so automation cannot advance.
    if int(result.get("temporary_error", 0)):
        raise RuntimeError("Handwriting sync ended with temporary errors")
    if int(result.get("candidates", 0)) and int(result.get("gemini_calls", 0)) < 1:
        raise RuntimeError("Handwriting candidate was not actually returned by Gemini")

    print("HANDWRITING_SAFE_SYNC_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
