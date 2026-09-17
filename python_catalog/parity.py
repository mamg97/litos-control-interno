from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import unicodedata
from collections import Counter
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]

MASTER_ID = os.environ.get(
    "LITOS_SPREADSHEET_ID",
    "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q",
)
RAW_SHEET = "Catálogo albaranes 2023-2026 · bruto"
OPERATIONAL_SHEET = "Catálogo operativo"
PEDIDOS_SHEET = "Pedidos"

HEADERS = [
    "Ítem canónico",
    "Variante / detalle",
    "Categoría",
    "Unidad",
    "Material / condición",
    "Precio actual (€)",
    "Validado por padre",
    "Nº apariciones",
    "Precio hist. reciente",
    "Rango histórico",
    "Pedidos ejemplo",
    "Regla de generación",
    "Observaciones",
]

DEFAULT_NOTE = "Precio histórico como referencia; confirmar el precio actual antes de automatizar."


def clean(value: Any) -> str:
    return str("" if value is None else value).strip()


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFD", clean(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower().replace("º", "").replace("°", "")
    return re.sub(r"\s+", " ", text).strip()


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    raw = re.sub(r"[^0-9,.-]", "", clean(value))
    if not raw:
        return None
    comma = raw.rfind(",")
    dot = raw.rfind(".")
    if comma != -1 and dot != -1:
        decimal = "," if comma > dot else "."
        thousands = "." if decimal == "," else ","
        raw = raw.replace(thousands, "").replace(decimal, ".")
    elif comma != -1:
        raw = raw.replace(",", ".")
    try:
        parsed = float(raw)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def median(values: list[float]) -> float | str:
    if not values:
        return ""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def money(value: float) -> str:
    # All catalog rates are positive. This reproduces Math.round(x * 100) / 100.
    rounded = math.floor(float(value) * 100 + 0.5) / 100
    rendered = f"{rounded:.2f}".rstrip("0").rstrip(".")
    return f"{rendered} €"


def padded(row: list[Any], index: int) -> Any:
    return row[index] if index < len(row) else ""


def build_sheets_service():
    raw = os.environ.get("GOOGLE_OAUTH_SABAN_JSON", "").strip()
    if not raw:
        raise RuntimeError("GOOGLE_OAUTH_SABAN_JSON is missing")
    info = json.loads(raw)
    required = {"client_id", "client_secret", "refresh_token"}
    missing = sorted(key for key in required if not clean(info.get(key)))
    if missing:
        raise RuntimeError("GOOGLE_OAUTH_SABAN_JSON missing fields: " + ", ".join(missing))
    credentials = Credentials.from_authorized_user_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=credentials, cache_discovery=False)


def read_values(sheets, sheet_name: str, formatted: bool = False) -> list[list[Any]]:
    response = (
        sheets.spreadsheets()
        .values()
        .get(
            spreadsheetId=MASTER_ID,
            range=f"'{sheet_name}'",
            valueRenderOption="FORMATTED_VALUE" if formatted else "UNFORMATTED_VALUE",
            dateTimeRenderOption="FORMATTED_STRING",
        )
        .execute()
    )
    return response.get("values", []) or []


def parse_year(value: Any) -> int:
    raw = clean(value)
    if not raw:
        return 0
    match = re.match(r"^(\d{4})[-/]", raw)
    if match:
        return int(match.group(1))
    match = re.search(r"\b(20\d{2})\b", raw)
    return int(match.group(1)) if match else 0


def year_by_order(pedidos: list[list[Any]]) -> dict[str, int]:
    header_index = next(
        (
            idx
            for idx, row in enumerate(pedidos)
            if any(clean(cell) == "Pedido" for cell in row)
        ),
        -1,
    )
    if header_index < 0:
        return {}
    headers = [clean(cell) for cell in pedidos[header_index]]
    columns = {header: idx for idx, header in enumerate(headers)}
    date_headers = [
        "Fecha para dashboard",
        "Fecha entrega (estadillo)",
        "Fecha recepción (email)",
        "Fecha ficha",
    ]
    out: dict[str, int] = {}
    for row in pedidos[header_index + 1 :]:
        id_col = columns.get("Pedido")
        if id_col is None:
            break
        order_id = clean(padded(row, id_col))
        if not re.fullmatch(r"\d{4}", order_id):
            continue
        for header in date_headers:
            col = columns.get(header)
            if col is None:
                continue
            year = parse_year(padded(row, col))
            if year:
                out[order_id] = year
                break
    return out


def inscription_variant(text: str) -> str:
    variants = [
        ("REMUS", ["remus"]),
        ("INGLESA", ["inglesa"]),
        ("ALDINE", ["aldine"]),
        ("GÓTICA", ["gotica", "gótica"]),
        ("CATANEO", ["cataneo"]),
        ("REDONDA", ["redonda"]),
        ("RELIEVE", ["relieve"]),
        ("LÁSER", ["laser", "láser"]),
        ("SEGÚN FOTO", ["segun foto", "según foto"]),
        ("SEGÚN SUYA", ["s/suya", "segun suya", "según suya"]),
    ]
    return " + ".join(
        name
        for name, terms in variants
        if any(normalize(term) in text for term in terms)
    )


def decoration_variant(text: str) -> str:
    out: list[str] = []
    if "laser" in text or "láser" in text:
        out.append("LÁSER")
    if "grab" in text:
        out.append("GRABADO")
    if "relieve" in text:
        out.append("RELIEVE")
    if "2 aguas" in text or "dos aguas" in text:
        out.append("2 AGUAS")
    return " + ".join(out)


def acoplar_variant(text: str) -> str:
    if "cruz" in text:
        return "CRUZ"
    if "floreo" in text:
        return "FLOREO"
    if "florero" in text:
        return "FLORERO"
    if "imagen" in text or "foto" in text:
        return "IMAGEN / FOTO"
    return ""


def material_name(value: Any) -> str:
    raw = clean(value)
    text = normalize(raw)
    aliases = [
        ("NEGRO ABSOLUTO", ["negro absoluto", "negro abs"]),
        ("NEGRO SUDÁFRICA", ["sudafrica", "sudáfrica"]),
        ("BLANCO MACAEL", ["blanco macael", "macael"]),
        ("MÁRMOL ITALIANO", ["italiano", "marmol italiano", "mármol italiano"]),
        ("BLANCO CHAMPÁN", ["champagne", "champan", "champán"]),
        ("NEGRO TEZAL", ["tezal"]),
        ("ROSA PORRIÑO", ["rosa porriño", "porriño"]),
        ("ROJO BALMORAL", ["rojo balmoral", "balmoral"]),
        ("LABRADOR", ["labrador"]),
        ("MATERIAL SUYO", ["material suyo", "mat suyo", "suyo"]),
        ("PORCELANA", ["porcelana"]),
        ("COMPAC", ["compac"]),
    ]
    for name, terms in aliases:
        if any(normalize(term) in text for term in terms):
            return name
    return raw.upper() if raw else ""


def canonicalize(
    description: Any,
    detail: Any,
    raw_category: Any,
    raw_unit: Any,
    material_raw: Any,
) -> dict[str, Any] | None:
    desc = normalize(description)
    det = normalize(detail)
    text = re.sub(r"\s+", " ", f"{desc} {det}").strip()
    if not text:
        return None
    noise_terms = [
        "diferencia para ajustar nota",
        "dieferencia para ajustar nota",
        "ajustar nota",
        "suma",
        "total",
        "iva",
        "i.v.a",
    ]
    if any(text == term or term in text for term in noise_terms):
        return {"noise": True}

    def match(terms: list[str]) -> bool:
        return any(term in text for term in terms)

    canonical = ""
    category = clean(raw_category) or "Otros"
    unit = clean(raw_unit) or "revisar"
    variant = ""
    special = False

    if match(["inscripcion", "inscripci", "letras", "texto grabado"]):
        canonical, category, unit = "INSCRIPCIÓN", "Inscripción", "ud"
        variant = inscription_variant(text)
    elif match(["canto pulido", "cantos pulidos", "pulir canto", "pulir cantos"]):
        canonical, category = "CANTO PULIDO", "Acabado"
        unit = "m" if unit == "revisar" else unit
    elif match(["cortar material suyo", "corte material suyo", "cortar mat suyo"]):
        canonical, category = "CORTAR MATERIAL SUYO", "Corte / taller"
    elif match(["corte", "cortar"]):
        canonical, category = "CORTE", "Corte / taller"
    elif match(["solera"]):
        canonical, category = "SOLERA", "Piedra / pieza"
    elif match(["junquillo"]):
        canonical, category = "JUNQUILLO", "Piedra / pieza"
    elif match(["repisa"]):
        canonical, category = "REPISA", "Piedra / pieza"
    elif match(["cornisa"]):
        canonical, category = "CORNISA", "Piedra / pieza"
    elif match(["coronacion", "coronación"]):
        canonical, category = "CORONACIÓN", "Piedra / pieza"
    elif match(["jardinera"]):
        canonical, category, unit = "JARDINERA", "Accesorio", "ud"
    elif match(["florero", "jarron", "jarrón"]):
        canonical, category, unit = "FLORERO", "Accesorio", "ud"
    elif match(["floreo"]):
        canonical, category, unit = "FLOREO", "Accesorio", "ud"
    elif match(["cruz"]):
        canonical, category, unit = "CRUZ", "Ornamento", "ud"
        variant = decoration_variant(text)
    elif match(["imagen", "foto", "fotografia", "fotografía"]):
        canonical, category, unit = "IMAGEN / FOTO", "Ornamento", "ud"
        variant = decoration_variant(text)
    elif match(["columna", "pilastra"]):
        canonical, category = "COLUMNA / PILASTRA", "Piedra / pieza"
    elif match(["abujard"]):
        canonical, category = "ABUJARDADO", "Acabado"
    elif match(["rebaje"]):
        canonical, category = "REBAJE", "Acabado"
    elif match(["canal"]):
        canonical, category = "CANAL", "Acabado"
    elif match(["pulir", "pulido"]):
        canonical, category = "PULIDO", "Acabado"
    elif match(["talla", "tallar"]):
        canonical, category = "TALLA", "Acabado"
    elif match(["acoplar"]):
        canonical, category, unit = "ACOPLAR", "Servicio", "ud"
        variant = acoplar_variant(text)
    elif match(["desmontar", "desmontaje"]):
        canonical, category, unit = "DESMONTAJE", "Servicio", "trabajo"
    elif match(["montar", "montaje", "colocacion", "colocación"]):
        canonical, category, unit = "MONTAJE / COLOCACIÓN", "Servicio", "trabajo"
    elif match(["transporte", "llevar", "porte"]):
        canonical, category, unit = "TRANSPORTE", "Servicio", "trabajo"
    elif match(["limpieza", "limpiar"]):
        canonical, category, unit = "LIMPIEZA", "Servicio", "trabajo"
    elif match(["taladrar", "taladro"]):
        canonical, category = "TALADRADO", "Corte / taller"
    else:
        canonical = clean(description).upper()
        category = clean(raw_category) or "Especial / revisar"
        special = True

    material_relevant = unit == "m²" or category in {
        "Piedra / pieza",
        "Corte / taller",
        "Acabado",
    }
    material = material_name(material_raw) if material_relevant else ""
    return {
        "canonical": canonical,
        "variant": variant,
        "category": category,
        "unit": unit,
        "material": material,
        "special": special,
        "noise": False,
    }


def reliable_rate(rate: float | None, unit: str, description: Any, detail: Any) -> bool:
    if rate is None or rate < 1 or rate > 2000:
        return False
    if normalize(unit) == "revisar":
        return False
    text = f"{normalize(description)} {normalize(detail)}"
    if "ajustar nota" in text:
        return False
    if unit == "m" and rate > 250:
        return False
    if unit == "m²" and rate > 750:
        return False
    if unit == "ud" and rate > 1500:
        return False
    return True


def row_key(row: list[Any]) -> str:
    return "|".join(normalize(padded(row, idx)) for idx in (0, 1, 3, 4))


def manual_values(current_rows: list[list[Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in current_rows:
        if not clean(padded(row, 0)):
            continue
        out[row_key(row)] = {
            "unit": clean(padded(row, 3)),
            "price": padded(row, 5),
            "validated": padded(row, 6) is True,
            "notes": clean(padded(row, 12)),
        }
    return out


def operational_rule(group: dict[str, Any]) -> str:
    parts = [group["canonical"]]
    variants = [value for value in group["variants"] if value]
    if variants:
        parts.append(" / ".join(variants))
    if group["material"]:
        parts.append(group["material"])
    return "Añadir cuando la nota/especificaciones indiquen: " + " · ".join(parts) + "."


def build_row(group: dict[str, Any], manual: dict[str, Any]) -> list[Any]:
    years = sorted((year for year in group["rates_by_year"] if year > 0), reverse=True)
    latest_year = years[0] if years else 0
    latest_rates = sorted(group["rates_by_year"].get(latest_year, [])) if latest_year else []
    recent_median = median(latest_rates)
    all_rates = sorted(group["rates"])
    price_range = (
        f"{money(all_rates[0])} – {money(all_rates[-1])}" if all_rates else ""
    )
    variants = " | ".join(value for value in group["variants"] if value)
    examples = ", ".join(
        sorted(group["orders"], key=lambda value: number(value) or 0, reverse=True)[:8]
    )
    return [
        group["canonical"],
        variants,
        group["category"],
        manual.get("unit") or group["unit"],
        group["material"],
        manual["price"] if "price" in manual else "",
        bool(manual.get("validated", False)),
        len(group["orders"]),
        "" if recent_median == "" else f"{money(float(recent_median))} ({latest_year})",
        price_range,
        examples,
        operational_rule(group),
        manual.get("notes") or DEFAULT_NOTE,
    ]


def generate_rows(
    raw_values: list[list[Any]],
    pedidos_display: list[list[Any]],
    current_body: list[list[Any]],
) -> tuple[list[list[Any]], dict[str, int]]:
    years = year_by_order(pedidos_display)
    previous = manual_values(current_body)
    groups: dict[str, dict[str, Any]] = {}

    for row in raw_values[1:]:
        order = clean(padded(row, 5))
        description = clean(padded(row, 6))
        detail = clean(padded(row, 7))
        raw_category = clean(padded(row, 8))
        raw_unit = clean(padded(row, 9))
        material_raw = clean(padded(row, 13))
        if not description:
            continue
        item = canonicalize(description, detail, raw_category, raw_unit, material_raw)
        if not item or item.get("noise"):
            continue
        key = "|".join(
            normalize(value)
            for value in (
                item["canonical"],
                item["variant"],
                item["unit"],
                item["material"],
            )
        )
        if key not in groups:
            groups[key] = {
                "key": key,
                "canonical": item["canonical"],
                "variants": [],
                "category": item["category"],
                "unit": item["unit"],
                "material": item["material"],
                "orders": set(),
                "rates": [],
                "rates_by_year": {},
                "special": item["special"],
            }
        group = groups[key]
        if item["variant"] and item["variant"] not in group["variants"]:
            group["variants"].append(item["variant"])
        if order:
            group["orders"].add(order)
        rate = number(padded(row, 10))
        year = years.get(order, 0)
        if reliable_rate(rate, item["unit"], description, detail):
            assert rate is not None
            group["rates"].append(rate)
            group["rates_by_year"].setdefault(year, []).append(rate)

    retained = [
        group
        for group in groups.values()
        if not group["special"] or len(group["orders"]) >= 2
    ]
    rows = [build_row(group, previous.get(group["key"], {})) for group in retained]
    stats = {
        "raw_occurrences": max(0, len(raw_values) - 1),
        "operational_items": len(rows),
        "orders_covered": len(
            set().union(*(group["orders"] for group in groups.values())) if groups else set()
        ),
    }
    return rows, stats


def canonical_cell(value: Any) -> Any:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
        return int(parsed) if parsed.is_integer() else round(parsed, 10)
    return clean(value)


def normalize_row(row: list[Any]) -> list[Any]:
    return [canonical_cell(padded(row, idx)) for idx in range(13)]


def parity_report(generated: list[list[Any]], current_body: list[list[Any]], stats: dict[str, int]) -> dict[str, Any]:
    generated_map = {row_key(row): normalize_row(row) for row in generated}
    current_map = {
        row_key(row): normalize_row(row)
        for row in current_body
        if clean(padded(row, 0))
    }

    missing_in_current = sorted(set(generated_map) - set(current_map))
    extra_in_current = sorted(set(current_map) - set(generated_map))
    shared = sorted(set(generated_map) & set(current_map))
    field_counts: Counter[str] = Counter()
    mismatched_rows = 0
    diagnostic_hashes: list[str] = []

    for key in shared:
        expected = generated_map[key]
        actual = current_map[key]
        row_mismatch = False
        for idx, header in enumerate(HEADERS):
            if expected[idx] != actual[idx]:
                field_counts[header] += 1
                row_mismatch = True
        if row_mismatch:
            mismatched_rows += 1
            if len(diagnostic_hashes) < 10:
                diagnostic_hashes.append(hashlib.sha256(key.encode("utf-8")).hexdigest()[:12])

    for key in (missing_in_current + extra_in_current)[: max(0, 10 - len(diagnostic_hashes))]:
        diagnostic_hashes.append(hashlib.sha256(key.encode("utf-8")).hexdigest()[:12])

    parity_ok = not missing_in_current and not extra_in_current and mismatched_rows == 0
    return {
        "mode": "M8_OPERATIONAL_CATALOG_READ_ONLY_PARITY",
        **stats,
        "generated_rows": len(generated_map),
        "current_rows": len(current_map),
        "missing_in_current": len(missing_in_current),
        "extra_in_current": len(extra_in_current),
        "mismatched_rows": mismatched_rows,
        "mismatch_fields": dict(sorted(field_counts.items())),
        "diagnostic_key_hashes": diagnostic_hashes,
        "parity_ok": parity_ok,
        "write_operations": 0,
    }


def run_parity() -> int:
    sheets = build_sheets_service()
    raw_values = read_values(sheets, RAW_SHEET, formatted=False)
    current = read_values(sheets, OPERATIONAL_SHEET, formatted=False)
    pedidos = read_values(sheets, PEDIDOS_SHEET, formatted=True)
    if not raw_values:
        raise RuntimeError("Raw catalog sheet is empty")
    if not current:
        raise RuntimeError("Operational catalog sheet is empty")
    current_headers = [clean(value) for value in current[0][:13]]
    if current_headers != HEADERS:
        raise RuntimeError("Operational catalog header contract changed")

    generated, stats = generate_rows(raw_values, pedidos, current[1:])
    report = parity_report(generated, current[1:], stats)
    print("M8_CATALOG_PARITY_OK" if report["parity_ok"] else "M8_CATALOG_PARITY_MISMATCH")
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["parity_ok"] else 1


def preflight() -> int:
    print("M8_CATALOG_PREFLIGHT_OK")
    print(json.dumps({
        "mode": "read_only",
        "source_sheet": RAW_SHEET,
        "target_sheet": OPERATIONAL_SHEET,
        "write_operations": 0,
    }, ensure_ascii=False, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="LITOS M8 operational catalog read-only parity")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--parity", action="store_true")
    args = parser.parse_args()
    if args.preflight:
        return preflight()
    if args.parity:
        return run_parity()
    parser.error("Choose --preflight or --parity")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
