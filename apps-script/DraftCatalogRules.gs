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
    if (options.quantity === undefined && entry && [draftNormalize_("m"), draftNormalize_("m²")].includes(entry.unitN)) {
      quantity = null;
    }
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
    const key = [canonical, variant, unit, wantedMaterial].map(draftNormalize_).join("|");
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
    add("CORTE", { units: ["ud", "trabajo", "m²"], material });
  }

  if (/\brepisa\b/.test(specsN)) {
    add("REPISA", { units: ["ud", "m", "m²"], material, detail: draftOwnOrMaterial_(specs, "repisa", material) });
  }
  if (/\bcornisa\b/.test(specsN)) {
    add("CORNISA", { units: ["ud", "m", "m²"], material, detail: draftOwnOrMaterial_(specs, "cornisa", material) });
  }
  if (/\bcoronacion\b/.test(specsN)) {
    add("CORONACIÓN", { units: ["ud", "m²"], material, detail: draftOwnOrMaterial_(specs, "coronación", material) });
  }

  const structural = draftStructural_(specs);
  if (structural && /columna|pilastra/i.test(structural.label)) {
    add("COLUMNA / PILASTRA", { units: ["ud", "trabajo"], material, detail: structural.detail });
  }

  const cross = specsN.match(/\b(cruz|crucificado)\b[^.;]*/);
  if (cross) {
    const block = cross[0];
    const variant = draftCatalogDecorationVariant_(block);
    add("CRUZ", { variant, units: ["ud"], material: "", detail: block.toUpperCase() });
  }

  if (/\bimagen\b|\bfoto\b|\bfotografia\b/.test(specsN)) {
    const variant = /grab/.test(specsN) ? "GRABADO" : "";
    add("IMAGEN / FOTO", { variant, units: ["ud"], material: "", detail: variant || "IMAGEN / FOTO" });
  }

  const inscriptionDetail = draftInscription_(specs);
  if (inscriptionDetail || data.memorial || /inscripci/.test(specsN)) {
    const variant = draftCatalogInscriptionVariant_(`${inscriptionDetail} ${specs}`);
    add("INSCRIPCIÓN", { variant, units: ["ud"], material: "", detail: inscriptionDetail || variant || "REVISAR TIPO" });
  }

  if (/\bjardinera\b/.test(specsN)) add("JARDINERA", { units: ["ud"], material: "" });
  if (/\bflorero\b|\bjarron\b/.test(specsN)) add("FLORERO", { units: ["ud"], material: "" });
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
  if (text.includes("suyo")) return "MATERIAL SUYO";
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
