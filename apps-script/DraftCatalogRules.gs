/**
 * LITOS — reglas de correspondencia nota/especificaciones -> líneas de albarán.
 * Complemento de DraftCatalogSync.gs.
 */

function draftCatalogLinesForData_(data, catalog) {
  const specs = draftClean_(data.specifications);
  const specsN = draftNormalize_(specs);
  const material = draftCatalogMaterial_(data.materialNormalized || data.material);
  const lines = [];
  const seen = new Set();

  const add = (canonical, options = {}) => {
    const variant = options.variant || "";
    const wantedMaterial = options.material === undefined ? material : options.material;
    const entry = draftCatalogLookup_(catalog, canonical, variant, options.units || ["ud", "trabajo", "m", "m²"], wantedMaterial);
    const unit = entry ? entry.unit : (options.units && options.units[0]) || "ud";
    let quantity = options.quantity === undefined ? 1 : options.quantity;
    if (options.quantity === undefined && [draftNormalize_("m"), draftNormalize_("m²")].includes(draftNormalize_(unit))) quantity = null;
    const line = {
      canonical,
      variant,
      detail: options.detail || variant || wantedMaterial || "",
      material: wantedMaterial || "",
      unit,
      price: entry ? entry.price : null,
      validated: entry ? entry.validated : false,
      quantity,
      kind: options.kind || "unit"
    };
    const key = [canonical, variant, unit, wantedMaterial, line.detail].map(draftNormalize_).join("|");
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  if (data.width && data.height) {
    const entry = draftCatalogLookup_(catalog, "CORTE", "", ["m²", "ud"], material);
    if (entry && draftNormalize_(entry.unit) === draftNormalize_("m²")) {
      add("CORTE", { units: ["m²"], material, kind: "area", quantity: 1, detail: material });
    } else {
      add("CORTE", { units: ["ud", "trabajo"], material, quantity: 1, detail: material });
    }
  } else if (/\bcorte\b|\bcortar\b/.test(specsN)) {
    const cutMaterial = draftCatalogComponentMaterial_(specs, "corte", material);
    add("CORTE", { units: ["ud", "trabajo", "m²"], material: cutMaterial, detail: draftCatalogComponentText_(specs, "corte") || cutMaterial });
  }

  if (/\brepisa\b/.test(specsN)) {
    const componentMaterial = draftCatalogComponentMaterial_(specs, "repisa", material);
    add("REPISA", {
      units: ["m²", "m", "ud"],
      material: componentMaterial,
      detail: draftCatalogComponentText_(specs, "repisa") || draftCatalogMaterialLabel_(componentMaterial)
    });
  }
  if (/\bcornisa\b/.test(specsN)) {
    const componentMaterial = draftCatalogComponentMaterial_(specs, "cornisa", material);
    add("CORNISA", {
      units: ["m²", "m", "ud"],
      material: componentMaterial,
      detail: draftCatalogComponentText_(specs, "cornisa") || draftCatalogMaterialLabel_(componentMaterial)
    });
  }
  if (/\bcoronacion\b/.test(specsN)) {
    const componentMaterial = draftCatalogComponentMaterial_(specs, "coronacion", material);
    add("CORONACIÓN", {
      units: ["m²", "ud"],
      material: componentMaterial,
      detail: draftCatalogComponentText_(specs, "coronacion") || draftCatalogMaterialLabel_(componentMaterial)
    });
  }

  // Elementos estructurales que suelen venir agrupados con repisa/cornisa.
  if (/\btabica\b|\btacos?\b/.test(specsN)) {
    const componentKey = /\btabica\b/.test(specsN) ? "tabica" : "tacos";
    const componentMaterial = draftCatalogComponentMaterial_(specs, componentKey, material);
    add("TABICA / TACOS", {
      units: ["m²", "trabajo", "ud"],
      material: componentMaterial,
      detail: draftCatalogComponentText_(specs, componentKey) || draftCatalogMaterialLabel_(componentMaterial)
    });
  }

  const structural = draftStructural_(specs);
  if (structural && /columna|pilastra/i.test(structural.label)) {
    add("COLUMNA / PILASTRA", { units: ["ud", "trabajo"], material, detail: structural.detail });
  }

  const garras = specsN.match(/\bgarras?\s+de\s+([0-9]+)/);
  if (garras) add("GARRAS", { units: ["ud"], material: "", quantity: Number(garras[1]), detail: `DE ${garras[1]}` });

  const cross = specsN.match(/\b(cruz|crucificado)\b[^.;]*/);
  if (cross) {
    const block = cross[0];
    const variant = draftCatalogDecorationVariant_(block);
    add("CRUZ", { variant, units: ["ud"], material: "", detail: block.toUpperCase() });
  }

  if (/\bimagen\b|\bfoto\b|\bfotografia\b/.test(specsN)) {
    const detail = draftCatalogComponentText_(specs, "imagen") || "IMAGEN / FOTO";
    const variant = /grab/.test(draftNormalize_(detail)) ? "GRABADO" : "";
    add("IMAGEN / FOTO", { variant, units: ["ud"], material: "", detail });
  }

  const inscriptionDetail = draftCatalogInscriptionDetail_(specs);
  if (inscriptionDetail || data.memorial || /inscripci/.test(specsN)) {
    const variant = draftCatalogInscriptionVariant_(`${inscriptionDetail} ${specs}`);
    add("INSCRIPCIÓN", { variant, units: ["ud"], material: "", detail: inscriptionDetail || variant || "REVISAR TIPO" });
  }

  if (/\bjardinera\b/.test(specsN)) {
    add("JARDINERA", { units: ["ud"], material: "", detail: draftCatalogComponentText_(specs, "jardinera") || "JARDINERA" });
  }
  if (/\bflorero\b|\bjarron\b/.test(specsN)) add("FLORERO", { units: ["ud"], material: "", detail: draftCatalogComponentText_(specs, "florero") || "FLORERO" });
  if (/\bfloreo\b/.test(specsN)) add("FLOREO", { units: ["ud"], material: "" });
  if (/\bcenefa\b/.test(specsN)) add("CENEFA", { units: ["ud"], material: "" });
  if (/borrar\s+cartela/.test(specsN)) add("BORRAR CARTELA", { units: ["ud"], material: "" });
  if (/retace/.test(specsN) && /zafra/.test(specsN)) add("RETACEAR EN ZAFRA", { units: ["ud", "trabajo"], material });
  if (/pegar|pegado/.test(specsN) && /escalon/.test(specsN)) add("PEGAR ESCALÓN", { units: ["ud", "trabajo"], material: "" });
  if (/taladr/.test(specsN)) add("TALADRADO", { units: ["ud", "trabajo"], material });
  if (/canto\s+pulido|cantos\s+pulidos|pulir\s+canto/.test(specsN)) add("CANTO PULIDO", { units: ["m", "trabajo"], material, quantity: null });
  if (/\bpulido\b|\bpulir\b/.test(specsN) && !/canto\s+pulido|pulir\s+canto/.test(specsN)) add("PULIDO", { units: ["m", "trabajo"], material, quantity: null });
  if (/\blimpieza\b|\blimpiar\b/.test(specsN)) add("LIMPIEZA", { units: ["trabajo"], material: "" });
  if (/\bmontaje\b|\bcolocacion\b/.test(specsN)) add("MONTAJE / COLOCACIÓN", { units: ["trabajo"], material: "" });
  if (/\bdesmontaje\b|\bdesmontar\b/.test(specsN)) add("DESMONTAJE", { units: ["trabajo"], material: "" });
  if (/faja\s+perimetral/.test(specsN)) add("FAJA PERIMETRAL", { units: ["ud"], material: "" });
  if (/abujard/.test(specsN)) add("ABUJARDADO", { units: ["ud", "trabajo"], material });
  if (/embellecedor/.test(specsN)) add("PEGAR EMBELLECEDORES", { units: ["ud"], material: "" });
  if (/punta\s+diamante/.test(specsN)) add("PEGAR PUNTA DIAMANTE", { units: ["trabajo", "ud"], material: "MÁRMOL" });

  return lines;
}

function draftCatalogLookup_(catalog, canonical, variant, units, material) {
  const canonicalN = draftNormalize_(canonical);
  const variantN = draftNormalize_(variant);
  const materialN = draftNormalize_(material);
  const unitOrder = (units || []).map(draftNormalize_);
  let best = null;
  let bestScore = -Infinity;

  catalog.entries.forEach(entry => {
    if (entry.canonicalN !== canonicalN) return;
    if (entry.price === null || entry.price <= 0) return;

    let score = 0;
    if (variantN) {
      if (entry.variantN === variantN) score += 40;
      else if (!entry.variantN) score += 5;
      else return;
    } else {
      if (!entry.variantN) score += 20;
      else score -= 5;
    }

    if (materialN) {
      if (entry.materialN === materialN) score += 30;
      else if (!entry.materialN) score += 2;
      else return;
    } else if (!entry.materialN) {
      score += 10;
    }

    const unitIndex = unitOrder.indexOf(entry.unitN);
    if (unitIndex >= 0) score += 20 - unitIndex * 3;
    else score -= 10;
    if (entry.validated) score += 2;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  });
  return best;
}

function draftCatalogComponentText_(specs, component) {
  const raw = draftClean_(specs);
  if (!raw) return "";
  const names = {
    corte: "corte",
    repisa: "repisa",
    cornisa: "cornisa",
    coronacion: "coronaci[oó]n",
    tabica: "tabica(?:\\/tacos)?",
    tacos: "tacos?",
    imagen: "imagen",
    jardinera: "jardinera",
    florero: "florero"
  };
  const key = names[component] || component;
  const match = raw.match(new RegExp(`\\b${key}\\b\\s*:?\\s*([^.;]*)`, "i"));
  if (!match) return "";

  let detail = draftClean_(match[1]).replace(/^[-,:\s]+/, "");
  const stoneComponents = new Set(["corte", "repisa", "cornisa", "coronacion", "tabica", "tacos"]);
  if (stoneComponents.has(component)) {
    // En frases como "Repisa, tabica/tacos y cornisa AB" el texto posterior
    // pertenece a componentes distintos. No debe derramarse de una línea a otra.
    if (/^(?:y\s+)?(?:repisa|tabica(?:\/tacos)?|tacos?|cornisa|coronaci[oó]n|garras?|imagen|jardinera|florero|inscripci[oó]n)\b/i.test(detail)) return "";
    const boundary = detail.search(/(?:,|\by\b)\s*(?:repisa|tabica(?:\/tacos)?|tacos?|cornisa|coronaci[oó]n|garras?|imagen|jardinera|florero|inscripci[oó]n)\b/i);
    if (boundary >= 0) detail = detail.slice(0, boundary);
    detail = draftClean_(detail).replace(/[,:\s]+$/, "");
  }
  return detail;
}

function draftCatalogComponentMaterial_(specs, component, fallback) {
  const raw = draftClean_(specs);
  const normalized = draftNormalize_(raw);
  const aliases = {
    coronacion: "coronacion",
    tabica: "tabica",
    tacos: "tacos"
  };
  const key = draftNormalize_(aliases[component] || component);
  const index = normalized.indexOf(key);
  const block = index >= 0 ? normalized.slice(index, index + 110) : normalized;

  if (/\bsuy[oa]s?\b/.test(block)) return "MATERIAL SUYO";
  if (/\b(ab|absoluto|negro absoluto)\b/.test(block)) return "NEGRO ABSOLUTO";
  if (/\b(sudafrica|sud africa)\b/.test(block)) return "NEGRO SUDÁFRICA";
  if (/\b(italia|italiano)\b/.test(block)) return "MÁRMOL ITALIANO";
  if (/\b(champan|champagne)\b/.test(block)) return "BLANCO CHAMPÁN";
  if (/\b(tezal)\b/.test(block)) return "NEGRO TEZAL";
  if (/\b(blanco|bl|macael)\b/.test(block)) return "BLANCO MACAEL";
  return fallback;
}

function draftCatalogMaterialLabel_(material) {
  return material === "MATERIAL SUYO" ? "MATERIAL SUYO" : material;
}

function draftCatalogInscriptionDetail_(specs) {
  const raw = draftClean_(specs);
  let match = raw.match(/inscripci[oó]n\s*:\s*([^.;]*)/i);
  if (!match) match = raw.match(/inscripci[oó]n\s+([^.;]*)/i);
  return match ? draftClean_(match[1]).toUpperCase() : "";
}

function draftCatalogMaterial_(value) {
  const raw = draftClean_(value);
  const text = draftNormalize_(raw);
  if (!text) return "";
  if (text.includes("macael") || text === "blanco") return "BLANCO MACAEL";
  if (text.includes("italia")) return "MÁRMOL ITALIANO";
  if (text.includes("sudafrica")) return "NEGRO SUDÁFRICA";
  if (text.includes("absoluto")) return "NEGRO ABSOLUTO";
  if (text.includes("champ")) return "BLANCO CHAMPÁN";
  if (text.includes("tezal")) return "NEGRO TEZAL";
  if (text.includes("porrino")) return "ROSA PORRIÑO";
  if (text.includes("quintana")) return "GRIS QUINTANA";
  if (text.includes("multicolor")) return "ROJO MULTICOLOR";
  if (text.includes("verde oliva")) return "VERDE OLIVA";
  if (text.includes("labrador")) return "LABRADOR";
  if (text.includes("crema marfil")) return "CREMA MARFIL";
  if (text.includes("suyo") || text.includes("piedra existente")) return "MATERIAL SUYO";
  return raw.toUpperCase();
}

function draftCatalogInscriptionVariant_(value) {
  const text = draftNormalize_(value);
  const variants = [];
  if (/relieve/.test(text)) variants.push("RELIEVE");
  if (/segun\s+suya|s\/suya/.test(text)) variants.push("SEGÚN SUYA");
  if (/aldine/.test(text)) variants.push("ALDINE");
  if (/remus/.test(text)) variants.push("REMUS");
  if (/inglesa/.test(text)) variants.push("INGLESA");
  if (/cataneo/.test(text)) variants.push("CATANEO");
  if (/redonda/.test(text)) variants.push("REDONDA");
  if (/gotica/.test(text)) variants.push("GÓTICA");
  if (/laser|láser/.test(text)) variants.push("LÁSER");
  if (variants.includes("RELIEVE") && variants.includes("SEGÚN SUYA")) return "RELIEVE + SEGÚN SUYA";
  return variants[0] || "";
}

function draftCatalogDecorationVariant_(value) {
  const text = draftNormalize_(value);
  const out = [];
  if (/grab/.test(text)) out.push("GRABADO");
  if (/relieve/.test(text)) out.push("RELIEVE");
  if (/2\s+aguas|dos\s+aguas/.test(text)) out.push("2 AGUAS");
  return out.join(" + ");
}
