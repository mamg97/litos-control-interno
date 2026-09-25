const ASSUMPTIONS_KEY = "litos-control-assumptions-v1";
const FINANCE_KEY = "litos-control-finance-v1";
// The Drive synchronizer runs approximately every five minutes. Polling the
// public feed more often only repeats the same payload and makes the status
// look as if the whole dashboard were constantly reloading.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
// Apps Script can need a cold start. Keep the JSONP callback alive long
// enough for that response instead of treating a valid late answer as failed.
const FEED_TIMEOUT_MS = 45 * 1000;
// This URL is added only after the Apps Script feed is deployed. The feed is
// anonymous by design, but it contains only the whitelisted operational data
// defined in apps-script/Code.gs — never the Sheet itself or client details.
const DATA_FEED_URL = "https://script.google.com/macros/s/AKfycbyhzZOwkeSuBLskOnjtPNUs1yElq6dcNb4UXmNAA0Bp38qBfFX7DEPi8rNkuOPnT4DlHw/exec";

const emptySummary = {
  total: 0,
  yearOrders: 0,
  year: null,
  measured: 0,
  distinctSizes: 0,
  repeatShare: 0,
  models: [],
  materials: [],
  sizes: [],
  months: []
};

const state = {
  rows: [],
  expenses: [],
  movements: [],
  summary: emptySummary,
  connected: false,
  generatedAt: null,
  loading: false,
  activeView: "summary"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatInt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const formatMoney = (value) => {
  const rounded = Math.round(Number(value) || 0);
  const sign = rounded < 0 ? "−" : "";
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${digits} €`;
};
const SVG_NS = "http://www.w3.org/2000/svg";

const FINANCE_DEFAULTS = Object.freeze({
  financeAveragePrice: 200,
  financeOtherIncome: 0,
  financeElectricity: 0,
  financeWaterWaste: 0,
  financeInternet: 0,
  financeLetters: 0,
  financeTransport: 0,
  financeLabour: 0,
  financeOtherCosts: 0
});

const KNOWN_CONSUMABLES = Object.freeze({
  abrasives: 1560 + 300,
  templates: 14 * 85,
  finishing: (55 * 4.5) + (24 * 9) + (6 * 15)
});

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 3600);
}

function text(value) {
  return String(value ?? "").trim();
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let normalized = text(value).replace(/[^0-9,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(thousands, "").replace(decimal, ".");
  } else if (lastComma !== -1) {
    normalized = normalized.replace(/,/g, ".");
  }
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const raw = text(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const spanish = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (spanish) {
    const year = Number(spanish[3].length === 2 ? `20${spanish[3]}` : spanish[3]);
    return new Date(year, Number(spanish[2]) - 1, Number(spanish[1]));
  }
  return null;
}

// The reconciliation keeps the date on which a fiche arrived separate from
// the date on which its work was delivered. Historical reporting is based on
// the latter; a live order without a ledger record falls back to its fiche.
function dashboardDate(row) {
  if (!row) return null;
  return parseDate(row["Fecha para dashboard"] || row["Fecha entrega (estadillo)"] || row["Fecha recepción (email)"] || row["Fecha ficha"]);
}

// Para medir el ritmo de entrada de pedidos usamos cuándo llegó realmente
// el pedido al taller. Si no existe recepción por email, usamos la fecha de
// ficha y, para históricos incompletos, la fecha disponible del dashboard.
function orderEntryDate(row) {
  if (!row) return null;
  return parseDate(
    row["Fecha recepción (email)"] ||
    row["Fecha ficha"] ||
    row["Fecha para dashboard"] ||
    row["Fecha entrega (estadillo)"]
  );
}

function recordedFinalPrice(row) {
  return optionalNumberAt(row, "Precio final (€)");
}

function recordedEstimatedPrice(row) {
  // A provisional selling price is valid for display only when there is a
  // draft document. It never overrides a definitive/final price.
  if (!text(row?.["Factura borrador (XLSX)"])) return null;
  return optionalNumberAt(row, "Precio estimado (€)");
}

function recordedRevenue(row) {
  const finalPrice = recordedFinalPrice(row);
  if (finalPrice !== null) return finalPrice;
  return optionalNumberAt(row, "Importe trabajo / Debe (€)");
}

function revenueFor(row, fallbackPrice) {
  const actual = recordedRevenue(row);
  return actual === null ? fallbackPrice : actual;
}

function normalize(value) {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function countBy(values) {
  const map = new Map();
  values.filter(Boolean).forEach((value) => map.set(value, (map.get(value) || 0) + 1));
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function familyFor(model) {
  const value = normalize(model);
  if (value.startsWith("tapa nicho") || value.startsWith("tapenucho")) return "Tapa nicho";
  if (value.startsWith("columbario") || value.startsWith("columbetino")) return "Columbario";
  if (value.startsWith("reforma")) return "Reforma";
  if (value.startsWith("lapida")) return "Lápida";
  return text(model) || "Sin modelo";
}

function isReform(row) {
  return familyFor(row.Modelo) === "Reforma";
}

function rawMaterialFor(row) {
  return text(row["Material indicado"] || row.Material);
}

function materialFor(row) {
  const raw = rawMaterialFor(row);
  const normalized = text(row["Material normalizado"]);
  if (normalized) return normalized === "Material aportado" ? "Material aportado · cliente" : normalized;
  const value = normalize(raw);
  // In the workshop's terminology, “Absoluto” is shorthand for the same
  // material as “Negro absoluto”; keep both spellings in one demand group.
  if (value === "absoluto" || value.includes("negro absoluto")) return "Granito negro absoluto";
  if (value.includes("italia") || value.includes("italiano")) return "Mármol blanco italiano";
  if (value.includes("blanco") || value.includes("macael")) return "Mármol blanco Macael · cliente";
  if (value === "suyo" || value === "suya") {
    return isReform(row) ? "Piedra existente" : "Material aportado · cliente";
  }
  return raw || "Sin material";
}

function materialRateFor(row) {
  const value = normalize(rawMaterialFor(row));
  // “Suyo” is either existing stone in a reform or material supplied by the client;
  // white Macael is also supplied by the client None is a workshop stone purchase.
  if (!value || value === "suyo" || value === "suya" || value.includes("macael") || (value.includes("blanco") && !value.includes("italiano") && !value.includes("italia"))) return 0;
  if (value.includes("negro absoluto") || value === "absoluto") return 110;
  if (value.includes("labrador")) return 80;
  if (value.includes("verde pradera")) return 75;
  if (value.includes("sudafrica") || value.includes("sud africa") || value.includes("sur africa")) return 69;
  if (value.includes("blanco italiano") || value.includes("italia")) return 62;
  if (value.includes("gris quintana")) return 45;
  if (value.includes("champan") || value.includes("gris perla") || value.includes("pardino")) return 30;
  return null;
}

function numberFromFields(row, preferredFields, matchesHeader) {
  const fields = [...preferredFields, ...Object.keys(row).filter(matchesHeader)];
  for (const field of new Set(fields)) {
    const raw = row[field];
    if (!text(raw)) continue;
    const value = parseNumber(raw);
    if (value !== null) return value;
  }
  return null;
}

function isSlabMeasureHeader(header, measure) {
  const value = normalize(header);
  if (!value.includes(measure)) return false;
  return !["escalon", "base", "remate", "rebaje", "interior", "hueco", "croquis"].some((term) => value.includes(term));
}

function writtenHeightFor(row) {
  return numberFromFields(
    row,
    ["Alto escrito (cm)", "Alto total (cm)", "Alto lápida (cm)", "Alto lapida (cm)", "Alto (cm)"],
    (header) => isSlabMeasureHeader(header, "alto") && !["neto", "final", "real"].some((term) => normalize(header).includes(term))
  );
}

function finishedHeightFor(row) {
  const explicit = numberFromFields(
    row,
    ["Alto neto lápida (cm)", "Alto neto (cm)", "Alto final (cm)", "Alto real (cm)"],
    (header) => isSlabMeasureHeader(header, "alto") && ["neto", "final", "real"].some((term) => normalize(header).includes(term))
  );
  if (explicit !== null) return explicit;
  const written = writtenHeightFor(row);
  return written === null ? null : Math.max(0, written - 4);
}

function sizeDetailsFor(row) {
  const width = numberFromFields(
    row,
    ["Ancho total (cm)", "Ancho lápida (cm)", "Ancho lapida (cm)", "Ancho (cm)"],
    (header) => isSlabMeasureHeader(header, "ancho")
  );
  const writtenHeight = writtenHeightFor(row);
  const netHeight = finishedHeightFor(row);
  // An empty numeric cell is read as 0 by JavaScript. Zero is not a valid
  // tombstone dimension, so omit incomplete forms from size analysis.
  if (width === null || writtenHeight === null || netHeight === null || width <= 0 || writtenHeight <= 0 || netHeight <= 0) return null;
  const show = (value) => Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
  return {
    initial: `${show(width)} × ${show(writtenHeight)}`,
    net: `${show(width)} × ${show(netHeight)}`
  };
}

function sizeFor(row) {
  return sizeDetailsFor(row)?.net || null;
}

function sizeCounts(rows) {
  const counts = new Map();
  rows.forEach((row) => {
    const detail = sizeDetailsFor(row);
    if (!detail) return;
    const key = `${detail.initial}|${detail.net}`;
    const current = counts.get(key) || { ...detail, count: 0 };
    current.count += 1;
    counts.set(key, current);
  });
  return [...counts.values()].sort((left, right) => right.count - left.count || left.initial.localeCompare(right.initial, "es", { numeric: true }));
}

function numberAt(row, key) {
  const value = row[key];
  return parseNumber(value);
}

function optionalNumberAt(row, key) {
  const value = row[key];
  if (value === null || value === undefined || text(value) === "") return null;
  return parseNumber(value);
}

function mapRows(values) {
  const headerIndex = values.findIndex((row) => row.some((cell) => text(cell) === "Pedido"));
  if (headerIndex < 0) throw new Error("No se localizó la fila de cabeceras 'Pedido' en la pestaña indicada.");
  const headers = values[headerIndex].map(text);
  return values.slice(headerIndex + 1)
    .map((row, index) => {
      const record = { _rowNumber: headerIndex + index + 2 };
      headers.forEach((header, column) => { if (header) record[header] = row[column] ?? ""; });
      return record;
    })
    .filter((row) => text(row.Pedido));
}

// The public feed deliberately has a narrow, fixed schema. Mapping it back to
// the dashboard's internal field names lets the analysis stay in one place
// without ever loading names, memorial text, attachments or Sheet metadata.
function mapPublicRows(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => ({
    Pedido: text(record.id),
    "Fecha ficha": text(record.orderDate),
    "Fecha recepción (email)": text(record.receiptDate),
    "Fecha entrega (estadillo)": text(record.deliveredDate),
    "Fecha entrega albarán": text(record.deliveryDocumentDate),
    "Estado conciliación definitivo": text(record.deliveryReviewStatus),
    "Fecha para dashboard": text(record.date),
    "Importe trabajo / Debe (€)": record.amount ?? "",
    "Precio final (€)": record.finalPrice ?? record.pvp ?? "",
    "Precio estimado (€)": record.estimatedPrice ?? "",
    "Coste material est. (€)": record.materialCost ?? "",
    "Coste directo real (€)": record.directCostActual ?? "",
    "Estado pedido": text(record.status),
    Modelo: text(record.model),
    Material: text(record.material),
    "Material normalizado": text(record.materialNormalized),
    "Ancho total (cm)": record.width ?? "",
    "Alto total (cm)": record.height ?? "",
    "Grosor (cm)": record.thickness ?? "",
    "Ancho base (cm)": record.baseWidth ?? "",
    "Alto base/croquis (cm)": record.baseHeight ?? "",
    "Ancho superior/remate (cm)": record.topWidth ?? "",
    "Cotas/escalones (cm)": text(record.stepMeasures),
    "Voleo (cm)": record.voleo ?? "",
    "Archivo factura / albarán (XLSX)": text(record.invoiceFile),
    "Factura borrador (XLSX)": text(record.invoiceDraftFile),
    "Archivo Corel (CDR)": text(record.corelFile),
    Notas: text(record.noteFile),
    "Nota manuscrita": text(record.noteFile),
    "Imágenes anejas": text(record.attachmentFile)
  })).filter((row) => row.Pedido);
}

// Cost details remain in the private Sheet. The public feed contains only the
// minimum aggregate required for the dashboard: monthly amount, category and
// audit status. No invoice reference, address, email or supplier account is
// added to the browser.
function mapPublicExpenses(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => {
    const month = text(record.month);
    const category = text(record.category);
    const amount = parseNumber(record.amount);
    return { month, category, amount, nature: text(record.nature) || "Sin clasificar", source: text(record.source), invoiceDate: text(record.invoiceDate), reference: text(record.reference), emailEvidence: text(record.emailEvidence), folderUrl: text(record.folderUrl), documentUrl: text(record.documentUrl) };
  }).filter((record) => /^\d{4}-(0[1-9]|1[0-2])$/.test(record.month) && record.category && record.amount !== null);
}


function mapPublicMovements(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record, index) => ({
    _index: index,
    year: parseNumber(record.year),
    date: text(record.date),
    sourceDate: text(record.sourceDate),
    type: text(record.type),
    ref: text(record.ref),
    line: parseNumber(record.line),
    concept: text(record.concept),
    debit: parseNumber(record.debit),
    credit: parseNumber(record.credit),
    balance: parseNumber(record.balance)
  })).filter((record) => record.date && record.type && record.balance !== null);
}

function latestEstadilloMovement() {
  for (let index = state.movements.length - 1; index >= 0; index -= 1) {
    if (state.movements[index].balance !== null) return state.movements[index];
  }
  return null;
}

function estadilloBalanceExplanation(balance) {
  if (balance === null || balance === undefined) return "Pendiente de cargar el estadillo";
  if (balance > 0) return "Pendiente de cobro: " + formatMoney(balance);
  if (balance < 0) return "Saldo a favor del cliente: " + formatMoney(Math.abs(balance));
  return "Cuenta cuadrada";
}

function renderEstadilloLedger(year) {
  const body = $("#estadilloLedgerBody");
  if (!body) return;
  const selectedYear = Number(year);
  const rows = state.movements
    .filter((movement) => !selectedYear || movement.year === selectedYear)
    .slice()
    .reverse();

  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "empty-state";
    td.textContent = "No hay movimientos de estadillo para este año.";
    tr.append(td);
    body.append(tr);
  } else {
    rows.forEach((movement) => {
      const tr = document.createElement("tr");
      const values = [
        formatOperationalDate(movement.date),
        movement.type === "ENTREGA A CUENTA" ? "Entrega a cuenta" : movement.type === "TRABAJO ENTREGADO" ? "Trabajo entregado" : movement.type,
        movement.ref && movement.ref !== "—" ? movement.ref : "—",
        movement.concept || "—",
        movement.debit === null ? "—" : formatMoney(movement.debit),
        movement.credit === null ? "—" : formatMoney(movement.credit),
        formatMoney(movement.balance)
      ];
      values.forEach((value) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      });
      body.append(tr);
    });
  }

  const balanceNode = $("#estadilloLedgerBalance");
  if (balanceNode) {
    const latestForYear = rows.length ? rows[0] : null;
    balanceNode.textContent = latestForYear
      ? formatMoney(latestForYear.balance) + " · " + estadilloBalanceExplanation(latestForYear.balance)
      : "Sin movimientos";
  }
}

function makeSummary(rows) {
  const rowsWithDate = rows.map((row) => ({ ...row, _date: dashboardDate(row) })).filter((row) => row._date);
  const latestYear = rowsWithDate.length ? Math.max(...rowsWithDate.map((row) => row._date.getFullYear())) : new Date().getFullYear();
  const inLatestYear = rowsWithDate.filter((row) => row._date.getFullYear() === latestYear);
  const measured = rows.filter((row) => sizeFor(row));
  const models = countBy(rows.map((row) => familyFor(row.Modelo))).slice(0, 6);
  const materials = countBy(rows.map(materialFor)).slice(0, 6);
  const sizes = sizeCounts(measured);
  const monthMap = new Map();
  rowsWithDate.forEach((row) => {
    const d = row._date;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthMap.set(key, (monthMap.get(key) || 0) + 1);
  });
  const months = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([key, value]) => {
    const [year, month] = key.split("-").map(Number);
    const label = new Intl.DateTimeFormat("es-ES", { month: "short", year: "2-digit" }).format(new Date(year, month - 1, 1)).replace(" de ", " ");
    return [label, value];
  });
  const recurrent = rows.filter((row) => ["Tapa nicho", "Reforma"].includes(familyFor(row.Modelo))).length;
  return {
    total: rows.length,
    yearOrders: inLatestYear.length,
    year: latestYear,
    measured: measured.length,
    distinctSizes: sizes.length,
    repeatShare: rows.length ? Math.round((recurrent / rows.length) * 100) : 0,
    models,
    materials,
    sizes: sizes.slice(0, 8),
    months
  };
}

function rowsForYear(year) {
  if (!year) return [];
  return state.rows.filter((row) => dashboardDate(row)?.getFullYear() === Number(year));
}

function selectedSummaryYear() {
  const selected = Number($("#summaryYear")?.value);
  return Number.isFinite(selected) && selected > 0 ? selected : state.summary.year;
}

function selectedSummaryGranularity() {
  return $("#summaryGranularity")?.value === "quarter" ? "quarter" : "year";
}

function selectedSummaryMetric() {
  return $("#summaryMetric")?.value || "orders";
}

function selectedFinanceGranularity() {
  return $("#financeGranularity")?.value === "quarter" ? "quarter" : "year";
}

function availableDataYears() {
  return [...new Set(state.rows.map((row) => dashboardDate(row)?.getFullYear()).filter(Boolean))]
    .sort((a, b) => b - a);
}

function selectedForecastYear() {
  const selected = Number($("#forecastYear")?.value);
  return Number.isFinite(selected) && selected > 0 ? selected : state.summary.year;
}

function getFilteredRows() {
  if (!state.rows.length) return [];
  const year = $("#yearFilter").value;
  const model = $("#modelFilter").value;
  return state.rows.filter((row) => {
    const date = dashboardDate(row);
    const yearMatches = year === "all" || (date && String(date.getFullYear()) === year);
    const modelMatches = model === "all" || familyFor(row.Modelo) === model;
    return yearMatches && modelMatches;
  });
}

function getProductionSummary() {
  const rows = getFilteredRows();
  if (!rows.length) return state.summary;
  const measured = rows.filter((row) => sizeFor(row));
  const sizes = sizeCounts(measured);
  return {
    total: rows.length,
    measured: measured.length,
    distinctSizes: sizes.length,
    models: countBy(rows.map((row) => familyFor(row.Modelo))).slice(0, 8),
    materials: countBy(rows.map(materialFor)).slice(0, 8),
    sizes: sizes.slice(0, 12)
  };
}

function renderRank(container, values, label) {
  container.replaceChildren();
  if (!values.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Los datos operativos se están actualizando.";
    container.append(empty);
    return;
  }
  const max = Math.max(...values.map(([, value]) => value), 1);
  values.forEach(([name, value], index) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    const rank = document.createElement("span"); rank.className = "rank-index"; rank.textContent = String(index + 1).padStart(2, "0");
    const nameEl = document.createElement("span"); nameEl.className = "rank-label"; nameEl.textContent = name;
    const count = document.createElement("span"); count.className = "rank-value"; count.textContent = `${value} ${label}`;
    const bar = document.createElement("div"); bar.className = "rank-bar";
    const fill = document.createElement("i"); fill.style.width = `${Math.max(8, (value / max) * 100)}%`;
    bar.append(fill); row.append(rank, nameEl, count, bar); container.append(row);
  });
}

function renderSizeRank(container, values) {
  container.replaceChildren();
  if (!values.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Los datos operativos se están actualizando.";
    container.append(empty);
    return;
  }
  const max = Math.max(...values.map((entry) => entry.count), 1);
  values.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "rank-row size-rank-row";
    const rank = document.createElement("span"); rank.className = "rank-index"; rank.textContent = String(index + 1).padStart(2, "0");
    const initial = document.createElement("span"); initial.className = "rank-label"; initial.textContent = entry.initial;
    const net = document.createElement("span"); net.className = "rank-net"; net.textContent = entry.net;
    const count = document.createElement("span"); count.className = "rank-value"; count.textContent = `${entry.count} pedidos`;
    const bar = document.createElement("div"); bar.className = "rank-bar";
    const fill = document.createElement("i"); fill.style.width = `${Math.max(8, (entry.count / max) * 100)}%`;
    bar.append(fill); row.append(rank, initial, net, count, bar); container.append(row);
  });
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function chartValue(value, metric) {
  if (metric === "orders") return formatInt.format(value);
  const amount = Math.round(value);
  if (Math.abs(amount) >= 1000) {
    return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(amount / 1000)}k`;
  }
  return `${formatInt.format(amount)} €`;
}

function drawOrdersChart(data, metric = "orders") {
  const canvas = $("#ordersChart");
  const { ctx, width, height } = setupCanvas(canvas);
  const left = metric === "orders" ? 38 : 58, right = 12, top = 28, bottom = 33;
  const values = data.map(([, value]) => value);
  const max = Math.max(...values, 0, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const plotHeight = height - top - bottom;
  const yFor = (value) => top + ((max - value) / range) * plotHeight;
  const zeroY = yFor(0);
  const colours = { orders: "#10726e", revenue: "#5b9b96", costs: "#d4953f", profit: "#0e3137" };
  const barColour = colours[metric] || colours.orders;
  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px Manrope"; ctx.fillStyle = "#799194"; ctx.strokeStyle = "#e4edeb"; ctx.lineWidth = 1;
  [0, .5, 1].forEach((ratio) => {
    const y = top + plotHeight * ratio;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
    const scaleValue = max - range * ratio;
    ctx.fillText(chartValue(scaleValue, metric), 2, y + 4);
  });
  if (min < 0) {
    ctx.beginPath(); ctx.moveTo(left, zeroY); ctx.lineTo(width - right, zeroY);
    ctx.strokeStyle = "#9fb3b1"; ctx.lineWidth = 1.4; ctx.stroke();
  }
  if (!data.length) return;
  const slot = (width - left - right) / data.length;
  const barWidth = Math.max(5, Math.min(42, slot * .58));
  data.forEach(([label, value, estimated = false], index) => {
    const x = left + slot * index + slot / 2;
    const y = yFor(value);
    const barTop = Math.min(y, zeroY);
    const barHeight = Math.max(1, Math.abs(zeroY - y));
    ctx.fillStyle = estimated ? "#bd7e27" : (metric === "profit" && value < 0 ? "#c86c58" : barColour);
    ctx.fillRect(x - barWidth / 2, barTop, barWidth, barHeight);
    ctx.fillStyle = estimated ? "#805817" : "#0e3137"; ctx.font = "600 10px DM Mono"; ctx.textAlign = "center";
    const valueLabelY = value < 0 ? Math.min(height - 20, barTop + barHeight + 13) : Math.max(13, barTop - 8);
    ctx.fillText(chartValue(value, metric), x, valueLabelY);
    if (index % 2 === 0 || data.length < 9 || width >= 940) { ctx.fillStyle = "#799194"; ctx.font = "11px Manrope"; ctx.fillText(label, x, height - 12); }
  });
  ctx.textAlign = "start";
}

function periodsFor(year, granularity) {
  if (granularity === "quarter") {
    return [
      { label: "T1", months: [0, 1, 2] }, { label: "T2", months: [3, 4, 5] },
      { label: "T3", months: [6, 7, 8] }, { label: "T4", months: [9, 10, 11] }
    ];
  }
  return Array.from({ length: 12 }, (_, month) => ({
    label: new Intl.DateTimeFormat("es-ES", { month: "short" }).format(new Date(Number(year), month, 1)).replace(".", ""),
    months: [month]
  }));
}

function performanceSeries(year, granularity = "year") {
  const periods = periodsFor(year, granularity);

  // Los pedidos se agrupan por fecha real de entrada.
  const annualOrderRows = state.rows.filter(
    (row) => orderEntryDate(row)?.getFullYear() === Number(year)
  );

  // Las magnitudes económicas mantienen la fecha operativa/contable.
  const annualFinancialRows = rowsForYear(year);
  const finance = calculateFinance(annualFinancialRows, year);
  const share = periods.length ? 1 / periods.length : 0;

  return periods.map(({ label, months }) => {
    const orderRows = annualOrderRows.filter(
      (row) => months.includes(orderEntryDate(row)?.getMonth())
    );

    const financialRows = annualFinancialRows.filter(
      (row) => months.includes(dashboardDate(row)?.getMonth())
    );

    const revenue =
      financialRows.reduce(
        (total, row) => total + revenueFor(row, finance.averagePrice),
        0
      ) + finance.otherIncome * share;

    // Annual KPIs and monthly/quarterly charts share the same cost engine.
    // Direct supplier costs replace job estimates; general real expenses enter
    // operating cost; stock, stock credits and pending links stay outside profit.
    const costs = operatingCostBreakdown(financialRows, Number(year), months).total;

    return {
      label,
      orders: orderRows.length,
      revenue,
      costs,
      profit: revenue - costs
    };
  });
}

function metricValue(point, metric) {
  return point[metric] ?? 0;
}

const FORECAST_HISTORY_WINDOW = 5;

function weightedMonthlyForecast(targetYear, month, metric) {
  const priorYears = availableDataYears()
    .filter((year) => Number(year) < Number(targetYear))
    .sort((a, b) => a - b)
    .slice(-FORECAST_HISTORY_WINDOW);

  if (!priorYears.length) return null;

  let weightedTotal = 0;
  let totalWeight = 0;
  priorYears.forEach((year, index) => {
    const point = performanceSeries(year, "year")[month];
    const value = Number(metricValue(point || {}, metric));
    if (!Number.isFinite(value)) return;
    const weight = index + 1;
    weightedTotal += value * weight;
    totalWeight += weight;
  });

  if (!totalWeight) return null;
  const estimate = weightedTotal / totalWeight;
  return metric === "orders" ? Math.max(0, Math.round(estimate)) : estimate;
}

function forecastMetricSeries(year, granularity, metric) {
  const targetYear = Number(year);
  const monthlyActual = performanceSeries(targetYear, "year");
  const now = new Date();
  const isOpenYear = targetYear === now.getFullYear();
  const currentMonth = now.getMonth();

  return periodsFor(targetYear, granularity).map(({ label, months }) => {
    let actualValue = 0;
    let estimatedValue = 0;
    let estimatedMonths = 0;

    months.forEach((month) => {
      if (isOpenYear && month > currentMonth) {
        const estimate = weightedMonthlyForecast(targetYear, month, metric);
        if (estimate !== null) {
          estimatedValue += estimate;
          estimatedMonths += 1;
        }
      } else {
        actualValue += metricValue(monthlyActual[month] || {}, metric);
      }
    });

    return {
      label,
      value: actualValue + estimatedValue,
      actualValue,
      estimatedValue,
      estimated: estimatedMonths > 0,
      estimatedMonths
    };
  });
}

function annualMetricProjection(year, metric) {
  const targetYear = Number(year);
  const now = new Date();
  if (targetYear !== now.getFullYear() || now.getMonth() >= 11) return null;
  const series = forecastMetricSeries(targetYear, "year", metric);
  if (!series.some((point) => point.estimated)) return null;
  return series.reduce((total, point) => total + point.value, 0);
}

function renderMetricStrip(years, selectedYear, granularity, metric) {
  const root = $("#summaryMetricTable");
  if (!root) return;
  root.replaceChildren();

  const periods = periodsFor(selectedYear || new Date().getFullYear(), granularity);
  const labels = periods.map(({ label }) => label);
  root.style.setProperty("--period-count", String(periods.length));

  if (!years.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "El histórico se mostrará al recibir pedidos con fecha.";
    root.append(empty);
    return;
  }

  const formatMetric = (value) => metric === "orders" ? formatInt.format(value) : chartValue(value, metric);
  const makeCell = (content, className = "") => {
    const cell = document.createElement("span");
    cell.className = className;
    cell.textContent = content;
    return cell;
  };

  const desktop = document.createElement("div");
  desktop.className = "history-desktop-view";

  const header = document.createElement("div");
  header.className = "history-matrix-row history-matrix-header";
  header.append(
    makeCell("Año"),
    ...labels.map((label) => makeCell(label)),
    makeCell("Total"),
    makeCell("Estimación", "history-estimate")
  );
  desktop.append(header);

  const mobile = document.createElement("div");
  mobile.className = "history-mobile-view";

  years.forEach((year) => {
    const actualSeries = performanceSeries(year, granularity);
    const displaySeries = forecastMetricSeries(year, granularity, metric);
    const actualTotal = actualSeries.reduce((sum, point) => sum + metricValue(point, metric), 0);
    const projection = annualMetricProjection(year, metric);

    const row = document.createElement("div");
    row.className = `history-matrix-row${year === Number(selectedYear) ? " selected" : ""}`;
    row.append(makeCell(String(year), "history-year"));
    displaySeries.forEach((point) => {
      row.append(makeCell(
        formatMetric(point.value),
        point.estimated ? "history-estimated-value" : ""
      ));
    });
    row.append(makeCell(formatMetric(actualTotal), "history-total"));
    row.append(makeCell(
      projection === null ? "—" : formatMetric(projection),
      projection === null ? "history-estimate" : "history-estimate history-estimated-value"
    ));
    desktop.append(row);

    const card = document.createElement("article");
    card.className = `history-mobile-year${year === Number(selectedYear) ? " selected" : ""}`;

    const yearHead = document.createElement("div");
    yearHead.className = "history-mobile-year-head";
    yearHead.append(
      makeCell(String(year), "history-mobile-year-label"),
      makeCell(year === Number(selectedYear) ? "Año seleccionado" : "Histórico", "history-mobile-year-state")
    );
    card.append(yearHead);

    const chunkSize = labels.length > 6 ? 6 : labels.length;
    for (let start = 0; start < labels.length; start += chunkSize) {
      const periodGrid = document.createElement("div");
      periodGrid.className = "history-mobile-period-grid";
      periodGrid.style.setProperty("--mobile-period-count", String(Math.min(chunkSize, labels.length - start)));

      labels.slice(start, start + chunkSize).forEach((label, offset) => {
        const point = displaySeries[start + offset];
        const item = document.createElement("div");
        item.className = `history-mobile-period${point?.estimated ? " estimated" : ""}`;
        item.append(
          makeCell(label, "history-mobile-period-label"),
          makeCell(formatMetric(point?.value || 0), "history-mobile-period-value")
        );
        periodGrid.append(item);
      });
      card.append(periodGrid);
    }

    const totals = document.createElement("div");
    totals.className = "history-mobile-totals";

    const totalItem = document.createElement("div");
    totalItem.className = "history-mobile-total";
    totalItem.append(
      makeCell("Total real", "history-mobile-period-label"),
      makeCell(formatMetric(actualTotal), "history-mobile-summary-value")
    );

    const estimateItem = document.createElement("div");
    estimateItem.className = `history-mobile-total estimate${projection === null ? "" : " estimated"}`;
    estimateItem.append(
      makeCell("Estimación", "history-mobile-period-label"),
      makeCell(projection === null ? "—" : formatMetric(projection), "history-mobile-summary-value")
    );

    totals.append(totalItem, estimateItem);
    card.append(totals);
    mobile.append(card);
  });

  root.append(desktop, mobile);
}

function drawFinancialSummaryChart(series) {
  const canvas = $("#financialSummaryChart");
  if (!canvas) return;
  const { ctx, width, height } = setupCanvas(canvas);
  if (width < 2 || height < 2) return;
  const left = 56, right = 12, top = 28, bottom = 33;
  const values = series.flatMap((point) => [point.revenue, point.costs, point.profit]);
  const max = Math.max(...values, 1);
  const plotHeight = height - top - bottom;
  const step = (width - left - right) / Math.max(series.length - 1, 1);
  const point = (index, value) => ({ x: left + index * step, y: top + plotHeight * (1 - value / max) });

  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px Manrope"; ctx.fillStyle = "#799194"; ctx.strokeStyle = "#e4edeb"; ctx.lineWidth = 1;
  [0, .5, 1].forEach((ratio) => {
    const y = top + plotHeight * ratio;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
    ctx.fillText(chartValue(max * (1 - ratio), "revenue"), 2, y + 4);
  });
  if (!series.length) return;

  const drawLine = (key, colour, lineWidth, withLabel = false) => {
    ctx.beginPath(); ctx.strokeStyle = colour; ctx.lineWidth = lineWidth;
    series.forEach((entry, index) => {
      const position = point(index, entry[key]);
      index ? ctx.lineTo(position.x, position.y) : ctx.moveTo(position.x, position.y);
    });
    ctx.stroke();
    series.forEach((entry, index) => {
      const position = point(index, entry[key]);
      ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(position.x, position.y, key === "profit" ? 3.6 : 2.5, 0, Math.PI * 2); ctx.fill();
      if (withLabel) {
        ctx.fillStyle = "#0e3137"; ctx.font = "600 10px DM Mono"; ctx.textAlign = "center";
        ctx.fillText(chartValue(entry[key], "profit"), position.x, Math.max(13, position.y - 10));
      }
    });
  };

  drawLine("revenue", "#7fb9b2", 2);
  drawLine("costs", "#dda859", 2);
  drawLine("profit", "#0e3137", 3.8, true);
  series.forEach((entry, index) => {
    if (index % 2 === 0 || series.length < 9 || width >= 940) {
      ctx.fillStyle = "#799194"; ctx.font = "11px Manrope"; ctx.textAlign = "center";
      ctx.fillText(entry.label, point(index, 0).x, height - 12);
    }
  });
  ctx.textAlign = "start";
}

function drawForecastChart(series) {
  const canvas = $("#forecastChart");
  if (!canvas) return;
  const { ctx, width, height } = setupCanvas(canvas);
  if (width < 2 || height < 2) return;
  const left = 47, right = 15, top = 27, bottom = 34;
  const values = [...series.actual, ...series.forecast.filter((value) => value !== null)];
  const max = Math.max(...values, 1);
  const point = (index, value) => ({
    x: left + index * ((width - left - right) / 11),
    y: top + (height - top - bottom) * (1 - value / max)
  });
  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px Manrope"; ctx.fillStyle = "#799194"; ctx.strokeStyle = "#e4edeb"; ctx.lineWidth = 1;
  [0, .5, 1].forEach((ratio) => {
    const y = top + (height - top - bottom) * ratio;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
    ctx.fillText(chartValue(max * (1 - ratio), "revenue"), 2, y + 4);
  });
  const actualEnd = Math.max(0, series.lastActualMonth);
  ctx.beginPath();
  series.actual.slice(0, actualEnd + 1).forEach((value, index) => {
    const position = point(index, value);
    index ? ctx.lineTo(position.x, position.y) : ctx.moveTo(position.x, position.y);
  });
  ctx.strokeStyle = "#10726e"; ctx.lineWidth = 2.5; ctx.stroke();
  if (actualEnd < 11) {
    ctx.save(); ctx.setLineDash([7, 6]); ctx.beginPath();
    const start = point(actualEnd, series.actual[actualEnd]);
    ctx.moveTo(start.x, start.y);
    for (let index = actualEnd + 1; index < 12; index += 1) {
      const position = point(index, series.forecast[index]);
      ctx.lineTo(position.x, position.y);
    }
    ctx.strokeStyle = "#bd7e27"; ctx.lineWidth = 2.25; ctx.stroke(); ctx.restore();
  }
  series.actual.slice(0, actualEnd + 1).forEach((value, index) => {
    const position = point(index, value);
    ctx.fillStyle = "#10726e"; ctx.beginPath(); ctx.arc(position.x, position.y, 3.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0e3137"; ctx.font = "600 10px DM Mono"; ctx.textAlign = "center";
    ctx.fillText(chartValue(value, "revenue"), position.x, Math.max(13, position.y - 10));
  });
  if (actualEnd < 11) {
    const end = point(11, series.forecast[11]);
    ctx.fillStyle = "#bd7e27"; ctx.beginPath(); ctx.arc(end.x, end.y, 3.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#805817"; ctx.font = "600 10px DM Mono"; ctx.textAlign = "center";
    ctx.fillText(chartValue(series.forecast[11], "revenue"), end.x, Math.max(13, end.y - 10));
  }
  Array.from({ length: 12 }, (_, index) => {
    const label = new Intl.DateTimeFormat("es-ES", { month: "short" }).format(new Date(series.year, index, 1)).replace(".", "");
    ctx.fillStyle = "#799194"; ctx.font = "11px Manrope"; ctx.textAlign = "center";
    if (index % 2 === 0 || width >= 940) ctx.fillText(label, point(index, 0).x, height - 12);
  });
  ctx.textAlign = "start";
}

function renderRevenueForecast() {
  const year = selectedForecastYear();
  const rows = rowsForYear(year);
  const averagePrice = financeValue("financeAveragePrice");
  const orders = Array.from({ length: 12 }, () => 0);
  const income = Array.from({ length: 12 }, () => 0);
  rows.forEach((row) => {
    const date = dashboardDate(row);
    if (date) {
      orders[date.getMonth()] += 1;
      income[date.getMonth()] += revenueFor(row, averagePrice);
    }
  });
  const lastActualMonth = orders.reduce((latest, count, month) => count > 0 ? month : latest, -1);
  const knownMonths = lastActualMonth >= 0 ? lastActualMonth + 1 : 0;
  const actual = income;
  const averageMonthly = knownMonths ? actual.slice(0, knownMonths).reduce((total, value) => total + value, 0) / knownMonths : 0;
  const forecast = actual.map((value, month) => month <= lastActualMonth ? value : averageMonthly);
  const projected = actual.slice(0, knownMonths).reduce((total, value) => total + value, 0) + forecast.slice(knownMonths).reduce((total, value) => total + value, 0);
  const note = $("#forecastChartNote");
  if (note) {
    note.textContent = !state.connected || !year
      ? "Pendiente de datos"
      : lastActualMonth < 0
        ? `Sin trabajos registrados · año ${year}`
        : lastActualMonth === 11
          ? `Año cerrado · ${formatMoney(projected)}`
          : `Cierre estimado: ${formatMoney(projected)}`;
  }
  drawForecastChart({ year: Number(year) || new Date().getFullYear(), actual, forecast, lastActualMonth });
}

function drawModelsChart(data) {
  const canvas = $("#modelsChart");
  const { ctx, width, height } = setupCanvas(canvas);
  const top = 10, left = 108, right = 30, bottom = 8;
  const max = Math.max(...data.map(([, value]) => value), 1);
  const step = (height - top - bottom) / Math.max(data.length, 1);
  ctx.clearRect(0, 0, width, height); ctx.font = "11px Manrope";
  data.slice(0, 5).forEach(([label, value], index) => {
    const y = top + index * step + step * .2; const barHeight = Math.max(12, step * .48); const barWidth = (width - left - right) * (value / max);
    ctx.fillStyle = "#f0f4f3"; ctx.fillRect(left, y, width - left - right, barHeight);
    ctx.fillStyle = index === 0 ? "#10726e" : "#6ca7a0"; ctx.fillRect(left, y, barWidth, barHeight);
    ctx.fillStyle = "#466267"; ctx.textAlign = "right"; ctx.fillText(label, left - 10, y + barHeight - 1);
    ctx.fillStyle = "#1b4145"; ctx.textAlign = "left"; ctx.fillText(String(value), Math.min(left + barWidth + 7, width - 20), y + barHeight - 1);
  });
  ctx.textAlign = "start";
}

function renderSummary() {
  const s = state.summary;
  const connected = state.connected;
  const year = selectedSummaryYear();
  const yearRows = rowsForYear(year);
  const finance = calculateFinance(yearRows, year);
  const years = availableDataYears();
  const granularity = selectedSummaryGranularity();
  const metric = selectedSummaryMetric();
  const metricLabels = {
    orders: "Pedidos",
    profit: "Beneficio estimado"
  };
  const firstDate = state.rows
    .map((row) => dashboardDate(row))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  $("#totalOrders").textContent = connected ? formatInt.format(s.total) : "—";
  $("#yearOrders").textContent = connected ? formatInt.format(yearRows.length) : "—";
  $("#yearOrdersFoot").textContent = connected && year ? `Año ${year}` : "Pendiente de actualización";
  $("#summaryRevenue").textContent = connected ? formatMoney(finance.revenue) : "—";
  $("#summaryCosts").textContent = connected ? formatMoney(finance.costs) : "—";
  const recordedRows = yearRows.filter((row) => recordedRevenue(row) !== null).length;
  const estimatedRows = Math.max(0, yearRows.length - recordedRows);
  $("#summaryRevenueFoot").textContent = connected && year
    ? recordedRows
      ? `${recordedRows} importes reales${estimatedRows ? ` · ${estimatedRows} estimados` : ""} · ${year}`
      : `Estimación operativa · ${year}`
    : "Estimación operativa";
  $("#summaryCostsFoot").textContent = connected && year ? `Material, consumibles y gastos · ${year}` : "Pendiente de facturas";
  const productionOrders = new Set(state.rows.filter((row) => isInProduction(row)).map((row) => text(row.Pedido))).size;
  const productionKpi = $("#ordersInProduction");
  productionKpi.textContent = connected ? formatInt.format(productionOrders) : "—";
  productionKpi.closest(".kpi-card")?.classList.toggle("pending-kpi", !connected);
  if (productionKpi.nextElementSibling) {
    productionKpi.nextElementSibling.textContent = connected
      ? `${currentQuarterLabel()} · sin factura/albarán`
      : "Pendiente de actualización";
  }
  const estadilloMovement = latestEstadilloMovement();
  const estadilloBalance = $("#estadilloBalance");
  const estadilloBalanceFoot = $("#estadilloBalanceFoot");
  if (estadilloBalance) {
    estadilloBalance.textContent = connected && estadilloMovement ? formatMoney(estadilloMovement.balance) : "—";
    estadilloBalance.closest(".kpi-card")?.classList.toggle("pending-kpi", !(connected && estadilloMovement));
  }
  if (estadilloBalanceFoot) {
    estadilloBalanceFoot.textContent = connected && estadilloMovement
      ? estadilloBalanceExplanation(estadilloMovement.balance)
      : "Pendiente de cargar el estadillo";
  }
  $("#measuredOrders").textContent = connected ? formatInt.format(s.measured) : "—";
  $("#distinctSizes").textContent = connected ? formatInt.format(s.distinctSizes) : "—";
  const topSize = s.sizes[0];
  $("#topSize").textContent = topSize?.initial || "—";
  $("#topSize").nextElementSibling.textContent = connected && topSize ? `Neto ${topSize.net} · ${topSize.count} pedidos` : "Medida de ficha";
  $("#orderPeriod").textContent = connected && firstDate
    ? `Desde ${new Intl.DateTimeFormat("es-ES", { dateStyle: "medium" }).format(firstDate)}`
    : "Sin datos cargados";
  const generated = state.generatedAt ? new Date(state.generatedAt) : null;
  const updateDate = generated && !Number.isNaN(generated.valueOf()) ? generated : null;
  $("#lastUpdate").textContent = connected
    ? `Actualizado ${new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(updateDate || new Date())}`
    : "Actualizando datos";
  $("#summaryChartHeading").textContent = `${metricLabels[metric]} por periodo`;

  $("#summaryChartNote").textContent = connected && year
    ? metric === "orders"
      ? "En " + year + ", los pedidos se agrupan " + (granularity === "quarter" ? "por trimestre" : "por mes") + " según su fecha de recepción por email; si no consta, se usa la fecha de ficha y, en el histórico incompleto, la mejor fecha disponible."
      : "En " + year + ", el beneficio se agrupa " + (granularity === "quarter" ? "por trimestre" : "por mes") + " según la fecha operativa de entrega registrada."
    : "La nota de fecha se completará al cargar los datos.";
  const series = forecastMetricSeries(year || new Date().getFullYear(), granularity, metric);
  const hasForecast = series.some((point) => point.estimated);
  if (hasForecast) {
    $("#summaryChartNote").textContent += " Las barras doradas son estimaciones de meses futuros mediante media móvil ponderada del mismo mes en hasta 5 años anteriores, dando más peso a los años recientes.";
  }
  drawOrdersChart(series.map((point) => [point.label, point.value, point.estimated]), metric);
  renderMetricStrip(years, year, granularity, metric);
}

function renderProduction() {
  const s = getProductionSummary();
  $("#measuredOrders").textContent = state.connected ? formatInt.format(s.measured || 0) : "—";
  $("#distinctSizes").textContent = state.connected ? formatInt.format(s.distinctSizes || 0) : "—";
  const topSize = s.sizes[0];
  $("#topSize").textContent = state.connected && topSize ? topSize.initial : "—";
  $("#topSize").nextElementSibling.textContent = state.connected && topSize ? `Neto ${topSize.net} · ${topSize.count} pedidos` : "Medida de ficha";
  renderRank($("#modelsTable"), s.models || [], "pedidos");
  renderRank($("#materialsTable"), s.materials || [], "pedidos");
  renderSizeRank($("#sizesTable"), s.sizes || []);
}

function formatOperationalDate(value) {
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat("es-ES", { dateStyle: "short" }).format(date) : text(value) || "—";
}

function traceDate(order) {
  // Operational traceability is ordered by definitive delivery first, then
  // receipt email, then the date written on the source order/note.
  return parseDate(order["Fecha entrega albarán"] || order["Fecha recepción (email)"] || order["Fecha ficha"]);
}

function currentQuarterBounds(now = new Date()) {
  const startMonth = Math.floor(now.getMonth() / 3) * 3;
  return {
    start: new Date(now.getFullYear(), startMonth, 1),
    end: new Date(now.getFullYear(), startMonth + 3, 1)
  };
}

function currentQuarterLabel(now = new Date()) {
  return `T${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`;
}

function productionReceiptDate(row) {
  return parseDate(row["Fecha recepción (email)"] || row["Fecha ficha"] || row["Fecha para dashboard"]);
}

function isInProduction(row, now = new Date()) {
  const receipt = productionReceiptDate(row);
  if (!receipt) return false;
  const { start, end } = currentQuarterBounds(now);
  const hasInvoice = Boolean(text(row["Archivo factura / albarán (XLSX)"]));
  const delivered = Boolean(parseDate(row["Fecha entrega (estadillo)"])) || normalize(row["Estado pedido"]).startsWith("entregado");
  return receipt >= start && receipt < end && !hasInvoice && !delivered;
}

function tracePeriod(order) {
  // Operational month: delivered jobs belong to the month they were delivered;
  // unresolved jobs belong to the month they entered the workshop.
  const date = parseDate(order["Fecha entrega albarán"])
    || orderEntryDate(order)
    || parseDate(order["Fecha para dashboard"]);
  return date ? (date.getFullYear() * 12 + date.getMonth()) : 0;
}

function isHistoricalDeliveryClosed(order) {
  return normalize(order["Estado conciliación definitivo"]) ===
    normalize("Cerrado histórico · sin fecha de entrega documental");
}

function deliveryDocumentReviewNeeded(order, now = new Date()) {
  if (isHistoricalDeliveryClosed(order)) return false;
  if (parseDate(order["Fecha entrega albarán"])) return false;
  const entry = orderEntryDate(order);
  if (!entry) return false;
  const entryMonth = new Date(entry.getFullYear(), entry.getMonth(), 1);
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return entryMonth < currentMonth;
}

function deliveryDocumentReviewLabel(order, now = new Date()) {
  if (isHistoricalDeliveryClosed(order)) return "Cerrado histórico · sin fecha documental";
  if (parseDate(order["Fecha entrega albarán"])) return "";
  const status = text(order["Estado conciliación definitivo"]).toLowerCase();
  if (status.includes("conflicto documental")) return "Conflicto documental";
  if (status.includes("sin fecha entrega diferenciada") || status.includes("sin fecha de entrega documental")) return "Sin fecha de entrega en albarán";
  if (status.includes("falta albarán definitivo")) return "Falta albarán definitivo";
  if (status.includes("mes en curso")) return "Pendiente de albarán · mes en curso";
  return deliveryDocumentReviewNeeded(order, now) ? "Revisar documento" : "";
}

function traceRows() {
  return [...state.rows].sort((a, b) => {
    const periodA = tracePeriod(a);
    const periodB = tracePeriod(b);

    // First group by operational month, newest first. Delivered jobs use
    // delivery month; unresolved jobs use entry/order month.
    if (periodA !== periodB) return periodB - periodA;

    const aDelivery = parseDate(a["Fecha entrega albarán"]);
    const bDelivery = parseDate(b["Fecha entrega albarán"]);

    // Within each month, unresolved/no-delivery-date jobs come first.
    if (!aDelivery && bDelivery) return -1;
    if (aDelivery && !bDelivery) return 1;

    // Pending rows: newest receipt email first, then source note/order date.
    if (!aDelivery && !bDelivery) {
      const aReceipt = parseDate(a["Fecha recepción (email)"]);
      const bReceipt = parseDate(b["Fecha recepción (email)"]);
      if (aReceipt || bReceipt) {
        const aValue = aReceipt?.valueOf() || 0;
        const bValue = bReceipt?.valueOf() || 0;
        if (aValue !== bValue) return bValue - aValue;
      }

      const aOrder = parseDate(a["Fecha ficha"])?.valueOf() || 0;
      const bOrder = parseDate(b["Fecha ficha"])?.valueOf() || 0;
      return bOrder - aOrder
        || text(b.Pedido).localeCompare(text(a.Pedido), "es", { numeric: true });
    }

    // Delivered rows in the same entry month: newest delivery first.
    return bDelivery.valueOf() - aDelivery.valueOf()
      || text(b.Pedido).localeCompare(text(a.Pedido), "es", { numeric: true });
  });
}

function matchesTraceQuery(order, query) {
  return !query || normalize([
    order.Pedido,
    order["Fecha para dashboard"],
    order["Fecha entrega albarán"],
    order["Fecha recepción (email)"],
    order["Fecha ficha"],
    familyFor(order.Modelo),
    materialFor(order),
    sizeFor(order)
  ].join(" ")).includes(query);
}

function renderTraceTable({ bodySelector, countSelector, searchSelector }) {
  const table = $(bodySelector);
  const count = $(countSelector);
  if (!table) return;
  table.replaceChildren();
  if (!state.connected) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 13;
    cell.className = "empty-state";
    cell.textContent = "Cargando datos operativos…";
    row.append(cell);
    table.append(row);
    if (count) count.textContent = "Cargando registros";
    return;
  }
  const query = normalize($(searchSelector)?.value);
  const allRows = traceRows();
  const rows = allRows.filter((order) => matchesTraceQuery(order, query));
  if (count) count.textContent = query
    ? `${formatInt.format(rows.length)} de ${formatInt.format(allRows.length)} trabajos`
    : `${formatInt.format(allRows.length)} trabajos · año-mes más reciente primero · dentro de cada mes, pendientes antes que entregados`;
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 13;
    cell.className = "empty-state";
    cell.textContent = "No hay trabajos que coincidan con la búsqueda.";
    row.append(cell);
    table.append(row);
    return;
  }

  rows.forEach((order) => {
    const row = document.createElement("tr");

    const appendTextCell = (value, { deliveryReview = false } = {}) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (deliveryReview) {
        const reviewLabel = deliveryDocumentReviewLabel(order);
        if (reviewLabel) {
          const flag = document.createElement("small");
          const status = text(order["Estado conciliación definitivo"]).toLowerCase();
          flag.className = isHistoricalDeliveryClosed(order) || status.includes("mes en curso")
            ? "trace-review current-month"
            : "trace-review";
          flag.textContent = reviewLabel;
          cell.append(flag);
        }
      }
      row.append(cell);
    };

    const appendDocumentCell = (url, label, { draft = false } = {}) => {
      const cell = document.createElement("td");
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label;
        if (draft) {
          link.dataset.documentStatus = "draft";
          link.title = "Borrador: al quitar _borrador del nombre, se reclasifica automáticamente como definitivo (máximo 5 min).";
        }
        cell.append(link);
      } else {
        cell.textContent = "No disponible";
      }
      row.append(cell);
    };

    // Keep the operational action closest to the work ID. This also makes the
    // most useful mobile columns visible before horizontal scrolling.
    appendTextCell(order.Pedido);
    const invoiceUrl = order["Archivo factura / albarán (XLSX)"];
    const draftInvoiceUrl = order["Factura borrador (XLSX)"];
    appendDocumentCell(
      invoiceUrl || draftInvoiceUrl,
      invoiceUrl ? "Abrir" : draftInvoiceUrl ? "Abrir borrador" : "",
      { draft: !invoiceUrl && Boolean(draftInvoiceUrl) }
    );

    appendTextCell(formatOperationalDate(order["Fecha entrega albarán"]), { deliveryReview: true });
    appendTextCell(formatOperationalDate(order["Fecha recepción (email)"]));
    appendTextCell(formatOperationalDate(order["Fecha ficha"]));
    appendTextCell(familyFor(order.Modelo));
    appendTextCell(materialFor(order));
    appendTextCell(sizeFor(order) || "Sin medida completa");

    const finalPrice = recordedFinalPrice(order);
    const estimatedPrice = finalPrice === null ? recordedEstimatedPrice(order) : null;
    const priceCell = document.createElement("td");
    if (finalPrice !== null) {
      priceCell.textContent = formatMoney(finalPrice);
    } else if (estimatedPrice !== null) {
      priceCell.textContent = formatMoney(estimatedPrice);
      const source = document.createElement("small");
      source.className = "cost-source estimated";
      source.textContent = "estimado";
      priceCell.append(source);
    } else {
      priceCell.textContent = "—";
    }
    row.append(priceCell);

    const cost = jobCostFor(order);
    const costCell = document.createElement("td");
    if (cost.value === null) {
      costCell.textContent = "—";
    } else {
      costCell.textContent = formatMoney(cost.value);
      const source = document.createElement("small");
      source.className = cost.actual ? "cost-source actual" : "cost-source estimated";
      source.textContent = cost.actual ? "real" : "estimado";
      costCell.append(source);
    }
    row.append(costCell);

    appendDocumentCell(order["Archivo Corel (CDR)"], "Abrir");
    appendDocumentCell(order.Notas || order["Nota manuscrita"], "Abrir");
    appendDocumentCell(order["Imágenes anejas"], "Abrir");

    table.append(row);
  });
}

function renderRecentOrders() {
  renderTraceTable({ bodySelector: "#recentOrders", countSelector: "#traceCount", searchSelector: "#ordersSearch" });
  renderTraceTable({ bodySelector: "#summaryOrders", countSelector: "#summaryTraceCount", searchSelector: "#summaryOrdersSearch" });
}

function setupFilters() {
  const year = $("#yearFilter"); const model = $("#modelFilter");
  const currentYear = year.value; const currentModel = model.value;
  const years = availableDataYears();
  const models = [...new Set(state.rows.map((row) => familyFor(row.Modelo)).filter(Boolean))].sort();
  year.replaceChildren(new Option("Todo el histórico", "all"), ...years.map((value) => new Option(String(value), String(value))));
  model.replaceChildren(new Option("Todos los modelos", "all"), ...models.map((value) => new Option(value, value)));
  if ([...year.options].some((option) => option.value === currentYear)) year.value = currentYear;
  if ([...model.options].some((option) => option.value === currentModel)) model.value = currentModel;
  setupSummaryYearFilter(years);
  setupFinanceYearFilter(years);
  setupForecastYearFilter(years);
}

function setupSummaryYearFilter(years = []) {
  const select = $("#summaryYear");
  if (!select) return;
  const current = select.value;
  if (!years.length) {
    select.replaceChildren(new Option("Sin pedidos con fecha", ""));
    return;
  }
  select.replaceChildren(...years.map((value) => new Option(String(value), String(value))));
  select.value = years.map(String).includes(current) ? current : String(years[0]);
}

function setupFinanceYearFilter(years = []) {
  const select = $("#financeYear");
  if (!select) return;
  const current = select.value;
  if (!years.length) {
    select.replaceChildren(new Option("Sin pedidos con fecha", ""));
    return;
  }
  select.replaceChildren(...years.map((value) => new Option(String(value), String(value))));
  select.value = years.map(String).includes(current) ? current : String(years[0]);
}

function setupForecastYearFilter(years = []) {
  const select = $("#forecastYear");
  if (!select) return;
  const current = select.value;
  if (!years.length) {
    select.replaceChildren(new Option("Sin pedidos con fecha", ""));
    return;
  }
  select.replaceChildren(...years.map((value) => new Option(String(value), String(value))));
  select.value = years.map(String).includes(current) ? current : String(years[0]);
}

function financeValue(id) {
  const input = $(`#${id}`);
  if (!input) return FINANCE_DEFAULTS[id] || 0;
  return numberAt({ value: input.value }, "value") || 0;
}

function financeRows() {
  const year = $("#financeYear")?.value;
  return state.rows.filter((row) => {
    const date = dashboardDate(row);
    return date && String(date.getFullYear()) === year;
  });
}

const SUPPLY_EXPENSE_FIELDS = Object.freeze({
  "Electricidad": "financeElectricity",
  "Agua y residuos": "financeWaterWaste",
  "Internet": "financeInternet"
});

function expenseRowsForYear(year) {
  return state.expenses.filter((expense) => expense.month.startsWith(`${year}-`));
}

function expenseLedgerForYear(year) {
  const rows = expenseRowsForYear(year);
  const totals = new Map();
  const nature = new Map();
  rows.forEach((expense) => {
    totals.set(expense.category, (totals.get(expense.category) || 0) + expense.amount);
    const kinds = nature.get(expense.category) || new Map();
    kinds.set(expense.nature, (kinds.get(expense.nature) || 0) + 1);
    nature.set(expense.category, kinds);
  });
  return { rows, totals, nature };
}

function importedExpenseLabel(category, ledger) {
  const kinds = ledger.nature.get(category);
  if (!kinds?.size) return "";
  const sourceBacked = (kinds.get("Factura real") || 0) + (kinds.get("Prorrateado de factura real") || 0);
  const estimated = kinds.get("Estimado · media disponible") || 0;
  const parts = [];
  if (sourceBacked) parts.push(`${sourceBacked} meses con factura`);
  if (estimated) parts.push(`${estimated} meses estimados`);
  return parts.join(" · ");
}

function isSupplierExpense(expense) {
  return normalize(expense?.nature).startsWith("factura proveedor");
}

function isSupplierCredit(expense) {
  return normalize(expense?.nature).startsWith("abono proveedor");
}

function isSupplierDirectCostExpense(expense) {
  const nature = normalize(expense?.nature);
  return nature.startsWith("factura proveedor") && nature.includes("coste directo");
}

function isSupplierStockExpense(expense) {
  const nature = normalize(expense?.nature);
  return (nature.startsWith("factura proveedor") || nature.startsWith("abono proveedor")) &&
    nature.includes("stock");
}

function isSupplierPendingExpense(expense) {
  const nature = normalize(expense?.nature);
  return nature.startsWith("factura proveedor") && nature.includes("pendiente");
}

function isSupplierGeneralExpense(expense) {
  const nature = normalize(expense?.nature);
  return nature.startsWith("factura proveedor") && nature.includes("gasto general");
}

function isConsumablesExpense(expense) {
  const category = normalize(expense?.category);
  return category.includes("consumibles") || category.includes("abrasivos") || category.includes("ferreteria");
}

function isOperatingLedgerExpense(expense) {
  if (isSupplierDirectCostExpense(expense)) return false;
  if (isSupplierStockExpense(expense)) return false;
  if (isSupplierPendingExpense(expense)) return false;
  if (isSupplierCredit(expense)) return false;
  if (isSupplierExpense(expense)) return isSupplierGeneralExpense(expense);
  return true;
}

const FINANCE_MANUAL_EXPENSES = Object.freeze([
  ["Electricidad", "financeElectricity", "fixed"],
  ["Agua y residuos", "financeWaterWaste", "fixed"],
  ["Internet", "financeInternet", "fixed"],
  ["Letras", "financeLetters", "direct"],
  ["Transporte y colocación", "financeTransport", "direct"],
  ["Mano de obra / autónomos", "financeLabour", "labour"],
  ["Otros gastos", "financeOtherCosts", "fixed"]
]);

const KNOWN_CONSUMABLES_TOTAL = Object.values(KNOWN_CONSUMABLES)
  .reduce((total, value) => total + value, 0);

function expenseMonthIndex(expense) {
  const month = Number(String(expense?.month || "").slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month - 1 : null;
}

function operatingCostBreakdown(rows, year, months = Array.from({ length: 12 }, (_, month) => month)) {
  const monthSet = new Set(months);
  const annualExpenses = expenseRowsForYear(year);
  const annualOperating = annualExpenses.filter(isOperatingLedgerExpense);
  const periodOperating = annualOperating.filter((expense) => monthSet.has(expenseMonthIndex(expense)));
  const manualLabels = new Set(FINANCE_MANUAL_EXPENSES.map(([label]) => label));

  const manual = FINANCE_MANUAL_EXPENSES.map(([label, field, tone]) => {
    const annualRows = annualOperating.filter((expense) => expense.category === label);
    const imported = annualRows.length > 0;
    const value = imported
      ? periodOperating
          .filter((expense) => expense.category === label)
          .reduce((total, expense) => total + expense.amount, 0)
      : financeValue(field) * (months.length / 12);
    return {
      label,
      value,
      tone,
      imported,
      sourceNote: imported ? importedExpenseLabel(label, expenseLedgerForYear(year)) : ""
    };
  });

  const annualConsumableRows = annualOperating.filter(isConsumablesExpense);
  const periodConsumableRows = periodOperating.filter(isConsumablesExpense);
  const annualConsumablesReal = annualConsumableRows.reduce((total, expense) => total + expense.amount, 0);
  const periodConsumablesReal = periodConsumableRows.reduce((total, expense) => total + expense.amount, 0);
  const annualConsumablesResidual = Math.max(0, KNOWN_CONSUMABLES_TOTAL - annualConsumablesReal);
  const consumablesEstimated = annualConsumablesResidual * (months.length / 12);
  const consumables = periodConsumablesReal + consumablesEstimated;

  const otherOperatingRows = periodOperating.filter(
    (expense) => !manualLabels.has(expense.category) && !isConsumablesExpense(expense)
  );
  const otherOperating = otherOperatingRows.reduce((total, expense) => total + expense.amount, 0);
  const material = estimateMaterial(rows);
  const manualTotal = manual.reduce((total, entry) => total + entry.value, 0);

  return {
    material,
    manual,
    manualTotal,
    consumables,
    consumablesReal: periodConsumablesReal,
    consumablesEstimated,
    otherOperating,
    otherOperatingRows,
    total: material.amount + consumables + manualTotal + otherOperating
  };
}

function estimatedMaterialCostFor(row) {
  const stored = optionalNumberAt(row, "Coste material est. (€)");
  if (stored !== null) return stored;
  const rate = materialRateFor(row);
  if (rate === null) return null;
  const width = numberFromFields(row, ["Ancho total (cm)"], (header) => isSlabMeasureHeader(header, "ancho"));
  const height = writtenHeightFor(row);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return (width * height / 10000) * 1.1 * rate;
}

function actualDirectCostFor(row) {
  return optionalNumberAt(row, "Coste directo real (€)");
}

function jobCostFor(row) {
  const actual = actualDirectCostFor(row);
  return actual !== null ? { value: actual, actual: true } : { value: estimatedMaterialCostFor(row), actual: false };
}

function estimateMaterial(rows) {
  let amount = 0;
  let covered = 0;
  let withMeasure = 0;
  let actualCount = 0;
  let estimatedCount = 0;
  rows.forEach((row) => {
    if (sizeDetailsFor(row)) withMeasure += 1;
    const cost = jobCostFor(row);
    if (cost.value === null) return;
    covered += 1;
    amount += cost.value;
    if (cost.actual) actualCount += 1;
    else estimatedCount += 1;
  });
  return { amount, covered, withMeasure, actualCount, estimatedCount };
}

function calculateFinance(rows, year = null) {
  const averagePrice = financeValue("financeAveragePrice");
  const otherIncome = financeValue("financeOtherIncome");
  const reportYear = Number(year) || dashboardDate(rows[0])?.getFullYear() || Number($("#financeYear")?.value) || new Date().getFullYear();
  const ledger = expenseLedgerForYear(reportYear);
  const operating = operatingCostBreakdown(rows, reportYear);
  const { material, consumables, manual, otherOperating } = operating;

  // The Estadillo's Debe is the value of the delivered work. Cash advances
  // are tracked separately in the private movements ledger and must not be
  // added here a second time. Only still-unpriced orders use the explicit
  // planning price fallback.
  const recordedIncomeRows = rows.filter((row) => recordedRevenue(row) !== null).length;
  const estimatedIncomeRows = rows.length - recordedIncomeRows;
  const revenueOrders = rows.reduce((total, row) => total + revenueFor(row, averagePrice), 0);
  const revenue = revenueOrders + otherIncome;
  const costs = operating.total;
  const margin = revenue - costs;
  const outputs = [
    { label: "Coste directo / material", value: material.amount, tone: "material" },
    { label: "Consumibles", value: consumables, tone: "consumables" },
    ...manual,
    ...(otherOperating > 0 ? [{ label: "Otros gastos reales", value: otherOperating, tone: "fixed" }] : []),
    ...(margin >= 0 ? [{ label: "Margen disponible", value: margin, tone: "margin" }] : [])
  ];
  return {
    averagePrice,
    reportYear,
    otherIncome,
    ledger,
    operating,
    material,
    consumables,
    manual,
    otherOperating,
    revenueOrders,
    recordedIncomeRows,
    estimatedIncomeRows,
    revenue,
    costs,
    margin,
    flowTotal: revenue + Math.max(0, -margin),
    outputs,
    incomes: [
      { label: `${recordedIncomeRows ? "Ingresos de estadillo" : "Ingresos estimados"} · ${rows.length} trabajos`, value: revenueOrders },
      { label: "Otros ingresos facturados", value: otherIncome },
      ...(margin < 0 ? [{ label: "Necesidad de caja", value: Math.abs(margin) }] : [])
    ]
  };
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function sankeyRibbon(sx, sy, tx, ty, thickness) {
  const width = Math.max(3, thickness);
  const middle = (sx + tx) / 2;
  return `M ${sx} ${sy - width / 2} C ${middle} ${sy - width / 2}, ${middle} ${ty - width / 2}, ${tx} ${ty - width / 2} L ${tx} ${ty + width / 2} C ${middle} ${ty + width / 2}, ${middle} ${sy + width / 2}, ${sx} ${sy + width / 2} Z`;
}

function addSankeyNode(svg, { x, y, width, height = 52, label, value, tone, align = "start" }) {
  const group = svgEl("g", { class: `sankey-node ${tone}` });
  const top = y - height / 2;
  group.append(svgEl("rect", { x, y: top, width, height, rx: 8 }));
  const labelEl = svgEl("text", { x: x + (align === "end" ? width - 11 : 11), y: top + 22, "text-anchor": align, class: "sankey-node-label" });
  labelEl.textContent = label;
  const valueEl = svgEl("text", { x: x + (align === "end" ? width - 11 : 11), y: top + 40, "text-anchor": align, class: "sankey-node-value" });
  valueEl.textContent = formatMoney(value);
  group.append(labelEl, valueEl);
  svg.append(group);
}

function sankeyIncomeByModel(rows, finance) {
  const grouped = new Map();
  rows.forEach((row) => {
    const model = familyFor(row.Modelo);
    const current = grouped.get(model) || { count: 0, value: 0 };
    current.count += 1;
    current.value += revenueFor(row, finance.averagePrice);
    grouped.set(model, current);
  });
  const groups = [...grouped.entries()]
    .map(([model, entry]) => ({
      label: `${model} · ${entry.count} ${entry.count === 1 ? "pedido" : "pedidos"}`,
      value: entry.value,
      tone: "income",
      count: entry.count
    }))
    .sort((left, right) => right.value - left.value);
  const modelIncome = groups.slice(0, 6);
  const remaining = groups.slice(6);
  if (remaining.length) {
    const count = remaining.reduce((total, entry) => total + entry.count, 0);
    const value = remaining.reduce((total, entry) => total + entry.value, 0);
    modelIncome.push({ label: `Otros modelos · ${count} ${count === 1 ? "pedido" : "pedidos"}`, value, tone: "income" });
  }
  if (finance.otherIncome > 0) modelIncome.push({ label: "Otros ingresos facturados", value: finance.otherIncome, tone: "income" });
  if (finance.margin < 0) modelIncome.push({ label: "Necesidad de caja", value: Math.abs(finance.margin), tone: "income" });
  return modelIncome.filter((entry) => entry.value > 0);
}

function sankeyPositions(entries, start, end) {
  if (entries.length <= 1) return entries.map((entry) => ({ ...entry, y: (start + end) / 2 }));
  const step = (end - start) / (entries.length - 1);
  return entries.map((entry, index) => ({ ...entry, y: start + index * step }));
}

function renderFinanceSankey(finance, incomeParts) {
  const root = $("#financeSankey");
  root.replaceChildren();
  if (!state.connected) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "El flujo se completará al recibir los pedidos operativos.";
    root.append(empty);
    return;
  }
  const outputs = finance.outputs.filter((entry) => entry.value > 0);
  const parts = incomeParts.filter((entry) => entry.value > 0);
  const rows = Math.max(outputs.length, parts.length, 4);
  const height = Math.max(490, rows * 76 + 132);
  const svg = svgEl("svg", { viewBox: `0 0 1060 ${height}`, xmlns: SVG_NS, "aria-hidden": "true" });
  const labels = [[36, "INGRESOS POR MODELO"], [425, "INGRESOS OPERATIVOS"], [766, "DESTINO"]];
  labels.forEach(([x, content]) => { const node = svgEl("text", { x, y: 34, class: "sankey-column-title" }); node.textContent = content; svg.append(node); });
  const centerY = Math.round(height / 2);
  // The real values remain exact in each card. Limiting the maximum ribbon to
  // 34 px keeps the margin and small operating costs legible together.
  const scale = 34 / Math.max(finance.flowTotal, 1);
  const ribbonThickness = (value) => Math.max(3.5, Math.min(34, value * scale));
  const ports = sankeyPositions(outputs, 112, height - 62).map((entry) => ({ ...entry, thickness: ribbonThickness(entry.value) }));
  const incomePorts = sankeyPositions(parts, 112, height - 62).map((entry) => ({ ...entry, thickness: ribbonThickness(entry.value) }));
  incomePorts.forEach((entry) => {
    const inletY = centerY + (entry.y - centerY) * 0.12;
    const link = svgEl("path", { d: sankeyRibbon(276, entry.y, 425, inletY, entry.thickness), class: "sankey-link income-link" });
    const tooltip = document.createElementNS(SVG_NS, "title");
    tooltip.textContent = `${entry.label}: ${formatMoney(entry.value)}`;
    link.append(tooltip);
    svg.append(link);
  });
  ports.forEach((entry) => {
    const outletY = centerY + (entry.y - centerY) * 0.12;
    const link = svgEl("path", { d: sankeyRibbon(635, outletY, 766, entry.y, entry.thickness), class: `sankey-link ${entry.tone}-link` });
    const tooltip = document.createElementNS(SVG_NS, "title");
    tooltip.textContent = `${entry.label}: ${formatMoney(entry.value)}`;
    link.append(tooltip);
    svg.append(link);
  });
  incomePorts.forEach((entry) => addSankeyNode(svg, { x: 36, y: entry.y, width: 240, label: entry.label, value: entry.value, tone: "income" }));
  addSankeyNode(svg, { x: 425, y: centerY, width: 210, height: 76, label: "Ingresos operativos", value: finance.flowTotal, tone: "center" });
  ports.forEach((entry) => addSankeyNode(svg, { x: 766, y: entry.y, width: 258, label: entry.label, value: entry.value, tone: entry.tone }));
  root.append(svg);
}

function syncImportedSupplyInputs(finance) {
  Object.entries(SUPPLY_EXPENSE_FIELDS).forEach(([category, field]) => {
    const input = $(`#${field}`);
    const entry = finance.manual.find((manual) => manual.label === category);
    if (!input || !entry) return;
    if (entry.imported) {
      input.value = entry.value.toFixed(2);
      input.readOnly = true;
      input.dataset.imported = "true";
      input.title = entry.sourceNote || "Importado del libro maestro";
    } else {
      input.readOnly = false;
      delete input.dataset.imported;
      input.removeAttribute("title");
    }
  });
}

function ledgerDescription(finance) {
  if (!finance.ledger.rows.length) return "Sin gastos importados todavía: los campos de suministro siguen siendo una referencia local.";
  const factured = finance.ledger.rows.filter((row) => row.nature !== "Estimado · media disponible").length;
  const estimated = finance.ledger.rows.length - factured;
  const supplierRows = expenseRowsForYear(finance.reportYear);
  const stockNet = supplierRows
    .filter(isSupplierStockExpense)
    .reduce((total, expense) => total + expense.amount, 0);
  const pending = supplierRows
    .filter(isSupplierPendingExpense)
    .reduce((total, expense) => total + expense.amount, 0);
  return `Libro maestro: ${factured} registros respaldados por factura/prorrateo y ${estimated} estimados. Los gastos generales reales entran en el resultado; coste directo sustituye estimación. Stock neto ${formatMoney(stockNet)} y pendientes ${formatMoney(pending)} se muestran aparte y no alteran el beneficio hasta consumo/vinculación validada.`;
}

function supplierExpensesForYear(year) {
  return expenseRowsForYear(year)
    .filter((expense) => isSupplierExpense(expense) || isSupplierCredit(expense))
    .sort((left, right) => String(right.invoiceDate || right.month).localeCompare(String(left.invoiceDate || left.month)));
}

function supplierExpenseStatus(expense) {
  const nature = normalize(expense.nature);
  if (isSupplierCredit(expense)) return "Abono de stock";
  if (nature.includes("pendiente")) return "Pendiente de vincular";
  if (nature.includes("stock")) return "Compra de stock";
  if (nature.includes("gasto general")) return "Gasto general";
  if (nature.includes("coste directo")) return "Vinculado a trabajo";
  return "Registrado";
}

function renderSupplierExpenses(year) {
  const body = $("#supplierExpensesBody");
  const total = $("#supplierExpensesTotal");
  if (!body) return;
  body.replaceChildren();
  const rows = supplierExpensesForYear(year);
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.className = "empty-state";
    td.textContent = "No hay facturas o abonos de proveedores registrados para este año.";
    tr.append(td);
    body.append(tr);
    if (total) total.textContent = "0 € registrados";
    return;
  }
  rows.forEach((expense) => {
    const tr = document.createElement("tr");
    const status = supplierExpenseStatus(expense);
    const plainValues = [
      formatOperationalDate(expense.invoiceDate || `${expense.month}-01`),
      expense.source || "Proveedor",
      expense.category.replace(/^(Compra|Abono) proveedor ·\s*/i, ""),
      expense.reference || "—",
      status,
      formatMoney(expense.amount)
    ];
    plainValues.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === 4) {
        const normalizedStatus = normalize(status);
        td.className = normalizedStatus.includes("pendiente") ? "supplier-status pending" : "supplier-status active";
      }
      tr.append(td);
    });
    [
      { url: expense.folderUrl, label: "Abrir carpeta" },
      { url: expense.documentUrl, label: "Abrir documento" }
    ].forEach(({ url, label }) => {
      const td = document.createElement("td");
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label;
        td.append(link);
      } else {
        td.textContent = "—";
      }
      tr.append(td);
    });
    const evidence = document.createElement("td");
    evidence.textContent = expense.emailEvidence || "—";
    tr.append(evidence);
    body.append(tr);
  });
  if (total) {
    const amount = rows.reduce((sum, expense) => sum + expense.amount, 0);
    const invoices = rows.filter(isSupplierExpense).length;
    const credits = rows.filter(isSupplierCredit).length;
    total.textContent = `${formatMoney(amount)} netos · ${invoices} ${invoices === 1 ? "factura" : "facturas"}${credits ? ` · ${credits} ${credits === 1 ? "abono" : "abonos"}` : ""}`;
  }
}

function renderFinance() {
  const rows = financeRows();
  const year = Number($("#financeYear")?.value) || new Date().getFullYear();
  const finance = calculateFinance(rows, year);
  const granularity = selectedFinanceGranularity();
  const { material, consumables, revenue, costs, margin } = finance;
  $("#financeOrders").textContent = state.connected ? formatInt.format(rows.length) : "—";
  $("#financePeriod").textContent = state.connected ? `Año ${$("#financeYear").value || "sin fecha"}` : "Datos operativos pendientes";
  $("#financeRevenue").textContent = state.connected ? formatMoney(revenue) : "—";
  $("#financeCosts").textContent = state.connected ? formatMoney(costs) : "—";
  $("#financeMargin").textContent = state.connected ? formatMoney(margin) : "—";
  $("#financeConsumables").textContent = formatMoney(consumables);
  $("#materialEstimateNote").textContent = state.connected
    ? `${formatMoney(material.amount)} de coste directo/material sobre ${material.covered} trabajos cubiertos: ${material.actualCount} con coste real y ${material.estimatedCount} estimados. El coste real sustituye siempre a la estimación; las estimaciones conservan 10 % de merma.`
    : "La estimación de materia prima se calculará al recibir los pedidos del año.";
  $("#financeFlowStatus").textContent = state.connected
    ? `${rows.length} trabajos · ${finance.recordedIncomeRows} importes de estadillo · ${finance.ledger.rows.length ? "gastos maestro" : "gastos pendientes"} · año ${$("#financeYear").value}`
    : "Actualizando pedidos";
  renderEstadilloLedger(year);
  renderSupplierExpenses(year);
  drawFinancialSummaryChart(performanceSeries(year, granularity));
  $("#financeChartScope").textContent = `Resultado ${granularity === "quarter" ? "por trimestre" : "por mes"}: usa la misma lógica que el KPI anual. El coste directo real sustituye la estimación; los gastos generales reales entran en resultado; stock, abonos de stock y pendientes de vincular se muestran aparte hasta que exista consumo o asignación validada.`;
  renderFinanceSankey(finance, sankeyIncomeByModel(rows, finance));
  syncImportedSupplyInputs(finance);
  const ledgerNote = $("#financeLedgerNote");
  if (ledgerNote) ledgerNote.textContent = ledgerDescription(finance);
  const values = Object.fromEntries(Object.keys(FINANCE_DEFAULTS).map((id) => [id, financeValue(id)]));
  localStorage.setItem(FINANCE_KEY, JSON.stringify(values));
}

function loadFinanceSettings() {
  renderFinance();
}

function renderFinancialViews() {
  renderFinance();
  if (state.activeView === "summary") renderSummary();
  if (state.activeView === "strategy") renderRevenueForecast();
}

function resetFinance() {
  localStorage.removeItem(FINANCE_KEY);
  renderFinancialViews();
}

function updateBenefit() {
  const values = {
    orders: numberAt({ value: $("#assumptionOrders").value }, "value") || 0,
    price: numberAt({ value: $("#assumptionPrice").value }, "value") || 0,
    procurement: numberAt({ value: $("#assumptionProcurement").value }, "value") || 0,
    extraJobs: numberAt({ value: $("#assumptionExtraJobs").value }, "value") || 0,
    contribution: numberAt({ value: $("#assumptionContribution").value }, "value") || 0,
    rework: numberAt({ value: $("#assumptionRework").value }, "value") || 0,
    cncCapacity: numberAt({ value: $("#assumptionCncCapacity").value }, "value") || 0,
    cncInvestment: numberAt({ value: $("#assumptionCncInvestment").value }, "value") || 0,
    cncPayback: numberAt({ value: $("#assumptionCncPayback").value }, "value") || 0
  };
  const components = { price: values.orders * values.price, procurement: values.procurement, capacity: values.extraJobs * values.contribution, rework: values.rework };
  const annual = Object.values(components).reduce((total, value) => total + value, 0);
  $("#annualBenefit").textContent = formatMoney(annual);
  $("#tenYearBenefit").textContent = formatMoney(annual * 10);
  const max = Math.max(...Object.values(components), 1);
  [["Price", components.price], ["Procurement", components.procurement], ["Capacity", components.capacity], ["Rework", components.rework]].forEach(([name, value]) => {
    $(`#benefit${name}`).textContent = formatMoney(value);
    $(`#benefit${name}Bar`).style.width = `${Math.max(value ? 7 : 0, (value / max) * 100)}%`;
  });
  const capacityForCnc = Math.max(0, values.cncCapacity - values.orders) * values.contribution;
  const target = values.cncInvestment > 0 && values.cncPayback > 0 ? values.cncInvestment / values.cncPayback : null;
  const gap = target === null ? null : target - capacityForCnc;
  $("#cncContribution").textContent = formatMoney(values.contribution);
  $("#cncBenefit").textContent = formatMoney(capacityForCnc);
  $("#cncTarget").textContent = target === null ? "A definir" : formatMoney(target);
  $("#cncVerdict").textContent = gap === null ? "Introduce inversión y plazo" : gap > 0 ? `Faltan ${formatMoney(gap)}` : `Supera el objetivo por ${formatMoney(Math.abs(gap))}`;
  localStorage.setItem(ASSUMPTIONS_KEY, JSON.stringify(values));
}

function loadAssumptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(ASSUMPTIONS_KEY) || "{}");
    const lookup = { orders: "assumptionOrders", price: "assumptionPrice", procurement: "assumptionProcurement", extraJobs: "assumptionExtraJobs", contribution: "assumptionContribution", rework: "assumptionRework", cncCapacity: "assumptionCncCapacity", cncInvestment: "assumptionCncInvestment", cncPayback: "assumptionCncPayback" };
    Object.entries(lookup).forEach(([key, id]) => { if (Number.isFinite(saved[key])) $(`#${id}`).value = saved[key]; });
  } catch { /* defaults remain visible */ }
  updateBenefit();
}

function resetAssumptions() {
  const defaults = { assumptionOrders: 0, assumptionPrice: 0, assumptionProcurement: 0, assumptionExtraJobs: 0, assumptionContribution: 0, assumptionRework: 0, assumptionCncCapacity: 0, assumptionCncInvestment: 0, assumptionCncPayback: 0 };
  Object.entries(defaults).forEach(([id, value]) => { $(`#${id}`).value = value; });
  localStorage.removeItem(ASSUMPTIONS_KEY); updateBenefit(); showToast("Supuestos restablecidos.");
}

function updateConnectionUI() {
  const status = $("#connectionStatus");
  const dataStatus = $("#dataStatus");
  status.classList.toggle("connected", state.connected);
  status.querySelector("b").textContent = state.connected ? "Datos operativos actualizados" : "Cargando datos";
  status.querySelector("small").textContent = state.connected
    ? "Consulta sin inicio de sesión. Actualización automática cada cinco minutos."
    : "El panel consultará los datos en unos segundos.";
  dataStatus.textContent = state.connected
    ? "Datos operativos reales actualizados desde el libro maestro. El panel se sincroniza cada cinco minutos, sin inicio de sesión para consultar."
    : "Cargando el panel con datos operativos reales…";
}

function feedConfigured() {
  return DATA_FEED_URL && !DATA_FEED_URL.startsWith("__");
}

function refreshPublicFeed() {
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
  const callbackName = `__litosPublicFeed${Date.now()}${Math.random().toString(36).slice(2)}`;
  const script = document.createElement("script");
  let settled = false;
  let timer;
  const cleanUp = () => {
    window.clearTimeout(timer);
    script.remove();
    delete window[callbackName];
    state.loading = false;
    $("#refreshData").textContent = "Actualizar datos";
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    cleanUp();
    const hasPreviousData = state.rows.length > 0;
    // A temporary Apps Script delay must not replace a working dashboard with
    // an empty “updating” table. Keep the last valid data visible instead.
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
  };
  window[callbackName] = (payload) => {
    if (settled) return;
    settled = true;
    try {
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
        ? "La actualización no fue válida; se muestran los últimos datos cargados."
        : "El servicio devolvió datos no válidos.");
    } finally {
      cleanUp();
    }
  };
  // Apps Script follows a redirect before it serves the JSONP payload. Some
  // browsers can emit an error during that hand-off and still execute the
  // callback afterwards, so the timer is the single failure authority. This
  // prevents us from deleting the callback just before a valid payload lands.
  script.onerror = () => {};
  timer = window.setTimeout(fail, FEED_TIMEOUT_MS);
  const separator = DATA_FEED_URL.includes("?") ? "&" : "?";
  script.src = `${DATA_FEED_URL}${separator}callback=${encodeURIComponent(callbackName)}&v=${Date.now()}`;
  document.head.append(script);
}

function switchView(view) {
  state.activeView = view;
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === view));
  $$("[data-view-target]").forEach((button) => button.classList.toggle("active", button.dataset.viewTarget === view));
  $("#viewTitle").textContent = ({ summary: "Resumen", production: "Producción", finance: "Ingresos y gastos", strategy: "Estrategia", data: "Datos y conexión" })[view];
  $(".sidebar").classList.remove("open");
  if (view === "summary") requestAnimationFrame(renderSummary);
  if (view === "production") requestAnimationFrame(renderProduction);
  if (view === "finance") requestAnimationFrame(renderFinance);
  if (view === "strategy") requestAnimationFrame(renderRevenueForecast);
}

function init() {
  updateConnectionUI(); setupFilters(); renderSummary(); renderProduction(); loadAssumptions(); loadFinanceSettings();
  renderRecentOrders();
  $$("[data-view-target]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewTarget)));
  $("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#refreshData").addEventListener("click", refreshPublicFeed);
  $("#yearFilter").addEventListener("change", renderProduction); $("#modelFilter").addEventListener("change", renderProduction);
  $("#summaryYear").addEventListener("change", renderSummary);
  $("#summaryGranularity").addEventListener("change", renderSummary);
  $("#summaryMetric").addEventListener("change", renderSummary);
  $("#forecastYear").addEventListener("change", renderRevenueForecast);
  $("#ordersSearch").addEventListener("input", renderRecentOrders);
  $("#summaryOrdersSearch").addEventListener("input", renderRecentOrders);
  ["#assumptionOrders", "#assumptionPrice", "#assumptionProcurement", "#assumptionExtraJobs", "#assumptionContribution", "#assumptionRework", "#assumptionCncCapacity", "#assumptionCncInvestment", "#assumptionCncPayback"].forEach((selector) => $(selector).addEventListener("input", updateBenefit));
  $("#financeYear").addEventListener("change", renderFinancialViews);
  $("#financeGranularity").addEventListener("change", renderFinance);
  $("#resetAssumptions").addEventListener("click", resetAssumptions);
  window.setInterval(refreshPublicFeed, AUTO_REFRESH_MS);
  window.addEventListener("resize", () => {
    if (state.activeView === "summary") renderSummary();
    if (state.activeView === "finance") renderFinance();
    if (state.activeView === "strategy") renderRevenueForecast();
  });
  refreshPublicFeed();
}

init();
