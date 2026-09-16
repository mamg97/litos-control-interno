/**
 * LITOS — catálogo operativo normalizado para generación de albaranes.
 *
 * Toma una instantánea de todo lo ya extraído en:
 *   Catálogo albaranes 2023-2026 · bruto
 * y construye una capa compacta en:
 *   Catálogo operativo
 *
 * No modifica albaranes históricos ni Pedidos. Puede ejecutarse aunque el barrido
 * reciente todavía no haya terminado; futuras ejecuciones incorporarán lo nuevo.
 * Conserva Precio actual, Validado por padre y Observaciones ya introducidos.
 */

const CATALOGO_OPERATIVO_SHEET = "Catálogo operativo";
const CATALOGO_OPERATIVO_RAW_SHEET = "Catálogo albaranes 2023-2026 · bruto";

function construirCatalogoOperativo() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { skipped: true, reason: "Hay otro proceso de catálogo ejecutándose." };
  }

  try {
    const book = SpreadsheetApp.openById(CATALOGO_ALBARAN_MASTER_ID);
    const raw = book.getSheetByName(CATALOGO_OPERATIVO_RAW_SHEET);
    if (!raw || raw.getLastRow() < 2) throw new Error("No hay datos brutos recientes para construir el catálogo operativo.");

    const sheet = catalogOperationalEnsureSheet_(book);
    const previous = catalogOperationalManualValues_(sheet);
    const yearByOrder = catalogOperationalYearByOrder_(book.getSheetByName("Pedidos"));
    const values = raw.getDataRange().getValues();
    const groups = new Map();

    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      const order = catalogClean_(row[5]);
      const description = catalogClean_(row[6]);
      const detail = catalogClean_(row[7]);
      const rawCategory = catalogClean_(row[8]);
      const rawUnit = catalogClean_(row[9]);
      const materialRaw = catalogClean_(row[13]);
      if (!description) continue;

      const item = catalogOperationalCanonicalize_(description, detail, rawCategory, rawUnit, materialRaw);
      if (!item || item.noise) continue;

      const key = [item.canonical, item.variant, item.unit, item.material].map(catalogNormalize_).join("|");
      const group = groups.get(key) || {
        key,
        canonical: item.canonical,
        variants: new Set(),
        category: item.category,
        unit: item.unit,
        material: item.material,
        orders: new Set(),
        observed: new Set(),
        rates: [],
        ratesByYear: new Map(),
        special: item.special,
        sources: new Set()
      };

      if (item.variant) group.variants.add(item.variant);
      group.observed.add([description, detail].filter(Boolean).join(" — "));
      if (order) group.orders.add(order);
      const source = catalogClean_(row[1]);
      if (source) group.sources.add(source);

      const rate = catalogNumber_(row[10]);
      const year = yearByOrder.get(order) || 0;
      if (catalogOperationalReliableRate_(rate, item.unit, description, detail)) {
        group.rates.push(rate);
        if (!group.ratesByYear.has(year)) group.ratesByYear.set(year, []);
        group.ratesByYear.get(year).push(rate);
      }

      groups.set(key, group);
    }

    const rows = [...groups.values()]
      .filter(group => !group.special || group.orders.size >= 2)
      .sort((a, b) => b.orders.size - a.orders.size || a.canonical.localeCompare(b.canonical, "es") || a.material.localeCompare(b.material, "es"))
      .map(group => catalogOperationalRow_(group, previous.get(group.key) || {}));

    sheet.clearContents();
    catalogOperationalWriteHeader_(sheet);
    if (rows.length) sheet.getRange(2, 1, rows.length, 13).setValues(rows);
    catalogOperationalFormat_(sheet, rows.length);
    SpreadsheetApp.flush();

    const result = {
      rawOccurrences: values.length - 1,
      operationalItems: rows.length,
      ordersCovered: new Set([...groups.values()].flatMap(group => [...group.orders])).size,
      note: "Precio actual queda reservado para validación manual; Precio hist. reciente es solo referencia."
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function catalogOperationalCanonicalize_(description, detail, rawCategory, rawUnit, materialRaw) {
  const desc = catalogNormalize_(description);
  const det = catalogNormalize_(detail);
  const text = `${desc} ${det}`.replace(/\s+/g, " ").trim();

  if (!text) return null;
  if ([
    "diferencia para ajustar nota", "dieferencia para ajustar nota", "ajustar nota", "suma", "total", "iva", "i.v.a"
  ].some(term => text === term || text.includes(term))) {
    return { noise: true };
  }

  const match = (terms) => terms.some(term => text.includes(term));
  let canonical = "";
  let category = rawCategory || "Otros";
  let unit = rawUnit || "revisar";
  let variant = "";
  let special = false;

  if (match(["inscripcion", "inscripci", "letras", "texto grabado"])) {
    canonical = "INSCRIPCIÓN";
    category = "Inscripción";
    unit = "ud";
    variant = catalogOperationalInscriptionVariant_(text);
  } else if (match(["canto pulido", "cantos pulidos", "pulir canto", "pulir cantos"])) {
    canonical = "CANTO PULIDO";
    category = "Acabado";
    unit = unit === "revisar" ? "m" : unit;
  } else if (match(["cortar material suyo", "corte material suyo", "cortar mat suyo"])) {
    canonical = "CORTAR MATERIAL SUYO";
    category = "Corte / taller";
  } else if (match(["corte", "cortar"])) {
    canonical = "CORTE";
    category = "Corte / taller";
  } else if (match(["solera"])) {
    canonical = "SOLERA";
    category = "Piedra / pieza";
  } else if (match(["junquillo"])) {
    canonical = "JUNQUILLO";
    category = "Piedra / pieza";
  } else if (match(["repisa"])) {
    canonical = "REPISA";
    category = "Piedra / pieza";
  } else if (match(["cornisa"])) {
    canonical = "CORNISA";
    category = "Piedra / pieza";
  } else if (match(["coronacion", "coronación"])) {
    canonical = "CORONACIÓN";
    category = "Piedra / pieza";
  } else if (match(["jardinera"])) {
    canonical = "JARDINERA";
    category = "Accesorio";
    unit = "ud";
  } else if (match(["florero", "jarron", "jarrón"])) {
    canonical = "FLORERO";
    category = "Accesorio";
    unit = "ud";
  } else if (match(["floreo"])) {
    canonical = "FLOREO";
    category = "Accesorio";
    unit = "ud";
  } else if (match(["cruz"])) {
    canonical = "CRUZ";
    category = "Ornamento";
    unit = "ud";
    variant = catalogOperationalDecorationVariant_(text);
  } else if (match(["imagen", "foto", "fotografia", "fotografía"])) {
    canonical = "IMAGEN / FOTO";
    category = "Ornamento";
    unit = "ud";
    variant = catalogOperationalDecorationVariant_(text);
  } else if (match(["columna", "pilastra"])) {
    canonical = "COLUMNA / PILASTRA";
    category = "Piedra / pieza";
  } else if (match(["abujard"])) {
    canonical = "ABUJARDADO";
    category = "Acabado";
  } else if (match(["rebaje"])) {
    canonical = "REBAJE";
    category = "Acabado";
  } else if (match(["canal"])) {
    canonical = "CANAL";
    category = "Acabado";
  } else if (match(["pulir", "pulido"])) {
    canonical = "PULIDO";
    category = "Acabado";
  } else if (match(["talla", "tallar"])) {
    canonical = "TALLA";
    category = "Acabado";
  } else if (match(["acoplar"])) {
    canonical = "ACOPLAR";
    category = "Servicio";
    unit = "ud";
    variant = catalogOperationalAcoplarVariant_(text);
  } else if (match(["desmontar", "desmontaje"])) {
    canonical = "DESMONTAJE";
    category = "Servicio";
    unit = "trabajo";
  } else if (match(["montar", "montaje", "colocacion", "colocación"])) {
    canonical = "MONTAJE / COLOCACIÓN";
    category = "Servicio";
    unit = "trabajo";
  } else if (match(["transporte", "llevar", "porte"])) {
    canonical = "TRANSPORTE";
    category = "Servicio";
    unit = "trabajo";
  } else if (match(["limpieza", "limpiar"])) {
    canonical = "LIMPIEZA";
    category = "Servicio";
    unit = "trabajo";
  } else if (match(["taladrar", "taladro"])) {
    canonical = "TALADRADO";
    category = "Corte / taller";
  } else {
    canonical = catalogClean_(description).toUpperCase();
    category = rawCategory || "Especial / revisar";
    special = true;
  }

  const materialRelevant = unit === "m²" || [
    "Piedra / pieza", "Corte / taller", "Acabado"
  ].includes(category);
  const material = materialRelevant ? catalogOperationalMaterial_(materialRaw) : "";

  // Evitar que detalles libres multipliquen combinaciones. Solo conservamos
  // variantes que probablemente alteran el precio (tipografía, técnica, accesorio).
  return { canonical, variant, category, unit, material, special, noise: false };
}

function catalogOperationalInscriptionVariant_(text) {
  const variants = [
    ["REMUS", ["remus"]],
    ["INGLESA", ["inglesa"]],
    ["ALDINE", ["aldine"]],
    ["GÓTICA", ["gotica", "gótica"]],
    ["CATANEO", ["cataneo"]],
    ["REDONDA", ["redonda"]],
    ["RELIEVE", ["relieve"]],
    ["LÁSER", ["laser", "láser"]],
    ["SEGÚN FOTO", ["segun foto", "según foto"]],
    ["SEGÚN SUYA", ["s/suya", "segun suya", "según suya"]]
  ];
  return variants.filter(([, terms]) => terms.some(term => text.includes(catalogNormalize_(term)))).map(([name]) => name).join(" + ");
}

function catalogOperationalDecorationVariant_(text) {
  const out = [];
  if (text.includes("laser") || text.includes("láser")) out.push("LÁSER");
  if (text.includes("grab")) out.push("GRABADO");
  if (text.includes("relieve")) out.push("RELIEVE");
  if (text.includes("2 aguas") || text.includes("dos aguas")) out.push("2 AGUAS");
  return out.join(" + ");
}

function catalogOperationalAcoplarVariant_(text) {
  if (text.includes("cruz")) return "CRUZ";
  if (text.includes("floreo")) return "FLOREO";
  if (text.includes("florero")) return "FLORERO";
  if (text.includes("imagen") || text.includes("foto")) return "IMAGEN / FOTO";
  return "";
}

function catalogOperationalMaterial_(value) {
  const raw = catalogClean_(value);
  const text = catalogNormalize_(raw);
  const aliases = [
    ["NEGRO ABSOLUTO", ["negro absoluto", "negro abs"]],
    ["NEGRO SUDÁFRICA", ["sudafrica", "sudáfrica"]],
    ["BLANCO MACAEL", ["blanco macael", "macael"]],
    ["MÁRMOL ITALIANO", ["italiano", "marmol italiano", "mármol italiano"]],
    ["BLANCO CHAMPÁN", ["champagne", "champan", "champán"]],
    ["NEGRO TEZAL", ["tezal"]],
    ["ROSA PORRIÑO", ["rosa porriño", "porriño"]],
    ["ROJO BALMORAL", ["rojo balmoral", "balmoral"]],
    ["LABRADOR", ["labrador"]],
    ["MATERIAL SUYO", ["material suyo", "mat suyo", "suyo"]],
    ["PORCELANA", ["porcelana"]],
    ["COMPAC", ["compac"]]
  ];
  for (const [name, terms] of aliases) {
    if (terms.some(term => text.includes(catalogNormalize_(term)))) return name;
  }
  return raw ? raw.toUpperCase() : "";
}

function catalogOperationalReliableRate_(rate, unit, description, detail) {
  if (!Number.isFinite(rate) || rate < 1) return false;
  if (rate > 2000) return false;
  if (catalogNormalize_(unit) === "revisar") return false;
  const text = `${catalogNormalize_(description)} ${catalogNormalize_(detail)}`;
  if (text.includes("ajustar nota")) return false;
  if (unit === "m" && rate > 250) return false;
  if (unit === "m²" && rate > 750) return false;
  if (unit === "ud" && rate > 1500) return false;
  return true;
}

function catalogOperationalRow_(group, manual) {
  const years = [...group.ratesByYear.keys()].filter(year => year > 0).sort((a, b) => b - a);
  const latestYear = years[0] || 0;
  const latestRates = latestYear ? group.ratesByYear.get(latestYear).slice().sort((a, b) => a - b) : [];
  const recentMedian = latestRates.length ? catalogMedian_(latestRates) : "";
  const allRates = group.rates.slice().sort((a, b) => a - b);
  const range = allRates.length ? `${catalogOperationalMoney_(allRates[0])} – ${catalogOperationalMoney_(allRates[allRates.length - 1])}` : "";
  const variants = [...group.variants].filter(Boolean).join(" | ");
  const examples = [...group.orders].sort((a, b) => Number(b) - Number(a)).slice(0, 8).join(", ");

  return [
    group.canonical,
    variants,
    group.category,
    manual.unit || group.unit,
    group.material,
    manual.price === undefined ? "" : manual.price,
    Boolean(manual.validated),
    group.orders.size,
    recentMedian === "" ? "" : `${catalogOperationalMoney_(recentMedian)} (${latestYear})`,
    range,
    examples,
    catalogOperationalRule_(group),
    manual.notes || "Precio histórico como referencia; confirmar el precio actual antes de automatizar."
  ];
}

function catalogOperationalRule_(group) {
  const parts = [group.canonical];
  const variants = [...group.variants].filter(Boolean);
  if (variants.length) parts.push(variants.join(" / "));
  if (group.material) parts.push(group.material);
  return `Añadir cuando la nota/especificaciones indiquen: ${parts.join(" · ")}.`;
}

function catalogOperationalMoney_(value) {
  return `${Math.round(Number(value) * 100) / 100} €`;
}

function catalogOperationalManualValues_(sheet) {
  const out = new Map();
  if (!sheet || sheet.getLastRow() < 2) return out;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 13).getValues();
  values.forEach(row => {
    const key = [row[0], row[1], row[3], row[4]].map(catalogNormalize_).join("|");
    if (!catalogClean_(row[0])) return;
    out.set(key, {
      unit: catalogClean_(row[3]),
      price: row[5],
      validated: row[6] === true,
      notes: catalogClean_(row[12])
    });
  });
  return out;
}

function catalogOperationalYearByOrder_(pedidos) {
  const out = new Map();
  if (!pedidos) return out;
  const shown = pedidos.getDataRange().getDisplayValues();
  const headerIndex = shown.findIndex(row => row.some(cell => catalogClean_(cell) === "Pedido"));
  if (headerIndex < 0) return out;
  const headers = shown[headerIndex].map(catalogClean_);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const dateHeaders = ["Fecha para dashboard", "Fecha entrega (estadillo)", "Fecha recepción (email)", "Fecha ficha"];

  for (let r = headerIndex + 1; r < shown.length; r += 1) {
    const id = catalogClean_(shown[r][columns["Pedido"]]);
    if (!/^\d{4}$/.test(id)) continue;
    for (const header of dateHeaders) {
      const col = columns[header];
      if (col === undefined) continue;
      const year = catalogOperationalParseYear_(shown[r][col]);
      if (year) {
        out.set(id, year);
        break;
      }
    }
  }
  return out;
}

function catalogOperationalParseYear_(value) {
  const raw = catalogClean_(value);
  if (!raw) return 0;
  let match = raw.match(/^(\d{4})[-/]/);
  if (match) return Number(match[1]);
  match = raw.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function catalogOperationalEnsureSheet_(book) {
  let sheet = book.getSheetByName(CATALOGO_OPERATIVO_SHEET);
  if (!sheet) sheet = book.insertSheet(CATALOGO_OPERATIVO_SHEET);
  if (sheet.getMaxColumns() < 13) sheet.insertColumnsAfter(sheet.getMaxColumns(), 13 - sheet.getMaxColumns());
  return sheet;
}

function catalogOperationalWriteHeader_(sheet) {
  sheet.getRange(1, 1, 1, 13).setValues([[
    "Ítem canónico", "Variante / detalle", "Categoría", "Unidad", "Material / condición",
    "Precio actual (€)", "Validado por padre", "Nº apariciones", "Precio hist. reciente",
    "Rango histórico", "Pedidos ejemplo", "Regla de generación", "Observaciones"
  ]]).setBackground("#15607f").setFontColor("#ffffff").setFontWeight("bold")
    .setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true);
}

function catalogOperationalFormat_(sheet, rowCount) {
  sheet.setFrozenRows(1);
  sheet.getRange("F2:F1000").setNumberFormat('#,##0.00 [$€-es-ES]');
  sheet.getRange("G2:G1000").insertCheckboxes();
  sheet.getRange("A:M").setWrap(true).setVerticalAlignment("top");
  sheet.setColumnWidths(1, 13, 150);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(5, 190);
  sheet.setColumnWidth(11, 210);
  sheet.setColumnWidth(12, 320);
  sheet.setColumnWidth(13, 320);
  if (rowCount > 0) sheet.autoResizeRows(1, Math.min(rowCount + 1, 1000));
}
