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

const MASTER_SPREADSHEET_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const INVOICE_DRAFT_TEMPLATE_ID = "1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY";
const INVOICE_DRAFT_SYSTEM_FOLDER_ID = "1QqDpXxdVab_qdHQ5hB3iqi8ML_gm7jGb";
const INVOICE_DRAFT_OUTPUT_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_";

// Este módulo es deliberadamente autónomo: no depende de los nombres de
// constantes del feed público, que puede desplegarse en otra revisión.
const DRAFT_ORDER_FIELDS = Object.freeze({
  id: "Pedido",
  date: "Fecha para dashboard",
  orderDate: "Fecha ficha",
  receiptDate: "Fecha recepción (email)",
  model: "Modelo",
  material: "Material",
  materialNormalized: "Material normalizado",
  width: "Ancho total (cm)",
  height: "Alto total (cm)",
  thickness: "Grosor (cm)"
});

const DRAFT_DOCUMENT_FIELDS = Object.freeze({
  invoice: "Archivo factura / albarán (XLSX)",
  invoiceDraft: "Factura borrador (XLSX)"
});

const DRAFT_FIELDS = Object.freeze({
  measures: "Notas de medidas y croquis",
  specifications: "Especificaciones",
  memorial: "Texto conmemorativo"
});

/**
 * Comando principal. Puede ejecutarse manualmente y también mediante el
 * trigger horario instalable de installDraftInvoiceTrigger().
 *
 * Importante: un borrador ya existente NO se regenera, porque puede contener
 * cambios manuales y precios añadidos por el taller. Solo se crea si falta.
 */
function ensureCurrentQuarterDraftInvoices() {
  // Un bloqueo por usuario evita duplicados de este generador sin quedar
  // secuestrado por los sincronizadores históricos instalados por otra cuenta.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otra ejecución en curso" };

  try {
    // Un trigger horario no tiene por qué tener una hoja activa. Abrir el
    // maestro por ID hace la tarea determinista también fuera del editor.
    const book = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
    const sheet = book.getSheetByName("Pedidos");
    if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

    const range = sheet.getDataRange();
    const values = range.getValues();
    const display = range.getDisplayValues();
    const headerIndex = display.findIndex((row) => row.some((cell) => draftClean_(cell) === DRAFT_ORDER_FIELDS.id));
    if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

    let headers = display[headerIndex].map(draftClean_);
    if (!headers.includes(DRAFT_DOCUMENT_FIELDS.invoiceDraft)) {
      const last = sheet.getLastColumn();
      sheet.insertColumnAfter(last);
      sheet.getRange(headerIndex + 1, last + 1).setValue(DRAFT_DOCUMENT_FIELDS.invoiceDraft);
      headers = [...headers, DRAFT_DOCUMENT_FIELDS.invoiceDraft];
    }
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
    const documents = draftIndexDocuments_(); // índice fresco, sin caché
    const targetFolder = DriveApp.getFolderById(INVOICE_DRAFT_OUTPUT_FOLDER_ID);
    const systemFolder = DriveApp.getFolderById(INVOICE_DRAFT_SYSTEM_FOLDER_ID);
    const quarter = draftQuarterBounds_(new Date());
    const created = [];
    const existing = [];
    const definitive = [];
    const pendingValidation = [];

    for (let rowIndex = headerIndex + 1; rowIndex < display.length; rowIndex += 1) {
      const shown = display[rowIndex];
      const raw = values[rowIndex];
      const id = draftClean_(shown[columns[DRAFT_ORDER_FIELDS.id]]);
      if (!/^\d{4}$/.test(id)) continue;

      const receipt = draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.receiptDate]])
        || draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.orderDate]])
        || draftDateValue_(raw[columns[DRAFT_ORDER_FIELDS.date]]);
      if (!receipt || receipt < quarter.start || receipt >= quarter.end) continue;

      // Un borrador solo nace cuando las especificaciones de la ficha han
      // pasado una revisión humana. Así una lectura manuscrita dudosa no
      // genera un documento de taller incompleto ni aparentemente definitivo.
      if (!draftIsTechnicallyValidated_(shown, columns)) {
        pendingValidation.push(id);
        continue;
      }

      const entry = documents.get(id) || {};
      if (entry.invoice) {
        definitive.push(id);
        // La definitiva manda. El borrador puede seguir físicamente en Drive,
        // pero deja de mostrarse como documento operativo.
        syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, entry.invoice, "");
        continue;
      }
      if (entry.invoiceDraft) {
        existing.push(id);
        syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, "", entry.invoiceDraft);
        continue;
      }

      const data = draftDataFromRow_(shown, raw, columns);
      // Los documentos nuevos viven dentro de la carpeta del ID, igual que
      // sus notas e imágenes. El índice recursivo los seguirá localizando.
      const orderFolder = typeof litosOrderFolder_ === "function"
        ? litosOrderFolder_(targetFolder, id)
        : targetFolder;
      const file = createDraftInvoiceFile_(data, orderFolder, systemFolder);
      const url = file.getUrl();
      documents.set(id, { ...entry, invoiceDraft: url });
      syncDraftInvoiceCells_(sheet, rowIndex + 1, columns, "", url);
      created.push({ id, url });
    }

    // Compatibilidad con las dos revisiones del índice de documentos.
    try {
      CacheService.getScriptCache().removeAll([
        "litos-current-documents-v1",
        "litos-current-documents-v2"
      ]);
    } catch (error) {
      // La caché es solo una optimización; no debe hacer fallar el proceso.
    }

    const result = {
      quarter: `${quarter.start.getFullYear()}-T${Math.floor(quarter.start.getMonth() / 3) + 1}`,
      created,
      existing,
      definitive,
      pendingValidation
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function draftIsTechnicallyValidated_(shown, columns) {
  const statusColumn = columns["Estado de lectura"];
  if (statusColumn === undefined) return false;
  const status = draftClean_(shown[statusColumn]).toLowerCase();
  return status.includes("validado manualmente")
    || status.includes("validado automáticamente")
    || status.includes("manuscrito revisado");
}

/**
 * Instala un trigger horario. Ejecutar una sola vez desde el editor de Apps
 * Script después de autorizar los permisos. Si ya existe no crea duplicados.
 */
function installDraftInvoiceTrigger() {
  const functionName = "ensureCurrentQuarterDraftInvoices";
  const alreadyInstalled = ScriptApp.getProjectTriggers()
    .some((trigger) => trigger.getHandlerFunction() === functionName);
  if (alreadyInstalled) return { installed: false, reason: "ya existe" };
  ScriptApp.newTrigger(functionName).timeBased().everyHours(1).create();
  return { installed: true };
}

function removeDraftInvoiceTrigger() {
  const functionName = "ensureCurrentQuarterDraftInvoices";
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { removed };
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
  // Cabecera. La fecha superior que existe como dibujo en la plantilla no se
  // modifica programáticamente; F14 sí contiene la fecha real del pedido.
  sheet.getRange("B14").setValue(Number(data.id));
  const documentDate = data.orderDate || data.receiptDate || "";
  // Guardar el texto visible evita que una zona horaria distinta desplace la
  // fecha un día al exportar el libro a XLSX.
  sheet.getRange("F14").setNumberFormat("@").setValue(documentDate);
  sheet.getRange("D16").setValue(data.model ? data.model.toUpperCase() : "");

  const material = draftMaterialCells_(data.materialNormalized || data.material);
  sheet.getRange("C18:D18").setValues([[material.family, material.variant]]);
  sheet.getRange("G18").clearContent(); // nunca heredar precio unitario

  // Limpiar el cuerpo variable conservando bordes y formato del albarán.
  sheet.getRange("A20:G36").clearContent();

  const thicknessM = data.thickness ? data.thickness / 100 : "";
  if (data.width && data.height) {
    sheet.getRange("A21:E21").setValues([["CORTE", 1, data.width / 100, data.height / 100, thicknessM]]);
    sheet.getRange("F21").setFormula("=B21*C21*D21");
    sheet.getRange("G21").setFormula("=F21*$G$18");
  }

  const specs = data.specifications || "";
  const materialLabel = draftMaterialShortLabel_(data.materialNormalized || data.material);

  // Los campos H/I del maestro describen el croquis/base, no necesariamente
  // las dimensiones físicas de una repisa. Por eso aquí no se inventan m².
  if (/\brepisa\b/i.test(specs)) {
    sheet.getRange("A22").setValue("REPISA");
    sheet.getRange("B22").setValue(draftOwnOrMaterial_(specs, "repisa", materialLabel));
  }
  if (/\b(cornisa|coronaci[oó]n)\b/i.test(specs)) {
    const label = /\bcoronaci[oó]n\b/i.test(specs) && !/\bcornisa\b/i.test(specs) ? "CORONACION" : "CORNISA";
    sheet.getRange("A23").setValue(label);
    sheet.getRange("B23").setValue(draftOwnOrMaterial_(specs, label === "CORNISA" ? "cornisa" : "coronación", materialLabel));
  }

  const structural = draftStructural_(specs);
  if (structural) {
    sheet.getRange("A25").setValue(structural.label);
    sheet.getRange("B25").setValue(structural.detail);
  }

  const image = draftImageOrCross_(specs);
  if (image) {
    sheet.getRange("A27").setValue(image.label);
    sheet.getRange("B27:D27").merge().setValue(image.detail).setWrap(true);
    sheet.getRange("E27").setValue(1);
    sheet.getRange("G27").setFormula("=E27*F27");
  }

  const inscription = draftInscription_(specs);
  sheet.getRange("A29").setValue("INSCRIPCION");
  sheet.getRange("B29:D29").merge().setValue(inscription || "[REVISAR TIPO]").setWrap(true);
  sheet.getRange("E29").setValue(1);
  sheet.getRange("G29").setFormula("=E29*F29");

  const accessory = draftAccessory_(specs);
  if (accessory) {
    sheet.getRange("A31").setValue(accessory.label);
    sheet.getRange("B31:D31").merge().setValue(accessory.detail).setWrap(true);
    sheet.getRange("E31").setValue(1);
    sheet.getRange("G31").setFormula("=E31*F31");
  }

  // Observaciones y texto conmemorativo deben quedar legibles al imprimir.
  const observationRange = sheet.getRange("B33:G35");
  observationRange.breakApart();
  observationRange.merge().setValue(draftObservations_(data)).setWrap(true).setVerticalAlignment("top");
  sheet.getRange("A33").setValue("OBS.");
  sheet.setRowHeights(33, 3, 24);

  // La plantilla histórica puede contener más de una línea de inscripción.
  // Se limpia todo el bloque antes de escribir para no heredar otro nombre.
  sheet.getRange("B43:G48").breakApart().clearContent();
  const memorialRange = sheet.getRange("B43:F43");
  memorialRange.breakApart();
  memorialRange.merge().setValue(draftMemorialText_(data.memorial)).setWrap(true).setVerticalAlignment("top");
  sheet.setRowHeight(43, 54);

  // Los precios quedan intencionadamente vacíos. Las fórmulas calculan el
  // total únicamente cuando el taller introduzca los importes reales.
  sheet.getRange("G37").setFormula("=SUM(G20:G36)");
  sheet.getRange("F38").setValue(0.21).setNumberFormat("0%");
  sheet.getRange("G38").setFormula("=G37*F38");
  sheet.getRange("F39").setValue(0.052).setNumberFormat("0.0%");
  sheet.getRange("G39").setFormula("=G37*F39");
  sheet.getRange("G40").setFormula("=SUM(G37:G39)");
}

function draftDataFromRow_(shown, raw, columns) {
  const getShown = (field) => columns[field] === undefined ? "" : draftClean_(shown[columns[field]]);
  const getRaw = (field) => columns[field] === undefined ? "" : raw[columns[field]];
  const n = (field) => draftNumberOrNull_(getShown(field));
  return {
    id: getShown(DRAFT_ORDER_FIELDS.id),
    orderDate: getShown(DRAFT_ORDER_FIELDS.orderDate),
    receiptDate: getShown(DRAFT_ORDER_FIELDS.receiptDate),
    model: getShown(DRAFT_ORDER_FIELDS.model),
    material: getShown(DRAFT_ORDER_FIELDS.material),
    materialNormalized: getShown(DRAFT_ORDER_FIELDS.materialNormalized),
    width: n(DRAFT_ORDER_FIELDS.width),
    height: n(DRAFT_ORDER_FIELDS.height),
    thickness: n(DRAFT_ORDER_FIELDS.thickness),
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
  setLink(DRAFT_DOCUMENT_FIELDS.invoice, invoiceUrl, "Abrir");
  setLink(DRAFT_DOCUMENT_FIELDS.invoiceDraft, draftUrl, "Abrir borrador");
}

function draftIndexDocuments_() {
  const result = new Map();
  const visit = (folder) => {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = draftClean_(file.getName());
      const idMatch = name.match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
      const extMatch = name.toLowerCase().match(/\.([a-z0-9]+)$/);
      if (!idMatch || !extMatch || !["xlsx", "xls", "xlsm"].includes(extMatch[1])) continue;
      const id = idMatch[1];
      const normalized = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const kind = /(?:^|[-_ ])borrador(?:[-_ .]|$)/.test(normalized) ? "invoiceDraft" : "invoice";
      const entry = result.get(id) || {};
      if (!entry[kind]) entry[kind] = file.getUrl();
      result.set(id, entry);
    }
    const folders = folder.getFolders();
    while (folders.hasNext()) visit(folders.next());
  };
  visit(DriveApp.getFolderById(INVOICE_DRAFT_OUTPUT_FOLDER_ID));
  return result;
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
  const raw = draftClean_(value);
  if (!raw) return null;
  const es = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (es) {
    const year = Number(es[3].length === 2 ? `20${es[3]}` : es[3]);
    return new Date(year, Number(es[2]) - 1, Number(es[1]));
  }
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : null;
}

function draftNumberOrNull_(value) {
  const raw = draftClean_(value);
  if (!raw) return null;
  let normalized = raw.replace(/[^0-9,.-]/g, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    normalized = normalized
      .replace(decimal === "," ? /\./g : /,/g, "")
      .replace(decimal, ".");
  } else if (comma >= 0) {
    normalized = normalized.replace(/,/g, ".");
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function draftMaterialCells_(value) {
  const original = draftClean_(value);
  const normalized = draftNormalize_(original);
  if (!normalized) return { family: "", variant: "" };
  if (normalized.includes("porcelana")) return { family: "PORCELANA", variant: "" };
  if (normalized.includes("suyo")) return { family: "SUYO", variant: "" };
  if (normalized.includes("macael") || normalized === "blanco") return { family: "MARMOL", variant: "BLANCO MACAEL" };
  if (normalized.includes("italia")) return { family: "MARMOL", variant: "ITALIANO" };
  if (normalized.includes("crema marfil")) return { family: "MARMOL", variant: "CREMA MARFIL" };
  if (normalized.includes("granito")) {
    return { family: "GRANITO", variant: original.replace(/^granito\s+/i, "").toUpperCase() };
  }
  if (normalized.includes("champ")) return { family: "GRANITO", variant: "CHAMPAGNE" };
  if (normalized.includes("sudafrica")) return { family: "GRANITO", variant: "NEGRO SUDAFRICA" };
  if (normalized.includes("absoluto")) return { family: "GRANITO", variant: "NEGRO ABSOLUTO" };
  return { family: original.toUpperCase(), variant: "" };
}

function draftMaterialShortLabel_(value) {
  const material = draftMaterialCells_(value);
  if (material.variant) return material.variant;
  return material.family || "";
}

function draftOwnOrMaterial_(specs, component, materialLabel) {
  const labeled = draftLabeledValue_(specs, component);
  if (labeled) {
    const normalizedLabeled = draftNormalize_(labeled);
    if (/\bsuy[oa]s?\b/.test(normalizedLabeled)) return "SUYA";
  }
  const normalized = draftNormalize_(specs);
  const key = draftNormalize_(component);
  const index = normalized.indexOf(key);
  if (index >= 0) {
    const tail = normalized.slice(index, index + 80);
    if (/\bsuy[oa]s?\b/.test(tail)) return "SUYA";
    if (/\bitalia\b/.test(tail)) return "ITALIA";
    if (/\bchamp/.test(tail)) return "CHAMPAGNE";
    if (/\bsudafrica\b/.test(tail)) return "SUDAFRICA";
    if (/\babsoluto\b/.test(tail)) return "NEGRO ABSOLUTO";
    if (/\bblanco\b|\bbl\b/.test(tail)) return "BLANCO";
  }
  return materialLabel;
}

function draftStructural_(specs) {
  const raw = draftClean_(specs);
  let match = raw.match(/\b(\d+)\s+barras?\s+de\s+z\b/i);
  if (match) return { label: "BARRAS Z", detail: match[1] };
  match = raw.match(/\b(columnas?|pilastras?)\s*([^.;]*)/i);
  if (match) return { label: match[1].toUpperCase(), detail: draftClean_(match[2]) };
  match = raw.match(/\btabica(?:\/tacos)?\s*([^.;]*)/i);
  if (match) return { label: "TABICA", detail: draftClean_(match[1]) };
  match = raw.match(/\bgarras?\s+de\s+([^.;]+)/i);
  if (match) return { label: "GARRAS", detail: `DE ${draftClean_(match[1]).toUpperCase()}` };
  return null;
}

function draftInscription_(specs) {
  let detail = draftLabeledValue_(specs, "inscripción");
  if (!detail) {
    const sentence = draftClean_(specs).match(/inscripci[oó]n\s+([^.;,]*)/i);
    if (!sentence) return "";
    detail = draftClean_(sentence[1]);
  }
  detail = detail.replace(/\bs\/(foto|diseño|suya)\b/gi, "").replace(/\s+/g, " ").trim();
  return detail.toUpperCase();
}

function draftImageOrCross_(specs) {
  const raw = draftClean_(specs);
  let match = raw.match(/\b(cruz|crucificado)\b\s*([^.;]*)/i);
  if (match) return { label: "CRUZ", detail: draftClean_(match[2]) };
  const image = draftLabeledValue_(raw, "imagen");
  if (image) return { label: "IMAGEN", detail: image };
  return null;
}

function draftAccessory_(specs) {
  const raw = draftClean_(specs);
  const flowerVase = draftLabeledValue_(raw, "florero");
  if (flowerVase) return { label: "FLORERO", detail: flowerVase };
  let match = raw.match(/\b(jardinera)\s*([^.;]*)/i);
  if (match) return { label: "JARDINERA", detail: draftClean_(match[2]) };
  match = raw.match(/\b(florero(?:s)?)\s*([^.;]*)/i);
  if (match) return { label: "FLORERO", detail: draftClean_(match[2]) };
  return null;
}

function draftLabeledValue_(specs, label) {
  const raw = draftClean_(specs);
  const aliases = {
    "inscripción": "inscripci[oó]n",
    "coronación": "coronaci[oó]n"
  };
  const key = aliases[label] || String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = "modelo|corte|imagen|florero|inscripci[oó]n|repisa|cornisa|coronaci[oó]n";
  const match = raw.match(new RegExp(`(?:^|[,;])\\s*${key}\\s*:\\s*(.*?)(?=\\s*[,;]\\s*(?:${next})\\s*:|$)`, "i"));
  return match ? draftClean_(match[1]) : "";
}

function regenerarBorradores7927y7928() {
  const ids = new Set(["7927", "7928"]);
  const root = DriveApp.getFolderById(INVOICE_DRAFT_OUTPUT_FOLDER_ID);
  ids.forEach((id) => {
    const folders = root.getFoldersByName(id);
    while (folders.hasNext()) {
      const files = folders.next().getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = draftClean_(file.getName());
      const match = name.match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
      if (match && ids.has(match[1]) && /(?:^|[-_ ])borrador(?:[-_ .]|$)/i.test(name)) {
        file.setTrashed(true);
      }
    }
    }
  });
  return ensureCurrentQuarterDraftInvoices();
}

function draftObservations_(data) {
  const items = [];
  if (data.measures) items.push(data.measures);
  if (data.specifications) items.push(data.specifications);
  return items.join("\n");
}

function draftMemorialText_(value) {
  return draftClean_(value).split(/\s*\|\s*/).filter(Boolean).join("\n");
}

function draftNormalize_(value) {
  return draftClean_(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function draftClean_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}
