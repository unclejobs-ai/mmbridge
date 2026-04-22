# mmbridge Harness Hardening Checklist

Status: PR-ready checklist
Date: 2026-04-22
Scope: post-audit hardening after P0 recovery

## Goal

Turn mmbridge from:
- good architecture + partial guardrails

into:
- good architecture + honest workspace coverage + trustworthy release gates

## Current Baseline

Already green now:
- `pnpm run lint`
- `pnpm run test`
- `pnpm run typecheck`
- `pnpm run build`

Still remaining from audit:
- root typecheck graph does not include `agent`, `auth`, `skills`
- some packages still have no `test` script
- `integrations` has a test file but no package test script
- doctor/release workflows are still too shallow
- README package table lags real workspace topology

## PR 1 — Make root typecheck honest

### Objective
Ensure the root `tsc -b` graph matches the actual workspace packages.

### Checklist
- [ ] Update root `tsconfig.json`
- [ ] Add references for:
  - [ ] `packages/agent`
  - [ ] `packages/auth`
  - [ ] `packages/skills`
- [ ] Run `pnpm run typecheck`
- [ ] Run `pnpm run build`
- [ ] Confirm newly referenced packages compile cleanly through root graph

### Files
- Modify: `tsconfig.json`

### Acceptance criteria
- `pnpm run typecheck` still passes
- root graph covers all intended publishable/runtime packages

## PR 2 — Make package tests actually execute

### Objective
Remove false confidence from unhooked or missing test scripts.

### Checklist
- [ ] Add `test` script to `packages/integrations/package.json`
- [ ] Decide per package whether to add test scripts now or explicitly document no-tests-yet:
  - [ ] `packages/agent/package.json`
  - [ ] `packages/auth/package.json`
  - [ ] `packages/create-adapter/package.json`
  - [ ] `packages/skills/package.json`
- [ ] If a package keeps no tests, document why in PR description
- [ ] Run `pnpm -r run test`

### Files
- Modify: `packages/integrations/package.json`
- Optional modify: `packages/agent/package.json`
- Optional modify: `packages/auth/package.json`
- Optional modify: `packages/create-adapter/package.json`
- Optional modify: `packages/skills/package.json`

### Acceptance criteria
- Existing test files are reachable by workspace test command
- No package silently carries dead tests

## PR 3 — Strengthen doctor smoke workflow

### Objective
Make the doctor workflow verify more than install/build health.

### Checklist
- [ ] Update `.github/workflows/doctor.yml`
- [ ] Keep:
  - [ ] install
  - [ ] build
  - [ ] `doctor --json`
- [ ] Add:
  - [ ] `mmbridge context tree --json -p .`
  - [ ] `mmbridge context packet --task "workflow smoke" --json -p .`
  - [ ] `mmbridge gate --format json --base-ref HEAD~1 -p . || true` if needed for no-fresh-review environments
- [ ] Make sure smoke commands are robust on CI clones with little session history

### Files
- Modify: `.github/workflows/doctor.yml`

### Acceptance criteria
- doctor workflow exercises context-broker and gate path, not just binary presence

## PR 4 — Strengthen release gate before publish

### Objective
Prevent build-only releases.

### Checklist
- [ ] Update `.github/workflows/release.yml`
- [ ] Add pre-publish steps:
  - [ ] `pnpm run lint`
  - [ ] `pnpm run typecheck`
  - [ ] `pnpm run test`
  - [ ] `pnpm run build`
  - [ ] optional lightweight smoke (`doctor --json`)
- [ ] Ensure changesets publish only runs after all gates pass

### Files
- Modify: `.github/workflows/release.yml`

### Acceptance criteria
- release path cannot publish from lint-red or test-red state

## PR 5 — Align README with actual workspace surface

### Objective
Make topology docs honest.

### Checklist
- [ ] Update package table in `README.md`
- [ ] Add entries for:
  - [ ] `@mmbridge/agent`
  - [ ] `@mmbridge/auth`
  - [ ] `@mmbridge/skills`
- [ ] Re-check package descriptions match package.json intent

### Files
- Modify: `README.md`

### Acceptance criteria
- README package table matches actual workspace packages users will encounter

## Optional PR 6 — Add a single top-level harness smoke script

### Objective
Make local and CI verification one-command consistent.

### Checklist
- [ ] Add root script such as `smoke`
- [ ] Script should run a compact sequence like:
  - [ ] `pnpm run build`
  - [ ] `node packages/cli/dist/bin/mmbridge.js doctor --json`
  - [ ] `node packages/cli/dist/bin/mmbridge.js context packet --task "smoke" --json -p .`
- [ ] Point CI helper workflows to the same script

### Files
- Modify: `package.json`

### Acceptance criteria
- local smoke and CI smoke use the same command path

## Suggested PR order

1. PR 1 — root typecheck honesty
2. PR 2 — package test execution honesty
3. PR 3 — doctor smoke deepening
4. PR 4 — release gate hardening
5. PR 5 — README topology sync
6. PR 6 — optional shared smoke script

## Verification commands

Run after each PR:
- `pnpm run lint`
- `pnpm run test`
- `pnpm run typecheck`
- `pnpm run build`

Run after CI-workflow PRs locally where possible:
- `node packages/cli/dist/bin/mmbridge.js doctor --json`
- `node packages/cli/dist/bin/mmbridge.js context packet --task "local smoke" --json -p .`
- `node packages/cli/dist/bin/mmbridge.js gate --format json --base-ref HEAD~1 -p .`

## Definition of Done

The hardening effort is done when all of the following are true:
- [ ] root typecheck graph matches real workspace coverage intent
- [ ] workspace tests are not silently skipped where test files exist
- [ ] doctor workflow covers context/gate smoke
- [ ] release workflow gates on lint/typecheck/test/build
- [ ] README accurately describes workspace package surface
- [ ] local green state and CI green state mean roughly the same thing
