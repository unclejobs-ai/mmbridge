# Backfill manual lanes into the APS ledger

Orchestrators use this when a lane already ran, or is still running, outside `aps dispatch`. Record only the state the evidence supports. Do not launch another lane, invent a card, or write a merge.

Commands are `mmbridge aps …`. Every write takes `--by <agent>` (or `APS_AGENT`). `agent new` prints a session id (`<slug>-<yyyymmddHHMMss>`). Later flags take that id, not `--name`.

## When to backfill — a lane ran outside `aps dispatch` (manual omp/herdr/claude).

The card is already `issued`. The work happened in a manual omp task, a herdr pane, or a claude session that `aps dispatch` did not spawn: the orchestrator started the lane by hand, dispatch failed after the pane existed, or a finished historical lane must appear on the kanban.

Do not backfill work you did not observe. Do not `aps dispatch` the same card to attach it — there is no attach (see Known gaps). If no card exists, issue one through the normal path first. This page does not create cards or rewrite acceptance.

## Register — `aps agent new --name <lane> --layer L1|L2|L3 --model <provider/model> --vendor <v> --project <p> [--herdr-pane wX:pY]`; one agent per historical lane; reviewers too.

Register the orchestrator first if it has no live session. That id is `--by` and `--recorded-by`. Then one new agent row per historical lane. Reviewers get their own rows. Independence compares `agents.name`, so a reviewer's `--name` must differ from the worker's and from every reporter's.

```
mmbridge aps agent new --by <you> \
  --name <lane> --layer L1|L2|L3 \
  --model <provider/model> --vendor <vendor> --project <project> \
  [--herdr-pane wX:pY]
```

- `--project` is an existing ledger project id.
- `--layer` is the lane's real layer. Do not relabel an L3 lane to dodge W02.
- `--herdr-pane` only when you know the pane id. `close-session` probes it (APS-H01) and refuses while that pane is open, including a bare shell. Omit the flag if you cannot name the pane; closure then has no pane check.
- Identity is immutable (APS-A03). A closed session cannot be reused (APS-A02); register a new id.
- The CLI also accepts L0. Worker lanes in this procedure are L1–L3.

## Proxy reporting — `aps start <card> --assignee <worker>` then `aps report <card> --by <worker> --recorded-by <you> --sha <40hex> --branch --files @f.json --evidence @ev.json --status DONE|DONE_WITH_CONCERNS [--risks]`; evidence shape [{ac,command,output,ok}] covering every AC id; `--body` takes a file path.

Start only when the lane actually began. The report's `--by` must be the assignee (APS-P02). The orchestrator is the proxy in `--recorded-by`, not the author.

```
mmbridge aps start <card> --by <you> --assignee <worker>
mmbridge aps report <card> --by <worker> --recorded-by <you> \
  --sha <40 lowercase hex> --branch <branch> \
  --files @files.json --evidence @evidence.json \
  --status DONE|DONE_WITH_CONCERNS [--risks "<text>"] \
  [--body <report.md>] [--pr <url>]
```

`files.json` is a JSON array of non-empty paths. `evidence.json` is one object per acceptance id:

```json
[{ "ac": "AC1", "command": "<exact command>", "output": "<non-empty result>", "ok": true }]
```

- DONE and DONE_WITH_CONCERNS must cover every acceptance id that is not marked `"reviewOnly": true` (APS-R03). An id not on the card is dropped with a warning by the CLI unless its evidence has `ok:false`, which still refuses the report with APS-P06 instead of hiding a failing check. Raw SQL refuses all unknown ids. Collect preserves dropped ids in the run event detail (`dropped_ac`) and JSON outcome (`droppedAc`). A card whose every AC is `reviewOnly` may report `[]`.
- `command` and `output` must be non-empty text (APS-P05). Paste the real result. `""` is refused.
- `ok` is a JSON boolean. DONE requires every item `true` (APS-P07). Any `false` needs `DONE_WITH_CONCERNS` and non-empty `--risks` (APS-P08; the CLI error names `--risks` — concerns without described risks are not recordable).
- `--sha` is the commit the worker produced (40 or 64 hex; the CLI lowercases it). Do not substitute a later HEAD.
- `--body` is a markdown file path, not inline text. Omit it if there is no report body. `--files` and `--evidence` accept a leading `@`.
- BLOCKED is stored and does not move the card. It is not a way to skip evidence.

## Stop rules — stop at the state the evidence supports: parked→issued; live lane→working; worker report→reported→closed_session (`aps close-session <worker> --note` once the pane is gone); merge_wait only with an independent accept on exactly the reported SHA (`aps review --by <reviewer> --verdict accept` auto-advances to merge_wait, so do not record it when another required reviewer is missing). Never record merges.

Stop at the furthest state the evidence supports. Do not walk the rest of the machine to clear the board.

| Evidence | Stop at | Do not |
|---|---|---|
| Card parked; lane never started | `issued` | `start` |
| Lane is live (pane or session still running) | `working` | `report`, `close-session` |
| Worker finished; evidence in hand; pane still open | `reported` | `close-session` (APS-H01) |
| Report recorded and the pane is gone | `closed_session` | review, merge |
| Independent accept on exactly the reported SHA, and no other required reviewer is missing | `merge_wait` | `merge`, `done` |

Close only after the pane is gone. The manager runs it; the command does not close the pane:

```
mmbridge aps close-session <worker> --by <you> --note "<why the pane is gone>"
```

That moves the worker's `reported` cards to `closed_session`. If any of that agent's cards are still `working`, it refuses unless `--abandon`, which returns them to `issued`. Do not abandon a live lane to force closure.

`aps review <card> --by <reviewer> --verdict accept` has no `--sha`. From `closed_session` it binds the current reported SHA and auto-advances `inspecting` → `accepted` → `merge_wait`. Record it only when:

- the reviewer is a different `agents.name` from the assignee and from every reporter (APS-V13);
- that reported SHA is the commit you intend to accept;
- every other required reviewer has already recorded an accept on that same SHA.

Accept does not wait for the others: the first accept from `closed_session` jumps to `merge_wait`. A later review cannot pull the card back in front of that jump; from `accepted` / `merge_wait` the only review move is `revise`. If a required reviewer is still missing, stop at `closed_session`. Vision (`needs_vision`) and owner OK (`needs_owner`) are not reviews and are not required to reach `merge_wait`; they gate `done`, which this procedure does not record.

Never record merges. Do not run `aps merge` or `aps done`, even if the target already contains the SHA. A merge row is a verified landing, not a backfill.

## Known gaps — no adopt/attach command for running lanes; audit has no UNRECORDED_LANE code; reviews have no proxy field; size L cards cannot go to L3 (W02).

- No adopt/attach. A running manual lane cannot be bound to a `worker_runs` row. Register the agent, `start` the card, and leave the run unrecorded. Do not dispatch a second lane onto the same card.
- `aps audit` has no `UNRECORDED_LANE` code. A manual lane that was never registered does not fail the audit. Backfill is an orchestrator duty, not an audit finding. Codes that do fire (`STALLED`, `FINISHED_OPEN`, and the rest) are not a substitute.
- `reviews` has no proxy / `recorded_by` field. `on_behalf_of` is only `owner`. The reviewer must be `--by`. Do not file an accept under the orchestrator's session.
- Size L cannot go to an L3 agent (APS-W02: split the card first). `start` refuses. Do not change the agent's layer or the card size to force it. Leave the card `issued` and split, or record the lane only after a legal assignee exists.
