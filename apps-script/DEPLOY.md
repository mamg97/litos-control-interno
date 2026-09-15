# Despliegue seguro de LITOS Apps Script

Este directorio contiene el backend que alimenta el dashboard y el generador de albaranes/facturas borrador.

## Archivos que deben existir en el proyecto Apps Script vinculado a `PEDIDOS M.S.`

- `Code.gs`
- `DraftInvoices.gs`
- `ImportarSaban.gs`
- `HandwrittenReadings.gs`
- `appsscript.json`

## Flujo seguro de nuevos pedidos por correo

1. En **Propiedades del script**, crear `SABAN_ALLOWED_SENDER` con el único
   remitente autorizado. No se guarda esa dirección en el repositorio.
2. Ejecutar `importarCorreosSaban` una vez para conceder los permisos y
   comprobar el resultado con pedidos de prueba.
3. Ejecutar `installSabanMailTriggers` una sola vez. Comprueba la etiqueta
   Gmail aproximadamente a las 07:00, 11:00, 15:00 y 19:00 (Europe/Madrid)
   y solo guarda adjuntos del remitente autorizado.
4. En **Propiedades del script**, guardar una clave de autorización de Gemini
   como `GEMINI_API_KEY`. Opcionalmente, `GEMINI_VISION_MODEL` permite cambiar
   el modelo; por defecto se usa `gemini-3.8-flash`.
5. Cada nota crea una fila en `Lecturas manuscritas`. El flujo obtiene una
   propuesta estructurada, valida rangos y confianza por campo y aplica
   únicamente lecturas técnicamente fiables al maestro.
6. Una lectura fiable genera el borrador XLSX dentro de la carpeta del pedido.
   Los casos dudosos quedan en revisión y pueden marcarse como `Validado` para
   aplicar después la corrección mediante `aplicarLecturasValidadas`.

## Organización de archivos de cada año

`organizarArchivosPorPedido` crea, dentro de cada año, una carpeta por ID de
trabajo y mueve ahí únicamente archivos cuyo nombre tenga un único ID de cuatro
cifras. Los archivos sin ID o con más de un ID no se mueven. Es repetible,
trabaja por lotes y conserva los mismos enlaces de Drive.

- Ejecutarla varias veces hasta que devuelva `pending: 0` para ordenar el
  histórico inicial.
- Ejecutar `installOrganizeJobFoldersTrigger` una sola vez para una pasada
  nocturna. Los nuevos adjuntos de correo ya se guardan directamente en la
  subcarpeta del pedido.

## Primera activación del generador de borradores

1. Abrir `PEDIDOS M.S.` en Google Sheets.
2. Abrir **Extensiones > Apps Script**.
3. Sincronizar el contenido de los tres archivos anteriores con este directorio del repositorio.
4. En Configuración del proyecto, activar **Mostrar el archivo de manifiesto appsscript.json** si no aparece.
5. Ejecutar manualmente `ensureCurrentQuarterDraftInvoices` una vez y aceptar los permisos solicitados.
   - La función solo considera pedidos cuya recepción cae en el trimestre actual.
   - Si ya existe una factura/albarán XLS/XLSX definitivo, no crea borrador.
   - Si ya existe `<ID>_borrador.xlsx`, no lo sobrescribe.
   - Si falta ambos, crea `<ID>_borrador.xlsx` desde la plantilla técnica.
6. Ejecutar `installDraftInvoiceTrigger` una sola vez. Instala una comprobación horaria y no duplica el trigger si ya existe.
7. Ir a **Implementar > Gestionar implementaciones**, editar la Web App, seleccionar **Nueva versión** y desplegar.

## Flujo del taller

- Sin definitiva: el dashboard muestra **Abrir borrador**.
- El borrador conserva el formato habitual, pero no hereda precios de otro trabajo.
- El taller completa/revisa precios y cualquier dato pendiente.
- Al quitar `_borrador` del nombre del mismo XLSX, el índice lo clasifica como factura/albarán definitivo.
- La definitiva tiene prioridad, desaparece la indicación de borrador y el pedido deja de contar como `En producción` si pertenece al trimestre actual.

## Importante

**No ejecutar `populateDocumentLinks()` para activar este flujo.** Esa función es de mantenimiento histórico y recorre el maestro de forma amplia. El generador de borradores usa `ensureCurrentQuarterDraftInvoices()` y está deliberadamente acotado al trimestre actual.

## Plantilla

El generador usa la plantilla técnica privada de Drive:

- `PLANTILLA ALBARAN LITOS - NO BORRAR`
- ID: `1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY`

La plantilla deriva del formato real del albarán 7917. Mantiene el diseño del taller, pero los precios y datos variables están limpiados.
