# CLI Streaming + TUI Monitor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI-first 아키텍처 전환 — `--stream` 실시간 출력 + TUI 모니터 대시보드

**Architecture:** CLI가 `runReviewPipeline`의 콜백으로 실시간 stdout 출력 + `~/.mmbridge/.live.json`에 상태 기록. TUI는 fs.watch로 live state를 감시하는 read-only 대시보드. Ink Box border 대신 `useStdout().columns` 기반 full-width 렌더링.

**Tech Stack:** Node.js, Commander, Ink (React for terminal), fs.watch, `@mmbridge/core` review pipeline

**Spec:** `docs/superpowers/specs/2026-03-15-cli-streaming-tui-monitor-design.md`

---

## Chunk 1: Core LiveState + CLI Stream Renderer

### Task 1: LiveState module

**Files:**
- Create: `packages/core/src/live-state.ts`
- Modify: `packages/core/src/index.ts` — export 추가

- [ ] **Step 1: Create LiveState types and write/read/clear functions**

```typescript
// packages/core/src/live-state.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface LiveState {
  active: boolean;
  tool: string;
  mode: string;
  phase: string;
  elapsed: number;
  startedAt: string;
  streamLines: string[];
  events: Array<{ time: string; message: string }>;
  progress?: number;
  findingsSoFar?: number;
}

const LIVE_DIR = path.join(os.homedir(), '.mmbridge');
const LIVE_PATH = path.join(LIVE_DIR, '.live.json');

export function getLiveStatePath(): string {
  return LIVE_PATH;
}

export async function writeLiveState(state: LiveState): Promise<void> {
  await fs.mkdir(LIVE_DIR, { recursive: true });
  await fs.writeFile(LIVE_PATH, JSON.stringify(state), 'utf8');
}

export async function readLiveState(): Promise<LiveState | null> {
  try {
    const raw = await fs.readFile(LIVE_PATH, 'utf8');
    return JSON.parse(raw) as LiveState;
  } catch {
    return null;
  }
}

export async function clearLiveState(): Promise<void> {
  try {
    await fs.unlink(LIVE_PATH);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Export from core index**

Add to `packages/core/src/index.ts`:
```typescript
export { writeLiveState, readLiveState, clearLiveState, getLiveStatePath } from './live-state.js';
export type { LiveState } from './live-state.js';
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/core && pnpm run build`
Expected: success, no errors

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/live-state.ts packages/core/src/index.ts
git commit -m "feat(core): add LiveState module for CLI↔TUI communication"
```

### Task 2: CLI Stream Renderer

**Files:**
- Create: `packages/cli/src/render/stream-renderer.ts`

- [ ] **Step 1: Create stream renderer with tree-style output**

The renderer writes directly to `process.stdout` and updates `LiveState`. Key methods:
- `header(tool, mode)` — prints `● mmbridge review tool / mode`
- `phase(name, detail)` — prints `├─ name  detail` with tree connectors
- `streamLine(text)` — prints `│  text` indented under current phase
- `done(elapsed, sessionId)` — prints `└─ done  elapsed · session #id`
- `findings(items)` — prints severity-colored finding list
- `summary(counts, total, elapsed)` — prints bottom bar

```typescript
// packages/cli/src/render/stream-renderer.ts
import { writeLiveState, clearLiveState } from '@mmbridge/core';
import type { LiveState } from '@mmbridge/core';
import type { Finding } from '@mmbridge/core';

const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '◆',
  WARNING: '▲',
  INFO: '●',
  REFACTOR: '◇',
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '\x1b[38;2;243;139;168m', // red
  WARNING: '\x1b[38;2;249;226;175m',  // yellow
  INFO: '\x1b[38;2;137;220;235m',     // sky
  REFACTOR: '\x1b[38;2;250;179;135m', // peach
};

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[38;2;166;227;161m';
const ACCENT = '\x1b[38;2;180;190;254m';
const RESET = '\x1b[0m';

export class StreamRenderer {
  private startTime: number;
  private liveState: LiveState;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(tool: string, mode: string) {
    this.startTime = Date.now();
    this.liveState = {
      active: true,
      tool,
      mode,
      phase: 'init',
      elapsed: 0,
      startedAt: new Date().toISOString(),
      streamLines: [],
      events: [],
    };
  }

  async start(): Promise<void> {
    const { tool, mode } = this.liveState;
    process.stdout.write(`${GREEN}●${RESET} ${ACCENT}${BOLD}mmbridge${RESET} review ${BOLD}${tool}${RESET} / ${mode}\n`);
    this.addEvent(`review requested — ${tool} (${mode})`);
    await this.flushLiveState();
  }

  phase(name: string, detail: string): void {
    const elapsed = this.elapsedStr();
    process.stdout.write(`${DIM}├─${RESET} ${name.padEnd(9)} ${detail}${DIM} (${elapsed})${RESET}\n`);
    this.liveState.phase = name;
    this.addEvent(`${name} — ${detail}`);
    this.debouncedFlush();
  }

  streamLine(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    process.stdout.write(`${DIM}│${RESET}  ${DIM}${trimmed}${RESET}\n`);
    this.liveState.streamLines.push(trimmed);
    if (this.liveState.streamLines.length > 20) {
      this.liveState.streamLines = this.liveState.streamLines.slice(-20);
    }
    this.debouncedFlush();
  }

  async done(sessionId: string): Promise<void> {
    const elapsed = this.elapsedStr();
    process.stdout.write(`${DIM}└─${RESET} ${GREEN}done${RESET}     ${elapsed} · session ${DIM}#${sessionId.slice(0, 8)}${RESET}\n`);
    this.liveState.active = false;
    this.liveState.phase = 'done';
    this.addEvent(`complete — ${elapsed}`);
    await this.flushLiveState();
  }

  printFindings(findings: Finding[]): void {
    process.stdout.write('\n');
    for (const f of findings) {
      const icon = SEVERITY_ICONS[f.severity] ?? '●';
      const color = SEVERITY_COLORS[f.severity] ?? '';
      const loc = f.line != null ? `:${f.line}` : '';
      process.stdout.write(`${color}${icon} ${f.severity.padEnd(8)}${RESET} ${f.file}${loc}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
  }

  printSummary(findings: Finding[], elapsed: string): void {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    }
    const parts = ['CRITICAL', 'WARNING', 'INFO', 'REFACTOR']
      .filter((s) => (counts[s] ?? 0) > 0)
      .map((s) => `${SEVERITY_COLORS[s]}${SEVERITY_ICONS[s]}${counts[s]}${RESET}`);

    process.stdout.write(`\n${DIM}${'─'.repeat(41)}${RESET}\n`);
    process.stdout.write(`${parts.join('  ')} ${DIM}│${RESET} ${findings.length} findings ${DIM}│${RESET} ${elapsed}\n`);
  }

  async cleanup(): Promise<void> {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    await clearLiveState();
  }

  private elapsedStr(): string {
    return `${((Date.now() - this.startTime) / 1000).toFixed(1)}s`;
  }

  private addEvent(message: string): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.liveState.events.push({ time: elapsed, message });
    this.liveState.elapsed = (Date.now() - this.startTime) / 1000;
  }

  private debouncedFlush(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(async () => {
      this.updateTimer = null;
      await this.flushLiveState();
    }, 200);
  }

  private async flushLiveState(): Promise<void> {
    this.liveState.elapsed = (Date.now() - this.startTime) / 1000;
    await writeLiveState(this.liveState).catch(() => {});
  }
}
```

- [ ] **Step 2: Build CLI**

Run: `cd /Users/parkeungje/project/mmbridge-v060 && pnpm run build`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/render/stream-renderer.ts
git commit -m "feat(cli): add stream renderer with tree-style output and live state"
```

### Task 3: Wire `--stream` flag to review command

**Files:**
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `packages/cli/src/index.ts` — add `--stream` option

- [ ] **Step 1: Add `--stream` option to CLI index**

In `packages/cli/src/index.ts`, add after line 36 (`.option('--export ...')`):
```typescript
    .option('-s, --stream', 'Stream real-time output to terminal')
```

- [ ] **Step 2: Update ReviewCommandOptions**

In `packages/cli/src/commands/review.ts`, add `stream?: boolean` to the interface.

- [ ] **Step 3: Update `runReviewCommand` to use StreamRenderer when `--stream`**

When `options.stream` is true:
1. Create `StreamRenderer`
2. Pass `onProgress` and `onStdout` callbacks that call renderer methods
3. After pipeline completes, call `renderer.printFindings()` and `renderer.printSummary()`
4. Call `renderer.cleanup()`

When `options.stream` is false: existing behavior (JSON/TUI output).

- [ ] **Step 4: Build and test**

Run: `pnpm run build`
Test: `cd /some/git/repo && mmbridge review --tool kimi --stream` (manual — requires kimi installed)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/review.ts packages/cli/src/index.ts
git commit -m "feat(cli): wire --stream flag for real-time review output"
```

---

## Chunk 2: TUI Monitor Redesign

### Task 4: Create full-width rendering primitives

**Files:**
- Create: `packages/tui/src/components/FullWidthRow.tsx` — 2-column row with computed widths
- Create: `packages/tui/src/components/HRuleFull.tsx` — full-width horizontal rule
- Modify: `packages/tui/src/components/Panel.tsx` — remove border, simplify to section header

- [ ] **Step 1: Create HRuleFull**

```tsx
// packages/tui/src/components/HRuleFull.tsx
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { colors } from '../theme.js';

export function HRuleFull(): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  return <Text color={colors.surface0}>{'─'.repeat(cols)}</Text>;
}
```

- [ ] **Step 2: Create FullWidthRow**

```tsx
// packages/tui/src/components/FullWidthRow.tsx
import React from 'react';
import { Box, useStdout } from 'ink';

interface FullWidthRowProps {
  leftRatio?: number; // default 0.5
  children: [React.ReactNode, React.ReactNode];
  gap?: number;
}

export function FullWidthRow({ leftRatio = 0.5, children, gap = 2 }: FullWidthRowProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const leftWidth = Math.floor(cols * leftRatio);
  const rightWidth = cols - leftWidth - gap;

  return (
    <Box flexDirection="row">
      <Box width={leftWidth}>{children[0]}</Box>
      <Box width={gap} />
      <Box width={rightWidth}>{children[1]}</Box>
    </Box>
  );
}
```

- [ ] **Step 3: Build and verify**

Run: `pnpm run build`

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/components/HRuleFull.tsx packages/tui/src/components/FullWidthRow.tsx
git commit -m "feat(tui): add full-width rendering primitives"
```

### Task 5: Create LiveMonitor and EventLog components

**Files:**
- Create: `packages/tui/src/hooks/use-live-state.ts`
- Create: `packages/tui/src/components/LiveMonitor.tsx`
- Create: `packages/tui/src/components/EventLog.tsx`

- [ ] **Step 1: Create use-live-state hook**

Uses `fs.watchFile` (polling) to watch `~/.mmbridge/.live.json` and return parsed `LiveState`.

```typescript
// packages/tui/src/hooks/use-live-state.ts
import { useState, useEffect } from 'react';
import fs from 'node:fs';
import { getLiveStatePath } from '@mmbridge/core';
import type { LiveState } from '@mmbridge/core';

export function useLiveState(pollMs = 500): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);

  useEffect(() => {
    const livePath = getLiveStatePath();
    const read = () => {
      try {
        const raw = fs.readFileSync(livePath, 'utf8');
        const parsed = JSON.parse(raw) as LiveState;
        setState(parsed.active ? parsed : null);
      } catch {
        setState(null);
      }
    };

    read();
    const interval = setInterval(read, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return state;
}
```

- [ ] **Step 2: Create LiveMonitor component**

Shows REVIEW progress (phase steps, progress bar) + STREAM output (right column). Uses `FullWidthRow`.

- [ ] **Step 3: Create EventLog component**

Shows timestamped event list from `LiveState.events`.

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/hooks/use-live-state.ts packages/tui/src/components/LiveMonitor.tsx packages/tui/src/components/EventLog.tsx
git commit -m "feat(tui): add LiveMonitor, EventLog, and use-live-state hook"
```

### Task 6: Create DashboardView

**Files:**
- Create: `packages/tui/src/views/DashboardView.tsx`

- [ ] **Step 1: Create DashboardView**

Combines:
- Row 1: ADAPTERS (left) + PROJECT (right) via `FullWidthRow`
- Row 2: ACTIVITY (left) + LAST REVIEW (right) — only when idle
- Row 2 (live): LiveMonitor — when `useLiveState()` returns non-null
- Bottom: EventLog (full-width)

All sections separated by `HRuleFull`.

Section headers are plain `<Text color={colors.overlay1} bold>SECTION</Text>` — no Box border.

- [ ] **Step 2: Build and verify**

Run: `pnpm run build`

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/views/DashboardView.tsx
git commit -m "feat(tui): add DashboardView with idle/live states"
```

### Task 7: Rewire App — 4 tabs → 3 tabs

**Files:**
- Modify: `packages/tui/src/App.tsx` — replace StatusView/ReviewView with DashboardView, remove review tab
- Modify: `packages/tui/src/store.ts` — change TabId, remove review-execution state
- Modify: `packages/tui/src/components/Header.tsx` — update tab labels
- Modify: `packages/tui/src/components/StatusBar.tsx` — update TAB_HINTS
- Delete: `packages/tui/src/views/ReviewSetup.tsx`
- Delete: `packages/tui/src/views/ReviewProgress.tsx`
- Delete: `packages/tui/src/views/ReviewResults.tsx`
- Delete: `packages/tui/src/views/ReviewView.tsx`
- Delete: `packages/tui/src/components/MiniBar.tsx`
- Delete: `packages/tui/src/components/ProgressSteps.tsx`

- [ ] **Step 1: Update store**

Change `TabId` to `'dashboard' | 'sessions' | 'config'`.
Change `TAB_ORDER` to `['dashboard', 'sessions', 'config']`.
Remove `reviewPhase`, `review.running`, `review.progress`, `review.progressPhase`, `review.result`, `review.bridgeMode`, `review.bridgeToolProgress`, `review.streamBuffer` and all related actions (`REVIEW_START`, `REVIEW_PROGRESS`, `REVIEW_COMPLETE`, `REVIEW_STREAM_CHUNK`, `REVIEW_TOGGLE_BRIDGE`, `REVIEW_BRIDGE_TOOL_PROGRESS`, `SET_REVIEW_PHASE`).
Keep `review.selectedTool`, `review.selectedMode`, `review.focusColumn` for future use.
Add `liveState: LiveState | null` to TuiState.

- [ ] **Step 2: Update App.tsx**

Replace `StatusView` with `DashboardView` for `dashboard` tab.
Remove `ReviewView` import and rendering.
Update `useInput` — remove `2` key mapping for review, shift sessions to `2`, config to `3`.

- [ ] **Step 3: Update Header and StatusBar**

Header: tab labels `Dashboard`, `Sessions`, `Config`.
StatusBar TAB_HINTS: update for 3 tabs.

- [ ] **Step 4: Delete old files**

```bash
rm packages/tui/src/views/ReviewSetup.tsx
rm packages/tui/src/views/ReviewProgress.tsx
rm packages/tui/src/views/ReviewResults.tsx
rm packages/tui/src/views/ReviewView.tsx
rm packages/tui/src/components/MiniBar.tsx
rm packages/tui/src/components/ProgressSteps.tsx
```

- [ ] **Step 5: Update SessionsView for full-width rendering**

Replace `Panel` usage with section headers + `FullWidthRow`.
Use `useStdout().columns` to compute column widths.

- [ ] **Step 6: Build and verify**

Run: `pnpm run build`
Expected: success, all deleted file references resolved

- [ ] **Step 7: Run tests**

Run: `pnpm run test`
Expected: TUI store tests will need updates for removed actions. Fix failing tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tui): 4-tab → 3-tab monitor redesign, delete review execution UI"
```

### Task 8: Update TUI tests

**Files:**
- Modify: `packages/tui/test/store.test.ts` — remove tests for deleted actions

- [ ] **Step 1: Remove tests for deleted actions**

Remove test cases for: `REVIEW_START`, `REVIEW_PROGRESS`, `REVIEW_COMPLETE`, `REVIEW_STREAM_CHUNK`, `REVIEW_TOGGLE_BRIDGE`, `REVIEW_BRIDGE_TOOL_PROGRESS`, `SET_REVIEW_PHASE`.
Update `SWITCH_TAB` tests to use `'dashboard'` instead of `'review'`.

- [ ] **Step 2: Run tests**

Run: `pnpm run test`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add packages/tui/test/store.test.ts
git commit -m "test(tui): update store tests for 3-tab architecture"
```

---

## Chunk 3: Final Integration + Verification

### Task 9: Full build + test + manual verification

- [ ] **Step 1: Full build**

Run: `cd /Users/parkeungje/project/mmbridge-v060 && pnpm run build`

- [ ] **Step 2: Full test suite**

Run: `pnpm run test`

- [ ] **Step 3: Verify CLI streaming (manual)**

Run in a test project: `mmbridge review --tool kimi --stream`
Verify: tree-style output, findings at end, summary bar

- [ ] **Step 4: Verify TUI monitor (manual)**

Run: `mmbridge` in separate terminal
Verify: Dashboard tab shows adapters, project info, events log, full-width rendering

- [ ] **Step 5: Verify TUI live state (manual)**

While CLI review running, check TUI Dashboard shows LIVE indicator and stream output

- [ ] **Step 6: Final commit if any fixes**

```bash
git add -A
git commit -m "fix: integration fixes for CLI streaming + TUI monitor"
```
