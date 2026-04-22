# mmbridge Harness Engineering Audit

Date: 2026-04-22
Repo: `/Users/parkeungje/project/mmbridge`
Auditor: Hermes (OpenAI Codex, gpt-5.4)

## Executive Summary

mmbridge is architected in the right direction for harness engineering.
It already behaves like a control plane rather than a loose CLI bundle.

But the verification harness is not yet in a trustworthy ship-ready state.
Current branch status is:
- architecture: good
- control-plane decomposition: good
- runtime primitives: good
- verification harness completeness: incomplete
- ship confidence: low to medium

In short:
structure is good, guardrails are still partially broken.

## Live Verification Performed

Environment:
- `node -v` → `v22.22.0`
- `pnpm -v` → `9.15.0`
- git status → clean branch `main...origin/main`

Commands run:
- `pnpm run lint`
- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run build`
- `node packages/cli/dist/bin/mmbridge.js doctor --json`
- `node packages/cli/dist/bin/mmbridge.js context tree --json -p .`
- `node packages/cli/dist/bin/mmbridge.js context packet --task "audit harness engineering" --json -p .`
- `node packages/cli/dist/bin/mmbridge.js gate --format json --base-ref HEAD~1 -p .`

Results:
- PASS: typecheck
- PASS: build
- PASS: doctor --json
- PASS: context tree
- PASS: context packet
- PASS: gate command execution
- FAIL: lint
- FAIL: test

## What Is Well Built

### 1. Strong control-plane decomposition

Core responsibilities are separated in sensible package/file boundaries:
- `packages/core/src/review-pipeline.ts`
- `packages/core/src/bridge.ts`
- `packages/core/src/operations.ts`
- `packages/core/src/redaction.ts`

This is a good harness-engineering sign because:
- orchestration is separate from consensus logic
- gate/resume decisions are explicit
- redaction is isolated as a reusable safety layer

### 2. Context / continuity layer is not an afterthought

The context-broker package is a real subsystem, not a helper folder:
- `packages/context-broker/src/context-tree.ts`
- `packages/context-broker/src/recall-engine.ts`
- `packages/context-broker/src/context-assembler.ts`
- `packages/context-broker/src/events.ts`

Especially strong:
- append-only task lineage
- recall budget handling
- project state + gate signals + recall rolled into `ContextPacket`
- event seam for observability and extension

### 3. Multiple product surfaces converge on the same core

mmbridge is exposed through:
- CLI
- TUI
- MCP
- agent/auth/skills packages around the same system

This is good because the system is trending toward a shared harnessable core instead of duplicated business logic per surface.

### 4. Operational primitives already exist

These are good building blocks for a robust harness:
- `doctor`
- `gate`
- `handoff`
- `memory`
- `context packet`

This means mmbridge is not just “can run commands”; it already has the beginnings of inspectability and workflow continuity.

## Critical Weaknesses

### 1. The current harness is visibly broken

#### Lint is red
`pnpm run lint` failed with 102 errors.
Representative failures are in:
- `packages/agent/src/system-prompt.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/builtin-tools.ts`
- `packages/auth/src/oauth-helpers.ts`
- `packages/auth/src/keychain.ts`
- `packages/auth/src/commands.ts`

This means the static-quality guardrail exists, but is not currently protecting the branch.

#### Tests are red
`pnpm run test` failed in `@mmbridge/tui`.
Observed failing tests:
- `SWITCH_TAB_DELTA: clamps at beginning`
- `initialState: TAB_ORDER has 3 tabs`

Root symptom:
- `packages/tui/src/store.ts` now defines 4 tabs:
  - `repl`, `dashboard`, `sessions`, `config`
- but `packages/tui/test/store.test.ts` still expects 3 tabs and old navigation behavior

This is classic harness drift: product surface evolved, regression tests did not.

### 2. Root typecheck does not cover the whole monorepo

Root `tsconfig.json` references do not include:
- `packages/agent`
- `packages/auth`
- `packages/skills`

So `pnpm run typecheck` passing does **not** mean the full workspace is typechecked through the root graph.

That is a significant harness integrity gap.
A green root typecheck currently overstates actual coverage.

### 3. Test execution coverage is uneven

There are 28 test files total, which is promising.
But package-level execution is inconsistent.

Packages without a `test` script:
- `agent`
- `auth`
- `create-adapter`
- `integrations`
- `skills`

Important mismatch:
- `packages/integrations/test/hooks.test.ts` exists
- but `packages/integrations/package.json` has no test script
- so that test is not exercised by `pnpm -r run test`

This is worse than “no test” because it looks covered while silently being skipped.

### 4. Smoke/release workflows are shallow

CI (`.github/workflows/ci.yml`) is reasonable:
- lint
- typecheck
- test
- build

But supporting harness workflows are still shallow.

#### doctor workflow
`.github/workflows/doctor.yml`
- installs deps
- builds
- runs `doctor --json`

Missing:
- context packet smoke
- gate smoke
- basic review-mode or context-broker smoke

#### release workflow
`.github/workflows/release.yml`
- installs deps
- builds
- publishes via changesets

Missing before publish:
- lint re-check
- typecheck re-check
- test re-check
- doctor/context/gate smoke

### 5. Docs are behind the real package surface

`README.md` package table lists major packages like:
- `@mmbridge/cli`
- `@mmbridge/core`
- `@mmbridge/adapters`
- `@mmbridge/context-broker`
- `@mmbridge/mcp`

But it does not list:
- `@mmbridge/agent`
- `@mmbridge/auth`
- `@mmbridge/skills`

That means documented system boundaries do not fully match the real workspace.
For harness engineering, stale topology docs increase blind spots.

## Harness Assessment by Layer

### Static checks
- lint: present, failing
- typecheck: present, passing, but partial workspace coverage

Verdict: partially effective, not trustworthy yet

### Unit/package tests
- many tests exist in core areas
- at least one product evolution drift exists in TUI
- some test files are not wired into package scripts

Verdict: good start, weak enforcement consistency

### Runtime smoke / operational verification
- doctor works
- context packet works
- context tree works
- gate works, but warns stale-review/unresolved-critical

Verdict: runtime primitives are real and useful

### Release gating
- build gate exists
- full release-confidence gate does not

Verdict: insufficient for confident publishing

## Architecture Judgment

mmbridge is not a random tool pile.
It is clearly converging on a meaningful control-plane architecture:
- research / review / debate / security
- gate / resume / handoff / memory
- context tree / recall / packet assembly

That is the right product and systems direction.

The issue is not the architecture.
The issue is that the harness has not been brought up to the same maturity level as the architecture.

## Priority Recommendations

### P0 — restore broken guardrails now
1. Fix TUI test drift (`repl` tab vs old 3-tab assumptions)
2. Make `pnpm run test` green
3. Make `pnpm run lint` green

### P1 — make green signals honest
4. Add `agent`, `auth`, `skills` to root `tsconfig.json` references
5. Ensure root typecheck covers actual workspace topology
6. Add missing package test scripts, especially `integrations`

### P2 — deepen smoke/release harness
7. Expand doctor workflow to include:
   - doctor
   - context packet
   - gate smoke
8. Expand release workflow to re-run:
   - lint
   - typecheck
   - test
   - smoke checks before publish

### P2 — align docs with runtime topology
9. Update README package table to reflect real workspace packages

## Final Verdict

mmbridge is built with the right harness-engineering instincts.
The structure is credible.
The control-plane abstraction is credible.
The continuity layer is especially strong.

But as of this audit, the verification harness is not yet strong enough to call the system fully “properly built” from a ship-confidence perspective.

Final verdict:
- architecture: yes
- harness direction: yes
- harness completeness: not yet

## Artifacts Generated

- Audit diagram HTML: `/Users/parkeungje/project/mmbridge/mmbridge-harness-audit-diagram.html`
- Audit report: `/Users/parkeungje/project/mmbridge/AUDIT-mmbridge-harness.md`
