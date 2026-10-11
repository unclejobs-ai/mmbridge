# mmbridge Control Plane Repositioning Design

Date: 2026-03-22
Status: Approved for planning

## Summary

This design repositions `mmbridge` from a narrow "multi-model code review bridge" into a broader `multi-model thinking and review control plane for coding agents`.

The codebase already supports more than post-hoc review:

- multi-model `research`
- structured `debate`
- consensus-backed `review`
- `security` audit flows
- `gate` freshness checks
- `resume` for review-session continuation
- project `memory` and `handoff`
- lifecycle orchestration through `embrace`, including `embrace --resume`

The problem is not capability depth. The problem is that the public product surface still undersells the system as a review-only CLI. This design aligns README, CLI help text, and package metadata with what the product already does.

## Why This Fits mmbridge

Recent changes moved `mmbridge` beyond one-shot review:

- `0f58df9` added `research`, `debate`, `security`, and `embrace`
- `5cd7f69` added project memory and handoff workflows
- `f13168f` documented an operations layer
- `26fd086` hardened the bridge review pipeline for real multi-tool use

The product story should now match the implementation surface:

- think before acting
- review with multiple models
- keep workflow state fresh
- continue work from memory and handoff

## Goals

- Redefine the primary product statement around `thinking + review + workflow continuity`
- Preserve review as a core capability without making it the entire identity
- Make the CLI help text reflect command groups that already exist
- Update package metadata so npm surfaces tell the same story as the README
- Clarify differentiation from agent harnesses such as `third-party Codex orchestration`, `oh-my-claude-code`, and `oh-my-openagent`

## Non-Goals

- No command renames in this phase
- No new orchestration runtime or tmux-style worker system
- No claim that `mmbridge` is an agent executor or agent OS
- No new product features beyond messaging, structure, and help text
- No breaking behavior changes for existing users

## Positioning Statement

Primary statement:

`mmbridge` is a multi-model thinking and review control plane for coding agents.

Expanded statement:

It sits alongside tools such as Claude Code, Codex CLI, and similar coding agents, and helps teams widen model perspective before execution, validate work after execution, and resume workflows with memory and handoff context.

## Product Boundaries

`mmbridge` is:

- a multi-model thinking layer
- a review and security aggregation layer
- a workflow continuity layer
- a session, memory, and handoff layer

`mmbridge` is not:

- a full autonomous agent runtime
- a terminal multiplexer orchestrator
- a replacement for the main coding agent
- a claim of end-to-end execution ownership

This boundary is important. It keeps the positioning credible and prevents overclaiming against products that already specialize in execution harnesses.

## Continuation Model

Workflow continuation should be described precisely:

- `resume` continues review-family workflows and follow-up loops
- `followup` continues a specific tool conversation when the adapter supports it
- `memory` and `handoff` expose prior context for the next step
- `embrace --resume` continues the broader multi-phase lifecycle flow

This keeps the public copy aligned with the current command behavior.

## Competitive Framing

Compared with `third-party Codex orchestration`, `oh-my-claude-code`, and `oh-my-openagent`:

- those tools are closer to execution harnesses and agent workflow runtimes
- `mmbridge` should instead emphasize multi-model thought expansion, consensus, freshness, memory, and workflow continuation

The recommended language is:

- not "replace your coding agent"
- not "full agent operating system"
- instead "works alongside your coding agent"

## User Narrative

The public narrative should move from:

1. run review
2. aggregate findings

to:

1. explore the problem with `research` or `debate`
2. validate implementation with `review` or `security`
3. inspect findings in `diff` and check freshness with `gate`
4. continue with `resume`, `followup`, `memory`, `handoff`, or `embrace --resume`

This gives users a clearer mental model for why the command set exists.

## README Changes

### Hero

Replace the current review-only tagline with the control-plane statement.

### Intro

Explain that `mmbridge` works next to coding agents and expands perspective across multiple models before and after implementation.

### Feature List

Reorder features into four groups:

- Thinking: `research`, `debate`, `embrace`
- Review and Audit: `review`, `security`, bridge consensus, `diff`
- Workflow Continuity: `gate`, `resume`, `followup`, `memory`, `handoff`
- Operations: config, adapters, session storage, TUI, hooks

### Quick Start

Show a sequential workflow instead of isolated review examples:

1. `research`
2. `review`
3. `diff`
4. `gate`
5. `resume`

Keep one bridge review example and one security example.

### Commands

Restructure the command table by intent, not alphabetically.

### Package Table and Integration Notes

Update the README package table so it covers the full public surface, including `@mmbridge/mcp`.

Also correct existing public-surface drift in docs, including any stale references such as `dashboard` where the actual command is `tui`.

## CLI Messaging Changes

### Root Command

Change the root description from `Multi-model code review bridge` to a control-plane description.

### Command Descriptions

Descriptions should be rewritten so the set reads as a coherent product:

- `research` and `debate` as thinking commands
- `review`, `security`, and `diff` as validation commands
- `gate`, `resume`, `followup`, `memory`, `handoff`, and `embrace --resume` as workflow continuity commands
- `doctor`, `hook`, `init`, `sync-agents`, `tui` as operations commands

### Command Grouping

Commander does not provide first-class grouped help here, so the grouping will be expressed through:

- section comments in the source for maintainability
- consistent description wording
- README command tables that mirror the intended taxonomy

## Package Metadata Changes

Add or update package `description` fields so npm metadata tells a coherent story.

Recommended direction:

- `@mmbridge/cli`: the main control-plane CLI for coding agents
- `@mmbridge/core`: context, consensus, workflow, and orchestration primitives
- `@mmbridge/adapters`: adapters for model CLIs used by the control plane
- `@mmbridge/session-store`: session, memory, handoff persistence
- `@mmbridge/tui`: terminal UI for sessions and workflow state
- `@mmbridge/mcp`: MCP server exposing mmbridge workflow context and artifacts
- `@mmbridge/integrations`: hook and agent integrations
- `@mmbridge/create-adapter`: scaffolding for custom model adapters

## Implementation Scope

Files expected to change:

- `README.md`
- `packages/cli/src/index.ts`
- `package.json`
- `packages/adapters/package.json`
- `packages/cli/package.json`
- `packages/core/package.json`
- `packages/create-adapter/package.json`
- `packages/integrations/package.json`
- `packages/mcp/package.json`
- `packages/session-store/package.json`
- `packages/tui/package.json`

## Verification Strategy

Because this phase changes product surface rather than runtime behavior, verification focuses on:

- help text rendering successfully
- package metadata remaining valid JSON
- documentation consistency
- README command and package tables matching the actual CLI/package surface
- build and test regression safety for touched packages

Recommended checks:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `node packages/cli/dist/bin/mmbridge.js --help`
- `node packages/cli/dist/bin/mmbridge.js review --help`
- `node packages/cli/dist/bin/mmbridge.js diff --help`
- `node packages/cli/dist/bin/mmbridge.js gate --help`
- `node packages/cli/dist/bin/mmbridge.js memory --help`
- `node packages/cli/dist/bin/mmbridge.js hook --help`
- `node packages/cli/dist/bin/mmbridge.js research --help`
- `node packages/cli/dist/bin/mmbridge.js embrace --help`
- manual README-to-CLI consistency pass for command names and package names

## Success Criteria

- A new user can understand `mmbridge` as more than a review tool within the first screenful of README
- The CLI help reads as one coherent workflow product, not a pile of unrelated commands
- npm package pages no longer look like anonymous internal packages
- The new message remains technically honest about current capabilities
