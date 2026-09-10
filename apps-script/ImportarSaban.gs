/**
 * LITOS — importación automática de correos con etiqueta Gmail "saban".
 *
 * Flujo:
 * Gmail (saban) -> Drive operativo 2026 -> PEDIDOS M.S.
 *
 * Esta primera capa NO interpreta todavía la nota con IA. Se encarga de:
 * - detectar el ID del trabajo;
 * - guardar los adjuntos sin duplicarlos;
 * - crear/actualizar el pedido en el maestro sin pisar datos manuales;
 * - enlazar nota e imágenes anejas;
 * - registrar la fecha real de recepción del correo;
 * - dejar el pedido preparado para la fase Gemini y para el borrador de albarán.
 *
 * La marca de mensaje procesado usa el ID interno de Gmail, de modo que ejecutar
 * esta función repetidamente no duplica trabajos ni adjuntos.
 */

const SABAN_MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const SABAN_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_";
const SABAN_LABEL = "saban";
const SABAN_YEAR = 2026;
const SABAN_LOOKBACK_DAYS = 14;

const SABAN_HEADERS = Object.freeze({
  id: "Pedido",
  orderDate: "Fecha ficha",
  sourceFile: "Archivo de ficha",
  readStatus: "Estado de lectura",
  receiptDate: "Fecha recepción (email)",
  receiptOrigin: "Origen fecha recepción",
  note: "Notas",
  attachments: "Imágenes anejas"
});

function importarCorreosSaban() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otra importación en curso" };

  try {
    const label = GmailApp.getUserLabelByName(SABAN_LABEL);
    if (!label) throw new Error(`No existe la etiqueta de Gmail '${SABAN_LABEL}'.`);

    const book = SpreadsheetApp.openById(SABAN_MASTER_ID);
    const sheet = book.getSheetByName("Pedidos");
    if (!sheet) throw new Error("No se encontró la pestaña Pedidos.");

    const display = sheet.getDataRange().getDisplayValues();
    const headerIndex = display.findIndex(row => row.some(cell => sabanClean_(cell) === SABAN_HEADERS.id));
    if (headerIndex < 0) throw new Error("No se encontró la cabecera Pedido.");

    const headers = display[headerIndex].map(sabanClean_);
    const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
    Object.values(SABAN_HEADERS).forEach(header => {
      if (columns[header] === undefined) throw new Error(`Falta la columna '${header}' en Pedidos.`);
    });

    const rowById = new Map();
    for (let i = headerIndex + 1; i < display.length; i += 1) {
      const id = sabanClean_(display[i][columns[SABAN_HEADERS.id]]);
      if (id) rowById.set(id, i + 1);
    }

    const folder = DriveApp.getFolderById(SABAN_FOLDER_ID);
    const props = PropertiesService.getScriptProperties();
    const query = `label:${SABAN_LABEL} newer_than:${SABAN_LOOKBACK_DAYS}d`;
    const threads = GmailApp.search(query, 0, 100);
    const messages = [];
    threads.forEach(thread => thread.getMessages().forEach(message => messages.push(message)));
    messages.sort((a, b) => a.getDate().getTime() - b.getDate().getTime());

    const result = {
      scanned: messages.length,
      importedMessages: 0,
      createdOrders: [],
      updatedOrders: [],
      savedFiles: [],
      skippedProcessed: 0,
      skippedNoId: [],
      skippedWrongYear: [],
      errors: []
    };

    for (const message of messages) {
      const messageId = message.getId();
      const processedKey = `litos_saban_msg_${messageId}`;
      if (props.getProperty(processedKey)) {
        result.skippedProcessed += 1;
        continue;
      }

      const date = message.getDate();
      if (!(date instanceof Date) || Number.isNaN(date.valueOf()) || date.getFullYear() !== SABAN_YEAR) {
        result.skippedWrongYear.push(messageId);
        continue;
      }

      try {
        const attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
        const id = sabanExtractId_(message.getSubject(), attachments);
        if (!id) {
          result.skippedNoId.push({ messageId, subject: message.getSubject() });
          continue;
        }

        const files = sabanSaveAttachments_(folder, attachments, id, result.savedFiles);
        const classified = sabanClassifyFiles_(files, id);
        let rowNumber = rowById.get(id) || null;
        const isNew = !rowNumber;

        if (!rowNumber) {
          rowNumber = Math.max(sheet.getLastRow() + 1, headerIndex + 2);
          rowById.set(id, rowNumber);
          sheet.getRange(rowNumber, columns[SABAN_HEADERS.id] + 1).setValue(Number(id));
        }

        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.receiptDate] + 1, date, "dd/MM/yyyy");
        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.receiptOrigin] + 1, "Gmail · saban");
        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.readStatus] + 1, "Importado automáticamente · pendiente IA");

        if (classified.note) {
          sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.sourceFile] + 1, classified.note.getName());
          sabanSetSingleLink_(sheet, rowNumber, columns[SABAN_HEADERS.note] + 1, classified.note, "Abrir");
        }

        if (classified.images.length) {
          sabanSetMultiLinks_(sheet, rowNumber, columns[SABAN_HEADERS.attachments] + 1, classified.images);
        }

        props.setProperty(processedKey, JSON.stringify({ id, date: new Date().toISOString() }));
        result.importedMessages += 1;
        (isNew ? result.createdOrders : result.updatedOrders).push(id);
      } catch (error) {
        result.errors.push({
          messageId,
          subject: message.getSubject(),
          error: String(error && error.message || error)
        });
      }
    }

    SpreadsheetApp.flush();

    // Si más adelante incorporamos DraftInvoices.gs al proyecto, una importación
    // nueva puede disparar la creación de borradores sin cambiar este código.
    if (result.importedMessages > 0 && typeof ensureCurrentQuarterDraftInvoices === "function") {
      try { result.drafts = ensureCurrentQuarterDraftInvoices(); }
      catch (error) { result.errors.push({ stage: "drafts", error: String(error && error.message || error) }); }
    }

    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Instala cuatro consultas diarias: aproximadamente 07:00, 11:00, 15:00 y 19:00
 * hora Europe/Madrid. Apps Script no garantiza el minuto exacto; nearMinute(0)
 * suele ejecutar dentro de una ventana aproximada de +/- 15 minutos.
 */
function installSabanMailTriggers() {
  const functionName = "importarCorreosSaban";

  // Evita duplicar disparadores si se ejecuta varias veces.
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(trigger);
  });

  const hours = [7, 11, 15, 19];
  hours.forEach(hour => {
    ScriptApp.newTrigger(functionName)
      .timeBased()
      .atHour(hour)
      .nearMinute(0)
      .everyDays(1)
      .inTimezone("Europe/Madrid")
      .create();
  });

  return { installed: true, hours, timezone: "Europe/Madrid", minute: "~00 (±15 min aprox.)" };
}

function removeSabanMailTriggers() {
  const functionName = "importarCorreosSaban";
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { removed };
}

function sabanExtractId_(subject, attachments) {
  const candidates = [String(subject || "")];
  (attachments || []).forEach(attachment => candidates.push(String(attachment.getName() || "")));
  for (const value of candidates) {
    const match = value.match(/(?:^|\D)([789]\d{3})(?:\D|$)/);
    if (match) return match[1];
  }
  return "";
}

function sabanSaveAttachments_(folder, attachments, id, savedLog) {
  const files = [];
  (attachments || []).forEach((attachment, index) => {
    let name = sabanClean_(attachment.getName());
    if (!name) name = `${id}-adjunto-${index + 1}${sabanExtensionFromContentType_(attachment.getContentType())}`;
    if (!new RegExp(`^${id}(?:\D|$)`).test(name)) name = `${id}-${name}`;

    const existing = folder.getFilesByName(name);
    if (existing.hasNext()) {
      files.push(existing.next());
      return;
    }

    const blob = attachment.copyBlob().setName(name);
    const file = folder.createFile(blob);
    files.push(file);
    savedLog.push(name);
  });
  return files;
}

function sabanClassifyFiles_(files, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const notePattern = new RegExp(`^${escaped}[-_ ]0(?:[-_. ]|$)`, "i");
  const imagePattern = /\.(jpe?g|png|heic|webp)$/i;

  let note = files.find(file => notePattern.test(file.getName())) || null;
  const images = files.filter(file => imagePattern.test(file.getName()) && (!note || file.getId() !== note.getId()));

  // Si solo llegó una imagen y no lleva -0, la tratamos como ficha principal.
  if (!note && files.length === 1 && imagePattern.test(files[0].getName())) {
    note = files[0];
  }

  return { note, images };
}

function sabanSetIfBlank_(sheet, row, column, value, numberFormat) {
  const cell = sheet.getRange(row, column);
  if (sabanClean_(cell.getDisplayValue())) return;
  cell.setValue(value);
  if (numberFormat) cell.setNumberFormat(numberFormat);
}

function sabanSetSingleLink_(sheet, row, column, file, label) {
  const builder = SpreadsheetApp.newRichTextValue().setText(label).setLinkUrl(file.getUrl());
  sheet.getRange(row, column).setRichTextValue(builder.build());
}

function sabanSetMultiLinks_(sheet, row, column, files) {
  const unique = [];
  const seen = new Set();
  files.forEach(file => {
    if (seen.has(file.getId())) return;
    seen.add(file.getId());
    unique.push(file);
  });
  if (!unique.length) return;

  const labels = unique.map((_, i) => `Abrir ${i + 1}`);
  const text = labels.join(" · ");
  const builder = SpreadsheetApp.newRichTextValue().setText(text);
  let cursor = 0;
  unique.forEach((file, i) => {
    const label = labels[i];
    builder.setLinkUrl(cursor, cursor + label.length, file.getUrl());
    cursor += label.length + (i < unique.length - 1 ? 3 : 0);
  });
  sheet.getRange(row, column).setRichTextValue(builder.build());
}

function sabanExtensionFromContentType_(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("jpeg")) return ".jpg";
  if (type.includes("png")) return ".png";
  if (type.includes("pdf")) return ".pdf";
  if (type.includes("heic")) return ".heic";
  return "";
}

function sabanClean_(value) {
  return String(value == null ? "" : value).trim();
}
