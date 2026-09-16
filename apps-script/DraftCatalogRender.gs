/**
 * LITOS — renderizado y persistencia de albaranes borrador basados en catálogo.
 * Complemento de DraftCatalogSync.gs.
 */

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

  const mergeText = (a1, text, options = {}) => {
    const range = sheet.getRange(a1);
    range.breakApart();
    range.merge();
    range.setValue(text).setWrap(true);
    if (options.bold) range.setFontWeight("bold");
    if (options.center) range.setHorizontalAlignment("center");
    if (options.size) range.setFontSize(options.size);
  };

  mergeText("A1:G1", "Miguel Angel Mayordomo Franco", { bold: true, center: true, size: 13 });
  mergeText("A2:G2", "N.I.F. 33973954X", { center: true });
  mergeText("A3:E3", "Calle San José nº 12", { center: true });
  mergeText("F3:G3", "Tlf y fax. 924 52 78 51", { center: true });
  mergeText("A4:G4", "VILLAFRANCA DE LOS BARROS (Badajoz)", { center: true });
  mergeText("A5:G5", "MÁRMOLES, PIEDRAS Y GRANITOS", { bold: true, center: true });
  mergeText("A8:G8", "ALBARÁN", { bold: true, center: true, size: 14 });
  mergeText("A10:G10", "BORRADOR · PRECIOS PROVISIONALES DEL CATÁLOGO OPERATIVO · REVISAR", { bold: true, center: true });
  sheet.getRange("A10:G10").setBackground("#fff2cc");
  sheet.setHiddenGridlines(true);
}

function draftCatalogFillSheet_(sheet, data, lines, warnings) {
  sheet.getRange("B14").setValue(Number(data.id));
  const documentDate = data.orderDate || data.receiptDate || "";
  sheet.getRange("F14").setNumberFormat("@").setValue(documentDate);
  sheet.getRange("D16").setValue(data.model ? data.model.toUpperCase() : "");

  const materialCells = draftMaterialCells_(data.materialNormalized || data.material);
  sheet.getRange("C18:D18").setValues([[materialCells.family, materialCells.variant]]);

  const areaCut = lines.find(line => line.canonical === "CORTE" && draftNormalize_(line.unit) === draftNormalize_("m²") && line.price);
  if (areaCut) sheet.getRange("G18").setValue(areaCut.price).setNumberFormat('#,##0.00 [$€-es-ES]');
  else sheet.getRange("G18").clearContent();

  const body = sheet.getRange("A20:G36");
  body.breakApart();
  body.clearContent();

  let row = 21;
  for (const line of lines.slice(0, 12)) {
    if (row > 32) break;
    const price = draftCatalogNumber_(line.price);
    const unitN = draftNormalize_(line.unit);

    if (line.kind === "area" && data.width && data.height) {
      const thicknessM = data.thickness ? data.thickness / 100 : "";
      sheet.getRange(row, 1, 1, 5).setValues([[line.canonical, 1, data.width / 100, data.height / 100, thicknessM]]);
      sheet.getRange(row, 6).setFormula(`=B${row}*C${row}*D${row}`);
      if (price !== null) sheet.getRange(row, 7).setFormula(`=F${row}*${price}`);
      else warnings.push(`${line.canonical}: sin precio en catálogo.`);
    } else {
      sheet.getRange(row, 1).setValue(line.canonical);
      const detailRange = sheet.getRange(row, 2, 1, 3);
      detailRange.merge().setValue(line.detail || line.variant || line.material || "").setWrap(true);

      const measurableWithoutQuantity = (unitN === draftNormalize_("m") || unitN === draftNormalize_("m²")) && line.quantity === null;
      if (!measurableWithoutQuantity) sheet.getRange(row, 5).setValue(line.quantity === null ? "" : line.quantity || 1);
      if (price !== null) sheet.getRange(row, 6).setValue(price).setNumberFormat('#,##0.00 [$€-es-ES]');

      if (price !== null && !measurableWithoutQuantity) {
        sheet.getRange(row, 7).setFormula(`=E${row}*F${row}`);
      } else if (measurableWithoutQuantity) {
        const original = draftClean_(sheet.getRange(row, 2).getDisplayValue());
        sheet.getRange(row, 2).setValue([original, `[${line.unit}: REVISAR MEDIDA]`].filter(Boolean).join(" · "));
      } else {
        warnings.push(`${line.canonical}${line.variant ? ` ${line.variant}` : ""}: sin precio en catálogo.`);
      }
    }
    row += 1;
  }

  const observationRange = sheet.getRange("B33:G35");
  observationRange.breakApart();
  observationRange.merge().setValue(draftObservations_(data)).setWrap(true).setVerticalAlignment("top");
  sheet.getRange("A33").setValue("OBS.");
  sheet.setRowHeights(33, 3, 24);

  sheet.getRange("B43:G48").breakApart().clearContent();
  const memorialRange = sheet.getRange("B43:F43");
  memorialRange.merge().setValue(draftMemorialText_(data.memorial)).setWrap(true).setVerticalAlignment("top");
  sheet.setRowHeight(43, 54);

  sheet.getRange("G37").setFormula("=SUM(G20:G36)");
  sheet.getRange("F38").setValue(0.21).setNumberFormat("0%");
  sheet.getRange("G38").setFormula("=G37*F38");
  sheet.getRange("F39").setValue(0.052).setNumberFormat("0.0%");
  sheet.getRange("G39").setFormula("=G37*F39");
  sheet.getRange("G40").setFormula("=SUM(G37:G39)");
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
      validated: line.validated
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
