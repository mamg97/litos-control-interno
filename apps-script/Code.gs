/**
 * LITOS Control Interno — public operational feed
 *
 * Bind this project to the native Google Sheet that is the private master
 * book. Deploy it as a Web App executed as the owner. The page is allowed to
 * consult it anonymously only because publicPayload_ returns this small,
 * explicitly approved operational schema — never the Sheet or its rows.
 */

const FIELDS = Object.freeze({
  id: "Pedido",
  // The master book deliberately stores the original order date and the
  // delivered-work date separately. The dashboard must group the historical
  // work by the latter, while unfinished email orders keep their fiche date.
  date: "Fecha para dashboard",
  orderDate: "Fecha ficha",
  receiptDate: "Fecha recepción (email)",
  deliveredDate: "Fecha entrega (estadillo)",
  amount: "Importe trabajo / Debe (€)",
  pvp: "P.V.P. (€)",
  materialCost: "Coste material est. (€)",
  status: "Estado pedido",
  model: "Modelo",
  material: "Material",
  materialNormalized: "Material normalizado",
  width: "Ancho total (cm)",
  height: "Alto total (cm)",
  thickness: "Grosor (cm)",
  baseWidth: "Ancho base (cm)",
  baseHeight: "Alto base/croquis (cm)",
  topWidth: "Ancho superior/remate (cm)",
  stepMeasures: "Cotas/escalones (cm)",
  voleo: "Voleo (cm)"
});

const EXPENSE_FIELDS = Object.freeze({
  month: "Mes",
  category: "Categoría",
  amount: "Importe (€)",
  nature: "Naturaleza del dato"
});

const DOCUMENT_FIELDS = Object.freeze({
  invoice: "Archivo factura / albarán (XLSX)",
  invoiceDraft: "Factura borrador (XLSX)",
  corel: "Archivo Corel (CDR)",
  note: "Notas",
  attachments: "Imágenes anejas"
});

// Shared historical archive supplied for the reconciliation. Files remain
// private in Drive; the generated URLs never alter their sharing settings.
const HISTORIC_DOCUMENTS_FOLDER_ID = "1RjvspVx85xu8BbisLjwDMToS148rfJ7-";
const CURRENT_DOCUMENTS_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_";

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
  // The reconciled history is larger than Apps Script's safe cache-item
  // limit. Serving this deliberately small, whitelisted feed directly keeps
  // the dashboard live and avoids stale or failed cache reads.
  return JSON.stringify({
    version: 6,
    generatedAt: new Date().toISOString(),
    records: readOperationalRows_(),
    // The private ledger has invoice references and other audit columns. The
    // public feed deliberately exposes just month, category, amount and
    // whether it is real, prorrated or estimated — never a document or a
    // supplier account.
    expenses: readExpenseRows_()
  });
}

function readOperationalRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Pedidos");
  if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

  const values = sheet.getDataRange().getDisplayValues();
  const richValues = sheet.getDataRange().getRichTextValues();
  const currentDocuments = currentDocumentIndex_();
  const headerIndex = values.findIndex((row) => row.some((cell) => clean_(cell) === FIELDS.id));
  if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

  const headers = values[headerIndex].map(clean_);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const read = (row, field) => {
    const index = columns[field];
    return index === undefined ? "" : clean_(row[index]);
  };
  const readLink = (rowIndex, field) => {
    const index = columns[field];
    if (index === undefined) return "";
    const value = richValues[rowIndex + headerIndex + 1] && richValues[rowIndex + headerIndex + 1][index];
    return value && value.getLinkUrl ? value.getLinkUrl() || "" : "";
  };

  return values.slice(headerIndex + 1).map((row, rowIndex) => {
    const id = read(row, FIELDS.id);
    if (!id) return null;
    const orderDate = read(row, FIELDS.orderDate);
    const receiptDate = read(row, FIELDS.receiptDate);
    const deliveredDate = read(row, FIELDS.deliveredDate);
    const dashboardDate = read(row, FIELDS.date) || deliveredDate || receiptDate || orderDate;
    const rawMaterial = read(row, FIELDS.material);
    const liveDocuments = currentDocuments.get(id);
    const liveDocument = (type, field) => liveDocuments ? clean_(liveDocuments[type]) : readLink(rowIndex, field);
    return {
      id,
      // Only this approved operational subset is public. In particular, the
      // email fiche text, customer names, file paths and source notes never
      // leave the private spreadsheet.
      date: normalizeDate_(dashboardDate),
      orderDate: normalizeDate_(orderDate),
      receiptDate: normalizeDate_(receiptDate),
      deliveredDate: normalizeDate_(deliveredDate),
      amount: numberOrNull_(read(row, FIELDS.amount)),
      pvp: numberOrNull_(read(row, FIELDS.pvp)),
      materialCost: numberOrNull_(read(row, FIELDS.materialCost)),
      status: read(row, FIELDS.status),
      model: read(row, FIELDS.model),
      material: rawMaterial,
      materialNormalized: read(row, FIELDS.materialNormalized) || rawMaterial,
      width: numberOrNull_(read(row, FIELDS.width)),
      height: numberOrNull_(read(row, FIELDS.height)),
      thickness: numberOrNull_(read(row, FIELDS.thickness)),
      baseWidth: numberOrNull_(read(row, FIELDS.baseWidth)),
      baseHeight: numberOrNull_(read(row, FIELDS.baseHeight)),
      topWidth: numberOrNull_(read(row, FIELDS.topWidth)),
      stepMeasures: read(row, FIELDS.stepMeasures),
      voleo: numberOrNull_(read(row, FIELDS.voleo)),
      invoiceFile: liveDocument("invoice", DOCUMENT_FIELDS.invoice),
      invoiceDraftFile: liveDocument("invoiceDraft", DOCUMENT_FIELDS.invoiceDraft),
      corelFile: readLink(rowIndex, DOCUMENT_FIELDS.corel),
      noteFile: readLink(rowIndex, DOCUMENT_FIELDS.note),
      attachmentFile: readLink(rowIndex, DOCUMENT_FIELDS.attachments)
    };
  }).filter(Boolean);
}

/**
 * One-off/private maintenance command. Run it from the bound Apps Script
 * editor when historical documents are added to Drive. It creates the four
 * traceability columns when absent and writes only Drive links or the exact
 * fallback text “No disponible”.
 */
function populateDocumentLinks_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName("Pedidos");
  if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");
  const values = sheet.getDataRange().getDisplayValues();
  const headerIndex = values.findIndex((row) => row.some((cell) => clean_(cell) === FIELDS.id));
  if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

  let headers = values[headerIndex].map(clean_);
  const missing = Object.values(DOCUMENT_FIELDS).filter((field) => !headers.includes(field));
  if (missing.length) {
    const last = sheet.getLastColumn();
    sheet.insertColumnsAfter(last, missing.length);
    sheet.getRange(headerIndex + 1, last + 1, 1, missing.length).setValues([missing]);
    headers = [...headers, ...missing];
  }
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const documents = indexHistoricalDocuments_();
  const body = sheet.getRange(headerIndex + 2, 1, Math.max(0, sheet.getLastRow() - headerIndex - 1), sheet.getLastColumn()).getDisplayValues();
  const makeLink = (url) => {
    const builder = SpreadsheetApp.newRichTextValue().setText(url ? "Abrir" : "No disponible");
    if (url) builder.setLinkUrl(url);
    return builder.build();
  };
  const results = body.map((row) => {
    const id = clean_(row[columns[FIELDS.id]]);
    const links = documents.get(id) || {};
    return [makeLink(links.invoice), makeLink(links.invoiceDraft), makeLink(links.corel), makeLink(links.note), makeLink(links.attachments)];
  });
  const targetColumns = [
    DOCUMENT_FIELDS.invoice,
    DOCUMENT_FIELDS.invoiceDraft,
    DOCUMENT_FIELDS.corel,
    DOCUMENT_FIELDS.note,
    DOCUMENT_FIELDS.attachments
  ].map((field) => columns[field] + 1);
  targetColumns.forEach((column, index) => {
    sheet.getRange(headerIndex + 2, column, results.length, 1).setRichTextValues(results.map((row) => [row[index]]));
  });
  return { rows: results.length, linked: countLinkedDocuments_(documents), folder: HISTORIC_DOCUMENTS_FOLDER_ID };
}

/**
 * Entrada manual visible en Apps Script para actualizar los enlaces privados.
 * El feed público únicamente lee las columnas ya preparadas por esta función.
 */
function populateDocumentLinks() {
  return populateDocumentLinks_();
}

function currentDocumentIndex_() {
  const cache = CacheService.getScriptCache();
  const key = "litos-current-documents-v1";
  const cached = cache.get(key);
  if (cached) {
    try { return new Map(Object.entries(JSON.parse(cached))); } catch (error) { /* rebuild below */ }
  }
  const documents = indexCurrentDocuments_();
  try { cache.put(key, JSON.stringify(Object.fromEntries(documents)), 300); } catch (error) { /* cache is optional */ }
  return documents;
}

function indexCurrentDocuments_() {
  const folder = DriveApp.getFolderById(CURRENT_DOCUMENTS_FOLDER_ID);
  const files = [];
  collectFiles_(folder, files, {});
  const documents = new Map();
  files.forEach((file) => {
    const match = clean_(file.getName()).match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
    if (!match) return;
    const id = match[1];
    const type = classifyDocument_(file.getName(), id);
    if (!type) return;
    const entry = documents.get(id) || {};
    if (!entry[type]) entry[type] = file.getUrl();
    documents.set(id, entry);
  });
  return documents;
}

function indexHistoricalDocuments_() {
  const folder = DriveApp.getFolderById(HISTORIC_DOCUMENTS_FOLDER_ID);
  const files = [];
  collectFiles_(folder, files, {});
  const documents = new Map();
  files.forEach((file) => {
    const match = clean_(file.getName()).match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
    if (!match) return;
    const id = match[1];
    const type = classifyDocument_(file.getName(), id);
    if (!type) return;
    const entry = documents.get(id) || {};
    // The source hierarchy can contain copies. Keep the first matching Drive
    // file rather than overwriting a valid link nondeterministically.
    if (!entry[type]) entry[type] = file.getUrl();
    documents.set(id, entry);
  });
  return documents;
}

function collectFiles_(folder, files, visited) {
  const id = folder.getId();
  if (visited[id]) return;
  visited[id] = true;
  const fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) files.push(fileIterator.next());
  const folderIterator = folder.getFolders();
  while (folderIterator.hasNext()) collectFiles_(folderIterator.next(), files, visited);
}

function classifyDocument_(name, id) {
  const lower = clean_(name).toLowerCase();
  const normalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const extension = normalized.match(/\.([a-z0-9]+)$/);
  const ext = extension ? extension[1] : "";
  if (["xlsx", "xls"].includes(ext)) {
    if (/(?:^|[-_ ])borrador(?:[-_ .]|$)/.test(normalized)) return "invoiceDraft";
    return "invoice";
  }
  if (ext === "cdr") return "corel";
  if (!["jpg", "jpeg", "png", "pdf"].includes(ext)) return "";

  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = `^${escapedId}(?:\\s*[-_ ]\\s*|\\s+)`;
  if (new RegExp(`${prefix}notas?(?:[-_. ]|$)`).test(normalized)) return "note";
  if (new RegExp(`${prefix}imagenes?\\s+anejas?(?:[-_. ]|$)`).test(normalized)) return "attachments";

  // Backwards compatibility with the first batch of downloaded mail images,
  // whose handwritten specification was named ID-0....
  if (new RegExp(`^${escapedId}[-_ ]0(?:[-_. ]|$)`).test(normalized)) return "note";
  return "";
}

function countLinkedDocuments_(documents) {
  let count = 0;
  documents.forEach((entry) => { count += Object.keys(entry).length; });
  return count;
}

function readExpenseRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Gastos");
  if (!sheet) return [];

  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];
  const headers = values[0].map(clean_);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const read = (row, field) => {
    const index = columns[field];
    return index === undefined ? "" : clean_(row[index]);
  };

  return values.slice(1).map((row) => {
    const month = normalizeMonth_(read(row, EXPENSE_FIELDS.month));
    const category = read(row, EXPENSE_FIELDS.category);
    const amount = numberOrNull_(read(row, EXPENSE_FIELDS.amount));
    if (!month || !category || amount === null) return null;
    return {
      month,
      category,
      amount,
      nature: read(row, EXPENSE_FIELDS.nature) || "Sin clasificar"
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

function normalizeMonth_(value) {
  const raw = clean_(value);
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})/);
  if (!iso) return "";
  const month = Number(iso[2]);
  if (month < 1 || month > 12) return "";
  return `${iso[1]}-${String(month).padStart(2, "0")}`;
}
