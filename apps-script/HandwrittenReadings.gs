/**
 * LITOS — zona segura de revisión de manuscritos.
 *
 * Principio operativo: una lectura automática propone; una persona valida;
 * solo la validación puede trasladar datos a la pestaña Pedidos. Esto evita
 * que una fecha, medida, nombre o nota ilegible termine en un albarán por
 * error.
 */

const HANDWRITING_REVIEW_SHEET = "Lecturas manuscritas";
const HANDWRITING_REVIEW_HEADERS = Object.freeze([
  "Pedido",
  "Fecha recepción",
  "Archivo de ficha",
  "Estado de revisión",
  "Modelo propuesto",
  "Material propuesto",
  "Ancho total (cm) propuesto",
  "Alto total (cm) propuesto",
  "Grosor (cm) propuesto",
  "Notas de medidas y croquis propuesta",
  "Especificaciones propuesta",
  "Texto conmemorativo propuesto",
  "Confianza global (0-100)",
  "Evidencia y dudas",
  "Fuente de lectura",
  "Actualizado",
  "Aplicado al maestro"
]);

const HANDWRITING_TARGETS = Object.freeze({
  "Modelo propuesto": "Modelo",
  "Material propuesto": "Material",
  "Ancho total (cm) propuesto": "Ancho total (cm)",
  "Alto total (cm) propuesto": "Alto total (cm)",
  "Grosor (cm) propuesto": "Grosor (cm)",
  "Notas de medidas y croquis propuesta": "Notas de medidas y croquis",
  "Especificaciones propuesta": "Especificaciones",
  "Texto conmemorativo propuesto": "Texto conmemorativo"
});

/** Crea o reutiliza la hoja separada de revisión. */
function sabanHandwritingReviewSheet_(book) {
  let sheet = book.getSheetByName(HANDWRITING_REVIEW_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(HANDWRITING_REVIEW_SHEET);
    sheet.getRange(1, 1, 1, HANDWRITING_REVIEW_HEADERS.length)
      .setValues([HANDWRITING_REVIEW_HEADERS])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Crea una única ficha de revisión por pedido, sin proponer contenido aún. */
function sabanEnsureHandwritingReview_(book, item) {
  const sheet = sabanHandwritingReviewSheet_(book);
  const values = sheet.getDataRange().getDisplayValues();
  const existingRow = values.findIndex((row, index) => index > 0 && sabanClean_(row[0]) === String(item.id));
  if (existingRow >= 0) return { created: false, row: existingRow + 1 };

  const link = SpreadsheetApp.newRichTextValue().setText("Abrir nota").setLinkUrl(item.note.getUrl()).build();
  const row = Array(HANDWRITING_REVIEW_HEADERS.length).fill("");
  row[0] = Number(item.id);
  row[1] = item.receiptDate;
  row[3] = "Pendiente de lectura";
  row[14] = item.source || "";
  row[15] = new Date();
  sheet.appendRow(row);
  const rowNumber = sheet.getLastRow();
  sheet.getRange(rowNumber, 2).setNumberFormat("dd/MM/yyyy");
  sheet.getRange(rowNumber, 3).setRichTextValue(link);
  sheet.getRange(rowNumber, 16).setNumberFormat("dd/MM/yyyy HH:mm");
  return { created: true, row: rowNumber };
}

/**
 * Guarda la respuesta estructurada de un motor de visión en la zona de
 * revisión. No escribe nunca en Pedidos. Los campos dudosos deben llegar
 * vacíos y explicados en "Evidencia y dudas".
 */
function registrarPropuestaManuscrita(pedido, propuesta) {
  const book = SpreadsheetApp.openById(SABAN_MASTER_ID);
  const sheet = sabanHandwritingReviewSheet_(book);
  const values = sheet.getDataRange().getDisplayValues();
  const rowIndex = values.findIndex((row, index) => index > 0 && sabanClean_(row[0]) === String(pedido));
  if (rowIndex < 0) throw new Error(`No existe una ficha de revisión para el pedido ${pedido}.`);

  const validation = validarPropuestaManuscrita_(pedido, propuesta || {});
  const headers = values[0].map(sabanClean_);
  const column = Object.fromEntries(headers.map((header, index) => [header, index + 1]));
  const row = rowIndex + 1;
  Object.entries(validation.values).forEach(([header, value]) => {
    if (column[header]) sheet.getRange(row, column[header]).setValue(value);
  });
  sheet.getRange(row, column["Estado de revisión"]).setValue(validation.status);
  sheet.getRange(row, column["Evidencia y dudas"]).setValue(validation.notes);
  sheet.getRange(row, column["Fuente de lectura"]).setValue(validation.source);
  sheet.getRange(row, column.Actualizado).setValue(new Date()).setNumberFormat("dd/MM/yyyy HH:mm");
  return validation;
}

/**
 * Traslada solo las filas que una persona haya marcado exactamente como
 * "Validado". Nunca sobrescribe una celda ya completada en Pedidos.
 */
function aplicarLecturasValidadas() {
  const book = SpreadsheetApp.openById(SABAN_MASTER_ID);
  const review = book.getSheetByName(HANDWRITING_REVIEW_SHEET);
  const orders = book.getSheetByName("Pedidos");
  if (!review || !orders) throw new Error("Falta la hoja de revisión o Pedidos.");

  const reviewValues = review.getDataRange().getValues();
  const reviewHeaders = reviewValues[0].map(sabanClean_);
  const reviewColumns = Object.fromEntries(reviewHeaders.map((header, index) => [header, index]));
  const orderValues = orders.getDataRange().getDisplayValues();
  const orderHeaderIndex = orderValues.findIndex((row) => row.some((cell) => sabanClean_(cell) === "Pedido"));
  if (orderHeaderIndex < 0) throw new Error("No se encontró la cabecera Pedido.");
  const orderHeaders = orderValues[orderHeaderIndex].map(sabanClean_);
  const orderColumns = Object.fromEntries(orderHeaders.map((header, index) => [header, index]));
  const orderRows = new Map();
  for (let i = orderHeaderIndex + 1; i < orderValues.length; i += 1) {
    const id = sabanClean_(orderValues[i][orderColumns.Pedido]);
    if (id) orderRows.set(id, i + 1);
  }

  const applied = [];
  const skipped = [];
  for (let i = 1; i < reviewValues.length; i += 1) {
    const row = reviewValues[i];
    if (sabanClean_(row[reviewColumns["Estado de revisión"]]).toLowerCase() !== "validado") continue;
    const id = sabanClean_(row[reviewColumns.Pedido]);
    const targetRow = orderRows.get(id);
    if (!targetRow) {
      skipped.push({ id, reason: "pedido no encontrado" });
      continue;
    }
    const write = [];
    Object.entries(HANDWRITING_TARGETS).forEach(([reviewHeader, orderHeader]) => {
      const reviewColumn = reviewColumns[reviewHeader];
      const orderColumn = orderColumns[orderHeader];
      const value = reviewColumn === undefined ? "" : row[reviewColumn];
      if (orderColumn === undefined || sabanClean_(value) === "") return;
      const cell = orders.getRange(targetRow, orderColumn + 1);
      if (sabanClean_(cell.getDisplayValue()) !== "") return;
      cell.setValue(value);
      write.push(orderHeader);
    });
    if (orderColumns["Estado de lectura"] !== undefined) {
      orders.getRange(targetRow, orderColumns["Estado de lectura"] + 1)
        .setValue("Validado manualmente · manuscrito revisado");
    }
    review.getRange(i + 1, reviewColumns["Aplicado al maestro"] + 1)
      .setValue(new Date())
      .setNumberFormat("dd/MM/yyyy HH:mm");
    review.getRange(i + 1, reviewColumns["Estado de revisión"] + 1).setValue("Aplicado al maestro");
    applied.push({ id, fields: write });
  }
  SpreadsheetApp.flush();
  return { applied, skipped };
}

function validarPropuestaManuscrita_(pedido, propuesta) {
  const confidence = Number(propuesta.confianzaGlobal);
  const numeric = (value, label) => {
    if (value === "" || value === null || value === undefined) return "";
    const parsed = Number(String(value).replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 300) {
      throw new Error(`${label} no es una medida válida: ${value}`);
    }
    return parsed;
  };
  const text = (value) => sabanClean_(value);
  const values = {
    "Modelo propuesto": text(propuesta.modelo),
    "Material propuesto": text(propuesta.material),
    "Ancho total (cm) propuesto": numeric(propuesta.ancho, "Ancho"),
    "Alto total (cm) propuesto": numeric(propuesta.alto, "Alto"),
    "Grosor (cm) propuesto": numeric(propuesta.grosor, "Grosor"),
    "Notas de medidas y croquis propuesta": text(propuesta.medidasYCroquis),
    "Especificaciones propuesta": text(propuesta.especificaciones),
    "Texto conmemorativo propuesto": text(propuesta.textoConmemorativo),
    "Confianza global (0-100)": Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : ""
  };
  const notes = text(propuesta.dudas || "");
  const hasLowConfidence = Number.isFinite(confidence) && confidence < 95;
  return {
    id: String(pedido),
    // Incluso con 100 de confianza una propuesta necesita la marca humana
    // "Validado" en la hoja. Este estado no activa ninguna escritura.
    status: hasLowConfidence ? "Revisar · confianza insuficiente" : "Propuesta lista para validar",
    values,
    notes,
    source: text(propuesta.fuente || "Motor de visión · pendiente de revisión")
  };
}

/**
 * Contrato para cualquier motor de visión. Debe responder JSON puro y dejar
 * vacío aquello que no se lea con certeza. El proveedor y la credencial se
 * configuran fuera del repositorio y nunca se incluyen en el dashboard.
 */
function promptLecturaManuscrita_() {
  return [
    "Extrae una propuesta estructurada de una ficha manuscrita de taller.",
    "No inventes texto ni medidas. Si un valor no es legible, usa una cadena vacía y explícalo en dudas.",
    "Devuelve solo JSON con: modelo, material, ancho, alto, grosor, medidasYCroquis, especificaciones, textoConmemorativo, confianzaGlobal, dudas.",
    "Conserva el texto conmemorativo literalmente; no corrijas nombres, fechas ni acentos.",
    "Las medidas solo se aceptan si son visibles en el rectángulo o croquis; no deduzcas números ausentes.",
    "La etiqueta SUYO/SUYA es una especificación, no un material comprado.",
    "La salida es una propuesta para revisión humana, nunca una orden definitiva."
  ].join(" ");
}
