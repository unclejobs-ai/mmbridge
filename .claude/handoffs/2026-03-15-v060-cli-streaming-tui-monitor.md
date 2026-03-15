# mmbridge v0.6.0 Handoff — CLI Streaming + TUI Monitor Redesign

**Date:** 2026-03-15
**Branch:** main
**Commits:** da2b56e..2afc536 (5 commits)

---

## What Changed (v0.5.0 → v0.6.0)

### 1. CLI Streaming — `--stream` flag (NEW)

**Before:** `mmbridge review --tool kimi` → 2-5분 기다림 → JSON 한번에 출력
**After:** `mmbridge review --tool kimi --stream` → 실시간 트리 형태 출력

```bash
# 기본 사용법
mmbridge review --tool kimi --stream

# 다른 도구/모드
mmbridge review --tool qwen --mode security --stream

# bridge 모드 (모든 도구 병렬)
mmbridge review --tool all --stream
```

출력 형태:
```
● mmbridge review kimi / review
├─ context  12 files · 3 redacted · 0.4s
├─ review   waiting for kimi response...
│  Analyzing src/api/users.ts...
│  Found potential SQL injection at line 42
├─ enrich   5 findings → 4 after scope filter
└─ done     12.3s · session #abc12345

◆ CRITICAL src/api/users.ts:42
  SQL injection via unsanitized user input
▲ WARNING  src/api/users.ts:15
  Missing authentication check

─────────────────────────────────────────
◆1 ▲2 ●1 │ 4 findings │ 12.3s
```

**Claude Code에서 사용:**
Claude Code의 Bash 도구로 직접 실행하면 실시간 로그가 흐른다.
MCP 도구(`mmbridge_review`) 대신 CLI를 권장하는 이유: 실시간 스트리밍이 체감됨.

### 2. TUI Monitor 리디자인 (CHANGED)

**Before:** 4탭 (Status, Review, Sessions, Config) — Review 탭에서 리뷰 실행 가능
**After:** 3탭 (Dashboard, Sessions, Config) — **리뷰 실행 UI 완전 제거**, 모니터 전용

```bash
# TUI 실행 (별도 터미널)
mmbridge
# 또는
mmbridge tui
```

**Dashboard 탭:**
- Idle: 어댑터 상태 + 프로젝트 정보 + 활동 통계 + 마지막 리뷰
- Live: CLI에서 리뷰 실행 중일 때 자동으로 진행 상황 표시 (LiveState 기반)

**Sessions 탭:**
- 3컬럼 레이아웃: 세션 목록 | 상세 정보 | 파인딩 미리보기
- j/k 탐색, f 팔로업, e 내보내기

**렌더링 변경:**
- Ink Box border 제거 → `useStdout().columns` 기반 full-width 렌더링
- `HRuleFull`: `'─'.repeat(columns)` 전체 너비 수평선
- `FullWidthRow`: 비율 기반 좌/우 컬럼 분할

### 3. 공유 리뷰 파이프라인 (INTERNAL)

CLI와 MCP가 동일한 `runReviewPipeline()` 함수를 사용. 코드 중복 제거.

- `packages/core/src/review-pipeline.ts` — DI 패턴 (adapter, session store 주입)
- CLI `review.ts`: 249 → 82 LOC
- MCP `tools.ts` handleReview: 127 → 30 LOC

### 4. 스트리밍 아키텍처 (INTERNAL)

`onStdout`/`onStderr` 콜백이 전체 스택을 관통:
```
runReviewPipeline → orchestrateReview → adapter.review → invoke → runCommand → child.stdout
```

### 5. MCP 도구 추가/강화

- **`mmbridge_search`** (NEW) — query/file/severity/tool 필터로 세션 검색
- **`mmbridge_sessions`** — query, severity 필터 추가
- **MCP progress** — `sendLoggingMessage`로 진행률 알림

### 6. 테스트 인프라 (NEW)

- `finding-parser.test.ts` — 20개 파싱 엣지 케이스
- `review-pipeline.test.ts` — 4개 파이프라인 통합 테스트
- `store.test.ts` — 30개 리듀서 액션 테스트
- `session-analytics.test.ts` — 14개 분석 함수 테스트
- **총 218개 테스트**, 전부 통과

### 7. 린트 정리

- 246개 Biome 에러 전부 해결 → **0 에러, 0 워닝**
- `noNonNullAssertion` 경고 10개 → 적절한 null guard로 교체

---

## LiveState 통신 프로토콜

CLI ↔ TUI 실시간 통신은 파일 기반:

```
~/.mmbridge/.live.json
```

CLI가 리뷰 실행 중 이 파일에 상태를 기록 (200ms debounce):
```typescript
interface LiveState {
  active: boolean;
  tool: string;
  mode: string;
  phase: 'context' | 'redact' | 'review' | 'enrich' | 'done';
  elapsed: number;
  startedAt: string;
  streamLines: string[];  // last 20 lines
  events: Array<{ time: string; message: string }>;
}
```

TUI는 `useLiveState()` 훅으로 500ms 간격 폴링.
CLI 종료 시 `clearLiveState()`로 파일 삭제.

---

## 삭제된 파일

| 파일 | 이유 |
|------|------|
| `tui/views/ReviewSetup.tsx` | 리뷰 실행 UI 제거 (CLI로 이동) |
| `tui/views/ReviewProgress.tsx` | Dashboard LiveMonitor로 대체 |
| `tui/views/ReviewResults.tsx` | Sessions 탭으로 통합 |
| `tui/views/ReviewView.tsx` | 3-phase 라우터 불필요 |
| `tui/components/MiniBar.tsx` | ReviewSetup 전용 |
| `tui/components/ProgressSteps.tsx` | ReviewProgress 전용 |

## 생성된 파일

| 파일 | 역할 |
|------|------|
| `core/src/review-pipeline.ts` | 공유 리뷰 파이프라인 |
| `core/src/live-state.ts` | LiveState 읽기/쓰기/삭제 |
| `cli/src/render/stream-renderer.ts` | CLI 트리 형태 stdout 렌더러 |
| `tui/views/DashboardView.tsx` | 통합 대시보드 (Status + Live) |
| `tui/components/LiveMonitor.tsx` | 실시간 리뷰 진행 표시 |
| `tui/components/EventLog.tsx` | 타임스탬프 이벤트 로그 |
| `tui/components/FullWidthRow.tsx` | 비율 기반 2컬럼 레이아웃 |
| `tui/components/HRuleFull.tsx` | 전체 너비 수평선 |
| `tui/hooks/use-live-state.ts` | fs 폴링 기반 LiveState 구독 |
| `tui/components/FindingsPreview.tsx` | 파일별 파인딩 미리보기 |
| `tui/components/StreamPanel.tsx` | 스트리밍 출력 패널 |

---

## TODO / Known Issues

- [ ] TUI Dashboard full-width 렌더링이 모든 터미널 크기에서 정상 동작하는지 테스트 필요
- [ ] `--stream` 모드에서 bridge (tool=all) 사용 시 여러 adapter의 스트리밍이 interleave될 수 있음
- [ ] TUI에서 리뷰 완료 후 자동 Sessions 갱신 — 현재 `r` 키로 수동 새로고침 필요
- [ ] CI에서 `pnpm run typecheck` (`tsc -b --noEmit`)는 tsconfig project reference 이슈로 실패 — `pnpm run build`로 대체 검증 중
- [ ] MCP `sendLoggingMessage` 진행률이 Claude Code에서 실제로 표시되는지 확인 필요

---

## Quick Verification

```bash
cd /Users/parkeungje/project/mmbridge

# 빌드
pnpm run build

# 테스트
pnpm run test

# 린트 (0 errors expected)
pnpm run lint

# CLI 스트리밍 테스트 (kimi 설치 필요)
mmbridge review --tool kimi --stream

# TUI 실행
mmbridge
```
