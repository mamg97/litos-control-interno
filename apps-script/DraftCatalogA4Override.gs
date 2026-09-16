/**
 * LITOS — ajuste de impresión A4 para albaranes borrador.
 *
 * Este módulo se concatena DESPUÉS de DraftCatalogRender.gs. Redefine únicamente
 * la construcción del XLSX para aplicar un diseño compacto antes de exportar.
 * Objetivo: que la hoja completa A:G quepa físicamente en una sola página A4
 * en vertical incluso al imprimir al 100 %, sin depender de que el usuario
 * seleccione manualmente "Ajustar a página".
 */

function draftCatalogBuildBlob_(data, lines, systemFolder) {
  const template = DriveApp.getFileById(INVOICE_DRAFT_TEMPLATE_ID);
  const temp = template.makeCopy(`_${data.id}_catalog_tmp`, systemFolder);
  const warnings = [];
  try {
    const book = SpreadsheetApp.openById(temp.getId());
    const sheet = book.getSheets()[0];
    draftCatalogStandardizeSheet_(sheet);
    draftCatalogFillSheet_(sheet, data, lines, warnings);
    draftCatalogCompactA4_(sheet);
    SpreadsheetApp.flush();

    const exportUrl = `https://docs.google.com/spreadsheets/d/${temp.getId()}/export?format=xlsx`;
    const response = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) throw new Error(`Export XLSX HTTP ${response.getResponseCode()}`);
    return { blob: response.getBlob().setName(`${data.id}_borrador.xlsx`), warnings };
  } finally {
    temp.setTrashed(true);
  }
}

function draftCatalogCompactA4_(sheet) {
  // El texto conmemorativo estaba en 43:48 y provocaba una segunda página.
  // Se coloca en la esquina inferior izquierda, en paralelo a los totales.
  let memorialText = "";
  try { memorialText = draftClean_(sheet.getRange("B43").getDisplayValue()); } catch (error) { /* vacío */ }

  sheet.getRange("A36:D40").breakApart().clearContent().setBackground("#ffffff");
  sheet.getRange("A41:G48").breakApart().clearContent();

  const memorialLabel = sheet.getRange("A36:A40");
  memorialLabel.merge()
    .setValue("INSCRIPCIÓN")
    .setFontWeight("bold")
    .setVerticalAlignment("top")
    .setHorizontalAlignment("left");

  const memorialRange = sheet.getRange("B36:D40");
  memorialRange.merge()
    .setValue(memorialText)
    .setWrap(true)
    .setVerticalAlignment("top")
    .setFontSize(8);
  sheet.getRange("A36:D40").setBorder(true, true, true, true, true, true);

  // Los totales permanecen a la derecha y aprovechan la misma franja vertical.
  sheet.getRange("E36:G36").breakApart().merge()
    .setValue("TOTALES")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#e6e6e6")
    .setBorder(true, true, true, true, true, true);
  sheet.getRange("E37:G40").setBorder(true, true, true, true, true, true);

  // Ancho total aproximado: 575 px. Con márgenes normales cabe en A4 vertical
  // sin generar una segunda página horizontal.
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 85);
  sheet.setColumnWidth(3, 85);
  sheet.setColumnWidth(4, 85);
  sheet.setColumnWidth(5, 55);
  sheet.setColumnWidth(6, 80);
  sheet.setColumnWidth(7, 85);

  // Cabecera compacta. Reducimos espacios heredados de la plantilla sin
  // sacrificar la legibilidad de los datos principales.
  const heights = {
    1: 22, 2: 15, 3: 15, 4: 15, 5: 15,
    6: 6, 7: 6, 8: 24, 9: 6, 10: 24,
    12: 5, 13: 5, 14: 20, 15: 6, 16: 20,
    17: 6, 18: 20, 19: 6, 20: 22
  };
  Object.keys(heights).forEach(row => sheet.setRowHeight(Number(row), heights[row]));

  // La fila de avisos puede crecer, pero nunca lo suficiente como para expulsar
  // el pie a otra página.
  const qualityText = draftClean_(sheet.getRange("A11").getDisplayValue());
  sheet.setRowHeight(11, qualityText ? Math.min(34, Math.max(22, 22 + Math.floor(qualityText.length / 120) * 6)) : 8);

  // Cuerpo: máximo 38 px por concepto; las filas vacías ocupan solo 14 px.
  for (let row = 21; row <= 32; row += 1) {
    const hasContent = draftClean_(sheet.getRange(row, 1).getDisplayValue()) || draftClean_(sheet.getRange(row, 2).getDisplayValue());
    sheet.setRowHeight(row, hasContent ? Math.min(38, Math.max(24, sheet.getRowHeight(row))) : 14);
  }

  // Observaciones y memorial comparten el espacio inferior de la página.
  sheet.setRowHeights(33, 3, 20);
  sheet.setRowHeights(36, 5, 20);

  // Tipografía compacta únicamente donde hace falta; títulos principales
  // conservan sus tamaños definidos por DraftCatalogRender.gs.
  sheet.getRange("A13:G40").setFontFamily("Arial").setFontSize(8);
  sheet.getRange("A20:G20").setFontSize(8).setFontWeight("bold");
  sheet.getRange("A33:G40").setFontSize(8);

  // Evita que el XLSX exportado conserve filas/columnas formateadas fuera del
  // documento, que Google Sheets interpretaría como páginas adicionales.
  const extraRows = sheet.getMaxRows() - 40;
  if (extraRows > 0) sheet.deleteRows(41, extraRows);
  const extraColumns = sheet.getMaxColumns() - 7;
  if (extraColumns > 0) sheet.deleteColumns(8, extraColumns);

  sheet.setHiddenGridlines(true);
}

/**
 * Ejecutar una vez tras instalar esta revisión. Borra solo las firmas técnicas
 * de borradores para forzar su regeneración; no toca albaranes definitivos.
 */
function forzarRegeneracionBorradoresA4() {
  const props = PropertiesService.getScriptProperties();
  props.getKeys()
    .filter(key => key.indexOf(DRAFT_CATALOG_SIG_PREFIX) === 0)
    .forEach(key => props.deleteProperty(key));
  return sincronizarTodosBorradoresConCatalogo();
}
