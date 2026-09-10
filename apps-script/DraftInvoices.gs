/**
 * LITOS — generación de albaranes/facturas borrador.
 *
 * Un pedido está "en producción" cuando su fecha de recepción cae en el
 * trimestre actual y no existe un XLS/XLSX definitivo para su ID. Para esos
 * pedidos se garantiza un `<ID>_borrador.xlsx` en la carpeta operativa 2026.
 *
 * El borrador se crea desde una plantilla nativa de Google Sheets obtenida del
 * formato real del albarán 7917. Nunca se copian precios ni importes de otro
 * cliente: se rellenan únicamente los datos técnicos disponibles en Pedidos.
 * Cuando el taller renombra el mismo archivo y elimina `_borrador`, el índice
 * de documentos lo clasifica automáticamente como factura/albarán definitivo.
 */

const INVOICE_DRAFT_TEMPLATE_ID = "1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY";
const INVOICE_DRAFT_SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb";

const DRAFT_FIELDS = Object.freeze({
  measures: "Notas de medidas y croquis",
  specifications: "Especificaciones",
  memorial: "Texto conmemorativo"
});

/**
 * Comando principal. Puede ejecutarse manualmente y también mediante el
 * trigger horario instalable de installDraftInvoiceTrigger().
 */
function ensureCurrentQuarterDraftInvoices() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName("Pedidos");
  if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

  const range = sheet.getDataRange();
  const values = range.getValues();
  const display = range.getDisplayValues();
  const headerIndex = display.findIndex((row) => row.some((cell) => clean_(cell) === FIELDS.id));
  if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

  let headers = display[headerIndex].map(clean_);
  if (!headers.includes(DOCUMENT_FIELDS.invoiceDraft)) {
    const last = sheet.getLastColumn();
    sheet.insertColumnAfter(last);
    sheet.getRange(headerIndex + 1, last + 1).setValue(DOCUMENT_FIELDS.invoiceDraft);
    headers = [...headers, DOCUMENT_FIELDS.invoiceDraft];
  }
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const documents = indexCurrentDocuments_(); // índice fresco, sin caché
  const targetFolder = DriveApp.getFolderById(CURRENT_DOCUMENTS_FOLDER_ID);
  const systemFolder = DriveApp.getFolderById(INVOICE_DRAFT_SYSTEM_FOLDER_ID);
  const now = new Date();
  const quarter = draftQuarterBounds_(now);
  const created = [];
  const existing = [];
  const skipped = [];

  for (let rowIndex = headerIndex + 1; rowIndex < display.length; rowIndex += 1) {
    const shown = display[rowIndex];
    const raw = values[rowIndex];
    const id = clean_(shown[columns[FIELDS.id]]);
    if (!/^\d{4}$/.test(id)) continue;

    const receipt = draftDateValue_(raw[columns[FIELDS.receiptDate]])
      || draftDateValue_(raw[columns[FIELDS.orderDate]])
      || draftDateValue_(raw[columns[FIELDS.date]]);
    if (!receipt || receipt < quarter.start || receipt >= quarter.end) continue;

    const entry = documents.get(id) || {};
    if (entry.invoice) {
      skipped.push({ id, reason: "definitiva" });
      syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, entry.invoice, "");
      continue;
    }
    if (entry.invoiceDraft) {
      existing.push(id);
      syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, "", entry.invoiceDraft);
      continue;
    }

    const data = draftDataFromRow_(shown, raw, columns);
    const file = createDraftInvoiceFile_(data, targetFolder, systemFolder);
    const url = file.getUrl();
    const freshEntry = { ...entry, invoiceDraft: url };
    documents.set(id, freshEntry);
    syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, "", url);
    created.push({ id, url });
  }

  CacheService.getScriptCache().remove("litos-current-documents-v2");
  return {
    quarter: `${quarter.start.getFullYear()}-T${Math.floor(quarter.start.getMonth() / 3) + 1}`,
    created,
    existing,
    skipped
  };
}

/**
 * Instala un trigger horario. Ejecutar una sola vez desde el editor de Apps
 * Script. Si ya existe no crea duplicados.
 */
function installDraftInvoiceTrigger() {
  const functionName = "ensureCurrentQuarterDraftInvoices";
  const alreadyInstalled = ScriptApp.getProjectTriggers().some((trigger) => trigger.getHandlerFunction() === functionName);
  if (alreadyInstalled) return { installed: false, reason: "ya existe" };
  ScriptApp.newTrigger(functionName).timeBased().everyHours(1).create();
  return { installed: true };
}

function createDraftInvoiceFile_(data, targetFolder, systemFolder) {
  const template = DriveApp.getFileById(INVOICE_DRAFT_TEMPLATE_ID);
  const temp = template.makeCopy(`_${data.id}_tmp`, systemFolder);
  try {
    const book = SpreadsheetApp.openById(temp.getId());
    const sheet = book.getSheets()[0];
    fillDraftInvoice_(sheet, data);
    SpreadsheetApp.flush();

    const exportUrl = `https://docs.google.com/spreadsheets/d/${temp.getId()}/export?format=xlsx`;
    const response = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      throw new Error(`No se pudo exportar el borrador ${data.id}: HTTP ${response.getResponseCode()}`);
    }
    const blob = response.getBlob().setName(`${data.id}_borrador.xlsx`);
    return targetFolder.createFile(blob);
  } finally {
    temp.setTrashed(true);
  }
}

function fillDraftInvoice_(sheet, data) {
  // Cabecera del documento.
  sheet.getRange("B14").setValue(Number(data.id));
  sheet.getRange("F14").setValue(data.orderDate || data.receiptDate || "");
  sheet.getRange("D16").setValue(data.model ? data.model.toUpperCase() : "");

  const material = draftMaterialCells_(data.materialNormalized || data.material);
  sheet.getRange("C18:D18").setValues([[material.family, material.variant]]);
  sheet.getRange("G18").clearContent(); // el precio unitario nunca se hereda

  // Limpiar la zona variable manteniendo el formato de la plantilla.
  sheet.getRange("A20:G36").clearContent();

  const thicknessM = data.thickness ? data.thickness / 100 : "";
  if (data.width && data.height) {
    sheet.getRange("A21:E21").setValues([["CORTE", 1, data.width / 100, data.height / 100, thicknessM]]);
    sheet.getRange("F21").setFormula("=B21*C21*D21");
    sheet.getRange("G21").setFormula('=IF($G$18="","",F21*$G$18)');
  }

  const specs = data.specifications || "";
  const repisa = /\brepisa\b/i.test(specs);
  const cornisa = /\b(cornisa|coronaci[oó]n)\b/i.test(specs);
  if (repisa && data.baseWidth && data.baseHeight) {
    sheet.getRange("A22:E22").setValues([["REPISA", 1, data.baseWidth / 100, data.baseHeight / 100, thicknessM]]);
    sheet.getRange("F22").setFormula("=B22*C22*D22");
    sheet.getRange("G22").setFormula('=IF($G$18="","",F22*$G$18)');
  }
  if (cornisa && data.baseWidth) {
    sheet.getRange("A23:B23").setValues([["CORNISA", 1]]);
    sheet.getRange("C23").setValue(data.baseWidth / 100);
    const cornisaWidth = draftExplicitCentimetres_(specs, /cornisa[^.;]*?(\d+(?:[,.]\d+)?)\s*cm/i);
    if (cornisaWidth) sheet.getRange("D23").setValue(cornisaWidth / 100);
    if (thicknessM) sheet.getRange("E23").setValue(thicknessM);
    sheet.getRange("F23").setFormula('=IF(OR(C23="",D23=""),"",B23*C23*D23)');
    sheet.getRange("G23").setFormula('=IF(OR($G$18="",F23=""),"",F23*$G$18)');
  }

  const image = draftImageOrCross_(specs);
  if (image) {
    sheet.getRange("A27:B27").setValues([[image.label, image.detail]]);
    sheet.getRange("E27").setValue(1);
  }

  const inscription = draftInscription_(specs);
  sheet.getRange("A29").setValue("INSCRIPCION");
  if (inscription) sheet.getRange("C29").setValue(inscription);
  sheet.getRange("E29").setValue(1);
  sheet.getRange("G29").setFormula('=IF(F29="","",E29*F29)');

  const accessory = draftAccessory_(specs);
  if (accessory) {
    sheet.getRange("A31:C31").setValues([[accessory.label, accessory.detail, accessory.extra]]);
    sheet.getRange("E31").setValue(1);
    sheet.getRange("G31").setFormula('=IF(F31="","",E31*F31)');
  }

  sheet.getRange("A33").setValue("OBS.");
  sheet.getRange("B33").setValue([data.measures, data.specifications].filter(Boolean).join("\n"));
  sheet.getRange("B43").setValue(draftMemorialText_(data.memorial));

  // Fórmulas finales. Los importes permanecen a cero hasta que el taller
  // introduzca los precios que correspondan al trabajo real.
  sheet.getRange("G37").setFormula("=SUM(G20:G36)");
  sheet.getRange("F38").setValue(0.21);
  sheet.getRange("G38").setFormula("=G37*F38");
  sheet.getRange("F39").setValue(0.052);
  sheet.getRange("G39").setFormula("=G37*F39");
  sheet.getRange("G40").setFormula("=SUM(G37:G39)");
}

function draftDataFromRow_(shown, raw, columns) {
  const getShown = (field) => columns[field] === undefined ? "" : clean_(shown[columns[field]]);
  const getRaw = (field) => columns[field] === undefined ? "" : raw[columns[field]];
  const n = (field) => numberOrNull_(getShown(field));
  return {
    id: getShown(FIELDS.id),
    orderDate: draftDateValue_(getRaw(FIELDS.orderDate)),
    receiptDate: draftDateValue_(getRaw(FIELDS.receiptDate)),
    model: getShown(FIELDS.model),
    material: getShown(FIELDS.material),
    materialNormalized: getShown(FIELDS.materialNormalized),
    width: n(FIELDS.width),
    height: n(FIELDS.height),
    thickness: n(FIELDS.thickness),
    baseWidth: n(FIELDS.baseWidth),
    baseHeight: n(FIELDS.baseHeight),
    measures: getShown(DRAFT_FIELDS.measures),
    specifications: getShown(DRAFT_FIELDS.specifications),
    memorial: getShown(DRAFT_FIELDS.memorial)
  };
}

function syncDraftInvoiceCells_(sheet, rowNumber, columns, invoiceUrl, draftUrl) {
  const setLink = (field, url, label) => {
    const column = columns[field];
    if (column === undefined) return;
    const builder = SpreadsheetApp.newRichTextValue().setText(url ? label : "No disponible");
    if (url) builder.setLinkUrl(url);
    sheet.getRange(rowNumber, column + 1).setRichTextValue(builder.build());
  };
  if (invoiceUrl) setLink(DOCUMENT_FIELDS.invoice, invoiceUrl, "Abrir");
  setLink(DOCUMENT_FIELDS.invoiceDraft, draftUrl, "Abrir borrador");
}

function draftQuarterBounds_(date) {
  const year = date.getFullYear();
  const startMonth = Math.floor(date.getMonth() / 3) * 3;
  return {
    start: new Date(year, startMonth, 1, 0, 0, 0, 0),
    end: new Date(startMonth === 9 ? year + 1 : year, (startMonth + 3) % 12, 1, 0, 0, 0, 0)
  };
}

function draftDateValue_(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const raw = clean_(value);
  if (!raw) return null;
  const es = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (es) {
    const year = Number(es[3].length === 2 ? `20${es[3]}` : es[3]);
    return new Date(year, Number(es[2]) - 1, Number(es[1]));
  }
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null;
}

function draftMaterialCells_(value) {
  const normalized = clean_(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!normalized) return { family: "", variant: "" };
  if (normalized.includes("champ")) return { family: "GRANITO", variant: "CHAMPAGNE" };
  if (normalized.includes("sudafrica")) return { family: "GRANITO", variant: "SUDAFRICA" };
  if (normalized.includes("absoluto")) return { family: "GRANITO", variant: "NEGRO ABSOLUTO" };
  if (normalized.includes("italia")) return { family: "ITALIA", variant: "" };
  if (normalized.includes("macael") || normalized.includes("blanco")) return { family: "BLANCO", variant: "" };
  if (normalized.includes("porcelana")) return { family: "PORCELANA", variant: "" };
  if (normalized.includes("suyo")) return { family: "SUYO", variant: "" };
  return { family: clean_(value).toUpperCase(), variant: "" };
}

function draftInscription_(specs) {
  const match = clean_(specs).match(/inscripci[oó]n\s+(grabada|en\s+relieve|relieve|l[aá]ser|en\s+bronce)(?:\s+([^,.;]+))?/i);
  if (!match) return "";
  const kind = clean_(match[1]).toUpperCase().replace("EN ", "");
  const style = clean_(match[2]).replace(/^(s\/foto|s\/diseño|s\/suya)\s*/i, "");
  return [kind, style].filter(Boolean).join(" · ");
}

function draftImageOrCross_(specs) {
  const raw = clean_(specs);
  let match = raw.match(/\b(cruz|crucificado)\b\s*([^.;]*)/i);
  if (match) return { label: "CRUZ", detail: clean_(match[2]) };
  match = raw.match(/\bimagen\s*:\s*([^.;]*)/i);
  if (match) return { label: "IMAGEN", detail: clean_(match[1]) };
  return null;
}

function draftAccessory_(specs) {
  const raw = clean_(specs);
  let match = raw.match(/\b(jardinera)\s*([^.;]*)/i);
  if (match) return { label: "JARDINERA", detail: clean_(match[2]), extra: "" };
  match = raw.match(/\b(florero(?:s)?)\s*([^.;]*)/i);
  if (match) return { label: "FLORERO", detail: clean_(match[2]), extra: "" };
  return null;
}

function draftExplicitCentimetres_(specs, pattern) {
  const match = clean_(specs).match(pattern);
  if (!match) return null;
  const value = Number(String(match[1]).replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function draftMemorialText_(value) {
  return clean_(value).split(/\s*\|\s*/).filter(Boolean).join("\n");
}
