/**
 * LITOS — catálogo histórico de ítems de albarán.
 *
 * Objetivo:
 * - recorrer los albaranes definitivos enlazados desde la pestaña Pedidos,
 *   incluidos 2020-2026;
 * - extraer todas las líneas de trabajo/producto observadas;
 * - cruzarlas con los datos ya leídos de la ficha/nota del mismo pedido;
 * - construir una hoja visible "Catálogo albaranes" para que el taller
 *   confirme el precio actual real de cada variante;
 * - dejar una hoja técnica oculta con las ocurrencias brutas para poder
 *   reconstruir y auditar el catálogo.
 *
 * No modifica albaranes ni pedidos. Solo lee documentos y escribe las dos
 * hojas de catálogo dentro de PEDIDOS M.S.
 *
 * Requiere el servicio avanzado Drive API v3, ya utilizado por
 * SyncAlbaranes.gs para convertir temporalmente XLS/XLSX/XLSM.
 */

const CATALOGO_ALBARAN_MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const CATALOGO_ALBARAN_SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb";
const CATALOGO_ALBARAN_VISIBLE_SHEET = "Catálogo albaranes";
const CATALOGO_ALBARAN_RAW_SHEET = "Catálogo albaranes · bruto";
const CATALOGO_ALBARAN_PROGRESS = "litos_catalogo_albaranes_next_row";
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

/**
 * Inicia desde cero el barrido histórico. Ejecutar manualmente una sola vez.
 * La propia función crea continuaciones de un minuto hasta terminar.
 */
function iniciarCatalogoAlbaranesHistorico() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otro proceso en curso" };

  try {
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const visible = catalogEnsureVisibleSheet_(book);
    const raw = catalogEnsureRawSheet_(book);

    raw.clearContents();
    catalogWriteRawHeader_(raw);
    raw.hideSheet();

    // Conservamos las columnas editables del catálogo visible; el agregado
    // final las recuperará por Clave ítem. El resto se regenerará al terminar.
    const props = PropertiesService.getScriptProperties();
    props.setProperty(CATALOGO_ALBARAN_PROGRESS, "0");
    props.setProperty(CATALOGO_ALBARAN_RUNNING, "1");
    catalogRemoveContinuationTriggers_();

    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // La primera tanda se inicia solo después de liberar el bloqueo anterior.
  return continuarCatalogoAlbaranesHistorico();
}

/**
 * Continúa el barrido en lotes pequeños para no superar el límite de Apps
 * Script. No hace falta ejecutarla a mano salvo para reanudar una incidencia.
 */
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

    const range = pedidos.getDataRange();
    const shown = range.getDisplayValues();
    const rawValues = range.getValues();
    const headerIndex = shown.findIndex(row => row.some(cell => catalogClean_(cell) === CATALOGO_ALBARAN_HEADERS.id));
    if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

    const headers = shown[headerIndex].map(catalogClean_);
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
    [CATALOGO_ALBARAN_HEADERS.id, CATALOGO_ALBARAN_HEADERS.invoice].forEach(header => {
      if (columns[header] === undefined) throw new Error(`Falta la columna '${header}' en Pedidos.`);
    });

    const firstBodyRow = headerIndex + 2;
    const bodyRows = Math.max(0, shown.length - headerIndex - 1);
    const invoiceCol = columns[CATALOGO_ALBARAN_HEADERS.invoice] + 1;
    const invoiceRich = bodyRows
      ? pedidos.getRange(firstBodyRow, invoiceCol, bodyRows, 1).getRichTextValues()
      : [];

    let offset = Math.max(0, Number(props.getProperty(CATALOGO_ALBARAN_PROGRESS) || 0));
    let inspectedRows = 0;
    let filesProcessed = 0;
    let itemsExtracted = 0;
    let filesSkipped = 0;
    const errors = [];
    const pendingRows = [];

    while (
      offset < bodyRows &&
      filesProcessed < CATALOGO_ALBARAN_MAX_FILES_PER_RUN &&
      Date.now() - startedAt < CATALOGO_ALBARAN_MAX_MS
    ) {
      const displayRow = shown[headerIndex + 1 + offset];
      const valueRow = rawValues[headerIndex + 1 + offset];
      const id = catalogClean_(displayRow[columns[CATALOGO_ALBARAN_HEADERS.id]]);
      const rich = invoiceRich[offset] && invoiceRich[offset][0];
      const url = rich && rich.getLinkUrl ? rich.getLinkUrl() || "" : "";
      inspectedRows += 1;
      offset += 1;

      if (!/^\d{4}$/.test(id) || !url) continue;
      const fileId = catalogDriveFileId_(url);
      if (!fileId) {
        filesSkipped += 1;
        continue;
      }

      const context = {
        id,
        model: catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.model),
        material: catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.material)
          || catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.materialRaw),
        measures: catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.measures),
        specs: catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.specs),
        memorial: catalogField_(displayRow, columns, CATALOGO_ALBARAN_HEADERS.memorial)
      };

      try {
        const occurrences = catalogExtractInvoice_(fileId, url, context);
        pendingRows.push(...occurrences);
        itemsExtracted += occurrences.length;
        filesProcessed += 1;
      } catch (error) {
        errors.push({ id, fileId, error: String(error && error.message || error) });
        filesProcessed += 1;
      }
    }

    if (pendingRows.length) catalogAppendRawRows_(raw, pendingRows);
    props.setProperty(CATALOGO_ALBARAN_PROGRESS, String(offset));
    SpreadsheetApp.flush();

    const finished = offset >= bodyRows;
    if (finished) {
      catalogBuildVisible_(book, visible, raw);
      props.deleteProperty(CATALOGO_ALBARAN_PROGRESS);
      props.deleteProperty(CATALOGO_ALBARAN_RUNNING);
      catalogRemoveContinuationTriggers_();
    } else {
      catalogScheduleContinuation_();
    }

    const result = {
      finished,
      rowsScanned: offset,
      totalRows: bodyRows,
      inspectedThisRun: inspectedRows,
      filesProcessed,
      filesSkipped,
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

/** Estado ligero para comprobar el progreso desde el editor. */
function estadoCatalogoAlbaranesHistorico() {
  const props = PropertiesService.getScriptProperties();
  const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
  const raw = book.getSheetByName(CATALOGO_ALBARAN_RAW_SHEET);
  return {
    running: props.getProperty(CATALOGO_ALBARAN_RUNNING) === "1",
    nextRowOffset: Number(props.getProperty(CATALOGO_ALBARAN_PROGRESS) || 0),
    rawOccurrences: raw ? Math.max(0, raw.getLastRow() - 1) : 0
  };
}

function catalogExtractInvoice_(fileId, sourceUrl, context) {
  const file = DriveApp.getFileById(fileId);
  const mime = file.getMimeType();
  const name = file.getName();
  let tempId = "";
  let book;

  if (mime === MimeType.GOOGLE_SHEETS) {
    book = SpreadsheetApp.openById(fileId);
  } else if (/excel|spreadsheetml|ms-excel/i.test(mime) || /\.(xlsx|xlsm|xls)$/i.test(name)) {
    const metadata = {
      name: `_tmp_catalogo_${context.id}_${Date.now()}`,
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
      const range = sheet.getDataRange();
      const shown = range.getDisplayValues();
      const values = range.getValues();
      out.push(...catalogExtractSheetItems_(shown, values, {
        ...context,
        sourceUrl,
        sourceFileId: fileId,
        sourceName: name,
        sourceSheet: sheet.getName()
      }));
    });
    return out;
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (error) { /* temporal */ }
    }
  }
}

function catalogExtractSheetItems_(shown, values, context) {
  if (!shown.length) return [];

  let start = 0;
  let end = shown.length;

  // Inicio habitual: la fila de CANTIDAD/LARGO/ANCHO/GRUESO/M/2.
  for (let row = 0; row < shown.length; row += 1) {
    const normalized = shown[row].map(catalogNormalize_);
    if (normalized.includes("cantidad") && (normalized.includes("largo") || normalized.includes("ancho"))) {
      start = row + 1;
      break;
    }
  }

  // Final habitual: antes de SUMA/IVA/RE/TOTAL.
  for (let row = start; row < shown.length; row += 1) {
    if (shown[row].some(cell => catalogNormalize_(cell) === "suma")) {
      end = row;
      break;
    }
  }

  const occurrences = [];
  for (let row = start; row < end; row += 1) {
    const displayRow = shown[row] || [];
    const valueRow = values[row] || [];
    const item = catalogItemFromRow_(displayRow, valueRow);
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
  for (let col = 0; col < Math.min(width, 6); col += 1) {
    const display = catalogClean_(displayRow[col]);
    if (!display) continue;
    if (catalogNumber_(valueRow[col]) !== null && !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(display)) continue;
    textCells.push({ col, text: display });
  }
  if (!textCells.length) return null;

  const first = textCells[0];
  const description = first.text;
  const normalized = catalogNormalize_(description);
  if (!normalized || catalogIsStructuralLabel_(normalized)) return null;

  const detail = textCells
    .slice(1)
    .map(entry => entry.text)
    .filter(text => !catalogIsStructuralLabel_(catalogNormalize_(text)))
    .join(" · ");

  const nums = Array.from({ length: Math.max(width, 7) }, (_, col) => catalogNumber_(valueRow[col]));
  const lineTotal = catalogLastPositiveNumber_(nums, 6);
  const inferred = catalogInferRate_(nums, lineTotal, description, detail);
  const category = catalogCategory_(description, detail);
  const unit = catalogUnit_(description, detail, nums, lineTotal, inferred.mode);

  // Para no considerar textos decorativos como ítems, una línea debe tener
  // importe/cantidad o parecer claramente un concepto de taller conocido.
  const workshopLike = catalogLooksLikeWorkshopItem_(description, detail);
  if (lineTotal === null && !inferred.hasQuantity && !workshopLike) return null;

  return {
    description,
    detail,
    category,
    unit,
    unitRate: inferred.rate,
    lineTotal
  };
}

function catalogInferRate_(nums, lineTotal, description, detail) {
  const b = nums[1];
  const e = nums[4];
  const f = nums[5];
  const total = lineTotal;
  const hasQuantity = [b, e, f].some(value => value !== null && value > 0);

  if (total !== null && e !== null && e > 0 && f !== null && f > 0 && catalogApprox_(e * f, total)) {
    return { rate: f, mode: "E*F", hasQuantity };
  }
  if (total !== null && f !== null && f > 0 && !catalogApprox_(f, total)) {
    return { rate: total / f, mode: "G/F", hasQuantity };
  }
  if (total !== null && b !== null && b > 0) {
    return { rate: total / b, mode: "G/B", hasQuantity };
  }
  if (total !== null) return { rate: total, mode: "TOTAL", hasQuantity };
  return { rate: null, mode: "", hasQuantity };
}

function catalogBuildVisible_(book, sheet, raw) {
  const previous = catalogManualValues_(sheet);
  const values = raw.getDataRange().getValues();
  const groups = new Map();

  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    const description = catalogClean_(row[6]);
    const detail = catalogClean_(row[7]);
    if (!description) continue;

    const key = catalogItemKey_(description, detail);
    const group = groups.get(key) || {
      key,
      descriptions: new Set(),
      details: new Set(),
      categories: new Map(),
      units: new Map(),
      rates: [],
      orders: new Set(),
      models: new Set(),
      materials: new Set(),
      signals: [],
      sources: []
    };

    group.descriptions.add(description);
    if (detail) group.details.add(detail);
    catalogCount_(group.categories, catalogClean_(row[8]) || "Otros");
    catalogCount_(group.units, catalogClean_(row[9]) || "revisar");
    const rate = catalogNumber_(row[10]);
    if (rate !== null && rate >= 0) group.rates.push(rate);
    if (row[5]) group.orders.add(String(row[5]));
    if (row[12]) group.models.add(catalogClean_(row[12]));
    if (row[13]) group.materials.add(catalogClean_(row[13]));

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
        group.key,
        canonical,
        [...group.descriptions].join(" | "),
        detail,
        category,
        unit,
        manual.price === undefined ? "" : manual.price,
        Boolean(manual.validated),
        group.orders.size,
        distinctRates.slice(0, 20).join(" · "),
        rates.length ? rates[0] : "",
        rates.length ? catalogMedian_(rates) : "",
        rates.length ? rates[rates.length - 1] : "",
        [...group.orders].slice(0, 10).join(", "),
        [...group.models].slice(0, 8).join(" | "),
        [...group.materials].slice(0, 8).join(" | "),
        group.signals.join(" || "),
        rule,
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
      canonical: catalogClean_(row[1]),
      unit: catalogClean_(row[5]),
      price: row[6],
      validated: row[7] === true,
      rule: catalogClean_(row[17]),
      notes: catalogClean_(row[19])
    });
  });
  return out;
}

function catalogWriteVisibleHeader_(sheet) {
  const headers = [[
    "Clave ítem",
    "Ítem canónico",
    "Variante observada",
    "Detalle / acabado / referencia",
    "Categoría sugerida",
    "Unidad sugerida",
    "Precio actual (€)",
    "Validado por padre",
    "Nº apariciones",
    "Precios unitarios históricos",
    "Precio hist. mín.",
    "Precio hist. mediana",
    "Precio hist. máx.",
    "Pedidos ejemplo",
    "Modelos asociados",
    "Materiales asociados",
    "Señales en nota / especificaciones",
    "Regla de generación",
    "Fuente última",
    "Observaciones"
  ]];
  sheet.getRange(1, 1, 1, headers[0].length).setValues(headers)
    .setBackground("#15607f")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle")
    .setWrap(true);
}

function catalogWriteRawHeader_(sheet) {
  sheet.getRange(1, 1, 1, 17).setValues([[
    "File ID", "Archivo", "URL", "Hoja", "Fila", "Pedido",
    "Descripción", "Detalle", "Categoría", "Unidad sugerida",
    "Precio unitario inferido", "Importe línea", "Modelo", "Material",
    "Especificaciones", "Medidas / croquis", "Texto conmemorativo"
  ]]);
}

function catalogAppendRawRows_(sheet, rows) {
  if (!rows.length) return;
  const start = Math.max(2, sheet.getLastRow() + 1);
  sheet.getRange(start, 1, rows.length, 17).setValues(rows);
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
  ScriptApp.newTrigger(CATALOGO_ALBARAN_CONTINUATION)
    .timeBased()
    .after(60 * 1000)
    .create();
}

function catalogRemoveContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === CATALOGO_ALBARAN_CONTINUATION) ScriptApp.deleteTrigger(trigger);
  });
}

function catalogDriveFileId_(url) {
  const raw = catalogClean_(url);
  if (!raw) return "";
  const patterns = [
    /\/d\/([A-Za-z0-9_-]{20,})/,
    /[?&]id=([A-Za-z0-9_-]{20,})/,
    /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/
  ];
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
    "albaran", "pedido n", "pedido nº", "pedido no", "fecha", "concepto",
    "material", "precio", "cantidad", "largo", "ancho", "grueso", "m/2",
    "m2", "suma", "i.v.a.", "iva", "r.e.", "re", "total"
  ].includes(normalized);
}

function catalogLooksLikeWorkshopItem_(description, detail) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  return [
    "corte", "cortar", "pulir", "pulido", "canto", "repisa", "cornisa",
    "coronacion", "columna", "inscripcion", "cruz", "jardinera", "florero",
    "retacear", "rebaje", "canal", "forma", "abujard", "relieve", "foto",
    "imagen", "placa", "transporte", "colocacion", "limpieza", "nicho"
  ].some(term => value.includes(term));
}

function catalogCategory_(description, detail) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  const rules = [
    ["Inscripción", ["inscripcion", "letra", "texto"]],
    ["Ornamento", ["cruz", "imagen", "foto", "relieve", "placa"]],
    ["Accesorio", ["jardinera", "florero", "jarron"]],
    ["Piedra / pieza", ["repisa", "cornisa", "coronacion", "columna", "tapa", "lapida"]],
    ["Acabado", ["pulir", "pulido", "canto", "abujard", "bisel", "rebaje", "canal"]],
    ["Corte / taller", ["corte", "cortar", "retacear", "forma"]],
    ["Servicio", ["transporte", "colocacion", "limpieza", "montaje"]]
  ];
  for (const [category, terms] of rules) {
    if (terms.some(term => value.includes(term))) return category;
  }
  return "Otros";
}

function catalogUnit_(description, detail, nums, lineTotal, mode) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  if (["inscripcion", "cruz", "jardinera", "florero", "placa", "columna"].some(term => value.includes(term))) return "ud";
  if (["canto", "pulir", "pulido"].some(term => value.includes(term)) && mode === "E*F") return "m";
  if (["corte", "repisa", "cornisa", "coronacion", "lapida", "tapa"].some(term => value.includes(term)) && mode === "G/F") return "m²";
  if (mode === "E*F" || mode === "G/B") return "ud";
  if (lineTotal !== null) return "trabajo";
  return "revisar";
}

function catalogSuggestedRule_(description, detail, category) {
  const value = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  const terms = [
    "repisa", "cornisa", "coronacion", "columna", "inscripcion", "cruz",
    "jardinera", "florero", "foto", "imagen", "relieve", "abujardado",
    "pulir cantos", "canto pulido", "retacear", "cortar material"
  ].filter(term => value.includes(term));
  if (terms.length) return `Si la nota/especificaciones indican: ${terms.slice(0, 3).join(" / ")}`;
  return `${category}: revisar correspondencia con la nota antes de automatizar.`;
}

function catalogSignal_(id, specs, measures) {
  const text = [catalogClean_(specs), catalogClean_(measures)].filter(Boolean).join(" · ");
  if (!text) return "";
  const compact = text.length > 180 ? `${text.slice(0, 177)}…` : text;
  return `${id}: ${compact}`;
}

function catalogItemKey_(description, detail) {
  return `${catalogNormalize_(description)}|${catalogNormalize_(detail)}`
    .replace(/\s+/g, " ")
    .trim();
}

function catalogCount_(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function catalogMostCommon_(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function catalogMedian_(values) {
  if (!values.length) return "";
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function catalogLastPositiveNumber_(nums, preferredCol) {
  if (nums[preferredCol] !== null) return nums[preferredCol];
  for (let col = nums.length - 1; col >= 0; col -= 1) {
    if (nums[col] !== null) return nums[col];
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
  } else if (comma !== -1) {
    raw = raw.replace(/,/g, ".");
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function catalogClean_(value) {
  return String(value == null ? "" : value).trim();
}

function catalogNormalize_(value) {
  return catalogClean_(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[º°]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
