/**
 * LITOS — sincronización de albaranes 2026.
 *
 * Fuente de verdad:
 *   <ID>_borrador.xlsx -> borrador
 *   <ID>.xlsx (o cualquier XLS/XLSX sin _borrador) -> definitivo
 *
 * El sincronizador hace tres cosas fuera del doGet para mantener la web rápida:
 * 1) reclasifica los enlaces de Albarán / Albarán borrador según el nombre real;
 * 2) lee el TOTAL del XLS/XLSX activo (definitivo primero, borrador como fallback);
 * 3) escribe ese TOTAL en "Total sheet (€)". "Precio final (€)" lo replica mediante fórmula.
 *
 * Solo recorre la carpeta operativa 2026. No toca 2025 ni años anteriores.
 * Los totales se cachean por fileId + fecha de modificación para no reconvertir archivos
 * que no han cambiado.
 *
 * Requiere el servicio avanzado Drive API v3 (Servicios > + > Drive API).
 */

const ALBARAN_SYNC_MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const ALBARAN_SYNC_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_";
const ALBARAN_SYNC_SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb";
const ALBARAN_SYNC_HEADERS = Object.freeze({
  id: "Pedido",
  invoice: "Archivo factura / albarán (XLSX)",
  draft: "Factura borrador (XLSX)",
  total: "Total sheet (€)"
});

function syncAlbaranes2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otra sincronización en curso" };

  try {
    const index = scanAlbaranes2026_();
    const book = SpreadsheetApp.openById(ALBARAN_SYNC_MASTER_ID);
    const sheet = book.getSheetByName("Pedidos");
    if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

    const data = sheet.getDataRange();
    const values = data.getDisplayValues();
    const headerIndex = values.findIndex(row => row.some(cell => albaranClean_(cell) === ALBARAN_SYNC_HEADERS.id));
    if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

    const headers = values[headerIndex].map(albaranClean_);
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
    [ALBARAN_SYNC_HEADERS.invoice, ALBARAN_SYNC_HEADERS.draft, ALBARAN_SYNC_HEADERS.total].forEach(header => {
      if (columns[header] === undefined) throw new Error(`Falta la columna '${header}' en Pedidos.`);
    });

    const makeLink = (url, label) => {
      const builder = SpreadsheetApp.newRichTextValue().setText(url ? label : "No disponible");
      if (url) builder.setLinkUrl(url);
      return builder.build();
    };

    let matched = 0;
    let totalsUpdated = 0;
    let totalsUnavailable = 0;
    const errors = [];

    for (let rowIndex = headerIndex + 1; rowIndex < values.length; rowIndex += 1) {
      const id = albaranClean_(values[rowIndex][columns[ALBARAN_SYNC_HEADERS.id]]);
      if (!id || !index.has(id)) continue;

      const entry = index.get(id);
      const rowNumber = rowIndex + 1;
      matched += 1;

      const invoiceUrl = entry.invoice ? entry.invoice.file.getUrl() : "";
      const draftUrl = entry.draft ? entry.draft.file.getUrl() : "";

      sheet.getRange(rowNumber, columns[ALBARAN_SYNC_HEADERS.invoice] + 1)
        .setRichTextValue(makeLink(invoiceUrl, "Abrir"));
      sheet.getRange(rowNumber, columns[ALBARAN_SYNC_HEADERS.draft] + 1)
        .setRichTextValue(makeLink(draftUrl, "Abrir borrador"));

      const active = entry.invoice || entry.draft;
      if (!active) continue;

      try {
        const total = readAlbaranTotalCached_(active.file);
        const cell = sheet.getRange(rowNumber, columns[ALBARAN_SYNC_HEADERS.total] + 1);
        if (total === null) {
          cell.clearContent();
          totalsUnavailable += 1;
        } else {
          cell.setValue(total).setNumberFormat('#,##0.00 [$€-es-ES]');
          totalsUpdated += 1;
        }
      } catch (error) {
        errors.push({ id, file: active.file.getName(), error: String(error && error.message || error) });
      }
    }

    SpreadsheetApp.flush();

    try {
      CacheService.getScriptCache().removeAll([
        "litos-current-documents-v1",
        "litos-current-documents-v2"
      ]);
    } catch (error) {
      // La caché no es crítica.
    }

    return {
      filesIndexed: index.size,
      rowsMatched: matched,
      totalsUpdated,
      totalsUnavailable,
      errors
    };
  } finally {
    lock.releaseLock();
  }
}

function installAlbaranSyncTrigger() {
  const functionName = "syncAlbaranes2026";
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === functionName);
  if (existing.length) return { installed: false, reason: "ya existe", triggers: existing.length };

  ScriptApp.newTrigger(functionName).timeBased().everyMinutes(5).create();
  return { installed: true, everyMinutes: 5 };
}

function removeAlbaranSyncTrigger() {
  const functionName = "syncAlbaranes2026";
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { removed };
}

function scanAlbaranes2026_() {
  const folder = DriveApp.getFolderById(ALBARAN_SYNC_FOLDER_ID);
  const index = new Map();
  const visited = {};

  const walk = current => {
    const folderId = current.getId();
    if (visited[folderId]) return;
    visited[folderId] = true;

    const files = current.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = albaranClean_(file.getName());
      const lower = name.toLowerCase();
      if (!/\.(xlsx|xls)$/.test(lower)) continue;

      const match = name.match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
      if (!match) continue;

      const id = match[1];
      const isDraft = /(?:^|[_ -])borrador(?:[_ .-]|$)/.test(lower);
      const type = isDraft ? "draft" : "invoice";
      const candidate = { file, updated: file.getLastUpdated().getTime() };
      const entry = index.get(id) || {};

      if (!entry[type] || candidate.updated > entry[type].updated) entry[type] = candidate;
      index.set(id, entry);
    }

    const folders = current.getFolders();
    while (folders.hasNext()) {
      const child = folders.next();
      if (child.getId() === ALBARAN_SYNC_SYSTEM_FOLDER_ID || child.getName() === "_sistema") continue;
      walk(child);
    }
  };

  walk(folder);
  return index;
}

function readAlbaranTotalCached_(file) {
  const props = PropertiesService.getScriptProperties();
  const key = `litos_albaran_total_${file.getId()}`;
  const stamp = String(file.getLastUpdated().getTime());
  const cached = props.getProperty(key);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.stamp === stamp) return parsed.total === null ? null : Number(parsed.total);
    } catch (error) {
      // Recalcular si la caché está dañada.
    }
  }

  const total = readAlbaranTotalFromXlsx_(file);
  props.setProperty(key, JSON.stringify({ stamp, total }));
  return total;
}

function readAlbaranTotalFromXlsx_(file) {
  const metadata = {
    name: `_tmp_total_${file.getName()}_${Date.now()}`,
    mimeType: MimeType.GOOGLE_SHEETS,
    parents: [ALBARAN_SYNC_SYSTEM_FOLDER_ID]
  };

  const converted = Drive.Files.create(metadata, file.getBlob(), { supportsAllDrives: true });
  if (!converted || !converted.id) throw new Error(`No se pudo convertir ${file.getName()} a Google Sheets.`);

  try {
    const book = SpreadsheetApp.openById(converted.id);
    const sheets = book.getSheets();

    for (const sheet of sheets) {
      const values = sheet.getDataRange().getDisplayValues();
      for (let row = 0; row < values.length; row += 1) {
        for (let col = 0; col < values[row].length; col += 1) {
          if (albaranNormalize_(values[row][col]) !== "total") continue;

          for (let candidate = col + 1; candidate < values[row].length; candidate += 1) {
            const number = albaranNumber_(values[row][candidate]);
            if (number !== null) return number > 0 ? Math.round(number * 100) / 100 : null;
          }
        }
      }
    }

    return null;
  } finally {
    try { DriveApp.getFileById(converted.id).setTrashed(true); } catch (error) { /* temporal */ }
  }
}

function albaranClean_(value) {
  return String(value == null ? "" : value).trim();
}

function albaranNormalize_(value) {
  return albaranClean_(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function albaranNumber_(value) {
  let raw = albaranClean_(value).replace(/[^0-9,.-]/g, "");
  if (!raw) return null;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    const decimal = comma > dot ? "," : ".";
    raw = raw.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
  } else if (comma !== -1) {
    raw = raw.replace(/,/g, ".");
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}
