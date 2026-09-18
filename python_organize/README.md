# LITOS · Python organizer (M5)

Migración del mantenimiento nocturno `organizarArchivosPorPedido` desde Apps Script a Python/GitHub Actions.

Contrato funcional conservado:
- carpetas anuales 2020-2026;
- solo se consideran archivos situados directamente en la carpeta anual;
- solo se mueve un archivo cuando el nombre contiene un único ID inequívoco de cuatro cifras;
- archivos sin ID o con varios ID nunca se mueven;
- cada archivo se mueve a la subcarpeta `<ID>`, creándola si no existe;
- el ID de Drive del archivo no cambia;
- procesamiento máximo por defecto: 120 archivos por ejecución.

Seguridad:
- `--dry-run` solo descubre candidatos;
- `--sync` exige `LITOS_FREE_ONLY=true`, `LITOS_ORGANIZE_WRITE_ENABLED=true` y kill switch desactivado;
- las ejecuciones programadas son fail-closed y solo escriben si `LITOS_ORGANIZE_KILL_SWITCH=false` existe como variable del repositorio;
- si una ejecución de escritura falla, intenta devolver los archivos ya movidos a su carpeta anual y eliminar las carpetas creadas durante esa transacción.

La autenticación reutiliza el secreto neutro `GOOGLE_OAUTH_USER_JSON` para Drive/Sheets. M5 no requiere acceso a Gmail ni ningún secreto específico de cliente.
