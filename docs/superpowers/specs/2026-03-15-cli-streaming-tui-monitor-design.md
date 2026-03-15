# mmbridge v0.6.0 — CLI Streaming + TUI Monitor Redesign

## Summary

mmbridge를 CLI-first 아키텍처로 전환. CLI가 `--stream` 플래그로 실시간 스트리밍 출력을 제공하고, TUI는 실행 주체가 아닌 실시간 모니터링 대시보드로 역할 변경.

## Problem

- MCP/CLI로 리뷰 실행 → 2-5분 블랙박스 → JSON 결과 한번에 반환
- TUI가 리뷰 실행 UI + 결과 뷰어를 겸하지만, CLI/MCP와 중복되고 체감 가치 낮음
- Ink Box border의 flexGrow 버그로 TUI 레이아웃이 왼쪽으로 쏠림

## Design Decisions

1. **CLI가 메인 인터페이스** — `mmbridge review --tool kimi --stream`
2. **TUI는 모니터 전용** — CLI가 실행한 리뷰를 실시간 감시하는 대시보드
3. **TUI에서 리뷰 실행 제거** — ReviewSetup, ReviewProgress 삭제
4. **4탭 → 3탭** — Dashboard(Status+Live 통합), Sessions, Config
5. **Box border 제거** — `useStdout().columns` 기반 full-width hrule 구분

## Architecture

```
Claude Code (Bash)
  └─ mmbridge review --tool kimi --stream
       ├─ stdout: 트리 형태 실시간 출력 (compact style)
       ├─ writes: session store (~/.mmbridge/sessions/)
       └─ writes: live state file (~/.mmbridge/.live.json)

TUI (separate terminal)
  └─ mmbridge (fullscreen dashboard)
       ├─ watches: live state file → Dashboard LIVE/STREAM/EVENTS 패널
       └─ reads: session store → Sessions 탭
```

## Part 1: CLI Streaming (`--stream` flag)

### Output Format (Compact Tree Style)

```
● mmbridge review kimi / review
├─ context  12 files · 3 redacted · 0.4s
├─ review   waiting for kimi response...
│  Analyzing src/api/users.ts...
│  Found potential SQL injection at line 42
│  Checking src/components/Form.tsx...
│  Review complete. Parsing output...
├─ enrich   5 findings → 4 after scope filter
└─ done     12.3s · session #abc12345

◆ CRITICAL src/api/users.ts:42
  SQL injection via unsanitized user input
▲ WARNING  src/api/users.ts:15
  Missing authentication check on DELETE endpoint
▲ WARNING  src/components/Form.tsx:88
  XSS risk: dangerouslySetInnerHTML with user data
● INFO     src/utils/helpers.ts
  Consider extracting validation logic

─────────────────────────────────────────
◆1 ▲2 ●1 │ 4 findings │ 12.3s
```

### Implementation

- `packages/cli/src/commands/review.ts` — `--stream` option 추가
- `packages/cli/src/render/stream-renderer.ts` — **새 파일**: 트리 형태 stdout 렌더러
- `runReviewPipeline`의 `onProgress` + `onStdout` 콜백을 stream renderer에 연결
- 리뷰 완료 시 findings를 severity 순으로 정렬해서 출력

### Live State File

CLI 실행 중 `~/.mmbridge/.live.json`에 상태 기록:

```typescript
interface LiveState {
  active: boolean;
  tool: string;
  mode: string;
  phase: string;       // 'context' | 'redact' | 'review' | 'enrich' | 'done'
  elapsed: number;
  startedAt: string;   // ISO timestamp
  streamLines: string[]; // last 20 lines of stream output
  events: Array<{ time: string; message: string }>;
  progress?: number;   // 0-100
  findingsSoFar?: number;
}
```

CLI가 주기적으로 이 파일을 업데이트 (debounced, 200ms). TUI가 fs.watch로 감시.

## Part 2: TUI Monitor Redesign

### Tab Structure

| Before (v0.5) | After (v0.6) |
|---|---|
| 1:Status 2:Review 3:Sessions 4:Config | 1:Dashboard 2:Sessions 3:Config |

### Rendering Strategy

- **Box border 전면 제거** — `borderStyle` 안 씀
- **`useStdout().columns`** — 터미널 너비 가져와서 모든 레이아웃에 적용
- **HRule** — `'─'.repeat(columns)` 전체 너비 수평선으로 섹션 구분
- **Row** — 좌/우 컬럼을 `Math.floor(cols * ratio)`로 고정 분할
- **padEnd** — 모든 텍스트 행을 컬럼 너비까지 패딩

### Dashboard (Tab 1) — Idle State

```
 mmbridge  Dashboard  Sessions  Config        main(dda16bd) 5△
────────────────────────────────────────────────────────────────────────────────
 ADAPTERS                                   PROJECT
 ✓ kimi     12 ▂▃▅▃▁▂▄ 3d ago        path     ~/project/my-app
 ✓ qwen     20 ▁▂▃▅▇▅▃ 1d ago        branch   main (dda16bd)
 ✓ codex    26 ▃▅▇▅▃▂▁ 1d ago        dirty    5 files
 ✓ gemini    7 ▁▁▂▃▁▁▁ 5d ago        base     origin/main
 ✗ droid     ·  ───────  ──           commit   feat: add streaming
 ✗ claude    ·  ───────  ──
────────────────────────────────────────────────────────────────────────────────
 ACTIVITY 7d                                LAST REVIEW
 ▁▂▃▅▇▅▃  avg 4.9/d · 34 total          qwen / review / 1d ago
 ◆41  ▲43  ●71  ◇1                       ◆0 ▲0 ●2 ◇0  2 findings
────────────────────────────────────────────────────────────────────────────────
 EVENTS
 no active review — run mmbridge review --stream to start
────────────────────────────────────────────────────────────────────────────────
 r Refresh   1-3 Tabs   ? Help   q Quit                     v0.6.0
```

### Dashboard (Tab 1) — Live Review

```
 mmbridge  Dashboard  Sessions  Config        main(dda16bd) ● LIVE
────────────────────────────────────────────────────────────────────────────────
 REVIEW  kimi · review                STREAM
 ■■■■■■■■■■■■■■■■■■░░░░░░ 75%  12.3s    │ INF reading input 4,211
                                          │ INF chunk 1/3 sent
 ✓ context   0.4s · 12 files             │ INF analyzing users.ts
 ✓ redact    0.1s · 3 redacted           │ WRN missing auth L15
 ⣾ review    11.8s                        │ CRI SQL injection L42
 ○ enrich                                 │ INF checking Form.tsx
                                          │ INF retry chunk 3...
────────────────────────────────────────────────────────────────────────────────
 EVENTS
 12:04.0  review requested — kimi (review)
 12:04.1  context — 12 files, 3 redacted
 12:04.5  kimi dispatched — timeout 300s
 12:08.2  kimi — 1 CRITICAL found
 12:11.9  kimi — 1 WARNING found
────────────────────────────────────────────────────────────────────────────────
 r Refresh   1-3 Tabs   ? Help   q Quit                     v0.6.0
```

### Sessions (Tab 2) — 3-column

Same as current implementation but with full-width rendering.

### Files to Delete

- `packages/tui/src/views/ReviewSetup.tsx` — 리뷰 실행 UI 제거
- `packages/tui/src/views/ReviewProgress.tsx` — 진행률 UI 제거 (Dashboard에 통합)
- `packages/tui/src/views/ReviewResults.tsx` — 결과 뷰 제거 (Sessions에 통합)
- `packages/tui/src/views/ReviewView.tsx` — 라우터 제거
- `packages/tui/src/components/MiniBar.tsx` — ReviewSetup 전용 컴포넌트
- `packages/tui/src/components/ProgressSteps.tsx` — ReviewProgress 전용

### Files to Create

- `packages/cli/src/render/stream-renderer.ts` — CLI 스트리밍 렌더러
- `packages/core/src/live-state.ts` — LiveState 읽기/쓰기 유틸
- `packages/tui/src/views/DashboardView.tsx` — 통합 대시보드 (Status + Live)
- `packages/tui/src/components/EventLog.tsx` — 타임스탬프 이벤트 로그
- `packages/tui/src/components/LiveMonitor.tsx` — 실시간 리뷰 진행 표시
- `packages/tui/src/hooks/use-live-state.ts` — fs.watch 기반 LiveState 구독

### Files to Modify

- `packages/tui/src/App.tsx` — 4탭→3탭, ReviewView 제거
- `packages/tui/src/store.ts` — reviewPhase/ReviewSetup 관련 상태 제거, liveState 추가
- `packages/tui/src/components/Header.tsx` — 탭 이름 변경
- `packages/tui/src/components/StatusBar.tsx` — TAB_HINTS 업데이트
- `packages/tui/src/components/Panel.tsx` — borderStyle 제거, 역할 축소
- `packages/tui/src/views/StatusView.tsx` — DashboardView로 교체
- `packages/tui/src/views/SessionsView.tsx` — full-width 렌더링 적용
- `packages/cli/src/commands/review.ts` — `--stream` flag 추가

## Success Criteria

1. `mmbridge review --tool kimi --stream` 실행 → 터미널에 트리 형태 실시간 출력
2. 동시에 다른 터미널에서 `mmbridge` TUI → Dashboard에 진행 상황 실시간 반영
3. 리뷰 완료 → TUI Sessions 탭에 자동 갱신
4. TUI가 터미널 전체 너비를 채움 (왼쪽 쏠림 없음)
5. TUI에서 리뷰 실행 UI 없음 (모니터 전용)
