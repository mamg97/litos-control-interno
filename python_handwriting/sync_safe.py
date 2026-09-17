from __future__ import annotations

import argparse
import json
import re
import time

import sync as base


TRANSIENT_CODES = {429, 500, 502, 503, 504}
PER_MODEL_ATTEMPTS = 2
FALLBACK_MODELS = ("gemini-3.7-flash", "gemini-3.6-flash")


def _sanitize_error(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").replace("\r", " ")
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


def _model_chain() -> list[str]:
    chain: list[str] = []
    for model in (base.MODEL, *FALLBACK_MODELS):
        if model and model not in chain:
            chain.append(model)
    return chain


def _gemini_read_json_schema(file_bytes: bytes, mime: str) -> tuple[dict, dict]:
    """Read one handwriting file with bounded transient retry and free fallbacks.

    The primary model is followed by stable Flash fallbacks that support the
    same multimodal/structured-output contract. Permanent failures stop
    immediately; only 429/5xx failures trigger retry/fallback.
    """
    client = base.genai.Client()
    total_attempt = 0
    last_exc: Exception | None = None

    for model_index, model in enumerate(_model_chain()):
        for model_attempt in range(1, PER_MODEL_ATTEMPTS + 1):
            total_attempt += 1
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=[base.types.Part.from_bytes(data=file_bytes, mime_type=mime), base.prompt()],
                    config=base.types.GenerateContentConfig(
                        temperature=0,
                        response_mime_type="application/json",
                        response_json_schema=base.response_schema(),
                    ),
                )
                # Keep downstream provenance accurate when a fallback succeeded.
                base.MODEL = model
                print("HANDWRITING_GEMINI_CALL_RETURNED")
                print(json.dumps({
                    "model": model,
                    "model_attempt": model_attempt,
                    "total_attempt": total_attempt,
                }, sort_keys=True))
                proposal = json.loads(response.text or "{}")
                technical = {
                    "model": getattr(response, "model_version", None) or model,
                    "model_requested": model,
                    "model_attempt": model_attempt,
                    "total_attempt": total_attempt,
                }
                return proposal, technical
            except Exception as exc:
                last_exc = exc
                code = _status_code(exc)
                diagnostic = {
                    "model": model,
                    "model_attempt": model_attempt,
                    "total_attempt": total_attempt,
                    "exception_type": type(exc).__name__,
                    "status_code": code,
                    "message": _sanitize_error(exc),
                }
                if code not in TRANSIENT_CODES:
                    print("HANDWRITING_GEMINI_CALL_FAILED")
                    print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
                    raise

                if model_attempt < PER_MODEL_ATTEMPTS:
                    diagnostic["retry_in_seconds"] = 2
                    print("HANDWRITING_GEMINI_TRANSIENT_RETRY")
                    print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
                    time.sleep(2)
                    continue

                if model_index < len(_model_chain()) - 1:
                    diagnostic["next_model"] = _model_chain()[model_index + 1]
                    print("HANDWRITING_GEMINI_MODEL_FALLBACK")
                    print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
                    time.sleep(1)
                    break

                print("HANDWRITING_GEMINI_CALL_FAILED")
                print(json.dumps(diagnostic, ensure_ascii=False, sort_keys=True))
                raise

    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Unreachable Gemini fallback state")


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

    if int(result.get("temporary_error", 0)):
        raise RuntimeError("Handwriting sync ended with temporary errors")
    if int(result.get("candidates", 0)) and int(result.get("gemini_calls", 0)) < 1:
        raise RuntimeError("Handwriting candidate was not actually returned by Gemini")

    print("HANDWRITING_SAFE_SYNC_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
