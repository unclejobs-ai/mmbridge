# omp task lanes → APS ledger

`aps-task-hook.ts` is an opt-in omp post hook. When an omp session spawns task subagents, it records every task whose assignment names an APS card. Each recorded task becomes a lane in the ledger with no manual `aps` command.

## Install (per machine, opt-in)

```bash
mkdir -p ~/.omp/agent/hooks/post
cp integrations/omp/aps-task-hook.ts ~/.omp/agent/hooks/post/aps-task-hook.ts
```

omp loads `~/.omp/agent/hooks/{pre,post}/*.ts` at session start. Restart running omp sessions to pick the hook up.

Environment variables, read by the omp process:

| Variable | Default | Meaning |
|---|---|---|
| `APS_HOOK_CMD` | `["mmbridge"]` | JSON argv prefix for the CLI, e.g. `["node","/abs/mmbridge/packages/cli/dist/bin/mmbridge.js"]` |
| `APS_HOOK_DB` | (resolved by the CLI) | Passed as `--db` |
| `APS_HOOK_LOG` | `~/ss-work/squads/Reports/aps-omp-hook.log` | Spawned argv plus each `lane start` JSON result or error |

Uninstall or roll back by removing the file from `~/.omp/agent/hooks/post/`. The hook is fail-silent: it never changes the task result, and a missing CLI or ledger only produces a log line.

## Task assignment convention

Put these lines in the task's `assignment` (or `task`) text, one line each:

```text
APS-CARD: <card id>          required; tasks without it are ignored
APS-LANE: <lane name>        optional; default = the task id. The lane name is the agent identity:
                             an open agent with that name in the card's project is reused.
APS-WORKTREE: /abs/worktree  optional; the lane's own git worktree (default = the omp session cwd)
```

For each such task the hook runs:

```bash
mmbridge aps lane start <card> --omp-id <task id> --lane <name> --json \
  --omp-session-dir <parent session dir> [--worktree <dir>] [--db $APS_HOOK_DB]
```

`lane start` starts the card, writes the worker run (`harness=omp`, `launched` with `{omp_id, session_ref, lane}`), and writes the dispatch packet. The JSON result in the log names the packet.

## Hand-off and close

1. The worker hands off through the packet contract. It writes `report.json` (see `report.schema.json`) and `report.md` in the packet, then yields. The orchestrator relays the packet pointer (`ompPrompt` in the log) when the task text did not already include it.
2. The manager closes the lane with:

   ```bash
   mmbridge aps lane end <card> --omp-id <task id> --by <manager>
   ```

   This refuses with `APS-H08` until the task's yield output (`<session dir>/<task id>.md`) exists. It refuses with `APS-H10` when the yield has no `report.json`; pass `--abandon` to abandon the run instead.

`mmbridge aps audit` lists live omp subagents that have no worker run as `UNRECORDED_LANE`. Use `--no-omp-sessions` to skip that scan, or `--omp-live-min <n>` to change the liveness window.
