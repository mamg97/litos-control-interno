# LITOS business logic

Updated: 2026-09-18

This file records business semantics that must survive future code changes and conversation handoffs.

## 1. Operational master

`PEDIDOS M.S.` is the private source of truth for orders.

Automation may enrich missing information, but existing non-empty manual/validated fields are authoritative unless a specific migration explicitly states otherwise.

Important date concepts are distinct:

- `Fecha recepción (email)`: when the authorized intake email was received.
- `Fecha ficha`: order/work-sheet date from the source document.
- `Fecha entrega (estadillo)`: date the work was delivered/posted to the private running account.
- `Fecha para dashboard`: canonical reporting date consumed by the website. If empty, feed code falls back to delivery, receipt, then fiche date.

Do not collapse these into a single date.

## 2. Private running account / estadillo

The estadillo is a private running account between the workshop and an external recurring account/customer.

Movement semantics:

- `TRABAJO ENTREGADO`: delivered work is posted to `Debe (€)`; it increases the amount pending from the external account.
- `ENTREGA A CUENTA`: cash/payment advance is posted to `Haber (€)`; it reduces the outstanding balance.
- `Saldo acumulado (€)` is the running balance.
- Positive balance = amount pending collection.
- Negative balance = balance in favor of the external account/customer.

The private ledger must remain private. The public dashboard may expose only the approved aggregate/sanitized movement fields.

### Revenue rule

`Importe trabajo / Debe (€)` is the economic value/base recorded for the delivered job in the estadillo.

Cash advances are movements of settlement, not additional revenue. Never add `ENTREGA A CUENTA` to revenue a second time.

For financial views, delivered-work value drives recorded revenue; advances only affect the running account balance.

## 3. Final sale price / PVP

`Precio final (€)` means the final public sale price: taxes included.

For the historical regime currently encoded in LITOS:

- IVA: 21%
- Recargo de equivalencia: 5.2%
- Combined multiplier from taxable base to PVP: `1.262`

Historical PVP recovery precedence:

1. Use an explicit tax-inclusive `TOTAL` from a validated albarán when available.
2. Otherwise use a validated albarán base and calculate `base × 1.262`.
3. If the linked albarán is missing or internally belongs to another order, use the reliable `Importe trabajo / Debe (€)` base from the master/estadillo and calculate `base × 1.262`.
4. Do not manufacture a PVP when the reliable base is zero/missing.
5. Record the source/calculation in `Observación de conciliación`.

The website's `finalPrice` must always map to `Precio final (€)`, never directly to `Importe trabajo / Debe (€)`.

## 4. Historical document reconciliation

Historical Drive organization is imperfect. A file name or folder name is not sufficient proof of ownership.

Before using a historical XLS/XLSX:

- inspect its internal order number;
- require the internal order number to match the target order when using document-specific fields;
- treat mismatches as conflicts and annotate them;
- reject impossible dates (for example, a fiche date after a known delivery date) unless independently validated;
- prefer explicit values from a validated document over inferred values;
- otherwise use the master/estadillo only for fields whose business meaning is known.

Historical enrichment is fill-only by default.

## 5. Gmail intake

The production intake processes only the explicitly authorized sender stored in the private `Configuracion privada` sheet.

Public repository rules:

- sender address must never be committed;
- message contents, subjects, Gmail IDs and attachment names must not be printed to public Actions logs;
- authentication credentials belong only in GitHub Secrets; real sender identity belongs only in private Sheet configuration.

A newly received authorized order is processed on the next scheduled M3+M4 run, not instantly.

## 6. Handwriting

Handwritten/private image content is processed only inside the protected production flow.

Structured extraction must be validated before being applied to the master. Low-confidence/ambiguous data stays for review rather than overwriting authoritative fields.

## 7. Drafts and final albaranes

Draft behavior:

- drafts use the corporate A4 style;
- a draft is subordinate to a definitive albarán;
- a definitive XLS/XLSX takes precedence over a draft for document links and production state;
- historical document IDs/links should be preserved when files are reorganized.

Do not copy prices from another job merely because a template or historical workbook contains them.

## 8. Public dashboard

The dashboard is a static GitHub Pages artifact generated from the private master.

It must:

- use the sanitized feed only;
- have no Apps Script runtime dependency;
- never expose private customer/person names or private notes;
- show `Precio final` as tax-inclusive PVP;
- treat the estadillo balance consistently:
  - positive = pending collection;
  - negative = credit/balance in favor of the external account/customer.

## 9. Privacy vocabulary

Public code/docs/UI should use neutral roles:

- workshop owner
- authorized sender
- external account/customer
- private running account / estadillo

Avoid real personal names, addresses and email addresses in public source, comments, workflow names and commit messages.

## 10. Monthly forecast logic

Summary-view forecasts apply only to the current open year.

- Real recorded values always take precedence and are never replaced by a forecast.
- The current calendar month remains actual even if it is partial.
- Only future months after the current calendar month are forecast.
- Each future month is estimated from the same calendar month in up to the five most recent prior years.
- The weighted moving average uses linearly increasing weights from oldest to newest sample: `1, 2, 3, 4, 5` (or `1..N` when fewer than five prior years exist).
- Order forecasts are rounded to whole orders.
- Profit forecasts retain their monetary numeric value and use the same weighted-month rule.
- Forecast values are rendered in the dashboard's gold/amber forecast color.
- The historical matrix keeps `Total` as the actual recorded total and adds `Estimación` as the projected year-end total.
- Closed years show `—` in the `Estimación` column.
- Quarterly display aggregates monthly actuals plus any monthly forecasts; forecasts are still computed month-by-month before aggregation.

