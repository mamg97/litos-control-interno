# LITOS business logic

Updated: 2026-09-19

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



## 11. Periodic business-mailbox review and reconciliation

Periodic review of the workshop's business mailbox(es) is part of normal LITOS operations. It complements the automated authorized-sender Gmail intake; it does not replace it.

The review must not be limited to unread mail. Each control cycle should inspect the relevant period since the last verified checkpoint and cover both incoming mail and sent items.

### Incoming business mail

Look for operational documents and events that can change LITOS, especially:

- supplier invoices, credit notes and corrected invoices;
- supplier order confirmations or material-related documents when they affect cost/catalog data;
- customer/account communications that change delivery, billing or settlement status;
- any attachment that is the authoritative source for an amount, date, reference or material description.

For an invoice or equivalent supplier document:

1. identify the supplier role, document/invoice reference, document date and total amount from the attachment or authoritative message content;
2. inspect the attachment when it contains more reliable detail than the email body;
3. check whether the same document reference is already registered before creating any new expense/cost record;
4. classify the cost using the existing LITOS expense/material semantics rather than inventing a new category ad hoc;
5. retain a private source reference/link when the data model supports it;
6. never publish supplier/private document contents in the public feed or repository.

A new email is evidence of receipt, not automatic proof that a new accounting row is required: duplicate, corrected or already-registered documents must be reconciled first.

### Sent items and delivered albaranes

Sent mail is also an operational evidence source. Periodically inspect sent items for albaranes or other final documents delivered to the recurring external account/customer.

For each sent albarán:

1. identify the internal order/albarán number from the attachment itself whenever possible;
2. match that number against the private master and the relevant Drive order folder;
3. treat the validated attachment as evidence that the document was sent/delivered on that date;
4. update delivery/document state only after the internal identifier matches;
5. use any price/base/total only if it is validated under the PVP and reconciliation rules in this file;
6. do not infer ownership, price or delivery solely from an attachment filename or email subject.

Several albaranes may be attached to one outgoing email; each attachment must be reconciled independently.

### Physical delivery with no email evidence

Some albaranes may be delivered physically and therefore will not appear in sent mail.

Those cases require explicit manual evidence before updating LITOS:

- internal order/albarán number;
- delivery date;
- relevant amount if the document is being used as an accounting source;
- note that the source was a physical handoff rather than email.

Do not fabricate an email/source link for a physical delivery.

### Reconciliation and idempotency

Use this order when resolving mailbox information:

1. email metadata identifies the event and date;
2. attachment/document content establishes the authoritative reference and values;
3. private master establishes current recorded state;
4. private Drive files/folders provide supporting operational evidence;
5. only then apply a fill/update according to the relevant business rule.

Before writing anything, check for an existing row/document/reference so the same email, invoice or albarán cannot be registered twice.

If evidence conflicts, do not guess. Leave the record for review and annotate the conflict in the private operational data when appropriate.

### Handoff rule for agents and future conversations

When an agent is asked to review recent workshop updates, it should actively consider the business mailbox as a source of truth for new supplier invoices and sent-document evidence, not only the order-intake Gmail flow.

A mailbox review should report, at minimum:

- new actionable incoming documents found;
- whether each one is already represented in LITOS;
- sent albaranes/documents found and their validated internal identifiers;
- physical-delivery items still requiring manual data;
- any conflict or missing evidence that prevents a safe update.

Public documentation must describe this process using neutral roles only. Real mailbox addresses, personal names, customer identities, attachment names and private message contents must remain outside the public repository.
