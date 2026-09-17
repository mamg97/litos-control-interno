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

function fetchLegacyPublicFeed() {
  return new Promise((resolve, reject) => {
    if (!LEGACY_DATA_FEED_URL) {
      reject(new Error("Legacy feed unavailable"));
      return;
    }
    const callbackName = `__litosLegacyFeed${Date.now()}${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    let settled = false;
    let timer;
    const cleanUp = () => {
      window.clearTimeout(timer);
      script.remove();
      delete window[callbackName];
    };
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanUp();
      handler(value);
    };
    window[callbackName] = (payload) => {
      if (!payload || !Array.isArray(payload.records)) {
        finish(reject, new Error("Respuesta legacy no válida"));
        return;
      }
      finish(resolve, payload);
    };
    // ContentService redirects before serving JSONP. As in the legacy client,
    // the timeout is the failure authority because browsers may emit an error
    // during the redirect even when the callback subsequently arrives.
    script.onerror = () => {};
    timer = window.setTimeout(
      () => finish(reject, new Error("Tiempo de espera agotado")),
      FEED_TIMEOUT_MS
    );
    const separator = LEGACY_DATA_FEED_URL.includes("?") ? "&" : "?";
    script.src = `${LEGACY_DATA_FEED_URL}${separator}callback=${encodeURIComponent(callbackName)}&v=${Date.now()}`;
    document.head.append(script);
  });
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
  let usedLegacyFallback = false;
  try {
    let payload;
    try {
      payload = await fetchStaticPublicFeed();
    } catch (staticError) {
      usedLegacyFallback = true;
      console.warn("M7 static feed unavailable; using rollback feed.", staticError);
      payload = await fetchLegacyPublicFeed();
    }
    applyPublicPayload(payload);
    showToast(`${formatInt.format(state.rows.length)} trabajos actualizados${usedLegacyFallback ? " · respaldo" : ""}.`);
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


def patch_runtime(app_path: Path) -> str:
    source = app_path.read_text(encoding="utf-8")
    url_match = DATA_URL_RE.search(source)
    if not url_match:
        raise RuntimeError("M7 build could not locate the legacy DATA_FEED_URL")
    legacy_url = url_match.group(1)
    source, url_count = DATA_URL_RE.subn(
        'const STATIC_DATA_FEED_URL = "./data/feed.json";\n'
        f'const LEGACY_DATA_FEED_URL = "{legacy_url}";',
        source,
        count=1,
    )
    if url_count != 1:
        raise RuntimeError(f"Expected one DATA_FEED_URL replacement, got {url_count}")
    source, block_count = NETWORK_BLOCK_RE.subn(RUNTIME_BLOCK, source, count=1)
    if block_count != 1:
        raise RuntimeError(f"Expected one public-feed runtime replacement, got {block_count}")
    marker = "// M7 Pages artifact: static feed first, Apps Script rollback fallback.\n"
    app_path.write_text(marker + source, encoding="utf-8")
    return legacy_url


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
    legacy_url = patch_runtime(output / "dist" / "app.js")
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
        "legacy_rollback_configured": legacy_url.startswith("https://"),
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
