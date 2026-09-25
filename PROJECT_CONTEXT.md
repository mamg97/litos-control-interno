# LITOS project context

Updated: 2026-09-21

## Purpose

LITOS is the workshop's internal control system. It consolidates incoming order information, private Drive documents, the operational master spreadsheet, draft/final invoice files, historical reconciliation and a public sanitized dashboard.

## Current production architecture

```
Authorized Gmail intake
        ↓
Google Drive private order folders
        ↓
PEDIDOS M.S. (private operational master)
        ↓
Python / GitHub Actions
   ├─ handwriting enrichment
   ├─ draft generation
   ├─ folder organization
   ├─ invoice/albarán synchronization
   └─ public-feed generation
        ↓
GitHub Pages static dashboard
```

Google Apps Script is no longer a production dependency.

## Production components

| Component | Role | Production mechanism |
| --- | --- | --- |
| M2 | Draft generation and corporate A4 styling | Python + GitHub Actions |
| M3 | Authorized Gmail intake | Python + GitHub Actions |
| M4 | Handwriting extraction/review | Python + GitHub Actions |
| M5 | Order-folder organization | Python + GitHub Actions |
| M6 | Final/draft albarán reconciliation | Python + GitHub Actions |
| M7 | Sanitized public feed and dashboard | Python + GitHub Pages |
| M8 | Curated operational catalog | Protected/read-only automation |

## Main schedules

- M3+M4 intake/handwriting: 07:07, 11:07, 15:07 and 19:07 Europe/Madrid.
- M2 Draft Sync: approximately every 15 minutes at :05, :20, :35 and :50.
- M6 and M7 are bridged from successful scheduled Draft Sync executions.
- M5 folder organizer: 02:17 Europe/Madrid daily.
- Workflows that need a wall-clock local time use GitHub Actions `schedule.timezone: Europe/Madrid`, so CET/CEST transitions are handled by GitHub.

All schedules remain behind repository kill switches where applicable.

## Data source of truth

`PEDIDOS M.S.` is authoritative for operational reporting.

The website does not scrape Drive or Apps Script at runtime. M7 reads the private master, builds a sanitized static `feed.json`, validates it, and deploys GitHub Pages.

## Historical reconciliation status

Historical work has completed a second controlled reconciliation pass through all available 2020 records. The 2021 historical block is also fully reviewed month by month. The available master/estadillo history starts in August 2020; no July-2020 records are present.

A second-pass cleanup of unresolved historical records is now in progress. August and December 2020 were re-inspected against the available XLSX contents, order folders and alternative-file search. The FECHA found in those files is the PEDIDO/header date and is not accepted as a differentiated delivery date. No PDF or alternative definitive version with a separate delivery FECHA was located. Those records therefore keep validated PVP/document provenance while both documentary-delivery fields stay blank. August 2020 has now been closed as a documented historical limitation with status `Cerrado histórico · sin fecha de entrega documental`; no synthetic delivery date is introduced.

October 2020 second-pass cleanup also recovered the previously orphaned 08/10/2020 ledger row as canonical order **7041**: `7041.xlsx` matches the concept (`junquillo de champagne`) and definitive base/SUMA of `0 €`. The header date `15/10/2020` is stored as `Fecha ficha`; no differentiated delivery date was found, so delivery-document fields remain blank while PVP is explicitly `0,00 €`.

October contains **23 canonical orders**, including the single recovered 7041 row. The earlier 22-order/ledger-only interpretation was superseded by that document recovery; do not delete 7041 or recreate the orphan row. The original accounting movement remains in the private ledger.

For each historical month the process closes the full chain:

1. inspect the linked XLS/XLSX itself and validate the internal four-digit work ID, document date and exact `SUMA`/amount;
2. compare those values with the private master and estadillo, correcting transcription errors, rounded historical bases and wrong document links only when the evidence is strong;
3. write the authoritative `Precio final (€)`, documentary date, reconciliation status and provenance back to the private master;
4. preserve unresolved cases as explicit conflicts or pending items instead of guessing;
5. add an M7 propagation guard for the reviewed month and require a successful sanitized-feed build and GitHub Pages deploy before considering the block closed.

The definitive document takes precedence over a rounded estadillo amount for PVP recovery. The working multiplier remains `base × 1.262` when the document contains a validated pre-tax base rather than a tax-inclusive total.

This second pass has already recovered/corrected cases such as wrong internal links, missing canonical IDs and historical PVP values that had been documented in notes but not materialized in `Precio final (€)`. See `BUSINESS_LOGIC.md` for the detailed precedence and conflict rules.

## Active handoff — 2020 closed and full web audit (2026-09-21)

- **2020 is complete.** The master and public feed contain 62 records: August 9, September 13, October 23, November 6 and December 11. Every record has exact status `Cerrado histórico · sin fecha de entrega documental`; both documentary-delivery fields are blank. All available linked XLSX were inspected month by month for internal NUM, header/date semantics, SUMA/PVP and embedded drawings/media. Exact filename searches and folder inventories found no alternative definitive document with a differentiated delivery date.
- Month closures and successful M7 deployments: December `2d42231` / run [35533089684](https://github.com/mamg97/litos-control-interno/actions/runs/35533089684); November `e09e5ed` / run [35570078323](https://github.com/mamg97/litos-control-interno/actions/runs/35570078323); October `5b6a2d2`, with corrected 7041 operational-date guard `f4dd726` / run [35570598363](https://github.com/mamg97/litos-control-interno/actions/runs/35570598363); September `4828954` / run [35571392623](https://github.com/mamg97/litos-control-interno/actions/runs/35571392623). August remains closed by `d18acdb` and documented by `44fecc6`.
- 7041 is canonical and unique. Its recovered document validates ID 7041, concept, order/header date 2020-10-15 and PVP 0.00; the operational ledger delivery date remains 2020-10-08. No differentiated documentary delivery date exists. Do not remove the order, duplicate it or promote the header date into a delivery field.
- Validated document prices are materialized in `Precio final (€)` and guarded in the sanitized feed. Auxiliary `Total sheet (€)` mismatches for 7003, 7005, 7006 and 7045 were aligned to the validated final price. Four redundant manual cells that blocked the `P.V.P. (€)` array formula were cleared; the formula now spills normally and retains the same displayed values.
- Full published-data audit: 925/925 orders, 275/275 expenses and 1080 account movements are present after the latest running-account and supplier-expense reconciliations; there are no missing IDs, extra IDs or duplicate canonical four-digit IDs. The repeated noncanonical marker `—` represents intentional ledger-only/payment entries. Currency is published at displayed two-decimal precision. A Google XLSX export can reinterpret a few slash-formatted values as dates; direct Google Sheets reads confirmed the public displayed values, including 7740 step measures and the affected account balances.
- Link audit covered 1,565 unique URLs (all feed document/expense links plus seven year-folder links): 692 returned HTTP 200 and 873 private Google links returned HTTP 401; there were no 404/410/5xx responses, invalid hosts or missing local assets. The 21 repeated URL occurrences are expected supplier-folder references shared by invoices from the same provider. All external links use `noopener noreferrer`.
- Web audit: local static build and JavaScript syntax check pass; the deployed page loads 925 records without console errors, all five views switch correctly, 2020 shows 9/13/23/6/11 = 62, search returns 7041 exactly once, and its row shows no delivery date, order date 15/10/2020, PVP 0 and the historical-close label. The finance view shows the latest reconciled movement first, balance −737 €, 9,256 € across 32 real supplier invoices and order 7869 with 384.85 € real direct cost. Privacy/OAuth routes and static assets are included in the build.
- M6 email incident fixed by `ba12954`. The scheduled bridge had synchronized successfully, but `parity_v2.py` downloaded one native Google Sheet without its MIME type and then reported `unknown:HttpError`. The verifier now exports native Sheets correctly, and M6 code changes trigger formula-aware parity. The exact **LITOS M6 Albaranes Cutover** run [35572143006](https://github.com/mamg97/litos-control-interno/actions/runs/35572143006) completed successfully, including the previously failing parity step.
- Running-account update received on 2026-09-21: the supplied estadillo image is authoritative for the new tail and its closing balance. The prior master tail was provisional and incomplete. It was replaced with the individually evidenced work/payment movements in source order, and the corresponding canonical `Pedidos` accounting fields were aligned. A repeated work reference remains a second ledger movement and does not create a duplicate order.
- The running-account update was published by commit `e340af9` through successful M7 [run 35596932390](https://github.com/mamg97/litos-control-interno/actions/runs/35596932390). Production feed generated `2026-09-21T11:59:17.760912Z`; build and deploy both succeeded. The deployed finance table, headline balance, latest movement, 2020 counts and 7041 were rechecked in the browser.
- No opaque balancing entry was needed for that update. When a new estadillo supplies identifiable movements, record those movements and their running balances directly. Use `AJUSTE / OTRO` only for a residual difference that cannot be assigned to real work or payment lines; document the source date, amount, previous balance, resulting authoritative balance and reason, and never create a second `Pedidos` row.
- Supplier-expense checkpoint completed on 2026-09-21 across both workshop mailboxes (Gmail and Hotmail) plus the directly supplied current invoice. The Gmail pass archived and registered eleven authoritative mailbox documents; the Hotmail pass added nineteen previously missing supplier invoices and replaced the March O2 estimate with the located real invoice at the same amount. The directly supplied invoice is also archived. Superseded versions, a proforma, bank notices, catalogues/tariffs, non-invoice attachments and one invoice issued to an unrelated recipient/address were excluded. The verified master now contains 275 expense rows.
- Supplier documents are linked to a LITOS order only when the invoice itself provides a unique, corroborated identity match. One Hotmail invoice meets that standard and is materialized as `Coste directo real (€)` for order 7869; all other newly registered documents remain stock, workshop overhead, general service or pending-link expenses. A supplier credit note remains recorded as a negative expense against the corrected stock purchase. The private master retains folder, document and source-message traceability; the public feed must continue to omit message URLs and private document contents.
- Mailbox review checkpoint: invoice-focused incoming-mail coverage for both workshop accounts is current through 2026-09-21. Future reviews must search both accounts, inspect the actual attachment, reject documents billed to unrelated recipients, prefer corrected/later versions, and check references globally before adding rows.
- Final supplier-expense publication is guarded by commit `e58b6a3`. Browser validation then exposed a Pages-only finance-chart error caused by the mobile artifact patch; `2bda0c9` declares the compact chart mode and `de3bf89` content-versions `app.js` so browsers cannot retain a stale runtime after deployment. M7 Pages [run 35631487241](https://github.com/mamg97/litos-control-interno/actions/runs/35631487241) and Public Feed Audit [run 35631487268](https://github.com/mamg97/litos-control-interno/actions/runs/35631487268) both succeeded. Production feed v12 was generated `2026-09-21T17:21:45.080281Z`; the deployed runtime is `app.js?v=27e327cdaf8e` and the finance view was rechecked with an empty browser console.
- Mail-intake scheduler correction on 2026-09-22: the nominal 11:07 `LITOS M3+M4 Cutover` run was delayed by GitHub Actions until 11:53, but then successfully processed the two waiting orders (2 orders, 2 folders, 5 files, 26 sheet cells). To reduce latency and remove an unnecessary coupling, M3 now polls every 15 minutes at minute 02/17/32/47 Europe/Madrid, while M4 remains at 07:07/11:07/15:07/19:07. M3 no longer depends on the M4 kill switch or Gemini credential. Commit `df4207f` passed the push workflow validation.
- Finance-accounting correction on 2026-09-21: annual KPI and monthly/quarterly finance series now share one operating-cost engine. Direct supplier costs replace job estimates; real supplier/general-service expenses enter operating cost; stock purchases/stock credit notes and unresolved supplier links remain outside profit until consumption/allocation is validated; real consumable invoices replace the corresponding portion of the standing consumables estimate instead of stacking on top. Supplier register now includes credit notes and reports net supplier spend. At the audit checkpoint, the 2026 engine reconciles 30,697.76 € revenue, 8,018.96 € operating costs and 22,678.80 € margin; supplier stock net is 4,627.84 € and unresolved supplier invoices total 2,426.62 €, both excluded from operating profit pending validated consumption/allocation. No private-master data was rewritten. Code commit `99a5517` deployed successfully through M7 Pages run [35640229164](https://github.com/mamg97/litos-control-interno/actions/runs/35640229164); rules are documented in `BUSINESS_LOGIC.md`.
- Remaining parser caution: the historical drawing-date fallback can accept dates from comments and choose the last unlabeled date. Do not rerun broad historical date automation until that heuristic is reviewed. The completed 2020 and 2021 manual decisions remain authoritative.
- **Next review frontier:** there is no pending 2020 month. Reopen 2020 only if a new definitive document supplies differentiated delivery evidence. Routine work can proceed from current operations or a separately scoped parser review.

Handoff protocol: after each single-month block, record evidence, changed fields, unresolved limitations, relevant commits, validation/deploy result and exactly one next block here. Read Git status/history and these MD files before writing. Keep private source contents and identifiers out of Git and Actions logs.

- Mobile traceability UI update on 2026-09-25: the jobs list now remains a horizontally scrollable table on phones, with the work ID sticky and Albarán immediately after ID. M7 now content-versions all mobile CSS assets in the generated Pages HTML so iOS/browser caches cannot keep serving stale card-layout styles after a deploy. Commit pending this handoff entry; verify the matching M7 Pages run before closing the change.\n\n## Legacy Apps Script state

As of 2026-09-18:

- installed Apps Script triggers: retired;
- active Apps Script deployments: retired/archived;
- legacy Apps Script source has been removed from the public repository;
- the old Web App is archived and is not required by the dashboard.

Do not recreate or reactivate legacy Apps Script unless performing a deliberate, documented rollback.

## Public-repository privacy

This repository is public because the zero-cost architecture relies on public-repository GitHub Actions policy.

Therefore:

- never commit personal names for customers/contacts or the workshop owner;
- never commit email addresses, OAuth credentials, tokens or private document contents;
- keep OAuth credentials in repository secrets; keep the authorized sender and other real identities only in the hidden private Sheet configuration;
- use neutral role names in comments, docs and UI copy;
- public dashboard output must stay limited to the approved sanitized schema.

The public Git history was rewritten to a privacy-safe neutral baseline on 2026-09-18. Current and future commits must not add personal identifiers.

Any local clone created before that history rewrite must be re-synchronized or freshly cloned before it is allowed to push again. Do not merge or push an old local history back into the sanitized repository.


## 2026-09-22 · Pedidos 7930/7932 y robustez de la cadena automática

- El pedido 7930 quedó validado con material confirmado por el usuario: `Mármol blanco Italia`. Se aplicó al maestro la lectura M4 ya extraída (fecha 21/08/2026, Tapa nicho, 98×76, base 98×18, remate 95, texto y croquis) y se registró la confirmación humana en `Lecturas manuscritas`.
- El diccionario privado aprendió los alias `IT` e `Italiano` -> `Mármol blanco Italia` con el coste canónico existente de 62 €/m². M4 también reconoce `Italia`, `Italiano` e `IT`, incluida la evidencia `CORTE=ITALIA` / piezas marcadas `IT`.
- `7930_borrador.xlsx` fue generado de forma segura en la carpeta exacta del pedido y su enlace quedó escrito en `Pedidos!AM`. Se verificó el XLSX: pedido 7930, fecha 21/08/2026, concepto TAPA NICHO, material MARMOL ITALIANO, 0,98×0,76 m, precio catálogo 90 €/m², observación N:20/escalones, inscripción y fórmulas de total/IVA/RE.
- El bloqueo `Mutation cap exceeded: 10 > 8` se resolvió sin elevar el límite global: 7930 se reparó con alcance unitario y los 9 borradores desalineados restantes (7919, 7910, 7914, 7920, 7904, 7921, 7923, 7924, 7926) se reconciliaron en lotes 8+1, con backup previo por archivo. El dry-run completo final quedó en `mutable=0`.
- El ejecutor M2 admite ahora alcance de reparación fail-closed mediante `LITOS_DRAFT_ONLY_ORDER` o `LITOS_DRAFT_ONLY_ORDERS`, siempre respetando `MAX_MUTATIONS=8`; la producción programada no cambia cuando esas variables no existen.
- Se eliminó el disparo directo `LITOS Draft Sync -> M7`. En producción programada la secuencia queda determinista: `Draft Sync -> M6 Albaranes -> M7 Pages`, evitando que la web publique durante unos minutos un estado intermedio sin enlaces recién reconciliados.
- Último despliegue M7 verificado: ejecución 35754572957, build y deploy correctos. El feed desplegado contiene 7930 con `invoiceDraftFile` apuntando al borrador y material/coste estimado propagados correctamente.


## 2026-09-24 · GitHub Actions failure storm resolved

- Repeated scheduled failures had two independent causes:
  - M3 completed its protected intake successfully, then the immediate post-sync Gmail dry-run exceeded Gmail API per-user query-cost quota and marked the whole run failed.
  - The historical neutral `GOOGLE_OAUTH_USER_JSON` refresh token had expired/revoked, causing `invalid_grant` in Draft Sync and M5 and preventing downstream OAuth-dependent work.
- M3 keeps the frequent inbound mailbox poll, but the redundant scheduled post-M3 Gmail dry-run was removed. Sent-mail definitive-document archival now runs only on the lower-frequency 07:07/11:07/15:07/19:07 production clock, reducing Gmail API pressure.
- Active Drive/Sheets workflows now receive the valid Gmail+Drive+Sheets `GOOGLE_OAUTH_CLIENT_JSON` secret through their existing `GOOGLE_OAUTH_USER_JSON` runtime variable. No secret contents are stored in the repository.
- The OAuth bridge was applied to Draft Sync, M5, M6, M7, M6 parity/audit, catalog/public-feed audits and the manual repair workflows that use Drive/Sheets.
- M6 formula-aware parity after the credential repair completed successfully: 119 files indexed, 119 rows matched, 0 draft-link mismatches, 0 invoice-link mismatches, 0 parse errors and 0 total mismatches.
- The earlier M6 parse failure is no longer present after the draft reconciliation: current parity reports `parse_errors=0`.
- One-time repair workflows for 2020/2026 delivery dates, final-price repair and sent-recovery are now manual-only; ordinary source/workflow pushes can no longer launch those write-capable repair jobs.
- During the credential migration, the legacy 2020 backfill workflow produced one transitional failed run because historical writes are intentionally paused while the active phase is 2026. Its dry-run had `planned_rows=0` and the write step aborted before any mutation. Other transitional 2026 repair runs were idempotent and reported 0 writes.
- A subsequent M7 Pages deployment completed successfully after the migration.
