# LITOS business logic

Updated: 2026-09-20

This file records business semantics that must survive future code changes and conversation handoffs.

## 1. Operational master

`PEDIDOS M.S.` is the private source of truth for orders.

Automation may enrich missing information, but existing non-empty manual/validated fields are authoritative unless a specific migration explicitly states otherwise.

Important date concepts are distinct:

- `Fecha recepción (email)`: when the authorized intake email was received.
- `Fecha ficha`: order/work-sheet date from the source document.
- `Fecha entrega (estadillo)`: date the work was delivered/posted to the private running account.
- `Fecha entrega albarán`: an independently validated delivery date, differentiated from the order/NUM header. Internal-ID validation and coincidence with the estadillo date are not sufficient delivery evidence. A header-only FECHA stays out of both documentary-delivery fields, even when the workbook is titled ALBARAN. Preserve the source date and provenance separately.
- `Fecha para dashboard`: canonical reporting date consumed by the website. If empty, feed code falls back to delivery, receipt, then fiche date.

Do not collapse these into a single date.

### Operational trace ordering

The work trace/history table is ordered for operational follow-up, not purely chronologically.

The grouping key is the **operational month**:

- if a work has a validated `Fecha entrega albarán`, it belongs to the month of delivery;
- if it has no validated delivery date, it belongs to its entry month, resolved from `Fecha recepción (email)` and then `Fecha ficha`.

Ordering rules:

1. operational months run from newest to oldest;
2. inside each month, unresolved jobs come first;
3. unresolved jobs are sorted by receipt email descending, then by source/order date descending;
4. delivered jobs for that same month follow, sorted by `Fecha entrega albarán` descending;
5. only after the full operational month is exhausted does the trace continue with the previous month.

This means a job ordered in July but delivered in September appears in the September block, after September jobs that are still pending.

A row with no `Fecha entrega albarán` whose entry month has already finished must be visually flagged for manual document review, except when its status is `Cerrado histórico · sin fecha de entrega documental`. A historical closure retains its limitation label without requesting repeated investigation. The absence of a delivery date after the month closes is treated as an operational warning that the definitive document may be missing or unreconciled.

This ordering is independent from the economic/statistical reporting date.


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

A later accounting movement that reuses an existing work ID must not create a second `Pedidos` row. `Pedidos` has one canonical row per work ID. Subsequent reform, repair, adjustment or other accounting entries that refer to that same historical ID remain separate rows in `Movimientos cliente` and may be documented on the canonical work, but they do not clone the order master row.

When a newly supplied estadillo is declared to contain the current real balance, reconcile its identifiable work and payment lines into `Movimientos cliente` in source order and carry the exact running balance shown by the source. Do not insert an opaque balancing entry when the detailed movements explain the difference. If an unexplained residual remains after all identifiable lines are recorded, add one explicit `AJUSTE / OTRO` movement with the evidence date, signed amount, prior balance, resulting authoritative balance, source and reason. An adjustment affects the running account only; it is not revenue and never creates or duplicates a `Pedidos` row.

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
4. Do not manufacture a PVP when the reliable base is missing. An explicitly validated documentary zero is a real zero PVP (for example 7041), not missing data.
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
- explicit variants such as `BIS`, `REPOSICION`/`REPOSICIÓN`, replacements or numeric revision suffixes must never be promoted automatically to the canonical work document; they require an explicit manual reconciliation, even when no base file is visible in the currently scanned operational folder;
- otherwise use the master/estadillo only for fields whose business meaning is known.

Historical enrichment is fill-only by default.


### Canonical work ID

The four-digit internal work/order ID is the canonical reconciliation key across the private master, Drive folders, incoming or sent attachments, generated drafts, definitive documents and running-account movements.

Names, customer text, materials, email subjects and filename text beyond the ID are secondary evidence only.

`Pedidos` and the public feed must contain exactly one canonical row per four-digit work ID. A later reform, repair, replacement, inscription/date adjustment or other ledger movement that reuses an existing ID remains a separate `Movimientos cliente` entry and may be documented on the canonical work, but it must not create a second `Pedidos` row. A duplicate canonical work ID in the public feed is a hard M7 validation failure and must block GitHub Pages deployment.

- If an attachment carries an explicit work ID, route it only to that ID.
- A multi-order email must be partitioned attachment by attachment; never assign the whole email to the first detected ID.
- If several IDs exist and an attachment has no explicit ID, leave that attachment unresolved rather than guessing.
- If a document's internal ID conflicts with its filename, folder or email context, block automatic reconciliation and require review.

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

An outgoing email with a validated albarán attachment is sufficient evidence to mark the job as operationally delivered even when the definitive file has not yet been archived in Drive. In that case, record the delivery evidence and date, remove the job from active production, but do not fabricate a final-document link or financial `Debe`. Accounting reconciliation remains pending until the authoritative amount/document is validated.


### Definitive sent document vs generated draft

The PDF/albarán actually sent to the external account/customer is the authoritative commercial document for the delivery. A generated `*_borrador.xlsx` is only a pre-delivery aid and must never be promoted to authoritative status just because it contains a computed PVP.

Whenever a definitive note/albarán is sent:

1. retrieve the exact attachment that was sent;
2. identify and validate its internal order number;
3. compare it against both the original handwritten/source note and the current generated draft;
4. record every material discrepancy (measure, material, concept, quantity, unit price, tax, total or other commercial term) in the private master;
5. archive the exact definitive PDF in the corresponding order folder;
6. preserve the draft for audit/history, but keep it subordinate to the definitive document;
7. update the master document link/state so the definitive document is the active commercial reference;
8. use the validated definitive amount as the real delivery amount/financial source;
9. create/update the corresponding `TRABAJO ENTREGADO` movement in the private running account and recalculate the balance from that real amount;
10. expose the delivery in finance/history as real, not estimated.

If the definitive PDF is not accessible, the email may still prove operational delivery, but financial posting remains pending. Never use a provisional draft total as a real `Debe` merely to close the gap.

Draft-generation errors are business feedback. Repeated discrepancies must be used to improve the generator/catalog rules rather than silently overwritten.

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



### Traceability table ordering

Use the canonical **Operational trace ordering** defined in section 1 above. Do not maintain a second independent ordering rule here.

Historical delivery-date enrichment must review definitive albaranes regardless of whether the real document is PDF, XLS, XLSX or XLSM. Source-note files such as `*-nota.pdf` are not definitive albaranes and must never populate the active albarán link or delivery date.

The `FECHA` printed in the header next to `PEDIDO Nº` is the order/fiche date and must not populate `Fecha entrega albarán`. The delivery field is populated only from a differentiated delivery/footer date (`FECHA` / `FECHA DE ENTREGA`) in the definitive document; when both spreadsheet and rendered PDF exist, prefer the PDF because it commonly carries the completed footer date. The internal four-digit work ID must match before a document date is accepted. If the written date is impossible relative to the order date or current date, preserve the conflict for review and leave `Fecha entrega albarán` blank unless an explicit manual validation resolves the documentary error.


### Delivery-date repair and phased reconciliation

A historical repair was required after detecting that the previous XLS/XLSX backfill could read the `FECHA` placed on the same header row as `PEDIDO Nº` and incorrectly store it as `Fecha entrega albarán`.

The repair is executed in controlled chronological phases. 2026 was reconciled first; historical years are then reviewed month/phase by month/phase before moving farther back. Header-date copies are removed, the parser skips the order header row, `*-nota.pdf` files are excluded from definitive-document classification, and native Google Sheets are supported as candidate albaranes. XLSX/XLSM reconciliation must also inspect DrawingML/text-box content because the workshop template often stores the definitive albarán `FECHA` in a floating graphic object rather than a worksheet cell. After repair, a delivery date is retained only when it is differentiated from the order header and passes document/date validation, or when it has been explicitly validated manually.


### Mandatory document → master → web closure

No reconciliation phase is complete merely because the private master has been edited. Every corrected work must close the full chain:

1. **Document**: inspect the definitive PDF/XLS/XLSX/XLSM itself. For Excel files, inspect both worksheet cells and DrawingML/text boxes. Validate the work ID from the document content; if the ID/header is inherited from a template, only accept the document after manual reconciliation against material, concept, inscription/person, dimensions and amount. Preserve the template discrepancy explicitly.
2. **Private master**: write the validated definitive `Precio final (€)`, `Fecha entrega albarán`, source/reference and reconciliation status. `Total sheet (€)` must agree with the validated definitive TOTAL when that document is authoritative. Never leave a synthetic estadillo-derived PVP in place once a trustworthy definitive TOTAL exists.
3. **Public feed / website**: regenerate the privacy-safe feed and assert that every reconciled phase record exposes the same work ID, final price, delivery date/review status and active document link as the master. GitHub Pages deployment must fail closed if those propagation assertions do not pass.

The public website is a projection of the private master through the generated feed; it is not considered updated until the staged feed assertions and Pages deployment both succeed.

Historical rows with no trustworthy differentiated delivery date remain blank by design. They must not be populated from `Fecha ficha`, email receipt, dashboard date or estadillo merely to avoid a blank value.

The active albarán link must never point to the same resource as `Notas`, `Nota manuscrita` or attachment folders. Missing definitive documents are represented as `No disponible`, while drafts remain separately auditable.


## 12. Real-cost precedence and supplier-expense register

LITOS must use real validated figures whenever they are available and retain estimates only where no authoritative real value exists.

Cost precedence for an individual job:

1. validated direct real cost linked to that job;
2. stored/derived material estimate when no direct real cost exists;
3. no value when neither source is reliable.

A real direct cost replaces the estimate for profitability; it must never be added on top of the estimate for the same job.

Supplier invoices and job costs are related but not identical concepts:

- every validated supplier invoice may be registered in the private supplier-expense ledger;
- a supplier invoice may be linked to a job only when the evidence identifies that job safely;
- bulk/stock purchases remain documented supplier expenditure and must not be allocated arbitrarily across jobs;
- unlinked supplier invoices remain pending reconciliation and do not overwrite job estimates;
- where a supplier invoice establishes a reliable purchase rate for a material, that rate may improve future estimates without pretending that a specific stock purchase has already been consumed by a specific job.

The finance dashboard must expose supplier invoices as a separate real-expense table and visibly distinguish real job costs from estimated job costs.

Profitability treatment is deterministic and shared by annual and period views:

- validated direct supplier cost linked to a job replaces that job's estimate and is not added a second time as a general expense;
- validated supplier general expenses enter operating cost;
- validated non-supplier general expenses (for example a real postal/service invoice) also enter operating cost;
- stock purchases and stock credit notes remain outside operating profit until consumption/allocation is validated; they remain visible in the supplier register as cash/stock movements;
- supplier invoices pending a safe link remain visible but do not alter a job or operating profit until classified;
- real consumable invoices replace the equivalent portion of the standing consumables estimate. The unreconciled residual estimate remains only as fallback, so real and estimated consumables are never stacked on top of each other;
- annual KPI, monthly/quarterly chart and Sankey must use the same cost-classification engine. Their annual totals must reconcile by construction.

The public feed may expose only the minimum fields required for that table: invoice date, neutral supplier/source name, category, document reference, amount, reconciliation status, private-Drive folder/document navigation links and a neutral email-evidence label. Supplier-expense traceability should retain the private email-source link in the master, but the Outlook/Gmail message URL itself must never be published. Private notes, invoice contents, addresses and bank details must never be published.
