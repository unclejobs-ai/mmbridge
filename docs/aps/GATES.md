# APS repository gates

`mmbridge aps gate` executes the APS §12 version-1 contract from `.aps/gates.json`.
It needs no APS database or agent identity unless `--card` is supplied. Commands
run **serially**, as argv without an implicit shell, in the selected repository.

```bash
mmbridge aps gate --project-dir .                         # human table; local advisory mode
mmbridge aps gate --base-ref origin/main --format json    # trusted CI comparison
mmbridge aps gate --base-ref origin/main --json           # equivalent JSON alias
mmbridge aps gate --base-ref origin/main --update-baseline
mmbridge aps gate --base-ref origin/main --card MM-C-0001 --by worker-session-id
```

Exit codes are **0** (all blocking gates pass), **1** (blocking gate failure or
execution/extraction error), and **2** (invalid config/usage/git/ledger input).
`enforcement: "warn"` and `mode: "report"` never block a normal run. A refused
explicit baseline update exits 1 even if the underlying gate is advisory.
All configured gates execute; one failure does not suppress later evidence.

## Configuration

The bundled schema is `packages/cli/src/commands/aps-gate-schema.ts`; its
`baselineFile`, `exemptionsFile`, and `gateResult` definitions validate those
contracts too. Unknown configuration keys, duplicate gate/metric IDs, invalid
regexes, inverted min/max bounds, and gate-family/item mismatches are rejected.
Paths are repository-relative (metric files are relative to `run.cwd`); absolute,
parent-traversal, and out-of-repository symlink targets are rejected.

```json
{
  "version": 1,
  "repo": "unclejobs-ai/mmbridge",
  "gates": [
    {
      "id": "static.typecheck",
      "item": 3,
      "title": "Strict TypeScript",
      "mode": "required",
      "run": { "argv": ["pnpm", "typecheck"] }
    },
    {
      "id": "static.unused",
      "item": 3,
      "title": "Unused-code ratchet",
      "mode": "ratchet",
      "when": { "changedPaths": ["packages/**/*.ts", "**/package.json"] },
      "run": { "argv": ["pnpm", "exec", "knip", "--reporter", "json"], "okExitCodes": [0, 1] },
      "metrics": [
        { "id": "files", "source": { "kind": "json", "pointer": "/files" }, "direction": "lower", "target": 0 }
      ]
    }
  ]
}
```

The example requires the selected repository to install the invoked tools.
Gate IDs are `<family>.<name>`: tests=1, mutation=2, static=3, arch=4,
contract=5, security=6, change=7, metrics=8, review=9. Defaults:
`enforcement: "block"`, `run.cwd: "."`, `timeoutSec: 900`,
`okExitCodes: [0]`, `tolerance: 0`, `.aps/baseline.json`, `.aps/exemptions.json`.
Literal `run.env` values overlay inherited process environment; do not put secrets
in configuration. Pipelines belong in a repository script.

Sources: `json` uses an RFC 6901 `pointer` to a finite number (an array yields its
length); `regex` takes the first match and numeric capture (`group: 1`, optional
`flags`); `count-lines` counts nonempty lines, optionally matching `pattern`;
`exit-code` records the process exit code. Except `exit-code`, sources use stdout
or an optional `file`. Missing, invalid, or nonnumeric output is an error, not zero.

- **required:** pass iff exit is in `okExitCodes`. Other normal exits are failures.
- **threshold:** every metric must satisfy inclusive `min`/`max` bounds.
- **ratchet:** inclusive hard bounds plus no worsening beyond `tolerance`:
  `lower` fails above baseline+tolerance; `higher` fails below baseline−tolerance.
- **report:** collect metrics without blocking. Targets are advisory only; JSON
  includes `target` and a nonnegative `targetGap` where configured.

Timeout/spawn/extraction errors always remain errors, including required gates.
For other modes, an exit outside `okExitCodes` is an execution error. Gate commands
are killed on timeout. With `--base-ref`, changed-path globs match the committed
`merge-base(baseRef, HEAD)..HEAD` diff; no matches means `skipped`. Without a
base ref, conditions always run (uncommitted files do not affect CI filtering).

## Base-ref drift

With `--base-ref`, the base `.aps/gates.json` is the authority. The head tree is
what runs, but a head config that weakens a base gate fails unless that base file
has a gate-level `waive` exemption. A metric-level `allow` does not skip these
checks. A metric-level `waive` skips that metric's direction, tolerance, and
min/max bound drift, but not source drift. Drift is any change to `run.argv`,
`run.cwd`, `run.env`, `mode`, or a metric `source`, plus a missing gate or metric,
a direction flip, a raised tolerance, a loosened min/max, `enforcement` from block
to warn, widened `okExitCodes`, or a raised `timeoutSec`. A lower timeout, a
narrower exit-code set, a tighter bound, or a lower tolerance is not drift.

`when` may be removed or broadened: a missing head filter, or a superset of the
base glob strings (compared as strings, not by glob meaning), still runs on every
base path and is not drift. Adding `when` to a gate that had none, or dropping a
base glob, is drift. Path filtering never skips more than the base gate.

`--update-baseline` refuses the whole write when any gate failed drift. It does
not rewrite the baseline or turn that row back to pass. Results include
`baseConfigSha256`, the SHA-256 of the base config bytes (`null` without a base
config).

## Baselines and monotone updates

```json
{
  "version": 1,
  "gates": {
    "static.unused": {
      "files": { "value": 0, "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "measuredAt": "2026-10-11T00:00:00Z" }
    }
  }
}
```

With `--base-ref`, the baseline at **that exact git ref** is authoritative, not a
loosened PR baseline. For a key absent in the base, a head baseline is a seed and
must equal the current measurement within tolerance (`seed-mismatch` otherwise).
Keys absent in both fail as `no-baseline`. Better measurements pass without
implicitly changing the baseline. Local mode instead trusts the worktree baseline
as a normal comparator and emits a `local-mode` warning.

Only `--update-baseline` writes. It takes the best directional value across the
current measurement, head baseline and base baseline, seeds missing keys, and
records `HEAD` SHA/time. It never relaxes a bound, including within tolerance.
Any regression against either baseline, hard-bound failure, tool error, or
base-ref drift refuses the entire update; the file remains byte-for-byte unchanged. Successful writes are
atomic. Skipped gates and unrelated keys are preserved.

## Owner-approved exemptions

`.aps/exemptions.json` is `{ "version": 1, "exemptions": [...] }`. Every entry
needs `id` (`EX-YYYYMMDD-NN`), `gate`, `effect`, `reason` (at least 10 characters),
`approvedBy: "owner"`, `approvalRef`, `createdAt` and `expiresAt` (UTC dates;
expiry at most 30 days after creation). Optional `metric` narrows its scope.
`waive` converts comparator failures to `exempt`, never execution/extraction
errors. `allow` requires `metric` and numeric `allow`, replacing baseline and
min/max comparison with that directional limit ± tolerance.

CI honors **only base-ref entries**, so adding/editing an exemption in the PR
cannot bypass a gate (`pending-exemption` warning). Local mode trusts the head
file. Expired entries are ignored with a warning; expiry day itself is valid.
Exemptions cannot authorize a regressing baseline update.

## JSON and card evidence

Successful configuration runs produce `schema: "aps-gate-result/1"`: UUID,
repo/ref/SHA, input hashes, timestamps, per-gate status and metrics, warnings,
and `baselineUpdated`. Metric evidence includes baseline source/value,
delta, improvement, effective limit and status. The JSON verdict is `pass`,
`fail`, or `error`; blocking runtime errors exit 1, not config exit 2.
Invalid configuration JSON output is `{ "verdict": "error", "message": "..." }`.

`--card` requires `--base-ref` (otherwise exit 2) and uses the existing APS
`card_links` append API: kind `other`, reference `aps-gate:<run UUID>`, at the
card's current attempt. The detail is the result JSON with stdout and stderr
removed and with messages, metric messages, and warnings re-redacted and
truncated. It is not a byte copy of the process JSON. Ledger location and agent
resolution are the same as other APS commands (`--db`, `--by`, environment/config
defaults). It never creates worker runs, changes lifecycle state, or advances
card acceptance. M02's worker run-event state machine has no generic evidence
event, so no new event/kind migration is introduced here. Acceptance-grade
evidence must have a non-null `baseRef`. `--card` cannot record local advisory
results.
