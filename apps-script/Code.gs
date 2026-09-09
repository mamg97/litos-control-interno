/**
 * LITOS Control Interno — public operational feed
 *
 * Bind this project to the native Google Sheet that is the private master
 * book. Deploy it as a Web App executed as the owner. The page is allowed to
 * consult it anonymously only because publicPayload_ returns this small,
 * explicitly approved operational schema — never the Sheet or its rows.
 */

const CACHE_SECONDS = 55;
const FIELDS = Object.freeze({
  id: "Pedido",
  // The master book deliberately stores the original order date and the
  // delivered-work date separately. The dashboard must group the historical
  // work by the latter, while unfinished email orders keep their fiche date.
  date: "Fecha para dashboard",
  orderDate: "Fecha ficha",
  deliveredDate: "Fecha entrega (estadillo)",
  amount: "Importe trabajo / Debe (€)",
  status: "Estado pedido",
  model: "Modelo",
  material: "Material",
  width: "Ancho total (cm)",
  height: "Alto total (cm)",
  thickness: "Grosor (cm)",
  baseWidth: "Ancho base (cm)",
  baseHeight: "Alto base/croquis (cm)",
  topWidth: "Ancho superior/remate (cm)",
  stepMeasures: "Cotas/escalones (cm)",
  voleo: "Voleo (cm)"
});

function doGet(event) {
  const parameter = (event && event.parameter) || {};
  const payload = parameter.health === "1"
    ? JSON.stringify({ ok: true, version: 1, generatedAt: new Date().toISOString() })
    : cachedPayload_();
  return output_(payload, parameter.callback);
}

function output_(payload, callback) {
  const safeCallback = String(callback || "");
  if (/^[A-Za-z_$][\w$]*$/.test(safeCallback)) {
    return ContentService.createTextOutput(`${safeCallback}(${payload});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function cachedPayload_() {
  const cache = CacheService.getScriptCache();
  const key = "litos-public-operational-feed-v1";
  const cached = cache.get(key);
  if (cached) return cached;

  const payload = JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    records: readOperationalRows_()
  });
  // Apps Script cache entries are limited to roughly 100 KB. A complete
  // reconciled history can legitimately exceed that, so serve it directly
  // rather than failing the public read. Small future payloads stay cached.
  if (payload.length <= 95 * 1024) cache.put(key, payload, CACHE_SECONDS);
  return payload;
}

function readOperationalRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Pedidos");
  if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

  const values = sheet.getDataRange().getDisplayValues();
  const headerIndex = values.findIndex((row) => row.some((cell) => clean_(cell) === FIELDS.id));
  if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

  const headers = values[headerIndex].map(clean_);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const read = (row, field) => {
    const index = columns[field];
    return index === undefined ? "" : clean_(row[index]);
  };

  return values.slice(headerIndex + 1).map((row) => {
    const id = read(row, FIELDS.id);
    if (!id) return null;
    const orderDate = read(row, FIELDS.orderDate);
    const deliveredDate = read(row, FIELDS.deliveredDate);
    const dashboardDate = read(row, FIELDS.date) || deliveredDate || orderDate;
    return {
      id,
      // Only this approved operational subset is public. In particular, the
      // email fiche text, customer names, file paths and source notes never
      // leave the private spreadsheet.
      date: normalizeDate_(dashboardDate),
      orderDate: normalizeDate_(orderDate),
      deliveredDate: normalizeDate_(deliveredDate),
      amount: numberOrNull_(read(row, FIELDS.amount)),
      status: read(row, FIELDS.status),
      model: read(row, FIELDS.model),
      material: read(row, FIELDS.material),
      width: numberOrNull_(read(row, FIELDS.width)),
      height: numberOrNull_(read(row, FIELDS.height)),
      thickness: numberOrNull_(read(row, FIELDS.thickness)),
      baseWidth: numberOrNull_(read(row, FIELDS.baseWidth)),
      baseHeight: numberOrNull_(read(row, FIELDS.baseHeight)),
      topWidth: numberOrNull_(read(row, FIELDS.topWidth)),
      stepMeasures: read(row, FIELDS.stepMeasures),
      voleo: numberOrNull_(read(row, FIELDS.voleo))
    };
  }).filter(Boolean);
}

function clean_(value) {
  return String(value == null ? "" : value).trim();
}

function numberOrNull_(value) {
  const raw = clean_(value);
  if (!raw) return null;
  let normalized = raw.replace(/[^0-9,.-]/g, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(thousands, "").replace(decimal, ".");
  } else if (comma !== -1) {
    normalized = normalized.replace(/,/g, ".");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate_(value) {
  const raw = clean_(value);
  const spanish = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!spanish) return raw;
  const year = spanish[3].length === 2 ? `20${spanish[3]}` : spanish[3];
  return `${year}-${spanish[2].padStart(2, "0")}-${spanish[1].padStart(2, "0")}`;
}
