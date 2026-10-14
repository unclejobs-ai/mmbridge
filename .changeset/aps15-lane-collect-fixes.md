---
'@mmbridge/aps': minor
'@mmbridge/cli': minor
'@mmbridge/core': patch
---

APS ledger v4/v5 + collect/report/merge fixes (issue #15).

- Acceptance items may carry `"reviewOnly": true`: the review judges them, so mech command/expect (C04) and evidence coverage (R02/R03) skip them — a card whose every AC is reviewOnly can report an empty evidence array (migration 0004).
- Usage identity includes the provider (migration 0005): one omp transcript repeating a model under two providers (a real one plus `unknown`) no longer raises "usage identity has conflicting evidence" on collect.
- `aps collect --abandon` also recovers a wedged lane whose packet report.json exists but cannot be recorded (P05–P08/R02/R03/H09) once the session end is proven; close evidence keeps `report_rejected`.
- Collect and `aps report` pre-check P08 with a message naming the packet `report.json` / `--risks` to fix, and drop evidence items whose `ac` is not on the card with a warning instead of failing the report (P06 stays the raw-SQL backstop).
- Collect with no live run exits 2 naming the card state and the next command instead of a bare `no live run`.
- `aps merge` card lookup is scoped by project: config `aps.project` (new key) or `--project`, so a shared ledger plus a cross-repo cwd can no longer record a stray merge row.
