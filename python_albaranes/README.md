# M6 — sincronización de albaranes 2026 en Python

M6 es la implementación de producción que sustituyó al antiguo sincronizador de Apps Script para conciliación de albaranes.

## Estado actual

**Producción certificada.** Apps Script ya no es una dependencia operativa.

El componente:

- recorre recursivamente la carpeta operativa 2026;
- clasifica el XLS/XLSX/XLSM activo por pedido como definitivo o borrador;
- valida enlaces y valores antes de escribir;
- busca el primer valor numérico a la derecha de una celda `TOTAL` cuando corresponde;
- sincroniza los campos permitidos del maestro mediante escritura fail-closed;
- dispone de modos `dry-run`, canary y sincronización manual controlada;
- puede ejecutarse mediante el bridge desde una ejecución programada y correcta de `LITOS Draft Sync`;
- queda bloqueado si `LITOS_ALBARAN_KILL_SWITCH` no está explícitamente en `false`;
- publica en Actions únicamente información técnica compatible con las reglas de privacidad.

## Autenticación

La credencial privada de Drive/Sheets vive en GitHub Secrets como `GOOGLE_OAUTH_USER_JSON`.

El adaptador M6 consume directamente `GOOGLE_OAUTH_USER_JSON` y solicita únicamente permisos de Drive/Sheets. M6 no requiere acceso a Gmail ni debe recrearse ningún secret legacy.

## Reglas de seguridad

- Las escrituras requieren `LITOS_ALBARAN_WRITE_ENABLED=true`.
- El kill switch debe estar explícitamente desactivado para cualquier escritura productiva.
- Los modos manuales de escritura exigen confirmación explícita.
- La ejecución por bridge solo procede desde un `LITOS Draft Sync` programado que haya terminado correctamente.
- Los backfills históricos son operaciones excepcionales y no forman parte de la sincronización ordinaria.
- Deben respetarse `BUSINESS_LOGIC.md`, `CONFIGURATION.md`, `PRIVACY_STATUS.md` y `ZERO_COST_POLICY.md`.

## Estado legacy

No reinstalar el antiguo trigger de Apps Script ni volver a desplegarlo como ruta normal. Cualquier rollback a Apps Script requiere una decisión deliberada y documentada.
