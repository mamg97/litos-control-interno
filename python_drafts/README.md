# LITOS · Python draft synchronizer

The Python draft synchronizer is the production implementation for current-quarter draft invoices. It runs through GitHub Actions (`LITOS Draft Sync`) with fail-closed write guards, private Google OAuth credentials and a repository kill switch.

Certified contract:
- ruleset SHA: c4dfcceb5e062c3ab6f151d536756580975823a2
- semantic renderer SHA: 43ccf1d88e37fc94ea6a76eeff018f16a355b8a7
- dynamic A4 renderer SHA: a5f6c848af221772a2bbc6aba78dbb75d8977e22
- renderer version: dynamic-a4-v1.2
- template ID: 1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY

Evidence passed:
- current-quarter semantic parity
- 19/19 targets recomputed from fresh Pedidos + Catálogo operativo
- zero cell/formula differences
- zero visible-style differences
- zero unexplained layout differences
- known historical drift isolated to pedido 7927 width E
- production canary 7916 updated in place while preserving Drive file ID and rollback
- scheduled production execution certified

Production safety:
- fresh plan is built from private Drive/Sheets data on every run;
- writes require both the production workflow path and write enablement;
- existing drafts are backed up before replacement and verified after write;
- mutation and runtime caps fail closed;
- the repository kill switch can disable scheduled writes;
- `Catálogo operativo` remains the manually curated pricing dictionary and is read, not rebuilt, by this component.

M6 and M7 are currently bridged from successful scheduled `LITOS Draft Sync` executions through restricted `workflow_run` triggers. See `MIGRATION_STATUS.md` for current cutover state.
