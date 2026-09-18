from __future__ import annotations

# Live human-facing header contract in the private `Catálogo operativo` sheet.
# Keep these labels stable during M8 cutover; column semantics remain A:M.
LIVE_HEADERS = [
    "Ítem canónico",
    "Variante / detalle",
    "Categoría",
    "Unidad",
    "Material / condición",
    "Precio actual PROVISIONAL (€) · REVISAR",
    "Validado por padre",
    "Nº apariciones",
    "Precio histórico reciente",
    "Rango histórico depurado",
    "Pedidos ejemplo",
    "Regla de generación",
    "Observaciones",
]


def apply_live_header_contract():
    import parity

    parity.HEADERS = list(LIVE_HEADERS)

    # sync.py imports HEADERS by value, so override its module binding too.
    try:
        import sync
    except ImportError:
        sync = None
    if sync is not None:
        sync.HEADERS = list(LIVE_HEADERS)

    return parity, sync
