# mmbridge quality benchmark harness

Fixture-based local benchmark runner for parser quality and bridge consensus quality regressions.

## What it does

- Loads reusable parser + bridge fixtures from `fixtures/**/*.json`
- Executes fixtures against `@mmbridge/core` (`parseFindings`, `detectParseState`, `runBridge`)
- Scores findings with set precision/recall/F1 and exact-match rates
- Compares current results against `baseline.json`
- Fails with non-zero exit when baseline thresholds regress

## Run

```bash
pnpm -C packages/core build
node benchmarks/mmbridge-quality/run.mjs
```

## Options

```bash
node benchmarks/mmbridge-quality/run.mjs --kind parser
node benchmarks/mmbridge-quality/run.mjs --kind bridge --json
node benchmarks/mmbridge-quality/run.mjs --update-baseline
```

## Fixture format

Each fixture JSON has:

- `id`: unique stable identifier
- `kind`: `parser` or `bridge`
- `input`: function input payload
- `expected.findings`: ground-truth findings list for scoring
- optional extra checks:
  - parser: `expected.parseState`
  - bridge: `expected.profile`, `expected.totalInputs`, `expected.consensusFindings`, `expected.counts`

## Baseline policy

`baseline.json` stores minimum accepted metrics:

- suite + overall minimum `meanF1` and `exactRate`
- per-fixture minimum `f1`

Use `--update-baseline` only when intentionally accepting new behavior.

