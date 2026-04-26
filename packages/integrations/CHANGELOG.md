# @mmbridge/integrations

## 0.7.1

### Patch Changes

- Add strict review gate support, settings.local hook installation, and Claude Code stdin JSON hook parsing.

## 0.7.0

### Minor Changes

- ## v0.7.0 — Context Broker + Pi Adapter

  ### New Package: @mmbridge/context-broker

  - **ContextTree**: Append-only JSONL lineage tracking with path traversal protection and SHA-based project keys
  - **RecallEngine**: Multi-source keyword recall across sessions, memory, handoffs, and context tree with relevance scoring and token budget management
  - **ContextAssembler**: Orchestrates project state, gate signals, tree nodes, and recall into a unified ContextPacket
  - **Compaction**: LLM-based subtree summarization via pluggable CompactionAdapter interface with auto-compact and node cleanup
  - **BrokerEventBus**: Typed lifecycle events (before_context, after_context, on_recall) wired into assembler

  ### New CLI Commands

  - `mmbridge context tree` — Show recent context tree nodes for a project
  - `mmbridge context packet` — Assemble and preview a ContextPacket for a task

  ### New MCP Surface

  - `mmbridge_context_packet` tool — Assemble ContextPacket for external consumers
  - `context-tree://recent` resource — Read recent tree nodes

  ### New Adapter: Pi

  - Pi adapter via acpx with --approve-reads, 10 min timeout, kimi.md fallback
  - `mmbridge review --tool pi` now available

  ### Bug Fixes (from multi-model review)

  - Tree recall entries no longer silently dropped (new recalledTree field)
  - autoCompact now removes original nodes after compaction
  - suggestAdapters no longer matches 'bridge' as substring of 'mmbridge'
  - searchTree passes projectKey to avoid full-scan
  - Pi adapter: unused sessionId parameter prefixed with underscore

  ### Core

  - 'pi' added to ADAPTER_NAMES canonical list
  - 41 tests across 6 suites

## 0.6.3

### Patch Changes

- Reposition mmbridge as a multi-model thinking and review control plane.

  This release updates the public package surface to match the broader command set:

  - refresh README and CLI help wording around thinking, review, workflow continuity, and operations
  - add package descriptions across the published workspace packages
  - enforce Node.js >=22 for the CLI package
  - add CLI help regression coverage for the new control-plane messaging

## 0.2.0

### Minor Changes

- Initial release of mmbridge CLI - multi-model AI code review bridge
