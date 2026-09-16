/**
 * LITOS — layout A4 dinámico.
 * Se concatena DESPUÉS de DraftCatalogA4Override.gs.
 *
 * En vez de reducir alturas hasta ocultar texto, reconstruye la zona documental
 * de forma dinámica: agrupa los metadatos superiores, crea solo las filas de
 * conceptos necesarias y coloca observaciones + inscripción + totales justo a
 * continuación.
 */

function draftCatalogBuildBlob_(data, lines, systemFolder) {
  const template = DriveApp.getFileById(INVOICE_DRAFT_TEMPLATE_ID);
  const temp = template.makeCopy(`_${data.id}_catalog_tmp`, systemFolder);
  const warnings = [];
  try {
    const book = SpreadsheetApp.openById(temp.getId());
    const sheet = book.getSheets()[0];
    draftCatalogStandardizeSheet_(sheet);
    draftCatalogFillDynamicA4_(sheet, data, lines, warnings);
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

function draftCatalogFillDynamicA4_(sheet, data, lines, warnings) {
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();

  // Conservamos la cabecera corporativa ya creada en filas 1:5 y rehacemos
  // desde la fila 6. Así no hay huecos heredados de la plantilla.
  const lower = sheet.getRange(6, 1, Math.max(1, maxRows - 5), Math.min(maxCols, 12));
  lower.getMergedRanges().forEach(range => range.breakApart());
  lower.clearContent().setBackground("#ffffff").setBorder(false, false, false, false, false, false);

  sheet.getRange("A1:G60").setFontFamily("Arial").setFontSize(9).setVerticalAlignment("middle");
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 95);
  sheet.setColumnWidth(3, 95);
  sheet.setColumnWidth(4, 95);
  sheet.setColumnWidth(5, 60);
  sheet.setColumnWidth(6, 82);
  sheet.setColumnWidth(7, 88);

  const merge = (row, col, numRows, numCols, text, options = {}) => {
    const range = sheet.getRange(row, col, numRows, numCols);
    range.merge().setValue(text).setWrap(true);
    if (options.bold) range.setFontWeight("bold");
    if (options.center) range.setHorizontalAlignment("center");
    if (options.background) range.setBackground(options.background);
    if (options.size) range.setFontSize(options.size);
    if (options.border) range.setBorder(true, true, true, true, true, true);
    return range;
  };

  // Título + estado del documento, sin filas separadoras vacías.
  merge(6, 1, 1, 7, "ALBARÁN", { bold: true, center: true, size: 14 });
  sheet.setRowHeight(6, 24);
  merge(7, 1, 1, 7, "BORRADOR · PRECIOS PROVISIONALES DEL CATÁLOGO OPERATIVO · REVISAR", {
    bold: true, center: true, background: "#fff2cc"
  });
  sheet.setRowHeight(7, 22);

  const qualityFlags = draftCatalogQualityFlags_(data, lines);
  let row = 8;
  if (qualityFlags.length) {
    const qualityText = `REVISAR DATOS · ${qualityFlags.join(" · ")}`;
    merge(row, 1, 1, 7, qualityText, { bold: true, center: true, background: "#f4cccc" });
    sheet.setRowHeight(row, Math.max(24, 22 + Math.floor(qualityText.length / 105) * 14));
    warnings.push(...qualityFlags.map(flag => `REVISAR: ${flag}`));
    row += 1;
  }

  // Pedido, fecha y concepto en una sola fila.
  const documentDate = draftCatalogFormatDateText_(data.orderDate || data.receiptDate || "");
  sheet.getRange(row, 1).setValue("PEDIDO Nº").setFontWeight("bold");
  sheet.getRange(row, 2).setValue(Number(data.id));
  sheet.getRange(row, 3).setValue("FECHA").setFontWeight("bold");
  sheet.getRange(row, 4).setNumberFormat("@").setValue(documentDate);
  sheet.getRange(row, 5).setValue("CONCEPTO").setFontWeight("bold");
  sheet.getRange(row, 6, 1, 2).merge().setValue(data.model ? data.model.toUpperCase() : "").setWrap(true);
  sheet.getRange(row, 1, 1, 7).setBackground("#d9e2f3").setBorder(true, true, true, true, true, true);
  sheet.setRowHeight(row, 24);
  row += 1;

  // Material y precio de referencia en otra única fila.
  const materialCells = draftMaterialCells_(data.materialNormalized || data.material);
  const materialText = [materialCells.family, materialCells.variant].filter(Boolean).join(" ");
  const areaCut = lines.find(line => line.canonical === "CORTE" && draftNormalize_(line.unit) === draftNormalize_("m²") && line.price);
  sheet.getRange(row, 1).setValue("MATERIAL").setFontWeight("bold");
  sheet.getRange(row, 2, 1, 4).merge().setValue(materialText).setWrap(true);
  sheet.getRange(row, 6).setValue("PRECIO").setFontWeight("bold");
  if (areaCut) sheet.getRange(row, 7).setValue(areaCut.price).setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange(row, 1, 1, 7).setBackground("#d9e2f3").setBorder(true, true, true, true, true, true);
  sheet.setRowHeight(row, 24);
  row += 1;

  // Cabecera del cuerpo.
  sheet.getRange(row, 1).setValue("CONCEPTO");
  sheet.getRange(row, 2, 1, 3).merge().setValue("DETALLE / MEDIDAS");
  sheet.getRange(row, 5).setValue("CANT.");
  sheet.getRange(row, 6).setValue("PRECIO UNIT.");
  sheet.getRange(row, 7).setValue("IMPORTE");
  sheet.getRange(row, 1, 1, 7)
    .setFontWeight("bold").setHorizontalAlignment("center")
    .setBackground("#e6e6e6").setBorder(true, true, true, true, true, true);
  sheet.setRowHeight(row, 24);
  row += 1;

  const firstLineRow = row;
  const renderLines = lines.slice(0, 12);
  for (const line of renderLines) {
    const price = draftCatalogNumber_(line.price);
    const unitN = draftNormalize_(line.unit);
    const detailRange = sheet.getRange(row, 2, 1, 3);
    detailRange.merge().setWrap(true).setVerticalAlignment("middle");

    let detail = draftClean_(line.detail || line.variant || line.material || "");
    let quantity = line.quantity === null ? null : (line.quantity || 1);

    if (line.kind === "area" && data.width && data.height) {
      const widthM = data.width / 100;
      const heightM = data.height / 100;
      const area = widthM * heightM;
      quantity = area;
      const thickness = data.thickness ? ` · grosor ${draftCatalogDecimalText_(data.thickness, 2)} cm` : "";
      detail = `${draftCatalogDecimalText_(widthM, 3)} × ${draftCatalogDecimalText_(heightM, 3)} = ${draftCatalogDecimalText_(area, 3)} m²${thickness}${line.material ? ` · ${line.material}` : ""}`;
    } else if (line.unit) {
      detail = [detail, `[${line.unit}]`].filter(Boolean).join(" · ");
    }

    const measurableWithoutQuantity = (unitN === draftNormalize_("m") || unitN === draftNormalize_("m²")) && quantity === null;
    if (measurableWithoutQuantity) detail = [detail, `[${line.unit}: REVISAR MEDIDA]`].filter(Boolean).join(" · ");
    if (line.chargeable === false) detail = [detail, `[SIN CARGO AUTOMÁTICO${line.reason ? ` · ${line.reason.toUpperCase()}` : ""}]`].filter(Boolean).join(" · ");
    if (line.review || (line.chargeable !== false && price === null)) detail = [detail, "[REVISAR PRECIO]"].filter(Boolean).join(" · ");

    sheet.getRange(row, 1).setValue(line.canonical).setFontWeight("bold");
    detailRange.setValue(detail);
    if (quantity !== null) sheet.getRange(row, 5).setValue(quantity).setNumberFormat("0.###");
    if (price !== null) sheet.getRange(row, 6).setValue(price).setNumberFormat('#,##0.00 [$€-es-ES]');

    if (price !== null && !measurableWithoutQuantity && line.chargeable !== false) {
      sheet.getRange(row, 7).setFormula(`=E${row}*F${row}`).setNumberFormat('#,##0.00 [$€-es-ES]');
    } else if (line.chargeable !== false && price === null) {
      warnings.push(`${line.canonical}${line.variant ? ` ${line.variant}` : ""}: sin precio en catálogo.`);
    }

    const lineRange = sheet.getRange(row, 1, 1, 7);
    lineRange.setBorder(true, true, true, true, true, true);
    if (line.chargeable === false) lineRange.setBackground("#f2f2f2");
    else if (line.review || price === null || measurableWithoutQuantity) lineRange.setBackground("#fff2cc");
    else lineRange.setBackground("#ffffff");
    sheet.getRange(row, 5, 1, 3).setHorizontalAlignment("right");

    // Altura suficiente para el texto real; nunca se comprime artificialmente.
    const lineHeight = Math.min(66, Math.max(28, 28 + Math.floor(detail.length / 62) * 14));
    sheet.setRowHeight(row, lineHeight);
    row += 1;
  }

  if (lines.length > 12) warnings.push(`Hay ${lines.length} conceptos y solo se muestran los 12 primeros; revisar el pedido.`);
  const lastLineRow = Math.max(firstLineRow, row - 1);

  // Observaciones: únicamente las filas que realmente necesita el texto.
  const observationText = draftObservations_(data);
  const obsRows = Math.min(3, Math.max(1, Math.ceil(Math.max(1, observationText.length) / 190)));
  sheet.getRange(row, 1, obsRows, 1).merge().setValue("OBS.").setFontWeight("bold").setVerticalAlignment("top");
  sheet.getRange(row, 2, obsRows, 6).merge().setValue(observationText).setWrap(true).setVerticalAlignment("top");
  sheet.getRange(row, 1, obsRows, 7).setBorder(true, true, true, true, true, true);
  sheet.setRowHeights(row, obsRows, 28);
  row += obsRows;

  // Inscripción y totales ocupan la misma franja inferior.
  const footerStart = row;
  const footerRows = 4;
  const memorialText = draftMemorialText_(data.memorial);
  sheet.getRange(footerStart, 1, footerRows, 1).merge().setValue("INSCRIPCIÓN").setFontWeight("bold").setVerticalAlignment("top");
  sheet.getRange(footerStart, 2, footerRows, 3).merge().setValue(memorialText).setWrap(true).setVerticalAlignment("top").setFontSize(8);

  sheet.getRange(footerStart, 5).setValue("SUMA").setFontWeight("bold");
  sheet.getRange(footerStart, 7).setFormula(`=SUM(G${firstLineRow}:G${lastLineRow})`);
  sheet.getRange(footerStart + 1, 5).setValue("IVA");
  sheet.getRange(footerStart + 1, 6).setValue(0.21).setNumberFormat("0%");
  sheet.getRange(footerStart + 1, 7).setFormula(`=G${footerStart}*F${footerStart + 1}`);
  sheet.getRange(footerStart + 2, 5).setValue("R.E.");
  sheet.getRange(footerStart + 2, 6).setValue(0.052).setNumberFormat("0.0%");
  sheet.getRange(footerStart + 2, 7).setFormula(`=G${footerStart}*F${footerStart + 2}`);
  sheet.getRange(footerStart + 3, 5).setValue("TOTAL").setFontWeight("bold");
  sheet.getRange(footerStart + 3, 7).setFormula(`=SUM(G${footerStart}:G${footerStart + 2})`).setFontWeight("bold");
  sheet.getRange(footerStart, 7, footerRows, 1).setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange(footerStart, 1, footerRows, 7).setBorder(true, true, true, true, true, true);
  sheet.setRowHeights(footerStart, footerRows, 25);

  const usedLastRow = footerStart + footerRows - 1;
  sheet.getRange(1, 1, usedLastRow, 7).setFontFamily("Arial");
  sheet.setHiddenGridlines(true);

  // Recortar físicamente la hoja al documento real.
  const extraRows = sheet.getMaxRows() - usedLastRow;
  if (extraRows > 0) sheet.deleteRows(usedLastRow + 1, extraRows);
  const extraColumns = sheet.getMaxColumns() - 7;
  if (extraColumns > 0) sheet.deleteColumns(8, extraColumns);
}

function forzarRegeneracionBorradoresA4Dinamico() {
  const props = PropertiesService.getScriptProperties();
  props.getKeys()
    .filter(key => key.indexOf(DRAFT_CATALOG_SIG_PREFIX) === 0)
    .forEach(key => props.deleteProperty(key));
  return sincronizarTodosBorradoresConCatalogo();
}
