# mmbridge

Multi-model AI code review bridge. Run a single-tool review, a multi-tool consensus review, or a supervisor-managed review without juggling a pile of flags.

## Features

- **Single or multi-tool review**: Run one tool with `--tool`, all installed tools with `--all`, or a supervisor-managed run with `--manager`
- **Finding aggregation**: Consensus mode compares findings across tools and surfaces shared issues
- **Manager pass**: `--manager` adds a supervisor layer that tightens the final findings set
- **Finding parser**: Extracts structured findings from raw AI output
- **Diff overlay**: View git diff annotated with review findings (`mmbridge diff`)
- **Secret redaction**: Auto-redacts API keys, tokens, passwords from context
- **Session tracking**: Stores review sessions for follow-up and comparison
- **Configurable**: `.mmbridge.config.json` for file classifiers, adapter settings, custom rules
- **Export**: Generate markdown reports (`--export report.md`)

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

# Run a review with one tool
mmbridge review --tool kimi

# Run a multi-tool consensus review
mmbridge review --all

# Run a supervisor-managed consensus review
mmbridge review --manager

# Add streaming output to any review
mmbridge review --manager --stream

# View diff with annotated findings
mmbridge diff

# Follow up on a review
mmbridge followup --tool kimi --prompt "explain the CRITICAL finding in detail"

# Check environment
mmbridge doctor

# Export a single-tool review
mmbridge review --tool qwen --export review.md
```

## Commands

| Command | Description |
|---------|-------------|
| `mmbridge review` | Run a review. Use `--tool`, `--all`, or `--manager` |
| `mmbridge diff` | Show git diff annotated with review findings |
| `mmbridge followup` | Send follow-up prompt to existing session |
| `mmbridge dashboard` | Open TUI dashboard for session history |
| `mmbridge doctor` | Check environment and binary installation |
| `mmbridge init` | Initialize project config interactively |
| `mmbridge sync-agents` | Sync agent definitions to Claude agents dir |

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
  },
  "memory": {
    "provider": "project"
  }
}
```

`mmbridge review` keeps the runtime surface intentionally small:

- `--tool <name>` for one tool
- `--all` for consensus across installed tools
- `--manager` for supervisor-managed consensus
- `--stream` for live terminal output

The legacy `--bridge` flag is still accepted for backward compatibility, but it is no longer the recommended surface.

Project memory defaults to `"project"`. Future backends like `"claude-mem"` and `"serena-mcp"` are selected through config, not extra review flags.

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
| `@mmbridge/core` | Context creation, finding pipeline, bridge logic |
| `@mmbridge/adapters` | Built-in AI tool adapters + registry |
| `@mmbridge/session-store` | Local session persistence |
| `@mmbridge/integrations` | Agent sync utilities |
| `@mmbridge/tui` | Terminal UI rendering |
| `@mmbridge/create-adapter` | Scaffold new adapters |

## Requirements

- Node.js >= 20
- At least one AI CLI tool installed (kimi, qwen, codex, or gemini)

## License

MIT
