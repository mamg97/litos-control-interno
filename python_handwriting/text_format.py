"""Fail-safe normalization of multiline handwriting transcription text."""


def normalize_inscription_linebreaks(value: object) -> str:
    """Decode literal JSON-style newline separators, preserving inscription text.

    Gemini can return backslash-n characters inside a JSON string instead of
    actual line breaks. Only decode when the text contains no real line breaks;
    leave mixed/ambiguous input untouched for manual review.
    """
    text = str("" if value is None else value).strip()
    if "\n" in text or "\r" in text:
        return text
    return text.replace(r"\r\n", "\n").replace(r"\n", "\n")
