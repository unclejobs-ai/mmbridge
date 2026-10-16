---
'@mmbridge/aps': patch
'@mmbridge/cli': patch
---

omp task lanes record themselves in the APS ledger (T1 lane).

- `mmbridge aps lane start <card> --omp-id <id> --lane <name> --omp-session-dir <parent session dir>` records a running omp task. It reuses the idle open agent named after the lane (a lane whose agent holds a working/reported card is refused), or creates one. It records the task's exact transcript from the required parent session dir (nested task-of-task transcripts included; no root-wide search; ambiguous ids and dirs outside the real omp sessions root are refused), starts the card and writes the run (`launched` `{omp_id, session_ref, lane}`) plus the dispatch packet.
- `mmbridge aps lane end <card> --omp-id <id> --by <manager>` collects that run, bound to the transcript recorded at start. It refuses with `APS-H08` until the task has yielded.
- Dispatch pointer-mode `session_ref` patterns now resolve nested task transcripts in collect and audit, and count only on a single match. Audit fills in the model and last output time from that transcript. It also reports live omp subagent transcripts that have no worker run as `UNRECORDED_LANE` (`source: omp`). New flags: `--no-omp-sessions`, `--omp-live-min`.
- Opt-in, fail-silent omp post hook `integrations/omp/aps-task-hook.ts`. It runs `lane start` for each task assignment with an `APS-CARD:` line.
