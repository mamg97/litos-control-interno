/**
 * LITOS — importación automática de correos con etiqueta Gmail "saban".
 *
 * Flujo:
 * Gmail (saban) -> Drive operativo 2026 -> PEDIDOS M.S.
 *
 * La importación se integra con la lectura visual y el borrador mediante
 * procesarCorreosSabanCompleto(). Esta capa base se encarga de:
 * - detectar el ID del trabajo;
 * - guardar los adjuntos sin duplicarlos;
 * - crear/actualizar el pedido en el maestro sin pisar datos manuales;
 * - enlazar nota e imágenes anejas;
 * - registrar la fecha real de recepción del correo;
 * - dejar el pedido preparado para una lectura propuesta y su validación.
 *
 * La marca de mensaje procesado usa el ID interno de Gmail, de modo que ejecutar
 * esta función repetidamente no duplica trabajos ni adjuntos.
 */

const SABAN_MASTER_ID = "1ZS-L0eJmfukNr0rmc8ZvC3UxdVKw7Rnggx5TlRydZ2Q";
const SABAN_FOLDER_ID = "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_";
const SABAN_LABEL = "saban";
const SABAN_YEAR = 2026;
const SABAN_LOOKBACK_DAYS = 30;
const SABAN_ALLOWED_SENDER_PROPERTY = "SABAN_ALLOWED_SENDER";

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
    const allowedSender = sabanAuthorizedSender_(props);
    const query = `label:${SABAN_LABEL} from:${allowedSender} newer_than:${SABAN_LOOKBACK_DAYS}d`;
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
      skippedWrongSender: [],
      errors: []
    };

    for (const message of messages) {
      const messageId = message.getId();
      const processedKey = `litos_saban_msg_${messageId}`;
      const processedValue = props.getProperty(processedKey);
      if (processedValue) {
        let processedId = "";
        try {
          processedId = sabanClean_(JSON.parse(processedValue).id);
        } catch (_error) {
          // Una marca antigua o incompleta nunca debe ocultar un pedido.
        }

        if (processedId && rowById.has(processedId)) {
          result.skippedProcessed += 1;
          continue;
        }

        // Recuperación automática tras una ejecución interrumpida: si el
        // mensaje figura como procesado pero el pedido no existe en el
        // maestro, elimina la marca huérfana y vuelve a importarlo.
        props.deleteProperty(processedKey);
      }

      const date = message.getDate();
      if (!(date instanceof Date) || Number.isNaN(date.valueOf()) || date.getFullYear() !== SABAN_YEAR) {
        result.skippedWrongYear.push(messageId);
        continue;
      }
      if (!sabanIsAuthorizedSender_(message.getFrom(), allowedSender)) {
        result.skippedWrongSender.push({ messageId, from: message.getFrom() });
        continue;
      }

      try {
        const attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
        const id = sabanExtractId_(message.getSubject(), attachments);
        if (!id) {
          result.skippedNoId.push({ messageId, subject: message.getSubject() });
          continue;
        }

        // Desde este punto cada pedido tiene su propia subcarpeta dentro del
        // año. Los enlaces de Drive se conservan al mover un archivo, por lo
        // que esta organización no rompe la trazabilidad existente.
        const orderFolder = litosOrderFolder_(folder, id);
        const files = sabanSaveAttachments_(orderFolder, attachments, id, result.savedFiles);
        const classified = sabanClassifyFiles_(files, id);
        let rowNumber = rowById.get(id) || null;
        const isNew = !rowNumber;

        if (!rowNumber) {
          // Las fórmulas matriciales pueden extender getLastRow() más allá
          // del último pedido; la posición se calcula sobre los ID reales.
          rowNumber = Math.max(headerIndex + 1, ...Array.from(rowById.values())) + 1;
          if (rowNumber > sheet.getMaxRows()) {
            sheet.insertRowsAfter(sheet.getMaxRows(), rowNumber - sheet.getMaxRows());
          }
          rowById.set(id, rowNumber);
          sheet.getRange(rowNumber, columns[SABAN_HEADERS.id] + 1).setValue(Number(id));
        }

        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.receiptDate] + 1, date, "dd/MM/yyyy");
        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.receiptOrigin] + 1, "Gmail · saban");
        sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.readStatus] + 1, "Adjuntos recibidos · pendiente de lectura y validación");

        if (classified.note) {
          sabanSetIfBlank_(sheet, rowNumber, columns[SABAN_HEADERS.sourceFile] + 1, classified.note.getName());
          sabanSetSingleLink_(sheet, rowNumber, columns[SABAN_HEADERS.note] + 1, classified.note, "Abrir");
        }

        if (classified.images.length) {
          // El feed admite un enlace por celda: la carpeta permite acceder
          // a todos los adjuntos sin perder enlaces de texto enriquecido.
          sabanSetSingleLink_(sheet, rowNumber, columns[SABAN_HEADERS.attachments] + 1, orderFolder, "Ver adjuntos");
        }

        // La ficha nunca se transcribe directamente al maestro. Se crea una
        // fila de revisión separada, para que una lectura automática sea solo
        // una propuesta hasta que alguien la valide explícitamente.
        if (classified.note && typeof sabanEnsureHandwritingReview_ === "function") {
          sabanEnsureHandwritingReview_(book, {
            id,
            receiptDate: date,
            note: classified.note,
            source: "Gmail · saban"
          });
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
    console.log(JSON.stringify(result));

    // No ocultar fallos parciales: un activador debe quedar marcado como error
    // si algún correo candidato no pudo incorporarse al maestro.
    if (result.errors.length) {
      throw new Error(`Fallos al importar correos saban: ${JSON.stringify(result)}`);
    }

    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Flujo completo del activador:
 * correo -> Drive -> maestro -> lectura visual -> XLSX borrador.
 */
function procesarCorreosSabanCompleto() {
  const intake = importarCorreosSaban();
  const ids = Array.from(new Set([].concat(
    intake && intake.createdOrders || [],
    intake && intake.updatedOrders || []
  ).map(String)));
  // Si no hay correos nuevos, vuelve a intentar las lecturas pendientes o con
  // error temporal. Esto hace que una saturación puntual de Gemini (429/503)
  // se recupere sola en el siguiente ciclo del activador.
  const handwriting = typeof procesarLecturasManuscritasPendientes === "function"
    ? procesarLecturasManuscritasPendientes(ids.length ? ids : undefined)
    : { processed: [], review: [], errors: [] };
  const drafts = handwriting.processed.length && typeof ensureCurrentQuarterDraftInvoices === "function"
    ? ensureCurrentQuarterDraftInvoices()
    : { created: [], existing: [], definitive: [], pendingValidation: [] };
  const result = { intake, handwriting, drafts };
  console.log(JSON.stringify(result));
  if (handwriting.errors && handwriting.errors.length) {
    throw new Error(`Fallos en la lectura automática: ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * Instala una consulta periódica aproximada cada cinco minutos. Apps Script no
 * garantiza el minuto exacto, por lo que no sustituye una cola en tiempo real.
 * La consulta solo acepta la etiqueta y remitente configurados en las
 * propiedades privadas del proyecto.
 */
function installSabanMailTriggers() {
  const functionName = "procesarCorreosSabanCompleto";

  // Elimina cualquier programación anterior del flujo de correo.
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if ([functionName, "importarCorreosSaban"].includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Cuatro revisiones diarias del buzón, en horario de Madrid.
  [7, 11, 15, 19].forEach(hour => {
    ScriptApp.newTrigger(functionName)
      .timeBased()
      .atHour(hour)
      .nearMinute(0)
      .everyDays(1)
      .inTimezone("Europe/Madrid")
      .create();
  });

  return {
    installed: true,
    schedule: ["07:00", "11:00", "15:00", "19:00"],
    timezone: "Europe/Madrid"
  };
}

function removeSabanMailTriggers() {
  const functionNames = ["procesarCorreosSabanCompleto", "importarCorreosSaban"];
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (functionNames.includes(trigger.getHandlerFunction())) {
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
    const match = value.match(/(?:^|\D)(\d{4})(?:\D|$)/);
    if (match) return match[1];
  }
  return "";
}

function sabanAuthorizedSender_(properties) {
  const sender = sabanClean_(properties.getProperty(SABAN_ALLOWED_SENDER_PROPERTY)).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    throw new Error(
      `Configura la propiedad privada ${SABAN_ALLOWED_SENDER_PROPERTY} con el correo autorizado antes de activar la importación.`
    );
  }
  return sender;
}

function sabanIsAuthorizedSender_(from, allowedSender) {
  const shown = String(from || "").toLowerCase();
  const match = shown.match(/<([^>]+)>/) || shown.match(/([^\s<>]+@[^\s<>]+)/);
  return Boolean(match && String(match[1]).trim() === allowedSender);
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
  if (cell.getFormula() || sabanClean_(cell.getDisplayValue())) return;
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
