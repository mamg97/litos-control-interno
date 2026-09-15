/**
 * LITOS — catálogo prioritario de albaranes recientes (2023-2026).
 *
 * Objetivo: procesar primero los años más útiles para generar borradores actuales,
 * en orden 2026 -> 2025 -> 2024 -> 2023, sin tocar el barrido histórico anterior.
 *
 * Depende de las funciones compartidas definidas en AlbaranCatalog.gs.
 */

const CATALOGO_RECIENTE_VISIBLE_SHEET = "Catálogo albaranes 2023-2026";
const CATALOGO_RECIENTE_RAW_SHEET = "Catálogo albaranes 2023-2026 · bruto";
const CATALOGO_RECIENTE_PROGRESS = "litos_catalogo_reciente_next_file";
const CATALOGO_RECIENTE_RUNNING = "litos_catalogo_reciente_running";
const CATALOGO_RECIENTE_CONTINUATION = "continuarCatalogoAlbaranesReciente";
const CATALOGO_RECIENTE_MAX_MS = 4.4 * 60 * 1000;
const CATALOGO_RECIENTE_MAX_FILES_PER_RUN = 24;
const CATALOGO_RECIENTE_YEARS = Object.freeze([2026, 2025, 2024, 2023]);

const CATALOGO_RECIENTE_DATE_HEADERS = Object.freeze([
  "Fecha para dashboard",
  "Fecha entrega (estadillo)",
  "Fecha recepción (email)",
  "Fecha ficha"
]);

function iniciarCatalogoAlbaranesReciente() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otro proceso en curso" };

  try {
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const raw = catalogRecentEnsureRawSheet_(book);
    const visible = catalogRecentEnsureVisibleSheet_(book);

    raw.clearContents();
    catalogWriteRawHeader_(raw);
    raw.hideSheet();

    // Mantenemos la hoja visible existente hasta que termine el barrido.
    // catalogBuildVisible_ conservará cualquier precio/validación manual previo.
    if (visible.getLastRow() === 0) catalogWriteVisibleHeader_(visible);

    const props = PropertiesService.getScriptProperties();
    props.setProperty(CATALOGO_RECIENTE_PROGRESS, "0");
    props.setProperty(CATALOGO_RECIENTE_RUNNING, "1");
    catalogRecentRemoveContinuationTriggers_();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return continuarCatalogoAlbaranesReciente();
}

function continuarCatalogoAlbaranesReciente() {
  const startedAt = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otro proceso en curso" };

  try {
    const props = PropertiesService.getScriptProperties();
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const pedidos = book.getSheetByName("Pedidos");
    if (!pedidos) throw new Error("No se encontró la pestaña Pedidos.");

    const visible = catalogRecentEnsureVisibleSheet_(book);
    const raw = catalogRecentEnsureRawSheet_(book);
    if (raw.getLastRow() === 0) catalogWriteRawHeader_(raw);

    const source = catalogRecentMasterSource_(pedidos);
    const files = source.files;
    const contexts = source.contexts;

    let offset = Math.max(0, Number(props.getProperty(CATALOGO_RECIENTE_PROGRESS) || 0));
    let filesProcessed = 0;
    let itemsExtracted = 0;
    const errors = [];
    const pendingRows = [];

    while (
      offset < files.length &&
      filesProcessed < CATALOGO_RECIENTE_MAX_FILES_PER_RUN &&
      Date.now() - startedAt < CATALOGO_RECIENTE_MAX_MS
    ) {
      const entry = files[offset];
      offset += 1;

      try {
        const occurrences = catalogExtractInvoice_(entry.fileId, entry.url, entry.fallbackId, contexts);
        pendingRows.push(...occurrences);
        itemsExtracted += occurrences.length;
      } catch (error) {
        errors.push({
          year: entry.year,
          fallbackId: entry.fallbackId,
          fileId: entry.fileId,
          error: String(error && error.message || error)
        });
      }

      filesProcessed += 1;
    }

    if (pendingRows.length) catalogRecentAppendRawRows_(raw, pendingRows);
    props.setProperty(CATALOGO_RECIENTE_PROGRESS, String(offset));
    SpreadsheetApp.flush();

    const finished = offset >= files.length;
    if (finished) {
      catalogBuildVisible_(visible, raw);
      props.deleteProperty(CATALOGO_RECIENTE_PROGRESS);
      props.deleteProperty(CATALOGO_RECIENTE_RUNNING);
      catalogRecentRemoveContinuationTriggers_();
    } else {
      catalogRecentScheduleContinuation_();
    }

    const current = offset > 0 && files.length ? files[Math.min(offset - 1, files.length - 1)] : null;
    const result = {
      finished,
      filesScanned: offset,
      totalUniqueFiles: files.length,
      filesProcessed,
      itemsExtracted,
      rawOccurrences: Math.max(0, raw.getLastRow() - 1),
      currentYear: current ? current.year : null,
      continuationScheduled: !finished,
      errors
    };

    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function estadoCatalogoAlbaranesReciente() {
  const props = PropertiesService.getScriptProperties();
  const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
  const pedidos = book.getSheetByName("Pedidos");
  const raw = book.getSheetByName(CATALOGO_RECIENTE_RAW_SHEET);
  const source = pedidos ? catalogRecentMasterSource_(pedidos) : { files: [] };
  const offset = Number(props.getProperty(CATALOGO_RECIENTE_PROGRESS) || 0);
  const total = source.files.length;
  const next = offset < total ? source.files[offset] : null;

  const result = {
    running: props.getProperty(CATALOGO_RECIENTE_RUNNING) === "1",
    filesScanned: offset,
    totalUniqueFiles: total,
    progressPct: total ? Math.round(offset * 1000 / total) / 10 : 0,
    nextYear: next ? next.year : null,
    nextOrder: next ? next.fallbackId : null,
    rawOccurrences: raw ? Math.max(0, raw.getLastRow() - 1) : 0
  };

  console.log(JSON.stringify(result));
  return result;
}

/**
 * Construye el origen reciente manteniendo contexto para todos los pedidos,
 * pero seleccionando solo archivos cuyo pedido de referencia pertenezca a 2023-2026.
 * Los archivos se ordenan por año y fecha descendentes: 2026 -> 2025 -> 2024 -> 2023.
 */
function catalogRecentMasterSource_(pedidos) {
  const range = pedidos.getDataRange();
  const shown = range.getDisplayValues();
  const headerIndex = shown.findIndex(row => row.some(cell => catalogClean_(cell) === CATALOGO_ALBARAN_HEADERS.id));
  if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

  const headers = shown[headerIndex].map(catalogClean_);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  [CATALOGO_ALBARAN_HEADERS.id, CATALOGO_ALBARAN_HEADERS.invoice].forEach(header => {
    if (columns[header] === undefined) throw new Error(`Falta la columna '${header}' en Pedidos.`);
  });

  const bodyRows = Math.max(0, shown.length - headerIndex - 1);
  const firstBodyRow = headerIndex + 2;
  const invoiceCol = columns[CATALOGO_ALBARAN_HEADERS.invoice] + 1;
  const rich = bodyRows ? pedidos.getRange(firstBodyRow, invoiceCol, bodyRows, 1).getRichTextValues() : [];

  const contexts = new Map();
  const filesById = new Map();
  const allowed = new Set(CATALOGO_RECIENTE_YEARS);

  for (let i = 0; i < bodyRows; i += 1) {
    const row = shown[headerIndex + 1 + i];
    const id = catalogClean_(row[columns[CATALOGO_ALBARAN_HEADERS.id]]);
    if (!/^\d{4}$/.test(id)) continue;

    contexts.set(id, {
      id,
      model: catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.model),
      material: catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.material)
        || catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.materialRaw),
      measures: catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.measures),
      specs: catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.specs),
      memorial: catalogField_(row, columns, CATALOGO_ALBARAN_HEADERS.memorial)
    });

    const dateInfo = catalogRecentDateInfo_(row, columns);
    if (!dateInfo || !allowed.has(dateInfo.year)) continue;

    const cell = rich[i] && rich[i][0];
    const url = cell && cell.getLinkUrl ? cell.getLinkUrl() || "" : "";
    if (!url) continue;

    const fileId = catalogDriveFileId_(url);
    if (!fileId) continue;

    const existing = filesById.get(fileId);
    const candidate = {
      fileId,
      url,
      fallbackId: id,
      year: dateInfo.year,
      timestamp: dateInfo.timestamp
    };

    // Si un mismo archivo aparece en varias filas, conservamos la referencia más reciente.
    if (!existing || candidate.timestamp > existing.timestamp) filesById.set(fileId, candidate);
  }

  const files = [...filesById.values()].sort((a, b) =>
    b.year - a.year ||
    b.timestamp - a.timestamp ||
    Number(b.fallbackId) - Number(a.fallbackId)
  );

  return { contexts, files };
}

function catalogRecentDateInfo_(row, columns) {
  for (const header of CATALOGO_RECIENTE_DATE_HEADERS) {
    const col = columns[header];
    if (col === undefined) continue;
    const parsed = catalogRecentParseDate_(row[col]);
    if (parsed) return { year: parsed.getFullYear(), timestamp: parsed.getTime() };
  }
  return null;
}

function catalogRecentParseDate_(value) {
  const raw = catalogClean_(value);
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function catalogRecentEnsureVisibleSheet_(book) {
  let sheet = book.getSheetByName(CATALOGO_RECIENTE_VISIBLE_SHEET);
  if (!sheet) sheet = book.insertSheet(CATALOGO_RECIENTE_VISIBLE_SHEET);
  if (sheet.getMaxColumns() < 20) sheet.insertColumnsAfter(sheet.getMaxColumns(), 20 - sheet.getMaxColumns());
  if (sheet.getLastRow() === 0) catalogWriteVisibleHeader_(sheet);
  return sheet;
}

function catalogRecentEnsureRawSheet_(book) {
  let sheet = book.getSheetByName(CATALOGO_RECIENTE_RAW_SHEET);
  if (!sheet) sheet = book.insertSheet(CATALOGO_RECIENTE_RAW_SHEET);
  if (sheet.getMaxColumns() < 17) sheet.insertColumnsAfter(sheet.getMaxColumns(), 17 - sheet.getMaxColumns());
  return sheet;
}

function catalogRecentAppendRawRows_(sheet, rows) {
  if (!rows.length) return;

  const startRow = Math.max(2, sheet.getLastRow() + 1);
  const requiredLastRow = startRow + rows.length - 1;
  const missingRows = requiredLastRow - sheet.getMaxRows();
  if (missingRows > 0) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(missingRows, 1000));

  sheet.getRange(startRow, 1, rows.length, 17).setValues(rows);
}

function catalogRecentScheduleContinuation_() {
  catalogRecentRemoveContinuationTriggers_();
  ScriptApp.newTrigger(CATALOGO_RECIENTE_CONTINUATION).timeBased().after(60 * 1000).create();
}

function catalogRecentRemoveContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === CATALOGO_RECIENTE_CONTINUATION) ScriptApp.deleteTrigger(trigger);
  });
}
