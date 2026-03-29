# mmbridge Roadmap

Date: 2026-03-23
Audience: maintainers and coding assistants planning product direction

## How to Read This

This roadmap is organized by capability area first and time horizon second.

The capability areas are:

- `Thinking`
- `Trust`
- `Continuity`
- `Control Plane`

The time horizons are:

- `Now`: current focus and near-term hardening
- `Next`: the next layer of product depth after current focus lands
- `Later`: longer-term direction that should shape architecture but not distort present claims

This structure is meant to keep the roadmap aligned with the product stance:

- externally: `mmbridge` is a multi-model thinking layer for coding assistants
- internally: it is growing toward a stronger control plane for coding work

## Thinking

### Goal

Help a primary coding assistant explore a problem space more broadly before execution.

### Now

- make `research`, `debate`, and `embrace` feel like one coherent thinking workflow
- improve synthesis quality so outputs are easier to turn into action
- reduce command-surface drift between exploratory commands and validation commands
- keep adapter behavior predictable across supported model CLIs

### Next

- add better planning-oriented output modes that bridge from exploration into implementation decisions
- improve cross-model comparison structures so disagreement is more actionable
- strengthen topic scoping, artifact summarization, and reusable research context

### Later

- support deeper multi-step thought pipelines that can feed downstream assistants more directly
- expose stronger shared reasoning artifacts that multiple agents or humans can pick up from
- make thinking workflows composable enough to become a stable substrate for higher-level orchestration

### Not Now

- replacing the main coding assistant's planning loop wholesale
- building a generic autonomous planner detached from actual coding workflows

## Trust

### Goal

Increase confidence in code changes after execution through review, security, and freshness signals.

### Now

- keep `review`, `security`, `diff`, and `gate` working as one trust layer
- improve reliability of bridge consensus, parsing, and result persistence
- keep findings legible and easy to compare across tools and sessions
- preserve accurate scope around changed files, risk, and freshness

### Next

- deepen result quality with better deduplication, ranking, and evidence handling
- improve how trust signals move from findings into next-step recommendations
- strengthen release and regression-oriented review flows, not just patch review

### Later

- make trust evaluation continuous across longer workflows instead of isolated review runs
- allow stronger quality gates that can inform assistant decisions without pretending to own execution
- accumulate richer confidence signals across sessions, tools, and artifacts

### Not Now

- turning `mmbridge` into a compliance platform
- treating review throughput as more important than product coherence

## Continuity

### Goal

Preserve context so work can continue across sessions, tools, models, and contributors.

### Now

- strengthen `memory`, `handoff`, `followup`, and `resume` as one continuity surface
- keep session persistence reliable and searchable
- make the next recommended action clearer after a run completes
- ensure continuity features degrade gracefully across different local environments

### Delivered (v0.7)

- `@mmbridge/context-broker` package: context tree, recall engine, context assembler, compaction, event hooks
- `mmbridge context tree` / `mmbridge context packet` CLI commands
- MCP `mmbridge_context_packet` tool and `context-tree://recent` resource
- Pi adapter via acpx (7th built-in adapter)
- Recall quality: multi-source keyword search across sessions, memory, handoffs, and context tree with relevance scoring and token budget management
- Context freshness: gate signals tied to diff digests and session age
- second-claude-code integration: companion-daemon reads context tree, session-start injects alwaysOnMemory

### Next

- make handoff outputs more useful for humans and assistants picking up work midstream
- expose context packets as first-class inputs to thinking workflows (research, debate, embrace)

### Later

- support more durable multi-session state that survives longer arcs of work
- make continuity artifacts suitable as shared operating context across multiple assistants
- build stronger resumability across phases of work, not just individual commands

### Not Now

- a heavy external state platform
- forcing all workflows through one centralized persistence model

## Control Plane

### Goal

Turn the surrounding workflow into something observable, resumable, and increasingly coordinated without claiming full runtime ownership.

### Now

- keep the CLI, TUI, hooks, MCP surface, and integrations aligned to the same product story
- reduce drift between commands, docs, package metadata, and assistant integrations
- make the control plane visible enough that the next actor knows what happened and what comes next

### Next

- strengthen orchestration across thinking, trust, and continuity flows
- make higher-level workflows easier to inspect and resume from the TUI or integrations
- improve the MCP and integration surfaces so external assistants can consume workflow state more directly

### Later

- evolve toward a deeper assistant operating substrate
- coordinate more of the workflow lifecycle while still interoperating with external coding assistants
- support richer multi-actor operating patterns without collapsing into a monolithic executor

### Not Now

- claiming that `mmbridge` is already an agent OS
- building a tmux-style execution harness as the core identity of the product

## Priority Order Across Axes

When priorities conflict, prefer this order:

1. `Thinking`
2. `Trust`
3. `Continuity`
4. `Control Plane`

That order reflects the product thesis:

- broaden thought first
- preserve confidence second
- preserve continuity third
- deepen coordination fourth

The fourth axis is still important, but it should emerge from the first three rather than overpower them too early.

## PR and Planning Heuristics

Use these questions when choosing work:

- Does this make pre-execution thinking sharper?
- Does this make post-execution trust stronger?
- Does this make cross-session continuity easier?
- Does this clarify the control plane without overstating product maturity?

If the answer is no across the board, it is probably roadmap drift.
