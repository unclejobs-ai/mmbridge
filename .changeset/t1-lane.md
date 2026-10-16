---
'@mmbridge/aps': patch
'@mmbridge/cli': patch
---

omp task lanes record themselves in the APS ledger (T1 lane).

- `mmbridge aps lane start <card> --omp-id <id> --lane <name>` records a running omp task. It reuses the open agent named after the lane, or creates one if none exists. It starts the card and writes the pointer-mode run (`launched` `{omp_id, session_ref, lane}`) plus the dispatch packet.
- `mmbridge aps lane end <card> --omp-id <id> --by <manager>` collects that run. It refuses with `APS-H08` until the task has yielded.
- Audit resolves glob `session_ref` values to the newest transcript, so the model and last output time are filled in. It also reports live omp subagent transcripts that have no worker run as `UNRECORDED_LANE` (`source: omp`). New flags: `--no-omp-sessions`, `--omp-live-min`.
- Opt-in, fail-silent omp post hook `integrations/omp/aps-task-hook.ts`. It runs `lane start` for each task assignment with an `APS-CARD:` line.
