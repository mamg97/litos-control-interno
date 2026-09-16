/**
 * LITOS — sincronización de albaranes borrador con Catálogo operativo.
 *
 * Reglas:
 * - Catálogo operativo es el diccionario de precios activo.
 * - La columna F (Precio actual PROVISIONAL · REVISAR) se usa incluso si aún
 *   no está validada; la casilla G permite convertirla después en confirmada.
 * - Los borradores abiertos se regeneran cuando cambian notas, reglas o precios.
 * - Una lectura no validada impide CREAR un borrador nuevo, pero no impide
 *   sanear/regenerar un borrador que ya existe.
 * - Los albaranes definitivos NUNCA se modifican.
 */

const DRAFT_CATALOG_SHEET = "Catálogo operativo";
const DRAFT_CATALOG_SYNC_HANDLER = "sincronizarBorradoresConCatalogo";
const DRAFT_CATALOG_EDIT_HANDLER = "alEditarCatalogoOperativo_";
const DRAFT_CATALOG_SOON_HANDLER = "sincronizarBorradoresConCatalogoAhora_";
const DRAFT_CATALOG_SIG_PREFIX = "litos_draft_catalog_sig_";
const DRAFT_CATALOG_MAX_MS = 4.25 * 60 * 1000;
const DRAFT_CATALOG_MAX_REFRESH_PER_RUN = 8;

function instalarSincronizacionBorradoresCatalogo() {
  const spreadsheet = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    const handler = trigger.getHandlerFunction();
    if (["ensureCurrentQuarterDraftInvoices", DRAFT_CATALOG_SYNC_HANDLER, DRAFT_CATALOG_EDIT_HANDLER, DRAFT_CATALOG_SOON_HANDLER].includes(handler)) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  ScriptApp.newTrigger(DRAFT_CATALOG_SYNC_HANDLER).timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger(DRAFT_CATALOG_EDIT_HANDLER).forSpreadsheet(spreadsheet).onEdit().create();
  const firstRun = draftCatalogSync_(99);
  return { installed: true, removedOldTriggers: removed, firstRun };
}

function sincronizarBorradoresConCatalogo() {
  return draftCatalogSync_(DRAFT_CATALOG_MAX_REFRESH_PER_RUN);
}

function sincronizarTodosBorradoresConCatalogo() {
  return draftCatalogSync_(99);
}

function alEditarCatalogoOperativo_(event) {
  try {
    if (!event || !event.range) return;
    const range = event.range;
    const sheet = range.getSheet();
    if (sheet.getName() !== DRAFT_CATALOG_SHEET || range.getRow() < 2) return;
    if (range.getColumn() > 7 || range.getLastColumn() < 1) return;
    draftCatalogRemoveTriggersByHandler_(DRAFT_CATALOG_SOON_HANDLER);
    ScriptApp.newTrigger(DRAFT_CATALOG_SOON_HANDLER).timeBased().after(60 * 1000).create();
  } catch (error) {
    console.log(`No se pudo programar sincronización inmediata: ${error}`);
  }
}

function sincronizarBorradoresConCatalogoAhora_() {
  try {
    return draftCatalogSync_(99);
  } finally {
    draftCatalogRemoveTriggersByHandler_(DRAFT_CATALOG_SOON_HANDLER);
  }
}

function draftCatalogSync_(maxRefresh) {
  const startedAt = Date.now();
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otra ejecución en curso" };

  try {
    const book = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
    draftCatalogPreparePriceSheet_(book);
    const catalog = draftCatalogLoad_(book);
    const pedidos = book.getSheetByName("Pedidos");
    if (!pedidos) throw new Error("No se encontró la pestaña Pedidos.");

    const range = pedidos.getDataRange();
    const rawValues = range.getValues();
    const shownValues = range.getDisplayValues();
    const headerIndex = shownValues.findIndex(row => row.some(cell => draftClean_(cell) === DRAFT_ORDER_FIELDS.id));
    if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

    let headers = shownValues[headerIndex].map(draftClean_);
    if (!headers.includes(DRAFT_DOCUMENT_FIELDS.invoiceDraft)) {
      const last = pedidos.getLastColumn();
      pedidos.insertColumnAfter(last);
      pedidos.getRange(headerIndex + 1, last + 1).setValue(DRAFT_DOCUMENT_FIELDS.invoiceDraft);
      headers = [...headers, DRAFT_DOCUMENT_FIELDS.invoiceDraft];
    }
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));

    const documents = draftCatalogIndexDocuments_();
    const quarter = draftQuarterBounds_(new Date());
    const targetRoot = DriveApp.getFolderById(INVOICE_DRAFT_OUTPUT_FOLDER_ID);
    const systemFolder = DriveApp.getFolderById(INVOICE_DRAFT_SYSTEM_FOLDER_ID);
    const props = PropertiesService.getScriptProperties();

    const created = [];
    const updated = [];
    const unchanged = [];
    const definitive = [];
    const pendingValidation = [];
    const refreshedWhilePending = [];
    const deferred = [];
    const warnings = [];
    let refreshed = 0;

    for (let r = headerIndex + 1; r < shownValues.length; r += 1) {
      if (Date.now() - startedAt > DRAFT_CATALOG_MAX_MS) break;
      const shown = shownValues[r];
      const raw = rawValues[r];
      const id = draftClean_(shown[columns[DRAFT_ORDER_FIELDS.id]]);
      if (!/^\d{4}$/.test(id)) continue;

      const receipt = draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.receiptDate]])
        || draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.orderDate]])
        || draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.date]]);
      if (!receipt || receipt < quarter.start || receipt >= quarter.end) continue;

      const entry = documents.get(id) || {};
      if (entry.invoice) {
        definitive.push(id);
        props.deleteProperty(`${DRAFT_CATALOG_SIG_PREFIX}${id}`);
        syncDraftInvoiceCells_(pedidos, r + 1, columns, entry.invoice.url, "");
        continue;
      }

      const technicallyValidated = draftIsTechnicallyValidated_(shown, columns);
      // No crear un borrador nuevo a partir de una lectura dudosa. Sin embargo,
      // si ya existe un borrador, sí hay que regenerarlo para eliminar residuos
      // de plantilla y mantenerlo sincronizado con el catálogo.
      if (!technicallyValidated && !entry.invoiceDraft) {
        pendingValidation.push(id);
        continue;
      }
      if (!technicallyValidated && entry.invoiceDraft) refreshedWhilePending.push(id);

      const data = draftDataFromRow_(shown, raw, columns);
      const lines = draftCatalogLinesForData_(data, catalog);
      const signature = draftCatalogSignature_(data, lines);
      const sigKey = `${DRAFT_CATALOG_SIG_PREFIX}${id}`;
      const previousSignature = props.getProperty(sigKey) || "";

      if (entry.invoiceDraft && previousSignature === signature) {
        unchanged.push(id);
        syncDraftInvoiceCells_(pedidos, r + 1, columns, "", entry.invoiceDraft.url);
        continue;
      }
      if (refreshed >= maxRefresh) {
        deferred.push(id);
        continue;
      }

      const orderFolder = typeof litosOrderFolder_ === "function" ? litosOrderFolder_(targetRoot, id) : targetRoot;
      const result = draftCatalogWriteDraft_(data, lines, orderFolder, systemFolder, entry.invoiceDraft || null);
      documents.set(id, { ...entry, invoiceDraft: { fileId: result.file.getId(), url: result.file.getUrl(), name: result.file.getName() } });
      syncDraftInvoiceCells_(pedidos, r + 1, columns, "", result.file.getUrl());
      props.setProperty(sigKey, signature);
      refreshed += 1;

      if (result.replaced) updated.push(id);
      else created.push(id);
      warnings.push(...result.warnings.map(message => `${id}: ${message}`));
    }

    SpreadsheetApp.flush();
    const result = {
      quarter: `${quarter.start.getFullYear()}-T${Math.floor(quarter.start.getMonth() / 3) + 1}`,
      catalogItems: catalog.entries.length,
      created,
      updated,
      unchanged,
      definitive,
      pendingValidation,
      refreshedWhilePending,
      deferred,
      warnings: warnings.slice(0, 40)
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function draftCatalogPreparePriceSheet_(book) {
  const sheet = book.getSheetByName(DRAFT_CATALOG_SHEET);
  if (!sheet) throw new Error(`No existe la pestaña '${DRAFT_CATALOG_SHEET}'.`);
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return;
  sheet.getRange("F1").setValue("Precio actual PROVISIONAL (€) · REVISAR")
    .setNote("Este precio se usa para albaranes borrador. Revisar/editar; la casilla de validación permite marcarlo como confirmado.");
  sheet.getRange("I1").setValue("Precio histórico reciente");
  sheet.getRange("J1").setValue("Rango histórico depurado");
  if (lastRow < 2) return;

  const prices = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
  const recent = sheet.getRange(2, 9, lastRow - 1, 1).getDisplayValues();
  let changed = false;
  for (let i = 0; i < prices.length; i += 1) {
    if (draftCatalogNumber_(prices[i][0]) !== null) continue;
    const match = draftClean_(recent[i][0]).match(/^([0-9]+(?:[.,][0-9]+)?)/);
    if (!match) continue;
    prices[i][0] = Number(match[1].replace(",", "."));
    changed = true;
  }
  if (changed) sheet.getRange(2, 6, prices.length, 1).setValues(prices);
  sheet.getRange(2, 6, Math.max(1, lastRow - 1), 1)
    .setNumberFormat('#,##0.00 [$€-es-ES]')
    .setBackground("#fff2cc");
}

function draftCatalogLoad_(book) {
  const sheet = book.getSheetByName(DRAFT_CATALOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) throw new Error("Catálogo operativo vacío.");
  const shown = sheet.getDataRange().getDisplayValues();
  const raw = sheet.getDataRange().getValues();
  const headers = shown[0].map(draftClean_);
  const col = Object.fromEntries(headers.map((name, index) => [name, index]));
  const findCol = (...names) => {
    for (const name of names) if (col[name] !== undefined) return col[name];
    return -1;
  };
  const idx = {
    canonical: findCol("Ítem canónico"),
    variant: findCol("Variante / detalle"),
    category: findCol("Categoría"),
    unit: findCol("Unidad"),
    material: findCol("Material / condición"),
    price: findCol("Precio actual PROVISIONAL (€) · REVISAR", "Precio actual (€)"),
    validated: findCol("Validado por padre")
  };
  if (idx.canonical < 0 || idx.unit < 0 || idx.price < 0) throw new Error("Cabeceras de Catálogo operativo incompletas.");

  const entries = [];
  for (let r = 1; r < shown.length; r += 1) {
    const canonical = draftClean_(shown[r][idx.canonical]);
    if (!canonical) continue;
    const price = draftCatalogNumber_(raw[r][idx.price]);
    entries.push({
      canonical,
      canonicalN: draftNormalize_(canonical),
      variant: idx.variant >= 0 ? draftClean_(shown[r][idx.variant]) : "",
      variantN: idx.variant >= 0 ? draftNormalize_(shown[r][idx.variant]) : "",
      category: idx.category >= 0 ? draftClean_(shown[r][idx.category]) : "",
      unit: draftClean_(shown[r][idx.unit]),
      unitN: draftNormalize_(shown[r][idx.unit]),
      material: idx.material >= 0 ? draftClean_(shown[r][idx.material]) : "",
      materialN: idx.material >= 0 ? draftNormalize_(shown[r][idx.material]) : "",
      price,
      validated: idx.validated >= 0 && raw[r][idx.validated] === true,
      row: r + 1
    });
  }
  return { entries };
}
