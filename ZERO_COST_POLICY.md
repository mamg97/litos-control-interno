# LITOS — Zero Cost Policy

## Regla inquebrantable

LITOS solo puede utilizar herramientas y servicios con coste real de **0 €**.

No se aceptan arquitecturas basadas en pruebas temporales, créditos promocionales, planes que exijan tarjeta para seguir funcionando ni servicios que puedan generar cargos por superar una cuota.

## Reglas técnicas

1. **GitHub Actions**
   - Ejecutar LITOS únicamente desde este repositorio público mientras la política de GitHub mantenga gratuitos los runners estándar para repositorios públicos.
   - Usar runners estándar Ubuntu (`ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04` o `ubuntu-slim`).
   - No usar larger runners ni runners premium.
   - Evitar artefactos persistentes y paquetes de pago; los backups operativos deben quedar en Google Drive.

2. **Google**
   - Google Sheets, Drive y APIs asociadas solo podrán usarse dentro de cuotas gratuitas y sin vincular servicios de pago necesarios para LITOS.
   - Las credenciales deben almacenarse como secretos, nunca dentro del repositorio.

3. **Infraestructura**
   - No usar Railway, Render, Fly.io, servidores VPS ni otros servicios que puedan requerir pago para mantener la automatización operativa.
   - Preferir ejecución efímera: el proceso se inicia, sincroniza y termina.

4. **Nuevas dependencias**
   - Antes de incorporar una herramienta externa debe verificarse su modelo de precios vigente.
   - Si existe posibilidad normal de facturación automática para el uso previsto, la herramienta queda descartada.

5. **Fail closed**
   - Si una condición de gratuidad deja de cumplirse, la automatización debe poder detenerse sin afectar los datos de producción.

## Arquitectura objetivo

`Google Sheets / Drive -> GitHub Actions (repo público, runner estándar) -> Python -> Google Sheets / Drive`

GitHub Actions no debe mantener ningún servidor 24/7: cada ejecución es temporal y termina al finalizar la sincronización.
