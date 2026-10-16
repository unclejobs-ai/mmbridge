---
'@mmbridge/aps': minor
'@mmbridge/cli': minor
---

APS ledger v6 (T1 slimming: A1 card fields, review budget, reopen, review cards retired).

- APS-B01: once a card's review rounds (moves to `revise`) reach its `review_budget`, the next rework waits for the owner's decision, recorded with the new `aps budget-override <card> --note …` in `revise` (append-only `budget_overrides` table, B02–B04, tied to the latest move to revise). It is not an owner OK, so D05 still needs `aps owner-ok` on the shipped sha. Reviews are still recorded past the budget; W03 stays the hard cap.
- Cards carry `direction_ref` (`<path>@<full sha>` or http(s) URL, APS-C11), `design_authority`, `review_budget` (1–3, default 2) and `risk_tier` (`low|normal|high`); all four are frozen once work starts (C09). `aps card new` gains `--direction-ref`, `--design-authority`, `--review-budget`, `--risk-tier`; a high-risk card without an explicit budget gets 3.
- New edge `rejected → inspecting` (manager, note) and `aps reopen <card> --note …` re-judge a wrongly rejected card on its reported sha (APS-T06 needs one).
- New `kind='review'` cards are refused (APS-C12); reviews attach to the parent card. `worker_runs.role` (`work|verify`) lets independent reviewer lanes run on the parent card next to its work run (APS-N05; N01 counts live runs per role, verify per agent). `getLiveRun`, collect and foreman read work runs only.
- `aps doctor` checks the triggers of the migrations up to the ledger's own `user_version`.
- Migration `0006_t1_ledger.sql` is forward-only and migrates the ledger on first open; take a `.backup` and stop foreman/audit before deploying.
