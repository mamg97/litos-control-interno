/**
 * LITOS — organización de documentos por año y pedido.
 *
 * Cada carpeta anual contiene una subcarpeta con el ID de cada trabajo. Solo
 * se mueve un archivo cuando su nombre identifica de forma inequívoca un
 * único pedido de cuatro cifras; lo no identificable nunca se mueve.
 */

const LITOS_YEAR_FOLDERS = Object.freeze({
  2020: "1UMgVG8IvZSJkCSxxrumXoBLxKaN6h7BK",
  2021: "1MitrqxWNS-ympuhRfoYr-fvMzbJCvyH1",
  2022: "1jT8Mlq4aeLvL4pWcChUFlTPHK0xe_Ynq",
  2023: "1d94eLfw6EOf0N9YOyJubpz1u4pCr_wsq",
  2024: "1TD0z7lRXkDOx47-dq4ig5vmDGUDC3BH7",
  2025: "1yicoADtD85yEWZ9Qevcn0mzhRqcYiXQU",
  2026: "1eUAupqLzfBhkiEexWqpI3JtYReT8c9A_"
});

const LITOS_ORGANIZE_BATCH_SIZE = 120;

/**
 * Organiza hasta 120 archivos por ejecución, empezando por los años recientes.
 * Ejecútala repetidamente hasta que pending sea 0. Al no tocar subcarpetas, es
 * segura de repetir y no desplaza documentos ya ordenados.
 */
function organizarArchivosPorPedido() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: true, reason: "otra organización en curso" };

  try {
    let remaining = LITOS_ORGANIZE_BATCH_SIZE;
    const result = { moved: [], createdFolders: [], skippedNoId: [], skippedAmbiguous: [], pending: 0 };
    const years = Object.keys(LITOS_YEAR_FOLDERS).sort((a, b) => Number(b) - Number(a));

    for (const year of years) {
      if (remaining <= 0) break;
      const folder = DriveApp.getFolderById(LITOS_YEAR_FOLDERS[year]);
      const files = folder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        const ids = litosOrderIdsInName_(file.getName());
        if (!ids.length) {
          result.skippedNoId.push({ year, name: file.getName() });
          continue;
        }
        if (ids.length > 1) {
          result.skippedAmbiguous.push({ year, name: file.getName(), ids });
          continue;
        }
        if (remaining <= 0) {
          result.pending += 1;
          continue;
        }

        const id = ids[0];
        const target = litosOrderFolder_(folder, id, result.createdFolders);
        file.moveTo(target);
        result.moved.push({ year, id, name: file.getName() });
        remaining -= 1;
      }
    }

    // Si agotamos el lote, todavía puede haber archivos directos pendientes.
    result.pending = result.pending || (remaining === 0 ? 1 : 0);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Instala una pasada nocturna, útil para las entradas manuales. La entrada por
 * correo ya guarda directamente dentro de la carpeta del pedido.
 */
function installOrganizeJobFoldersTrigger() {
  const functionName = "organizarArchivosPorPedido";
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(functionName).timeBased().atHour(2).everyDays(1).inTimezone("Europe/Madrid").create();
  return { installed: true, schedule: "diario, 02:00 aproximadas" };
}

function removeOrganizeJobFoldersTrigger() {
  const functionName = "organizarArchivosPorPedido";
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { removed };
}

function litosOrderFolder_(yearFolder, id, createdLog) {
  const folders = yearFolder.getFoldersByName(String(id));
  if (folders.hasNext()) return folders.next();
  const created = yearFolder.createFolder(String(id));
  if (createdLog) createdLog.push({ year: yearFolder.getName(), id: String(id) });
  return created;
}

function litosOrderIdsInName_(name) {
  const matches = String(name || "").match(/(?:^|[^0-9])(\d{4})(?=[^0-9]|$)/g) || [];
  const ids = matches.map(match => (match.match(/\d{4}/) || [""])[0]).filter(Boolean);
  return [...new Set(ids)];
}
