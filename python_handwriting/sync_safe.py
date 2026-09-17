from __future__ import annotations

import argparse
import json
import re

import sync as base


def _sanitize_error(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").replace("\r", " ")
    # Avoid leaking common credential-like query/header material if an SDK ever
    # includes it in an exception. Keep only a short technical diagnostic.
    text = re.sub(r"(?i)(key|api[_-]?key|token|authorization)=?[^\s,&]+", r"\1=[REDACTED]", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:800]


def _gemini_read_json_schema(file_bytes: bytes, mime: str) -> tuple[dict, dict]:
    """Use the SDK JSON-Schema field rather than the OpenAPI-style field.

    The LITOS schema intentionally uses nullable JSON Schema types such as
    ["number", "null"]. `response_json_schema` accepts that representation
    without the Pydantic/OpenAPI coercion that caused the first cutover canary's
    pre-request ValidationError.
    """
    client = base.genai.Client()
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
    except Exception as exc:
        print("HANDWRITING_GEMINI_CALL_FAILED")
        print(json.dumps({"exception_type": type(exc).__name__, "message": _sanitize_error(exc)}, ensure_ascii=False, sort_keys=True))
        raise

    print("HANDWRITING_GEMINI_CALL_RETURNED")
    proposal = json.loads(response.text or "{}")
    technical = {"model": getattr(response, "model_version", None) or base.MODEL}
    return proposal, technical


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
