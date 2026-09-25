from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

from feed import payload_hash

DATA_URL_RE = re.compile(r'const DATA_FEED_URL = "([^"]+)";')
APP_SCRIPT_RE = re.compile(r'(src="\./dist/app\.js)(?:\?v=[^"]*)?("\s*></script>)')
NETWORK_BLOCK_RE = re.compile(
    r"function feedConfigured\(\) \{.*?\n\}\n\nfunction switchView\(view\) \{",
    re.DOTALL,
)
MOBILE_STYLESHEET_NAMES = (
    "mobile.css",
    "mobile-chart.css",
    "mobile-links.css",
)

RUNTIME_BLOCK = r'''function feedConfigured() {
  return Boolean(STATIC_DATA_FEED_URL);
}

function applyPublicPayload(payload) {
  if (!payload || !Array.isArray(payload.records)) throw new Error("Respuesta no válida");
  state.rows = mapPublicRows(payload.records);
  state.expenses = mapPublicExpenses(payload.expenses);
  state.movements = mapPublicMovements(payload.movements);
  state.summary = makeSummary(state.rows);
  state.generatedAt = text(payload.generatedAt) || new Date().toISOString();
  state.connected = true;
  setupFilters();
  renderSummary();
  renderProduction();
  renderRecentOrders();
  renderFinance();
  if (state.activeView === "strategy") renderRevenueForecast();
  updateConnectionUI();
}

async function fetchStaticPublicFeed() {
  const separator = STATIC_DATA_FEED_URL.includes("?") ? "&" : "?";
  const response = await fetch(`${STATIC_DATA_FEED_URL}${separator}v=${Date.now()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.records)) throw new Error("Respuesta estática no válida");
  return payload;
}

async function refreshPublicFeed() {
  if (state.loading) return;
  if (!feedConfigured()) {
    state.connected = false;
    updateConnectionUI();
    renderSummary();
    renderProduction();
    renderRecentOrders();
    renderFinance();
    if (state.activeView === "strategy") renderRevenueForecast();
    showToast("El servicio de consulta todavía se está activando.");
    return;
  }

  state.loading = true;
  $("#refreshData").textContent = "Actualizando…";
  try {
    const payload = await fetchStaticPublicFeed();
    applyPublicPayload(payload);
    showToast(`${formatInt.format(state.rows.length)} trabajos actualizados.`);
  } catch {
    const hasPreviousData = state.rows.length > 0;
    state.connected = hasPreviousData;
    updateConnectionUI();
    if (!hasPreviousData) {
      renderSummary();
      renderProduction();
      renderRecentOrders();
      renderFinance();
      if (state.activeView === "strategy") renderRevenueForecast();
    }
    showToast(hasPreviousData
      ? "No se pudo consultar la actualización; se muestran los últimos datos cargados."
      : "No se pudieron cargar los datos. Vuelve a intentarlo en unos segundos.");
  } finally {
    state.loading = false;
    $("#refreshData").textContent = "Actualizar datos";
  }
}

function switchView(view) {'''


def copy_public_source(output: Path) -> None:
    for file_name in ("index.html", "privacy.html", "favicon.png"):
        source = Path(file_name)
        if not source.is_file():
            raise RuntimeError(f"Required public asset missing: {file_name}")
        shutil.copy2(source, output / file_name)
    shutil.copytree("dist", output / "dist")
    if Path("oauth").exists():
        shutil.copytree("oauth", output / "oauth")


def patch_mobile_styles(index_path: Path, dist_dir: Path) -> dict[str, str]:
    source = index_path.read_text(encoding="utf-8")
    if "</head>" not in source:
        raise RuntimeError("Could not find </head> while adding mobile stylesheets")

    versions: dict[str, str] = {}
    for file_name in MOBILE_STYLESHEET_NAMES:
        stylesheet_path = dist_dir / file_name
        if not stylesheet_path.is_file():
            raise RuntimeError(f"Required mobile stylesheet missing: {file_name}")
        version = hashlib.sha256(stylesheet_path.read_bytes()).hexdigest()[:12]
        versions[file_name] = version
        stylesheet = f'<link rel="stylesheet" href="./dist/{file_name}?v={version}" />'
        source = source.replace(
            f'<link rel="stylesheet" href="./dist/{file_name}" />',
            stylesheet,
        )
        source = re.sub(
            rf'<link rel="stylesheet" href="\.\/dist\/{re.escape(file_name)}\?v=[^"]+"\s*\/?>',
            stylesheet,
            source,
        )
        if stylesheet not in source:
            source = source.replace("</head>", f"    {stylesheet}\n  </head>", 1)

    index_path.write_text(source, encoding="utf-8")
    return versions


def patch_mobile_chart_runtime(source: str) -> str:
    replacements = (
        (
            '  const { ctx, width, height } = setupCanvas(canvas);\n'
            '  if (width < 2 || height < 2) return;\n'
            '  const left = 56, right = 12, top = 28, bottom = 33;',
            '  const { ctx, width, height } = setupCanvas(canvas);\n'
            '  if (width < 2 || height < 2) return;\n'
            '  const compact = width < 520;\n'
            '  const left = 56, right = 12, top = 28, bottom = 33;',
        ),
        (
            '  const left = metric === "orders" ? 38 : 58, right = 12, top = 28, bottom = 33;',
            '  const compact = width < 520;\n'
            '  const left = metric === "orders" ? (compact ? 24 : 38) : (compact ? 42 : 58), '
            'right = compact ? 6 : 12, top = compact ? 22 : 28, bottom = compact ? 28 : 33;',
        ),
        (
            '  const barWidth = Math.max(5, Math.min(42, slot * .58));',
            '  const barWidth = Math.max(compact ? 3 : 5, Math.min(compact ? 18 : 42, slot * (compact ? .66 : .58)));',
        ),
        (
            '    ctx.fillStyle = "#0e3137"; ctx.font = "600 10px DM Mono"; ctx.textAlign = "center";',
            '    ctx.fillStyle = "#0e3137"; ctx.font = compact ? "600 8px DM Mono" : "600 10px DM Mono"; ctx.textAlign = "center";',
        ),
        (
            '    if (index % 2 === 0 || data.length < 9 || width >= 940) { ctx.fillStyle = "#799194"; ctx.font = "11px Manrope"; ctx.fillText(label, x, height - 12); }',
            '    ctx.fillStyle = "#799194";\n'
            '    ctx.font = compact ? "9px Manrope" : "11px Manrope";\n'
            '    const periodLabel = compact ? String(label).slice(0, 3) : label;\n'
            '    if (compact || index % 2 === 0 || data.length < 9 || width >= 940) {\n'
            '      ctx.fillText(periodLabel, x, height - (compact ? 8 : 12));\n'
            '    }',
        ),
    )
    for old, new in replacements:
        count = source.count(old)
        if count < 1:
            raise RuntimeError(f"Mobile chart patch target missing: {old[:72]}")
        source = source.replace(old, new, 1)
    if source.count("const compact = width < 520;") != 2:
        raise RuntimeError("Expected compact chart mode in orders and financial charts")
    return source


def patch_runtime(app_path: Path) -> None:
    source = app_path.read_text(encoding="utf-8")
    source, url_count = DATA_URL_RE.subn(
        'const STATIC_DATA_FEED_URL = "./data/feed.json";',
        source,
        count=1,
    )
    if url_count != 1:
        raise RuntimeError(f"Expected one DATA_FEED_URL replacement, got {url_count}")
    source, block_count = NETWORK_BLOCK_RE.subn(RUNTIME_BLOCK, source, count=1)
    if block_count != 1:
        raise RuntimeError(f"Expected one public-feed runtime replacement, got {block_count}")
    source = patch_mobile_chart_runtime(source)
    marker = "// M7 Pages artifact: static feed only; no Apps Script runtime dependency.\n"
    app_path.write_text(marker + source, encoding="utf-8")


def version_app_script(index_path: Path, app_path: Path) -> str:
    version = hashlib.sha256(app_path.read_bytes()).hexdigest()[:12]
    source = index_path.read_text(encoding="utf-8")
    source, count = APP_SCRIPT_RE.subn(rf'\1?v={version}\2', source, count=1)
    if count != 1:
        raise RuntimeError(f"Expected one app.js script tag, got {count}")
    index_path.write_text(source, encoding="utf-8")
    return version


def build_pages(output: Path, feed_file: Path) -> dict:
    if not feed_file.is_file():
        raise RuntimeError(f"Feed file does not exist: {feed_file}")
    payload = json.loads(feed_file.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise RuntimeError("Generated feed is invalid")
    if not isinstance(payload.get("expenses"), list):
        raise RuntimeError("Generated expenses payload is invalid")
    if not isinstance(payload.get("movements"), list):
        raise RuntimeError("Generated movements payload is invalid")

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    copy_public_source(output)
    mobile_style_versions = patch_mobile_styles(output / "index.html", output / "dist")
    patch_runtime(output / "dist" / "app.js")
    app_version = version_app_script(output / "index.html", output / "dist" / "app.js")
    data_dir = output / "data"
    data_dir.mkdir(parents=True)
    shutil.copy2(feed_file, data_dir / "feed.json")
    (output / ".nojekyll").write_text("", encoding="utf-8")

    return {
        "mode": "M7_PAGES_ARTIFACT_BUILD",
        "phase": "M7",
        "records": len(payload["records"]),
        "expenses": len(payload["expenses"]),
        "movements": len(payload["movements"]),
        "payload_hash": payload_hash(payload),
        "app_version": app_version,
        "static_feed_path": "data/feed.json",
        "mobile_stylesheets": [
            f"dist/{file_name}?v={mobile_style_versions[file_name]}"
            for file_name in MOBILE_STYLESHEET_NAMES
        ],
        "legacy_rollback_configured": False,
        "source_git_data_snapshot_created": False,
        "external_write_operations": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the LITOS GitHub Pages artifact for M7")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--feed", required=True, type=Path)
    args = parser.parse_args()
    result = build_pages(args.output, args.feed)
    print("M7_PAGES_BUILD_OK")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
