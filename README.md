# mmbridge

Multi-model AI code review bridge. Run code reviews across multiple AI tools (Kimi, Qwen, Codex, Gemini) and aggregate findings with consensus-based filtering.

## Features

- **Multi-tool review**: Run reviews with Kimi, Qwen, Codex, or Gemini CLI tools
- **Finding aggregation**: Bridge mode compares findings across tools, surfaces consensus issues
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

# Run a review with Kimi
mmbridge review --tool kimi

# Run with Qwen and export report
mmbridge review --tool qwen --export review.md

# View diff with annotated findings
mmbridge diff

# Follow up on a review
mmbridge followup --tool kimi --prompt "explain the CRITICAL finding in detail"

# Check environment
mmbridge doctor

# Bridge mode: aggregate multiple reviews
mmbridge review --tool kimi --bridge standard
```

## Commands

| Command | Description |
|---------|-------------|
| `mmbridge review` | Run code review with specified AI tool |
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
