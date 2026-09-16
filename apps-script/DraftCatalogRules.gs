/**
 * LITOS — reglas de correspondencia nota/especificaciones -> líneas de albarán.
 * Complemento de DraftCatalogSync.gs.
 *
 * Principios de esta revisión:
 * - "s/foto", "sin foto" o "según foto" NO crean por sí solos una línea FOTO.
 * - Las piezas "suyas" se reflejan en el borrador, pero no se cobran como nuevas.
 * - Una inscripción solo nace si las especificaciones hablan de inscripción;
 *   el texto conmemorativo por sí solo no genera un cargo.
 * - Se conservan trabajos técnicos no tarifados (barras Z, barandillas, garras...)
 *   como líneas de revisión en vez de perderlos.
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
    const forceNoPrice = options.forceNoPrice === true;
    const entry = forceNoPrice
      ? null
      : draftCatalogLookup_(catalog, canonical, variant, options.units || ["ud", "trabajo", "m", "m²"], wantedMaterial);
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
      kind: options.kind || "unit",
      chargeable: options.chargeable === undefined ? true : !!options.chargeable,
      review: !!options.review,
      reason: options.reason || ""
    };
    const key = [canonical, variant, unit, wantedMaterial, line.detail, line.chargeable].map(draftNormalize_).join("|");
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  // CORTE. Si la nota dice que el material/corte es suyo, no cobrar un corte nuevo
  // aunque existan dimensiones en la ficha.
  const cutOwn = draftCatalogComponentOwned_(specs, "corte") || material === "MATERIAL SUYO";
  if (data.width && data.height) {
    if (cutOwn) {
      add("CORTE", {
        units: ["ud", "trabajo"],
        material: "MATERIAL SUYO",
        detail: "MATERIAL / CORTE SUYO",
        forceNoPrice: true,
        chargeable: false,
        reason: "material suyo"
      });
    } else {
      const entry = draftCatalogLookup_(catalog, "CORTE", "", ["m²", "ud", "trabajo"], material);
      if (entry && draftNormalize_(entry.unit) === draftNormalize_("m²")) {
        add("CORTE", { units: ["m²"], material, kind: "area", quantity: 1, detail: material });
      } else {
        add("CORTE", { units: ["ud", "trabajo"], material, quantity: 1, detail: material });
      }
    }
  } else if (/\bcorte\b|\bcortar\b/.test(specsN)) {
    const cutMaterial = draftCatalogComponentMaterial_(specs, "corte", material);
    const own = draftCatalogComponentOwned_(specs, "corte") || cutMaterial === "MATERIAL SUYO";
    add("CORTE", {
      units: ["ud", "trabajo", "m²"],
      material: own ? "MATERIAL SUYO" : cutMaterial,
      detail: draftCatalogComponentText_(specs, "corte") || (own ? "MATERIAL / CORTE SUYO" : cutMaterial),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "material suyo" : ""
    });
  }

  // Piezas de piedra. Las piezas suyas se muestran, pero sin cargo automático.
  [
    ["repisa", "REPISA", ["m²", "m", "ud"]],
    ["cornisa", "CORNISA", ["m²", "m", "ud"]],
    ["coronacion", "CORONACIÓN", ["m²", "ud"]]
  ].forEach(([component, canonical, units]) => {
    const componentPattern = new RegExp(`\\b${draftCatalogComponentPattern_(component)}\\b`);
    if (!componentPattern.test(specsN)) return;
    const own = draftCatalogComponentOwned_(specs, component);
    const componentMaterial = own ? "MATERIAL SUYO" : draftCatalogComponentMaterial_(specs, component, material);
    const rawDetail = draftCatalogComponentText_(specs, component);
    add(canonical, {
      units,
      material: componentMaterial,
      detail: rawDetail || draftCatalogMaterialLabel_(componentMaterial),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "pieza suya" : ""
    });
  });

  // Operaciones explícitas sobre piezas suyas: no deben confundirse con el precio
  // de la pieza. Estas líneas usan conceptos propios del catálogo operativo.
  if (draftCatalogComponentOwned_(specs, "cornisa") && draftCatalogComponentHasAction_(specs, "cornisa", /\bpegar|pegado\b/)) {
    add("PEGAR CORNISA", { units: ["ud", "trabajo"], material: "", detail: "PEGADO DE CORNISA SUYA" });
  }
  if (draftCatalogComponentOwned_(specs, "jardinera") && draftCatalogComponentHasAction_(specs, "jardinera", /\bpegar|pegado\b/)) {
    add("PEGAR JARDINERA", { units: ["ud", "trabajo"], material: "", detail: "PEGADO DE JARDINERA SUYA" });
  }

  // Elementos estructurales que suelen venir agrupados con repisa/cornisa.
  if (/\btabica\b|\btacos?\b/.test(specsN)) {
    const componentKey = /\btabica\b/.test(specsN) ? "tabica" : "tacos";
    const own = draftCatalogComponentOwned_(specs, componentKey);
    const componentMaterial = own ? "MATERIAL SUYO" : draftCatalogComponentMaterial_(specs, componentKey, material);
    add("TABICA / TACOS", {
      units: ["m²", "trabajo", "ud"],
      material: componentMaterial,
      detail: draftCatalogComponentText_(specs, componentKey) || draftCatalogMaterialLabel_(componentMaterial),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "pieza suya" : ""
    });
  }

  const structural = draftStructural_(specs);
  if (structural) {
    if (/columna|pilastra/i.test(structural.label)) {
      const component = /pilastra/i.test(structural.label) ? "pilastra" : "columna";
      const own = draftCatalogComponentOwned_(specs, component);
      add("COLUMNA / PILASTRA", {
        units: ["ud", "trabajo"],
        material: own ? "MATERIAL SUYO" : material,
        detail: structural.detail || (own ? "SUYA" : ""),
        forceNoPrice: own,
        chargeable: !own,
        reason: own ? "pieza suya" : ""
      });
    } else if (/BARRAS Z/i.test(structural.label)) {
      add("BARRAS Z", {
        units: ["ud", "trabajo"],
        material: "",
        quantity: Number(structural.detail) || 1,
        detail: `${structural.detail || ""} BARRAS DE Z`.trim(),
        forceNoPrice: true,
        chargeable: true,
        review: true,
        reason: "sin tarifa validada"
      });
    }
  }

  // Garras: conservar la indicación técnica, sin inventar precio ni interpretar
  // "de 2" como dos unidades de forma automática.
  const garras = draftClean_(specs).match(/\bgarras?\s+de\s+([^.;,]+)/i);
  if (garras) {
    add("GARRAS", {
      units: ["ud"],
      material: "",
      quantity: 1,
      detail: `DE ${draftClean_(garras[1]).toUpperCase()}`,
      forceNoPrice: true,
      chargeable: false,
      reason: "indicación técnica"
    });
  }

  // Cruz / crucificado. Si es suyo, se documenta pero no se cobra como pieza nueva.
  const cross = draftClean_(specs).match(/\b(cruz|crucificado)\b[^.;]*/i);
  if (cross) {
    const block = cross[0];
    const variant = draftCatalogDecorationVariant_(block);
    const own = draftCatalogComponentOwned_(specs, "cruz") || draftCatalogComponentOwned_(specs, "crucificado");
    add("CRUZ", {
      variant,
      units: ["ud"],
      material: "",
      detail: block.toUpperCase(),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "pieza suya" : ""
    });
  }

  // IMAGEN: solo una mención real a imagen, no cualquier aparición de "foto".
  if (/\bimagen\b/.test(specsN)) {
    const imageOwn = draftCatalogComponentOwned_(specs, "imagen");
    const imageDetail = draftCatalogComponentText_(specs, "imagen") || (imageOwn ? "IMAGEN SUYA" : "IMAGEN");
    const variant = /grab/.test(draftNormalize_(imageDetail)) ? "GRABADO" : "";
    add("IMAGEN / FOTO", {
      variant,
      units: ["ud"],
      material: "",
      detail: imageDetail,
      forceNoPrice: imageOwn,
      chargeable: !imageOwn,
      reason: imageOwn ? "imagen suya" : ""
    });
  }

  // FOTO física: exige evidencia positiva (medidas/color/soporte). "s/foto",
  // "sin foto" y "según foto" no crean esta línea.
  const photoDetail = draftCatalogPhysicalPhoto_(specs);
  if (photoDetail) {
    const photoOwn = /\bfotos?\s+suy[oa]s?\b/.test(draftNormalize_(photoDetail));
    add("IMAGEN / FOTO", {
      units: ["ud"],
      material: "",
      detail: photoDetail,
      forceNoPrice: photoOwn,
      chargeable: !photoOwn,
      reason: photoOwn ? "foto suya" : ""
    });
  }

  // INSCRIPCIÓN: nunca crearla solo porque exista texto conmemorativo.
  const inscriptionDetail = draftCatalogInscriptionDetail_(specs);
  if (inscriptionDetail || /inscripci/.test(specsN)) {
    const variant = draftCatalogInscriptionVariant_(`${inscriptionDetail} ${specs}`);
    const unresolved = /pendiente|consultar|revisar/.test(draftNormalize_(inscriptionDetail)) && !variant;
    add("INSCRIPCIÓN", {
      variant,
      units: ["ud"],
      material: "",
      detail: inscriptionDetail || variant || "REVISAR TIPO",
      forceNoPrice: unresolved || (!inscriptionDetail && !variant),
      chargeable: true,
      review: unresolved || (!inscriptionDetail && !variant),
      reason: unresolved ? "tipo/estilo pendiente" : ""
    });
  }

  // Algunas fichas complejas (p. ej. panteones) traen la técnica de varias
  // inscripciones en el bloque memorial. Solo se usa si hay palabras técnicas
  // explícitas (grabado/relieve); un nombre/fecha sin técnica nunca factura.
  if (!inscriptionDetail && !/inscripci/.test(specsN)) {
    draftCatalogMemorialInscriptionLines_(data.memorial).forEach(item => {
      add("INSCRIPCIÓN", {
        variant: item.variant,
        units: ["ud"],
        material: "",
        detail: item.detail,
        chargeable: true,
        review: false
      });
    });
  }

  // Accesorios. Una pieza propia se conserva como información, sin cargo nuevo.
  if (/\bjardinera\b/.test(specsN)) {
    const own = draftCatalogComponentOwned_(specs, "jardinera");
    add("JARDINERA", {
      units: ["ud"],
      material: "",
      detail: draftCatalogComponentText_(specs, "jardinera") || (own ? "JARDINERA SUYA" : "JARDINERA"),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "pieza suya" : ""
    });
  }
  if (/\bflorero\b|\bfloreros\b|\bjarron\b/.test(specsN)) {
    const own = draftCatalogComponentOwned_(specs, "florero");
    add("FLORERO", {
      units: ["ud"],
      material: "",
      detail: draftCatalogComponentText_(specs, "florero") || (own ? "FLORERO SUYO" : "FLORERO"),
      forceNoPrice: own,
      chargeable: !own,
      reason: own ? "pieza suya" : ""
    });
  }

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

  const remate = draftClean_(specs).match(/\bremate\s+(?:de\s+)?caj[oó]n\b[^.;]*/i);
  if (remate) {
    add("REMATE / CAJÓN", {
      units: ["ud", "trabajo"],
      material: "",
      detail: draftClean_(remate[0]).toUpperCase(),
      forceNoPrice: true,
      chargeable: true,
      review: true,
      reason: "sin tarifa validada"
    });
  }

  // Herrajes especiales: nunca perderlos aunque el catálogo todavía no tenga precio.
  const hardware = draftClean_(specs).match(/\b(barandilla|pletinas?|[aá]ngulos?)\b[^;]*/i);
  if (hardware) {
    add("BARANDILLA / HERRAJES", {
      units: ["trabajo", "ud"],
      material: "",
      detail: draftClean_(hardware[0]).toUpperCase(),
      forceNoPrice: true,
      chargeable: true,
      review: true,
      reason: "sin tarifa validada"
    });
  }

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

function draftCatalogComponentPattern_(component) {
  const names = {
    corte: "corte",
    repisa: "repisas?",
    cornisa: "cornisas?",
    coronacion: "coronaci[oó]n",
    tabica: "tabica(?:\\/tacos)?",
    tacos: "tacos?",
    imagen: "imagen",
    jardinera: "jardineras?",
    florero: "floreros?",
    columna: "columnas?",
    pilastra: "pilastras?",
    cruz: "cruz",
    crucificado: "crucificado"
  };
  return names[component] || component;
}

function draftCatalogAllComponentPattern_() {
  return "modelo|corte|imagen|floreros?|jardineras?|inscripci[oó]n|repisas?|cornisas?|coronaci[oó]n|tabica(?:\\/tacos)?|tacos?|columnas?|pilastras?|garras?|cruz|crucificado";
}

function draftCatalogComponentText_(specs, component) {
  const raw = draftClean_(specs);
  if (!raw) return "";
  const key = draftCatalogComponentPattern_(component);
  const all = draftCatalogAllComponentPattern_();

  // Formato etiquetado: CORNISA: SUYA / Pegar, INSCRIPCION: Relieve s/suya...
  const labeled = raw.match(new RegExp(`(?:^|[,;.])\\s*${key}\\s*:\\s*(.*?)(?=\\s*[.;]|\\s*[,]\\s*(?:${all})\\s*:|$)`, "i"));
  if (labeled) {
    let value = draftClean_(labeled[1]).replace(/^[-,:\s]+|[-,:\s]+$/g, "");
    if (["corte", "repisa", "cornisa", "coronacion", "tabica", "tacos"].includes(component) && /^suy[oa]s?\b/i.test(value)) {
      value = draftClean_(value.split(",")[0]);
    }
    return value;
  }

  const standalone = raw.match(new RegExp(`(?:^|[.;])\\s*${key}\\b\\s*:?\\s*([^.;]*)`, "i"));
  const match = standalone || raw.match(new RegExp(`\\b${key}\\b\\s*:?\\s*([^.;]*)`, "i"));
  if (!match) return "";
  let detail = draftClean_(match[1]).replace(/^[-,:\s]+/, "");

  // Cortar cuando empieza claramente otro componente, para que no se derrame
  // "jardinera, repisa y tabica/tacos suyos" dentro de una sola línea.
  const boundary = detail.search(new RegExp(`(?:,|\\by\\b)\\s*(?:${all})\\b`, "i"));
  if (boundary >= 0) detail = detail.slice(0, boundary);
  if (new RegExp(`^(?:${all})\\b`, "i").test(detail)) return "";
  return draftClean_(detail).replace(/[,:\s]+$/, "");
}

function draftCatalogComponentOwned_(specs, component) {
  const raw = draftClean_(specs);
  if (!raw) return false;
  const key = draftCatalogComponentPattern_(component);

  // Caso directo: "imagen suya", "cornisa: suya", "floreros suyos".
  if (new RegExp(`\\b${key}\\b\\s*(?::\\s*)?suy[oa]s?\\b`, "i").test(raw)) return true;

  // Caso de lista plural: "jardinera, repisa y tabica/tacos suyos" o
  // "repisa y cornisa suyas". Solo propagamos hacia atrás el plural para no
  // confundir frases como "cruz BL con Cristo de mármol blanco suyo".
  const groupComponents = "imagen|floreros?|jardineras?|repisas?|cornisas?|coronaci[oó]n|tabica(?:\\/tacos)?|tacos?|columnas?|pilastras?|cruz";
  const group = new RegExp(`\\b${key}\\b(?:\\s*[,/]?\\s*(?:y\\s+)?(?:${groupComponents})\\b)*\\s+suy[oa]s\\b`, "i");
  return group.test(raw);
}

function draftCatalogComponentHasAction_(specs, component, actionRegex) {
  const text = draftCatalogComponentText_(specs, component);
  if (actionRegex.test(draftNormalize_(text))) return true;

  // Para redacción libre, mirar solo la frase del componente, no toda la nota.
  const raw = draftClean_(specs);
  const key = draftCatalogComponentPattern_(component);
  const sentence = raw.match(new RegExp(`\\b${key}\\b[^.;]*`, "i"));
  return sentence ? actionRegex.test(draftNormalize_(sentence[0])) : false;
}

function draftCatalogComponentMaterial_(specs, component, fallback) {
  if (draftCatalogComponentOwned_(specs, component)) return "MATERIAL SUYO";
  const rawDetail = draftCatalogComponentText_(specs, component);
  let block = draftNormalize_(rawDetail);
  if (!/\b(ab|absoluto|negro absoluto|sd|sudafrica|sud africa|it|italia|italiano|ch|champan|champagne|tezal|blanco|bl|macael|lc|labrador)\b/.test(block)) {
    const raw = draftClean_(specs);
    const key = draftCatalogComponentPattern_(component);
    const sentence = raw.match(new RegExp(`\\b${key}\\b[^.;]*`, "i"));
    if (sentence) block = draftNormalize_(sentence[0]);
  }

  if (/\b(ab|absoluto|negro absoluto)\b/.test(block)) return "NEGRO ABSOLUTO";
  if (/\b(sd|sudafrica|sud africa)\b/.test(block)) return "NEGRO SUDÁFRICA";
  if (/\b(it|italia|italiano)\b/.test(block)) return "MÁRMOL ITALIANO";
  if (/\b(ch|champan|champagne)\b/.test(block)) return "BLANCO CHAMPÁN";
  if (/\b(tezal)\b/.test(block)) return "NEGRO TEZAL";
  if (/\b(blanco|bl|macael)\b/.test(block)) return "BLANCO MACAEL";
  if (/\b(lc|labrador)\b/.test(block)) return "LABRADOR";
  return fallback;
}

function draftCatalogMaterialLabel_(material) {
  return material === "MATERIAL SUYO" ? "MATERIAL SUYO" : material;
}

function draftCatalogInscriptionDetail_(specs) {
  const raw = draftClean_(specs);
  if (!raw) return "";
  const labeled = raw.match(/(?:^|[,;.])\s*inscripci[oó]n\s*:\s*(.*?)(?=\s*[,;.]\s*(?:modelo|corte|imagen|floreros?|jardinera|repisa|cornisa|coronaci[oó]n|tabica|columnas?|pilastras?|garras?)\s*:|$)/i);
  if (labeled) return draftClean_(labeled[1]).toUpperCase();
  const sentence = raw.match(/inscripci[oó]n\s+([^.;]*)/i);
  if (!sentence) return "";
  let detail = draftClean_(sentence[1]);
  const boundary = detail.search(/(?:,|\by\b)\s*(?:repisa|cornisa|coronaci[oó]n|jardinera|floreros?|imagen|garras?|tabica|columnas?|pilastras?)\b/i);
  if (boundary >= 0) detail = detail.slice(0, boundary);
  return draftClean_(detail).toUpperCase();
}

function draftCatalogPhysicalPhoto_(specs) {
  const raw = draftClean_(specs);
  if (!raw) return "";

  // Excluir explícitamente referencias de diseño: s/foto, sin foto, según foto.
  const candidates = raw.split(/[.;]/).map(draftClean_).filter(Boolean);
  for (const candidate of candidates) {
    const n = draftNormalize_(candidate);
    if (!/\bfotos?\b/.test(n)) continue;
    if (/\bs\/\s*foto\b|\bsin\s+foto\b|\bsegun\s+foto\b/.test(n)) continue;
    const isPhysical = /\bfotos?\s+(?:de\s+)?\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*cm\b/i.test(candidate)
      || /\bfotos?\s+(?:color|b\/n|blanco y negro)\b/i.test(candidate)
      || /\bfotos?\b[^.;]{0,50}\b(?:a acero|a porcelana|anillo|aro|fondo)\b/i.test(candidate);
    if (isPhysical) return candidate.toUpperCase();
  }
  return "";
}

function draftCatalogMemorialInscriptionLines_(memorial) {
  const raw = draftClean_(memorial);
  if (!raw) return [];
  const sentences = raw.split(/\.\s+(?=En\s)|\n+/i).map(draftClean_).filter(Boolean);
  const out = [];
  sentences.forEach(sentence => {
    const match = sentence.match(/^(?:En\s+([^,]+),\s*)?(relieve|grabado)\s+([^:.;]*)(?=:|$)/i);
    if (!match) return;
    const zone = draftClean_(match[1]);
    const technique = draftClean_(`${match[2]} ${match[3]}`).toUpperCase();
    const variant = /relieve/i.test(match[2]) ? "RELIEVE" : "";
    out.push({ variant, detail: [zone ? zone.toUpperCase() : "", technique].filter(Boolean).join(" · ") });
  });
  return out;
}

function draftCatalogMaterial_(value) {
  const raw = draftClean_(value);
  const text = draftNormalize_(raw);
  if (!text) return "";
  if (text.includes("porcelana")) return "PORCELANA";
  if (text.includes("italia")) return "MÁRMOL ITALIANO";
  if (text.includes("sudafrica")) return "NEGRO SUDÁFRICA";
  if (text.includes("absoluto")) return "NEGRO ABSOLUTO";
  if (text.includes("champ")) return "BLANCO CHAMPÁN";
  if (text.includes("macael") || text === "blanco") return "BLANCO MACAEL";
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
  if (/remus|renus|renys/.test(text)) variants.push("REMUS");
  if (/inglesa/.test(text)) variants.push("INGLESA");
  if (/cataneo/.test(text)) variants.push("CATANEO");
  if (/redonda/.test(text)) variants.push("REDONDA");
  if (/gotica/.test(text)) variants.push("GÓTICA");
  if (/laser/.test(text)) variants.push("LÁSER");
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
