/**
 * LITOS — renderizado y persistencia de albaranes borrador basados en catálogo.
 * Complemento de DraftCatalogSync.gs.
 */

const DRAFT_CATALOG_RENDER_VERSION = 4;

function draftCatalogWriteDraft_(data, lines, targetFolder, systemFolder, existing) {
  const blobResult = draftCatalogBuildBlob_(data, lines, systemFolder);
  const blob = blobResult.blob;
  let file;
  let replaced = false;

  if (existing && existing.fileId) {
    try {
      Drive.Files.update(
        { name: `${data.id}_borrador.xlsx` },
        existing.fileId,
        blob,
        { supportsAllDrives: true }
      );
      file = DriveApp.getFileById(existing.fileId);
      replaced = true;
    } catch (error) {
      // El automatismo debe seguir funcionando aunque el servicio avanzado de
      // Drive no esté activado. En ese caso se recrea solo el BORRADOR.
      try { DriveApp.getFileById(existing.fileId).setTrashed(true); } catch (trashError) { /* best effort */ }
      file = targetFolder.createFile(blob);
      replaced = true;
      blobResult.warnings.push(`No se pudo reemplazar el XLSX en el mismo ID; se creó uno nuevo (${error}).`);
    }
  } else {
    file = targetFolder.createFile(blob);
  }

  return { file, replaced, warnings: blobResult.warnings };
}

function draftCatalogBuildBlob_(data, lines, systemFolder) {
  const template = DriveApp.getFileById(INVOICE_DRAFT_TEMPLATE_ID);
  const temp = template.makeCopy(`_${data.id}_catalog_tmp`, systemFolder);
  const warnings = [];
  try {
    const book = SpreadsheetApp.openById(temp.getId());
    const sheet = book.getSheets()[0];
    draftCatalogStandardizeSheet_(sheet);
    draftCatalogFillSheet_(sheet, data, lines, warnings);
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

function draftCatalogStandardizeSheet_(sheet) {
  try { sheet.getImages().forEach(image => image.remove()); } catch (error) { /* no images */ }
  try { sheet.getDrawings().forEach(drawing => drawing.remove()); } catch (error) { /* no drawings */ }

  // La plantilla histórica contiene combinaciones de celdas incompatibles con
  // el formato nuevo. Se deshacen todas de forma segura y se reconstruyen solo
  // las necesarias.
  const wholeSheet = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  wholeSheet.getMergedRanges().forEach(merged => merged.breakApart());
  sheet.setHiddenGridlines(true);

  // Tipografía y anchuras homogéneas. El cuerpo deja espacio real al detalle.
  sheet.getRange("A1:G50").setFontFamily("Arial").setFontSize(9).setVerticalAlignment("middle");
  sheet.setColumnWidth(1, 130);
  sheet.setColumnWidth(2, 92);
  sheet.setColumnWidth(3, 92);
  sheet.setColumnWidth(4, 92);
  sheet.setColumnWidth(5, 66);
  sheet.setColumnWidth(6, 92);
  sheet.setColumnWidth(7, 96);

  const mergeText = (a1, text, options = {}) => {
    const range = sheet.getRange(a1);
    range.merge();
    range.setValue(text).setWrap(true);
    if (options.bold) range.setFontWeight("bold");
    if (options.center) range.setHorizontalAlignment("center");
    if (options.size) range.setFontSize(options.size);
    if (options.background) range.setBackground(options.background);
  };

  sheet.getRange("A1:G12").clearContent();
  mergeText("A1:G1", "Miguel Angel Mayordomo Franco", { bold: true, center: true, size: 13 });
  mergeText("A2:G2", "N.I.F. 33973954X", { center: true });
  mergeText("A3:E3", "Calle San José nº 12", { center: true });
  mergeText("F3:G3", "Tlf y fax. 924 52 78 51", { center: true });
  mergeText("A4:G4", "VILLAFRANCA DE LOS BARROS (Badajoz)", { center: true });
  mergeText("A5:G5", "MÁRMOLES, PIEDRAS Y GRANITOS", { bold: true, center: true });
  mergeText("A8:G8", "ALBARÁN", { bold: true, center: true, size: 14 });
  mergeText("A10:G10", "BORRADOR · PRECIOS PROVISIONALES DEL CATÁLOGO OPERATIVO · REVISAR", {
    bold: true,
    center: true,
    background: "#fff2cc"
  });
  sheet.setRowHeight(10, 28);
}

function draftCatalogFillSheet_(sheet, data, lines, warnings) {
  sheet.getRange("B14").setValue(Number(data.id));
  const documentDate = draftCatalogFormatDateText_(data.orderDate || data.receiptDate || "");
  sheet.getRange("F14").setNumberFormat("@").setValue(documentDate);
  sheet.getRange("D16").setValue(data.model ? data.model.toUpperCase() : "");

  const materialCells = draftMaterialCells_(data.materialNormalized || data.material);
  sheet.getRange("C18:D18").setValues([[materialCells.family, materialCells.variant]]);

  const areaCut = lines.find(line => line.canonical === "CORTE" && draftNormalize_(line.unit) === draftNormalize_("m²") && line.price);
  if (areaCut) sheet.getRange("G18").setValue(areaCut.price).setNumberFormat('#,##0.00 [$€-es-ES]');
  else sheet.getRange("G18").clearContent();

  const qualityFlags = draftCatalogQualityFlags_(data, lines);
  const qualityRange = sheet.getRange("A11:G11");
  qualityRange.breakApart().clearContent();
  qualityRange.merge().setWrap(true).setHorizontalAlignment("center").setFontWeight("bold");
  if (qualityFlags.length) {
    qualityRange.setValue(`REVISAR DATOS · ${qualityFlags.join(" · ")}`).setBackground("#f4cccc");
    sheet.setRowHeight(11, Math.min(58, 28 + Math.floor(qualityFlags.join(" ").length / 95) * 14));
    warnings.push(...qualityFlags.map(flag => `REVISAR: ${flag}`));
  } else {
    qualityRange.setBackground("#ffffff");
    sheet.setRowHeight(11, 10);
  }

  // Tabla homogénea: CONCEPTO | DETALLE/MEDIDAS | CANT. | PRECIO UNIT. | IMPORTE.
  const body = sheet.getRange("A20:G36");
  body.breakApart();
  body.clearContent();
  body.setFontFamily("Arial").setFontSize(9).setVerticalAlignment("middle");

  sheet.getRange("A20").setValue("CONCEPTO");
  sheet.getRange("B20:D20").merge().setValue("DETALLE / MEDIDAS");
  sheet.getRange("E20").setValue("CANT.");
  sheet.getRange("F20").setValue("PRECIO UNIT.");
  sheet.getRange("G20").setValue("IMPORTE");
  sheet.getRange("A20:G20")
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#e6e6e6")
    .setBorder(true, true, true, true, true, true);
  sheet.setRowHeight(20, 26);

  let row = 21;
  const renderLines = lines.slice(0, 12);
  for (const line of renderLines) {
    if (row > 32) break;
    const price = draftCatalogNumber_(line.price);
    const unitN = draftNormalize_(line.unit);
    const detailRange = sheet.getRange(row, 2, 1, 3);
    detailRange.merge().setWrap(true);

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

    sheet.getRange(row, 1).setValue(line.canonical);
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

    sheet.getRange(row, 1).setFontWeight("bold");
    sheet.getRange(row, 5, 1, 3).setHorizontalAlignment("right");
    const lineHeight = Math.min(72, 28 + Math.floor(detail.length / 58) * 14);
    sheet.setRowHeight(row, lineHeight);
    row += 1;
  }

  if (lines.length > 12) {
    warnings.push(`Hay ${lines.length} conceptos y solo se muestran los 12 primeros; revisar el pedido.`);
    sheet.getRange("A32:G32").setBackground("#f4cccc");
  }

  // Observaciones: tres filas completas y altura dinámica para que no se corten.
  const observationText = draftObservations_(data);
  sheet.getRange("A33:G35").breakApart().clearContent();
  const observationRange = sheet.getRange("B33:G35");
  observationRange.merge().setValue(observationText).setWrap(true).setVerticalAlignment("top");
  sheet.getRange("A33").setValue("OBS.").setFontWeight("bold");
  const obsHeight = Math.min(42, Math.max(24, 22 + Math.floor(observationText.length / 180) * 6));
  sheet.setRowHeights(33, 3, obsHeight);
  sheet.getRange("A33:G35").setBorder(true, true, true, true, true, true);

  // Totales claros y homogéneos.
  sheet.getRange("E37:G40").breakApart();
  sheet.getRange("E37:G40").clearContent().setBackground("#ffffff");
  sheet.getRange("F37").setValue("SUMA").setFontWeight("bold");
  sheet.getRange("G37").setFormula("=SUM(G21:G32)");
  sheet.getRange("E38").setValue("IVA");
  sheet.getRange("F38").setValue(0.21).setNumberFormat("0%");
  sheet.getRange("G38").setFormula("=G37*F38");
  sheet.getRange("E39").setValue("R.E.");
  sheet.getRange("F39").setValue(0.052).setNumberFormat("0.0%");
  sheet.getRange("G39").setFormula("=G37*F39");
  sheet.getRange("F40").setValue("TOTAL").setFontWeight("bold");
  sheet.getRange("G40").setFormula("=SUM(G37:G39)").setFontWeight("bold");
  sheet.getRange("G37:G40").setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange("E37:G40").setBorder(true, true, true, true, true, true);

  // Inscripción/texto conmemorativo: usar todo el bloque disponible, no una sola
  // fila. Esto evita que nombres y frases largas queden invisibles al imprimir.
  sheet.getRange("A43:G48").breakApart().clearContent();
  sheet.getRange("A43").setValue("INSCRIPCIÓN").setFontWeight("bold").setVerticalAlignment("top");
  const memorialText = draftMemorialText_(data.memorial);
  const memorialRange = sheet.getRange("B43:G48");
  memorialRange.merge().setValue(memorialText).setWrap(true).setVerticalAlignment("top");
  const memorialRowHeight = Math.min(32, Math.max(20, 20 + Math.floor(memorialText.length / 220) * 4));
  sheet.setRowHeights(43, 6, memorialRowHeight);
  sheet.getRange("A43:G48").setBorder(true, true, true, true, true, true);
}

function draftCatalogQualityFlags_(data, lines) {
  const flags = [];
  const combined = draftNormalize_([data.measures, data.specifications, data.memorial].filter(Boolean).join(" "));

  if (!draftClean_(data.specifications) && draftClean_(data.memorial)) flags.push("sin especificaciones técnicas: no se generan cargos solo por el texto");
  if (/\bpendiente\b|\brevisar\b|\bconsultar\b/.test(combined)) flags.push("la nota contiene datos pendientes / consultar");

  const futureDates = draftCatalogFutureDeathDates_(data.memorial);
  if (futureDates.length) flags.push(`fecha de defunción futura: ${futureDates.join(", ")}`);

  const missingPrice = lines.filter(line => line.chargeable !== false && draftCatalogNumber_(line.price) === null);
  if (missingPrice.length) {
    const names = [...new Set(missingPrice.map(line => line.canonical))].slice(0, 4);
    flags.push(`sin precio automático: ${names.join(", ")}${missingPrice.length > 4 ? "…" : ""}`);
  }

  const missingMeasure = lines.filter(line => {
    const unit = draftNormalize_(line.unit);
    return line.chargeable !== false && line.quantity === null && (unit === draftNormalize_("m") || unit === draftNormalize_("m²"));
  });
  if (missingMeasure.length) flags.push(`faltan medidas para: ${[...new Set(missingMeasure.map(line => line.canonical))].join(", ")}`);
  if (lines.length > 12) flags.push(`${lines.length} conceptos; el formato admite 12 líneas`);

  return flags;
}

function draftCatalogFutureDeathDates_(memorial) {
  const raw = draftClean_(memorial);
  if (!raw) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  const re = /(?:†|\+)\s*(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{2,4})/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    if (!Number.isNaN(date.valueOf()) && date > today) out.push(`${String(match[1]).padStart(2, "0")}/${String(match[2]).padStart(2, "0")}/${year}`);
  }
  return [...new Set(out)];
}

function draftCatalogFormatDateText_(value) {
  const raw = draftClean_(value);
  if (!raw) return "";
  let match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${String(match[1]).padStart(2, "0")}/${String(match[2]).padStart(2, "0")}/${year}`;
  }
  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return `${String(match[3]).padStart(2, "0")}/${String(match[2]).padStart(2, "0")}/${match[1]}`;
  return raw;
}

function draftCatalogDecimalText_(value, maxDecimals) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const decimals = maxDecimals === undefined ? 2 : maxDecimals;
  return number.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

function draftCatalogIndexDocuments_() {
  const result = new Map();
  const root = DriveApp.getFolderById(INVOICE_DRAFT_OUTPUT_FOLDER_ID);
  const visit = folder => {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const name = draftClean_(file.getName());
      const idMatch = name.match(/(?:^|[^0-9])(\d{4})(?:[^0-9]|$)/);
      const extMatch = name.toLowerCase().match(/\.([a-z0-9]+)$/);
      if (!idMatch || !extMatch || !["xlsx", "xls", "xlsm"].includes(extMatch[1])) continue;
      const id = idMatch[1];
      const normalized = draftNormalize_(name);
      const kind = /(?:^|[-_ ])borrador(?:[-_ .]|$)/.test(normalized) ? "invoiceDraft" : "invoice";
      const entry = result.get(id) || {};
      if (!entry[kind]) entry[kind] = { fileId: file.getId(), url: file.getUrl(), name };
      result.set(id, entry);
    }
    const folders = folder.getFolders();
    while (folders.hasNext()) visit(folders.next());
  };
  visit(root);
  return result;
}

function draftCatalogSignature_(data, lines) {
  const payload = JSON.stringify({
    engineVersion: DRAFT_CATALOG_RENDER_VERSION,
    id: data.id,
    orderDate: data.orderDate,
    receiptDate: data.receiptDate,
    model: data.model,
    material: data.materialNormalized || data.material,
    width: data.width,
    height: data.height,
    thickness: data.thickness,
    measures: data.measures,
    specifications: data.specifications,
    memorial: data.memorial,
    lines: lines.map(line => ({
      canonical: line.canonical,
      variant: line.variant,
      detail: line.detail,
      unit: line.unit,
      material: line.material,
      price: line.price,
      validated: line.validated,
      chargeable: line.chargeable,
      review: line.review,
      reason: line.reason
    }))
  });
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload, Utilities.Charset.UTF_8);
  return bytes.map(byte => (byte + 256).toString(16).slice(-2)).join("");
}

function draftCatalogNumber_(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = draftClean_(value);
  if (!raw) return null;
  const number = Number(raw.replace(/[^0-9,.-]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function draftCatalogRemoveTriggersByHandler_(handler) {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
}
