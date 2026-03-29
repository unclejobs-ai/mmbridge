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

## Packages

| Package | Description |
|---------|-------------|
| `@mmbridge/cli` | CLI entry point and commands |
| `@mmbridge/core` | Context creation, finding pipeline, and orchestration logic |
| `@mmbridge/adapters` | Built-in AI tool adapters and registry |
| `@mmbridge/session-store` | Local session persistence and memory storage |
| `@mmbridge/integrations` | Claude Code integration and agent sync utilities |
| `@mmbridge/tui` | Terminal UI rendering for the control plane |
| `@mmbridge/context-broker` | Context tree, recall engine, assembler, compaction, and event hooks |
| `@mmbridge/mcp` | MCP server exposing mmbridge control-plane tools |
| `@mmbridge/create-adapter` | Scaffold new adapters from the template |

## Requirements

- Node.js >= 22.13.0
- At least one AI CLI tool installed (kimi, qwen, codex, gemini, pi, or claude)

## License

MIT
