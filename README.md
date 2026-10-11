# mmbridge

Multi-model thinking and review control plane for coding agents.

`mmbridge` works alongside tools like Claude Code, Codex CLI, and similar coding agents. Use it to research with multiple models, debate approaches, review implementations, audit security, and continue workflows with memory and handoff context.

See [VISION.md](./VISION.md) for the external product vision and [docs/vision/coding-assistant-operating-model.md](./docs/vision/coding-assistant-operating-model.md) for the internal operating model aimed at coding assistants and maintainers.

## Features

### Thinking

- **Research**: Compare multiple models on a topic and synthesize the results
- **Debate**: Run a structured multi-model debate on a proposition
- **Embrace**: Coordinate research, debate, checkpointing, review, and security in one run

### Review and Audit

- **Review orchestration**: Run reviews across Kimi, Qwen, Codex, Gemini, and other adapters
- **Security audit**: Execute a security audit workflow with model assistance
- **Finding aggregation**: Compare findings across tools and surface consensus issues
- **Diff overlay**: View git diff annotated with review findings using `mmbridge diff`

### Context Broker

- **Context tree**: Append-only lineage tracking of all mmbridge tasks (Pi-inspired session tree)
- **Recall engine**: Multi-source recall with relevance scoring across sessions, memory, handoffs, and context tree
- **Context packet**: Assembled context with always-on memory, recall budget, gate signals, and suggested commands
- **Compaction**: LLM-based subtree summarization to manage growing context trees
- **Event hooks**: Lifecycle events (before_context, after_context, on_recall) for monitoring and extension

### Workflow Continuity

- **Review follow-up**: Continue an existing session with targeted prompts
- **Resume flow**: Pick up the next recommended review action
- **Gate checks**: See whether the current diff has fresh review coverage
- **Memory and handoff**: Search project memory, follow review families across follow-up chains, and export the latest handoff artifact
- **Session tracking**: Store review sessions for follow-up and comparison

### Operations

- **Interactive TUI**: Open the terminal control plane with `mmbridge tui`
- **Finding parser**: Extract structured findings from raw AI output
- **Secret redaction**: Auto-redact API keys, tokens, and passwords from context
- **Export**: Generate markdown reports with `--export report.md`
- **Configuration**: Use `.mmbridge.config.json` for file classifiers, adapters, and custom rules

## Install

```bash
npm install -g @mmbridge/cli
# or
pnpm add -g @mmbridge/cli
```

## Quick Start

```bash
# Initialize config
mmbridge init

# Research an approach across models
mmbridge research "compare rollout strategies for mmbridge control-plane messaging"

# Run a bridge-backed review
mmbridge review --tool all --bridge standard

# View diff with annotated findings
mmbridge diff

# Check whether the current diff has fresh review coverage
mmbridge gate

# Continue the review workflow with the recommended next action
mmbridge resume

# Run a security audit
mmbridge security --tool all --bridge standard
```

## Commands

### Thinking

| Command | Description |
|---------|-------------|
| `mmbridge research` | Research a topic using multiple AI models |
| `mmbridge debate` | Run a multi-model debate on a proposition |
| `mmbridge embrace` | Orchestrate research, debate, checkpointing, review, and security |

### Review and Audit

| Command | Description |
|---------|-------------|
| `mmbridge review` | Run a multi-model review for a change or commit |
| `mmbridge security` | Run a security audit workflow with model assistance |
| `mmbridge diff` | Show a git diff annotated with review findings |

### Workflow Continuity

| Command | Description |
|---------|-------------|
| `mmbridge followup` | Send a follow-up prompt to an existing session |
| `mmbridge resume` | Continue the review workflow with a recommended next action |
| `mmbridge gate` | Check whether the current diff has fresh review coverage |
| `mmbridge handoff` | Inspect or export the latest session handoff artifact |
| `mmbridge memory` | Search and inspect project memory |

### Context Broker

| Command | Description |
|---------|-------------|
| `mmbridge context tree` | Show recent context tree nodes for a project |
| `mmbridge context packet` | Assemble and preview a ContextPacket for a task |

### Operations

| Command | Description |
|---------|-------------|
| `mmbridge tui` | Open the interactive TUI control plane |
| `mmbridge doctor` | Inspect local tooling and binary installation |
| `mmbridge init` | Initialize project config interactively |
| `mmbridge sync-agents` | Sync agent definitions to Claude Code |
| `mmbridge hook` | Manage Claude Code hooks |

### APS Work-Card Ledger

`mmbridge aps` records work cards, worker sessions, evidence, independent reviews,
vision audits, owner approvals, and merge confirmations in a guarded SQLite ledger.
It is local-only: importing a review uses an existing mmbridge session and never
starts a model call.

```bash
export APS_AGENT=<manager-session-id>
mmbridge aps init
mmbridge aps project add studio --prefix SS --name Studio
mmbridge aps agent new --name worker --layer L2 --model sol --vendor subscription
mmbridge aps card new --project studio --title "Fix the parser" --kind mech --size S \
  --scope packages/parser --acceptance acceptance.json --forbidden "paid calls" \
  --owner "$APS_AGENT" --assignee <worker-session-id>
mmbridge aps card show SS-C-0001 --as-prompt
mmbridge aps start SS-C-0001 --assignee <worker-session-id>
mmbridge aps report SS-C-0001 --by <worker-session-id> --sha <commit-sha> \
  --branch feature/parser --files '["packages/parser/src/index.ts"]' \
  --evidence evidence.json --status DONE
mmbridge aps close-session <worker-session-id> --note "worker pane ended"
mmbridge aps review SS-C-0001 --verdict accept --from-session <local-session-uuid>
mmbridge aps merge SS-C-0001 --merged-sha <merged-commit-sha> --target main --gate
mmbridge aps done SS-C-0001
mmbridge aps todo-render --out ./TODO.md
mmbridge aps metrics --week --json
mmbridge aps brief --level L1 --save
mmbridge aps chart --metric rework --days 14 --json
mmbridge aps doctor
```

Use `--db <path>` on any leaf command to isolate a ledger. Resolution is
`--db` → `MMBRIDGE_APS_DB` → `APS_DB` (demo alias) → config `aps.dbPath` →
`~/ss-work/aps/aps.db`. Every command accepts `--by` (default `APS_AGENT`) and
`--json`; `card show --as-prompt` is text-only. Exit codes are 0 for success,
2 for invalid input, 3 for an `APS-*` guard rejection, and 1 for unexpected errors.
Writes are transactional; missing guard triggers fail closed. `--project-dir`
selects the git/context working directory, independently of the ledger project ID.
Required owner/vision approvals remain enforced before `done`.

See [the APS contract](docs/aps/DESIGN.md) for JSON evidence shapes, all commands,
state transitions, and exact guard messages. `return`, `reject`, `feedback`,
`defect`, `vision`, and `owner-ok` are also available via `mmbridge aps --help`.

The `@mmbridge/aps` library also exposes `openApsDbReadOnly`, `dataVersion`,
`readBoardSnapshot`, and the pure `classifyHygiene` function for board consumers.
The reader never creates or migrates a ledger, refuses newer schemas, and reads
each snapshot in a single deferred transaction. Snapshots include lane cells,
card evidence and blockers, review queues, run-only list-equivalent costs, quota
samples, and session hygiene. Assigned lane cells aggregate across card owners;
unassigned cells remain grouped under their `layerOwner`.
Version-1 ledgers retain lanes and reviews with
`runsAvailable: false` and `cost: null`. Pass fresh normalized pane observations
through `BoardReadOptions.panes`; omit them after a herdr failure to show `?`
rather than infer leaks or ghosts from stale data. Headless PID/yield observations
are supplied separately through `observations`, keyed by run ID (or agent ID).
Hygiene ignores terminal runs (`closed`, `blocked`, `failed`, `abandoned`) so a
previous attempt cannot produce a false ghost beside its live replacement. A
working card with a matching pane whose status is neither working, idle, nor done
is shown as `?`, without inferring a stuck session. Missing or non-finite feedback
escalation settings use the default 30-minute overdue cutoff.
Consumers keep the last good snapshot on read errors and own polling/DB cleanup.

## Configuration

Create `.mmbridge.config.json` in your project root:

```json
{
  "classifiers": [
    { "pattern": "convex/", "category": "Database" },
    { "pattern": "stores/", "category": "State" }
  ],
  "adapters": {
    "kimi": { "command": "kimi" },
    "custom-tool": { "module": "mmbridge-adapter-custom" }
  },
  "redaction": {
    "extraRules": [
      { "pattern": "INTERNAL_[A-Z]+", "replacement": "[REDACTED]", "label": "Internal tokens" }
    ]
  }
}
```

## Custom Adapters

Create your own adapter:

```bash
npx @mmbridge/create-adapter my-adapter
```

See [packages/create-adapter](./packages/create-adapter) for the template.

## MCP host integration

If you want another coding shell or agent host to call mmbridge as tools instead of shelling out to the CLI, use `@mmbridge/mcp` / `mmbridge-mcp`.

Example project MCP config:

```json
{
  "mcpServers": {
    "mmbridge": {
      "type": "stdio",
      "command": "mmbridge-mcp"
    }
  }
}
```

Hosts that need a local repo build can also launch the built entrypoint directly:

```json
{
  "mcpServers": {
    "mmbridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mmbridge/packages/mcp/dist/index.js"]
    }
  }
}
```

The MCP surface is the recommended integration path for agent hosts because it exposes structured tools such as review, research, security, debate, context packet, gate, handoff, and doctor without requiring fragile shell parsing.

## Packages

| Package | Description |
|---------|-------------|
| `@mmbridge/cli` | CLI entry point and commands |
| `@mmbridge/core` | Context creation, finding pipeline, and orchestration logic |
| `@mmbridge/adapters` | Built-in AI tool adapters and registry |
| `@mmbridge/agent` | Conversational agent loop with Claude tool_use for mmbridge |
| `@mmbridge/auth` | OAuth and API key management for mmbridge |
| `@mmbridge/session-store` | Local session persistence and memory storage |
| `@mmbridge/integrations` | Claude Code integration and agent sync utilities |
| `@mmbridge/tui` | Terminal UI rendering for the control plane |
| `@mmbridge/context-broker` | Context tree, recall engine, assembler, compaction, and event hooks |
| `@mmbridge/mcp` | MCP server exposing mmbridge control-plane tools |
| `@mmbridge/skills` | File-based skill and plugin loader for mmbridge |
| `@mmbridge/create-adapter` | Scaffold new adapters from the template |

## Requirements

- Node.js >= 22.13.0
- At least one AI CLI tool installed (kimi, qwen, codex, gemini, pi, or claude)

## License

MIT
