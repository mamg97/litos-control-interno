/**
 * LITOS — catálogo histórico de ítems de albarán.
 *
 * Recorre todos los albaranes definitivos enlazados desde Pedidos (2020-2026),
 * extrae sus líneas de producto/trabajo, las cruza con los datos leídos de las
 * fichas/notas y construye una hoja visible para que el taller confirme precios.
 *
 * Particularidad histórica importante: algunos XLSX antiguos contienen varios
 * pedidos dentro del mismo archivo (p. ej. un bloque 7003 seguido de 7005). El
 * extractor identifica cada bloque por su NUM/PEDIDO Nº y lo cruza con el ID
 * correspondiente del maestro, aunque el nombre del archivo solo contenga uno.
 *
 * No modifica albaranes ni Pedidos. Solo escribe:
 * - Catálogo albaranes            (visible, para revisión del padre)
 * - Catálogo albaranes · bruto    (oculta, auditoría técnica)
 *
 * Requiere el servicio avanzado Drive API v3, ya usado por SyncAlbaranes.gs.
 */

const CATALOGO_ALBARAN_MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const CATALOGO_ALBARAN_SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb";
const CATALOGO_ALBARAN_VISIBLE_SHEET = "Catálogo albaranes";
const CATALOGO_ALBARAN_RAW_SHEET = "Catálogo albaranes · bruto";
const CATALOGO_ALBARAN_PROGRESS = "litos_catalogo_albaranes_next_file";
const CATALOGO_ALBARAN_RUNNING = "litos_catalogo_albaranes_running";
const CATALOGO_ALBARAN_CONTINUATION = "continuarCatalogoAlbaranesHistorico";
const CATALOGO_ALBARAN_MAX_MS = 4.4 * 60 * 1000;
const CATALOGO_ALBARAN_MAX_FILES_PER_RUN = 24;

const CATALOGO_ALBARAN_HEADERS = Object.freeze({
  id: "Pedido",
  invoice: "Archivo factura / albarán (XLSX)",
  model: "Modelo",
  material: "Material normalizado",
  materialRaw: "Material",
  measures: "Notas de medidas y croquis",
  specs: "Especificaciones",
  memorial: "Texto conmemorativo"
});

function iniciarCatalogoAlbaranesHistorico() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otro proceso en curso" };
  try {
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const raw = catalogEnsureRawSheet_(book);
    catalogEnsureVisibleSheet_(book);
    raw.clearContents();
    catalogWriteRawHeader_(raw);
    raw.hideSheet();

    const props = PropertiesService.getScriptProperties();
    props.setProperty(CATALOGO_ALBARAN_PROGRESS, "0");
    props.setProperty(CATALOGO_ALBARAN_RUNNING, "1");
    catalogRemoveContinuationTriggers_();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return continuarCatalogoAlbaranesHistorico();
}

function continuarCatalogoAlbaranesHistorico() {
  const startedAt = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otro proceso en curso" };

  try {
    const props = PropertiesService.getScriptProperties();
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const pedidos = book.getSheetByName("Pedidos");
    if (!pedidos) throw new Error("No se encontró la pestaña Pedidos.");
    const visible = catalogEnsureVisibleSheet_(book);
    const raw = catalogEnsureRawSheet_(book);
    if (raw.getLastRow() === 0) catalogWriteRawHeader_(raw);

    const source = catalogMasterSource_(pedidos);
    const files = source.files;
    const contexts = source.contexts;
    let offset = Math.max(0, Number(props.getProperty(CATALOGO_ALBARAN_PROGRESS) || 0));
    let filesProcessed = 0;
    let itemsExtracted = 0;
    const errors = [];
    const pendingRows = [];

    while (
      offset < files.length &&
      filesProcessed < CATALOGO_ALBARAN_MAX_FILES_PER_RUN &&
      Date.now() - startedAt < CATALOGO_ALBARAN_MAX_MS
    ) {
      const entry = files[offset];
      offset += 1;
      try {
        const occurrences = catalogExtractInvoice_(entry.fileId, entry.url, entry.fallbackId, contexts);
        pendingRows.push(...occurrences);
        itemsExtracted += occurrences.length;
      } catch (error) {
        errors.push({ fallbackId: entry.fallbackId, fileId: entry.fileId, error: String(error && error.message || error) });
      }
      filesProcessed += 1;
    }

    if (pendingRows.length) catalogAppendRawRows_(raw, pendingRows);
    props.setProperty(CATALOGO_ALBARAN_PROGRESS, String(offset));
    SpreadsheetApp.flush();

    const finished = offset >= files.length;
    if (finished) {
      catalogBuildVisible_(visible, raw);
      props.deleteProperty(CATALOGO_ALBARAN_PROGRESS);
      props.deleteProperty(CATALOGO_ALBARAN_RUNNING);
      catalogRemoveContinuationTriggers_();
    } else {
      catalogScheduleContinuation_();
    }

    const result = {
      finished,
      filesScanned: offset,
      totalUniqueFiles: files.length,
      filesProcessed,
      itemsExtracted,
      rawOccurrences: Math.max(0, raw.getLastRow() - 1),
      continuationScheduled: !finished,
      errors
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function estadoCatalogoAlbaranesHistorico() {
  const props = PropertiesService.getScriptProperties();
  const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
  const raw = book.getSheetByName(CATALOGO_ALBARAN_RAW_SHEET);
  return {
    running: props.getProperty(CATALOGO_ALBARAN_RUNNING) === "1",
    nextFileOffset: Number(props.getProperty(CATALOGO_ALBARAN_PROGRESS) || 0),
    rawOccurrences: raw ? Math.max(0, raw.getLastRow() - 1) : 0
  };
}

/** Construye una lista única de archivos y un mapa de contexto por pedido. */
function catalogMasterSource_(pedidos) {
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

    const cell = rich[i] && rich[i][0];
    const url = cell && cell.getLinkUrl ? cell.getLinkUrl() || "" : "";
    if (!url) continue;
    const fileId = catalogDriveFileId_(url);
    if (!fileId || filesById.has(fileId)) continue;
    filesById.set(fileId, { fileId, url, fallbackId: id });
  }

  return { contexts, files: [...filesById.values()] };
}

function catalogExtractInvoice_(fileId, sourceUrl, fallbackId, contexts) {
  const file = DriveApp.getFileById(fileId);
  const mime = file.getMimeType();
  const name = file.getName();
  let tempId = "";
  let book;

  if (mime === MimeType.GOOGLE_SHEETS) {
    book = SpreadsheetApp.openById(fileId);
  } else if (/excel|spreadsheetml|ms-excel/i.test(mime) || /\.(xlsx|xlsm|xls)$/i.test(name)) {
    const metadata = {
      name: `_tmp_catalogo_${fallbackId}_${Date.now()}`,
      mimeType: MimeType.GOOGLE_SHEETS,
      parents: [CATALOGO_ALBARAN_SYSTEM_FOLDER_ID]
    };
    const converted = Drive.Files.create(metadata, file.getBlob(), { supportsAllDrives: true });
    if (!converted || !converted.id) throw new Error(`No se pudo convertir ${name}.`);
    tempId = converted.id;
    book = SpreadsheetApp.openById(tempId);
  } else {
    throw new Error(`Formato no compatible: ${name} (${mime}).`);
  }

  try {
    const out = [];
    book.getSheets().forEach(sheet => {
      const data = sheet.getDataRange();
      const shown = data.getDisplayValues();
      const values = data.getValues();
      const sections = catalogOrderSections_(shown, fallbackId);

      sections.forEach(section => {
        const base = contexts.get(section.id) || contexts.get(fallbackId) || { id: section.id || fallbackId };

        // El propio albarán es la fuente principal para modelo y material.
        // Pedidos queda como respaldo y aporta la lectura de la nota.
        const invoiceMeta = catalogSectionMetadata_(shown, values, section);

        const context = {
          id: section.id || base.id || fallbackId,
          model: invoiceMeta.model || base.model || "",
          material: invoiceMeta.material || base.material || "",
          measures: base.measures || "",
          specs: base.specs || "",
          memorial: base.memorial || "",
          sourceUrl,
          sourceFileId: fileId,
          sourceName: name,
          sourceSheet: sheet.getName()
        };

        out.push(...catalogExtractSectionItems_(shown, values, section, context));
      });
    });
    return out;
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (error) { /* temporal */ }
    }
  }
}

/** Detecta bloques NUM/PEDIDO Nº; si no existen, trata la hoja como un bloque. */
function catalogOrderSections_(shown, fallbackId) {
  const markers = [];
  for (let row = 0; row < shown.length; row += 1) {
    const normalized = shown[row].map(catalogNormalize_);
    const isHeader = normalized.some(value => value === "num" || value.startsWith("pedido"));
    if (!isHeader) continue;
    const id = shown[row].map(catalogClean_).find(value => /^\d{4}$/.test(value));
    if (id) markers.push({ id, start: row });
  }

  if (!markers.length) return [{ id: fallbackId, start: 0, end: shown.length }];
  return markers.map((marker, index) => ({
    id: marker.id,
    start: marker.start,
    end: index + 1 < markers.length ? markers[index + 1].start : shown.length
  }));
}


/**
 * Lee la cabecera real de cada bloque del albarán.
 *
 * Ejemplos históricos:
 *   CONCEPTO | LAPIDA | COLUMBARIO
 *   MATERIAL | GRANITO NEGRO ABSOLUTO | PRECIO | 120
 *
 * También admite formatos modernos:
 *   CONCEPTO | TAPA NICHO
 *   MATERIAL | MARMOL | BLANCO MACAEL | PRECIO
 */
function catalogSectionMetadata_(shown, values, section) {
  let model = "";
  let material = "";
  let materialRate = null;

  const uniqueText = parts => {
    const seen = new Set();
    return parts
      .map(catalogClean_)
      .filter(Boolean)
      .filter(value => {
        const key = catalogNormalize_(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(" ");
  };

  const ignored = new Set([
    "modelo",
    "precio",
    "cantidad",
    "largo",
    "ancho",
    "grueso",
    "m/2",
    "m2",
    "m²"
  ]);

  for (let row = section.start; row < section.end; row += 1) {
    const displayRow = shown[row] || [];
    const valueRow = values[row] || [];
    const normalized = displayRow.map(catalogNormalize_);

    const conceptoCol = normalized.findIndex(value => value === "concepto");
    if (!model && conceptoCol >= 0) {
      const parts = [];

      for (let col = conceptoCol + 1; col < displayRow.length; col += 1) {
        const value = catalogClean_(displayRow[col]);
        const key = catalogNormalize_(value);

        if (!value || ignored.has(key)) continue;

        // No incorporar números sueltos de la cabecera.
        if (
          catalogNumber_(valueRow[col]) !== null &&
          !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(value)
        ) {
          continue;
        }

        parts.push(value);
      }

      model = uniqueText(parts);
    }

    const materialCol = normalized.findIndex(value => value === "material");
    if (!material && materialCol >= 0) {
      const priceCol = normalized.findIndex(
        (value, col) => col > materialCol && value === "precio"
      );

      const stop = priceCol >= 0 ? priceCol : displayRow.length;
      const parts = [];

      for (let col = materialCol + 1; col < stop; col += 1) {
        const value = catalogClean_(displayRow[col]);
        const key = catalogNormalize_(value);

        if (!value || ignored.has(key)) continue;

        if (
          catalogNumber_(valueRow[col]) !== null &&
          !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(value)
        ) {
          continue;
        }

        parts.push(value);
      }

      material = uniqueText(parts);

      if (priceCol >= 0) {
        for (let col = priceCol + 1; col < valueRow.length; col += 1) {
          const candidate = catalogNumber_(valueRow[col]);
          if (candidate !== null && candidate > 0) {
            materialRate = candidate;
            break;
          }
        }
      }
    }

    // Una vez encontrada la cabecera de material normalmente ya hemos
    // recorrido toda la zona relevante del bloque.
    if (model && material) break;
  }

  return { model, material, materialRate };
}

function catalogExtractSectionItems_(shown, values, section, context) {
  let start = section.start;
  let end = section.end;

  for (let row = section.start; row < section.end; row += 1) {
    const normalized = shown[row].map(catalogNormalize_);
    if (normalized.includes("cantidad") && (normalized.includes("largo") || normalized.includes("ancho"))) {
      start = row + 1;
      break;
    }
  }

  for (let row = start; row < section.end; row += 1) {
    if (shown[row].some(cell => catalogNormalize_(cell) === "suma")) {
      end = row;
      break;
    }
  }

  const occurrences = [];
  for (let row = start; row < end; row += 1) {
    const item = catalogItemFromRow_(shown[row] || [], values[row] || []);
    if (!item) continue;
    occurrences.push([
      context.sourceFileId,
      context.sourceName,
      context.sourceUrl,
      context.sourceSheet,
      row + 1,
      context.id,
      item.description,
      item.detail,
      item.category,
      item.unit,
      item.unitRate,
      item.lineTotal,
      context.model,
      context.material,
      context.specs,
      context.measures,
      context.memorial
    ]);
  }
  return occurrences;
}

function catalogItemFromRow_(displayRow, valueRow) {
  const width = Math.max(displayRow.length, valueRow.length);
  const textCells = [];
  for (let col = 0; col < Math.min(width, 8); col += 1) {
    const display = catalogClean_(displayRow[col]);
    if (!display) continue;
    if (catalogNumber_(valueRow[col]) !== null && !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(display)) continue;
    textCells.push({ col, text: display });
  }
  if (!textCells.length) return null;

  const description = textCells[0].text;
  const normalized = catalogNormalize_(description);
  if (!normalized || catalogIsStructuralLabel_(normalized)) return null;

  const detail = textCells
    .slice(1)
    .map(entry => entry.text)
    .filter(text => !catalogIsStructuralLabel_(catalogNormalize_(text)))
    .join(" · ");

  const nums = Array.from({ length: Math.max(width, 8) }, (_, col) => catalogNumber_(valueRow[col]));
  const totalInfo = catalogLastNumber_(nums);
  const lineTotal = totalInfo ? totalInfo.value : null;
  const inferred = catalogInferRate_(nums, totalInfo);
  const category = catalogCategory_(description, detail);
  const unit = catalogUnit_(description, detail, lineTotal, inferred.mode);
  const workshopLike = catalogLooksLikeWorkshopItem_(description, detail);

  if (lineTotal === null && !inferred.hasQuantity && !workshopLike) return null;
  return { description, detail, category, unit, unitRate: inferred.rate, lineTotal };
}

/**
 * Infiere la tarifa histórica sin asumir una plantilla fija:
 * - si dos números anteriores multiplican el total, el segundo suele ser tarifa;
 * - si no, total / último número anterior captura tarifas €/m² antiguas;
 * - si no hay base, el total de línea queda como referencia.
 */
function catalogInferRate_(nums, totalInfo) {
  if (!totalInfo) return { rate: null, mode: "", hasQuantity: false };
  const total = totalInfo.value;
  const prior = [];
  for (let col = 0; col < totalInfo.col; col += 1) {
    const value = nums[col];
    if (value !== null && value > 0) prior.push({ col, value });
  }
  const hasQuantity = prior.length > 0;

  let bestPair = null;
  for (let i = 0; i < prior.length; i += 1) {
    for (let j = i + 1; j < prior.length; j += 1) {
      if (!catalogApprox_(prior[i].value * prior[j].value, total)) continue;
      if (!bestPair || prior[j].col > bestPair.rate.col) bestPair = { qty: prior[i], rate: prior[j] };
    }
  }
  if (bestPair) return { rate: bestPair.rate.value, mode: "PAIR", hasQuantity };

  const last = prior[prior.length - 1];
  if (last && last.value > 0 && !catalogApprox_(last.value, total)) {
    return { rate: total / last.value, mode: "RATIO_LAST", hasQuantity };
  }
  if (last && last.value > 0) return { rate: total / last.value, mode: "SINGLE", hasQuantity };
  return { rate: total, mode: "TOTAL", hasQuantity };
}

function catalogBuildVisible_(sheet, raw) {
  const previous = catalogManualValues_(sheet);
  const values = raw.getDataRange().getValues();
  const groups = new Map();

  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    const description = catalogClean_(row[6]);
    const detail = catalogClean_(row[7]);
    const category = catalogClean_(row[8]) || "Otros";
    const unit = catalogClean_(row[9]) || "revisar";
    const material = catalogClean_(row[13]);
    if (!description) continue;

    const key = catalogItemKey_(description, detail, material, unit, category);
    const group = groups.get(key) || {
      key,
      descriptions: new Set(), details: new Set(), categories: new Map(), units: new Map(),
      rates: [], orders: new Set(), models: new Set(), materials: new Set(), signals: [], sources: []
    };

    group.descriptions.add(description);
    if (detail) group.details.add(detail);
    catalogCount_(group.categories, category);
    catalogCount_(group.units, unit);
    const rate = catalogNumber_(row[10]);
    if (rate !== null && rate >= 0) group.rates.push(rate);
    if (row[5]) group.orders.add(String(row[5]));
    if (row[12]) group.models.add(catalogClean_(row[12]));
    if (material) group.materials.add(material);

    const signal = catalogSignal_(row[5], row[14], row[15]);
    if (signal && !group.signals.includes(signal) && group.signals.length < 4) group.signals.push(signal);
    const source = catalogClean_(row[1]);
    if (source && !group.sources.includes(source)) group.sources.push(source);
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.orders.size - a.orders.size || [...a.descriptions][0].localeCompare([...b.descriptions][0], "es"))
    .map(group => {
      const manual = previous.get(group.key) || {};
      const rates = group.rates.filter(Number.isFinite).sort((a, b) => a - b);
      const description = [...group.descriptions][0] || "";
      const detail = [...group.details].join(" | ");
      const category = catalogMostCommon_(group.categories);
      const unit = manual.unit || catalogMostCommon_(group.units);
      const canonical = manual.canonical || description;
      const distinctRates = [...new Set(rates.map(value => Math.round(value * 100) / 100))];
      const rule = manual.rule || catalogSuggestedRule_(description, detail, category);

      return [
        group.key, canonical, [...group.descriptions].join(" | "), detail, category, unit,
        manual.price === undefined ? "" : manual.price, Boolean(manual.validated), group.orders.size,
        distinctRates.slice(0, 20).join(" · "), rates.length ? rates[0] : "",
        rates.length ? catalogMedian_(rates) : "", rates.length ? rates[rates.length - 1] : "",
        [...group.orders].slice(0, 10).join(", "), [...group.models].slice(0, 8).join(" | "),
        [...group.materials].slice(0, 8).join(" | "), group.signals.join(" || "), rule,
        group.sources.slice(-3).join(" | "),
        manual.notes || "Precios históricos orientativos; confirmar el precio actual antes de usarlo en borradores."
      ];
    });

  sheet.clearContents();
  catalogWriteVisibleHeader_(sheet);
  if (rows.length) sheet.getRange(2, 1, rows.length, 20).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.getRange("G2:G2000").setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange("K2:M2000").setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange("H2:H2000").insertCheckboxes();
  sheet.getRange("A:T").setWrap(true).setVerticalAlignment("top");
  sheet.setColumnWidths(1, 20, 140);
  sheet.setColumnWidth(3, 230);
  sheet.setColumnWidth(4, 260);
  sheet.setColumnWidth(14, 220);
  sheet.setColumnWidth(17, 360);
  sheet.setColumnWidth(18, 300);
  sheet.setColumnWidth(20, 300);
  sheet.autoResizeRows(1, Math.min(sheet.getLastRow(), 2000));
  raw.hideSheet();
}

function catalogManualValues_(sheet) {
  const out = new Map();
  if (!sheet || sheet.getLastRow() < 2) return out;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(20, sheet.getLastColumn())).getValues();
  values.forEach(row => {
    const key = catalogClean_(row[0]);
    if (!key) return;
    out.set(key, {
      canonical: catalogClean_(row[1]), unit: catalogClean_(row[5]), price: row[6],
      validated: row[7] === true, rule: catalogClean_(row[17]), notes: catalogClean_(row[19])
    });
  });
  return out;
}

function catalogWriteVisibleHeader_(sheet) {
  const headers = [[
    "Clave ítem", "Ítem canónico", "Variante observada", "Detalle / acabado / referencia",
    "Categoría sugerida", "Unidad sugerida", "Precio actual (€)", "Validado por padre",
    "Nº apariciones", "Precios unitarios históricos", "Precio hist. mín.", "Precio hist. mediana",
    "Precio hist. máx.", "Pedidos ejemplo", "Modelos asociados", "Materiales asociados",
    "Señales en nota / especificaciones", "Regla de generación", "Fuente última", "Observaciones"
  ]];
  sheet.getRange(1, 1, 1, 20).setValues(headers)
    .setBackground("#15607f").setFontColor("#ffffff").setFontWeight("bold")
    .setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true);
}

function catalogWriteRawHeader_(sheet) {
  sheet.getRange(1, 1, 1, 17).setValues([[
    "File ID", "Archivo", "URL", "Hoja", "Fila", "Pedido", "Descripción", "Detalle",
    "Categoría", "Unidad sugerida", "Precio unitario inferido", "Importe línea", "Modelo",
    "Material", "Especificaciones", "Medidas / croquis", "Texto conmemorativo"
  ]]);
}

function catalogAppendRawRows_(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(Math.max(2, sheet.getLastRow() + 1), 1, rows.length, 17).setValues(rows);
}

function catalogEnsureVisibleSheet_(book) {
  let sheet = book.getSheetByName(CATALOGO_ALBARAN_VISIBLE_SHEET);
  if (!sheet) sheet = book.insertSheet(CATALOGO_ALBARAN_VISIBLE_SHEET);
  if (sheet.getMaxColumns() < 20) sheet.insertColumnsAfter(sheet.getMaxColumns(), 20 - sheet.getMaxColumns());
  catalogWriteVisibleHeader_(sheet);
  return sheet;
}

function catalogEnsureRawSheet_(book) {
  let sheet = book.getSheetByName(CATALOGO_ALBARAN_RAW_SHEET);
  if (!sheet) sheet = book.insertSheet(CATALOGO_ALBARAN_RAW_SHEET);
  if (sheet.getMaxColumns() < 17) sheet.insertColumnsAfter(sheet.getMaxColumns(), 17 - sheet.getMaxColumns());
  return sheet;
}

function catalogScheduleContinuation_() {
  catalogRemoveContinuationTriggers_();
  ScriptApp.newTrigger(CATALOGO_ALBARAN_CONTINUATION).timeBased().after(60 * 1000).create();
}

function catalogRemoveContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === CATALOGO_ALBARAN_CONTINUATION) ScriptApp.deleteTrigger(trigger);
  });
}

function catalogDriveFileId_(url) {
  const raw = catalogClean_(url);
  const patterns = [/\/d\/([A-Za-z0-9_-]{20,})/, /[?&]id=([A-Za-z0-9_-]{20,})/, /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function catalogField_(row, columns, field) {
  return columns[field] === undefined ? "" : catalogClean_(row[columns[field]]);
}

function catalogIsStructuralLabel_(normalized) {
  return [
    "albaran", "hoja de pedido", "pedido n", "pedido nº", "pedido no", "num", "fecha",
    "concepto", "material", "precio", "cantidad", "largo", "ancho", "grueso", "m/2",
    "m2", "suma", "i.v.a.", "iva", "r.e.", "re", "total"
  ].includes(normalized);
}

function catalogLooksLikeWorkshopItem_(description, detail) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  return [
    "corte", "cortar", "solera", "junquillo", "pulir", "pulido", "canto", "repisa",
    "cornisa", "coronacion", "columna", "inscripcion", "cruz", "jardinera", "florero",
    "floreo", "retacear", "rebaje", "canal", "forma", "abujard", "relieve", "foto",
    "imagen", "placa", "transporte", "colocacion", "limpieza", "nicho", "acoplar"
  ].some(term => value.includes(term));
}

function catalogCategory_(description, detail) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  const rules = [
    ["Inscripción", ["inscripcion", "letra", "texto"]],
    ["Ornamento", ["cruz", "imagen", "foto", "relieve", "placa"]],
    ["Accesorio", ["jardinera", "florero", "floreo", "jarron"]],
    ["Piedra / pieza", ["solera", "junquillo", "repisa", "cornisa", "coronacion", "columna", "tapa", "lapida"]],
    ["Acabado", ["pulir", "pulido", "canto", "abujard", "bisel", "rebaje", "canal"]],
    ["Corte / taller", ["corte", "cortar", "retacear", "forma"]],
    ["Servicio", ["transporte", "colocacion", "limpieza", "montaje", "acoplar"]]
  ];
  for (const [category, terms] of rules) if (terms.some(term => value.includes(term))) return category;
  return "Otros";
}

function catalogUnit_(description, detail, lineTotal, mode) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  if (["inscripcion", "cruz", "jardinera", "florero", "floreo", "placa", "columna"].some(term => value.includes(term))) return "ud";
  if (["canto", "pulir", "pulido"].some(term => value.includes(term)) && mode === "PAIR") return "m";
  if (["corte", "solera", "junquillo", "repisa", "cornisa", "coronacion", "lapida", "tapa"].some(term => value.includes(term)) && mode === "RATIO_LAST") return "m²";
  if (mode === "PAIR" || mode === "SINGLE") return "ud";
  if (lineTotal !== null) return "trabajo";
  return "revisar";
}

function catalogSuggestedRule_(description, detail, category) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  const terms = [
    "repisa", "solera", "junquillo", "cornisa", "coronacion", "columna", "inscripcion",
    "cruz", "jardinera", "florero", "floreo", "foto", "imagen", "relieve", "abujardado",
    "pulir cantos", "canto pulido", "retacear", "cortar material", "acoplar"
  ].filter(term => value.includes(term));
  if (terms.length) return `Si la nota/especificaciones indican: ${terms.slice(0, 3).join(" / ")}`;
  return `${category}: revisar correspondencia con la nota antes de automatizar.`;
}

function catalogSignal_(id, specs, measures) {
  const text = [catalogClean_(specs), catalogClean_(measures)].filter(Boolean).join(" · ");
  if (!text) return "";
  return `${id}: ${text.length > 180 ? `${text.slice(0, 177)}…` : text}`;
}

function catalogItemKey_(description, detail, material, unit, category) {
  let key = `${catalogNormalize_(description)}|${catalogNormalize_(detail)}`;
  // Las piezas cobradas por m² dependen normalmente del material; no debemos
  // mezclar, por ejemplo, CORTE de mármol italiano con granito negro absoluto.
  if (unit === "m²" || category === "Piedra / pieza") key += `|material:${catalogNormalize_(material)}`;
  return key.replace(/\s+/g, " ").trim();
}

function catalogCount_(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function catalogMostCommon_(map) { return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ""; }
function catalogMedian_(values) {
  if (!values.length) return "";
  const m = Math.floor(values.length / 2);
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}
function catalogLastNumber_(nums) {
  for (let col = nums.length - 1; col >= 0; col -= 1) {
    if (nums[col] !== null) return { col, value: nums[col] };
  }
  return null;
}
function catalogApprox_(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(0.03, Math.abs(right) * 0.015);
}
function catalogNumber_(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let raw = catalogClean_(value).replace(/[^0-9,.-]/g, "");
  if (!raw) return null;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    const decimal = comma > dot ? "," : ".";
    raw = raw.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
  } else if (comma !== -1) raw = raw.replace(/,/g, ".");
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}
function catalogClean_(value) { return String(value == null ? "" : value).trim(); }
function catalogNormalize_(value) {
  return catalogClean_(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[º°]/g, "").replace(/\s+/g, " ").trim();
}
