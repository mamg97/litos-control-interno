# M6 — sincronización de albaranes 2026 en Python

Esta fase migra `apps-script/SyncAlbaranes.gs` fuera de Apps Script.

## Estado actual

Solo existe la fase de **paridad read-only**. No modifica Google Sheets ni Drive y no tiene ejecución programada.

El comprobador:

- recorre recursivamente la carpeta operativa 2026;
- clasifica el XLS/XLSX/XLSM más reciente por pedido como definitivo o borrador;
- compara los enlaces preparados en `Pedidos`;
- descarga el fichero activo y busca el primer valor numérico a la derecha de una celda `TOTAL`;
- compara ese valor con `Total sheet (€)`;
- publica únicamente contadores técnicos en Actions, no nombres de ficheros ni IDs de pedido.

## Cutover previsto

1. validar paridad read-only contra el Apps Script todavía activo;
2. añadir escritura fail-closed, canary y rollback/guardas;
3. ejecutar sync manual controlado;
4. retirar el trigger `syncAlbaranes2026` de Apps Script;
5. habilitar el schedule Python mediante kill switch explícito;
6. validar una ejecución programada real.

La automatización final debe respetar `ZERO_COST_POLICY.md` y usar únicamente el OAuth privado almacenado en GitHub Actions.
