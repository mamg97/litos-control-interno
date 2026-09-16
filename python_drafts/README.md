# LITOS · Python draft synchronizer (cutover preparation)

This branch contains the Python draft synchronizer preparation work. The production Apps Script remains active.

Certified contract:
- ruleset SHA: c4dfcceb5e062c3ab6f151d536756580975823a2
- semantic renderer SHA: 43ccf1d88e37fc94ea6a76eeff018f16a355b8a7
- dynamic A4 renderer SHA: a5f6c848af221772a2bbc6aba78dbb75d8977e22
- renderer version: dynamic-a4-v1.2
- template ID: 1LWbOK3s2BlaEzYY7tgtlUn-6E4QoyazLt8fCYGdhHbY

Evidence already passed:
- current-quarter semantic parity
- 19/19 targets recomputed from fresh Pedidos + Catálogo operativo
- zero cell/formula differences
- zero visible-style differences
- zero unexplained layout differences
- known historical drift isolated to pedido 7927 width E
- production canary 7916 updated in place while preserving Drive file ID and rollback

Safety: this branch is preparation only. Production writes remain disabled until a separate explicitly authorized cutover executor exists with fresh preflight, SHA pins, backup-before-write, rollback, kill switch and Apps Script recovery instructions.
