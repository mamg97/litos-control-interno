from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

from feed import payload_hash

DATA_URL_RE = re.compile(r'const DATA_FEED_URL = "([^"]+)";')
NETWORK_BLOCK_RE = re.compile(
    r"function feedConfigured\(\) \{.*?\n\}\n\nfunction switchView\(view\) \{",
    re.DOTALL,
)
MOBILE_STYLESHEET = '<link rel="stylesheet" href="./dist/mobile.css" />'

RUNTIME_BLOCK = r'''function feedConfigured() {
  return Boolean(STATIC_DATA_FEED_URL);
}

function applyPublicPayload(payload) {
  if (!payload || !Array.isArray(payload.records)) throw new Error("Respuesta no válida");
  state.rows = mapPublicRows(payload.records);
  state.expenses = mapPublicExpenses(payload.expenses);
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
    for file_name in ("index.html", "privacy.html"):
        shutil.copy2(file_name, output / file_name)
    shutil.copytree("dist", output / "dist")
    if Path("oauth").exists():
        shutil.copytree("oauth", output / "oauth")


def patch_mobile_styles(index_path: Path) -> None:
    source = index_path.read_text(encoding="utf-8")
    if MOBILE_STYLESHEET in source:
        return
    if "</head>" not in source:
        raise RuntimeError("Could not find </head> while adding mobile stylesheet")
    source = source.replace("</head>", f"    {MOBILE_STYLESHEET}\n  </head>", 1)
    index_path.write_text(source, encoding="utf-8")


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
    marker = "// M7 Pages artifact: static feed only; no Apps Script runtime dependency.\n"
    app_path.write_text(marker + source, encoding="utf-8")


def build_pages(output: Path, feed_file: Path) -> dict:
    if not feed_file.is_file():
        raise RuntimeError(f"Feed file does not exist: {feed_file}")
    payload = json.loads(feed_file.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise RuntimeError("Generated feed is invalid")
    if not isinstance(payload.get("expenses"), list):
        raise RuntimeError("Generated expenses payload is invalid")

    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    copy_public_source(output)
    patch_mobile_styles(output / "index.html")
    patch_runtime(output / "dist" / "app.js")
    data_dir = output / "data"
    data_dir.mkdir(parents=True)
    shutil.copy2(feed_file, data_dir / "feed.json")
    (output / ".nojekyll").write_text("", encoding="utf-8")

    return {
        "mode": "M7_PAGES_ARTIFACT_BUILD",
        "phase": "M7",
        "records": len(payload["records"]),
        "expenses": len(payload["expenses"]),
        "payload_hash": payload_hash(payload),
        "static_feed_path": "data/feed.json",
        "mobile_stylesheet": "dist/mobile.css",
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
