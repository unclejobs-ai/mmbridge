# mmbridge Harness Bridge — 설계 & 실행 계획 (2026-09-23)

> 상태: 계획. 근거 리서치 5건(R1 현황 감사 · R2 omp/pi 프로바이더 · R3 unclecode · R4 경쟁 지형 · R5 최신 이론/Code Mode)과
> 이 문서 작성 중 수행한 spike 3건의 **측정값**에 기반한다.

## 0. 방향 전환 (Pivot)

`docs/vision/roadmap.md`는 mmbridge를 "agent OS / 실행 하네스"로 두는 것을 명시적으로 거부한다.
**이 문서가 그 입장을 대체한다.** 새 포지션:

> mmbridge는 설치하는 순간 사용자가 이미 가진 모든 모델 프로바이더를 가져오고,
> 역할(worker / scout / reviewer / designer)을 가장 알맞은 **이미 인증된** 모델에 배정해 실제 작업을 시키며,
> 그 결과를 타입이 있는 게이트(plan → implement → review → validate)로 검증하는 **멀티모델 하네스 브릿지**다.
> 호스트(Claude Code, unclecode, 자체 TUI)는 MCP·CLI로 mmbridge를 부른다.

R4 결론: 아래 네 가지를 **동시에** 하는 도구는 없다 — (1) 설치 시 크리덴셜 자동 발견, (2) 벤더 에이전트 루프를 재구현하지 않고 프로토콜로 구동, (3) 역할 → 인증된 프로바이더 라우팅 + fallback, (4) 타입 게이트를 TUI의 실제 버튼으로. 이게 mmbridge의 자리다.

## 1. Ubiquitous language (고정)

| 용어 | 뜻 | omp `modelRoles` 대응 |
|---|---|---|
| **host** | mmbridge를 부르는 쪽 (Claude Code, unclecode, `mmbridge` TUI) | — |
| **worker** | 파일을 수정하는 구현 역할 | `task` |
| **scout** | 읽기 전용 정찰·초안 | `smol` |
| **reviewer** | 읽기 전용 교차검증. 기본값은 host/worker와 **다른 모델 계열** | `advisor` |
| **designer** | UI/시각 설계·비평 | `designer` |
| **dispatch** | 역할 하나를 모델 하나에 배정해 작업 1건을 돌리는 행위 | — |
| **catalog** | 인증된 프로바이더 × 모델 목록 (가져온 것) | `models.db` |
| **role table** | 역할 → 후보 모델의 **순서 있는 fallback 체인** | `modelRoles` + `fallbackChains` |
| **gate** | 스키마로 검증된 pass/block 판정 | — |

기존 `mmbridge run`(codex read-only task runner)은 이름을 유지하고, 새 개념은 `dispatch`로 부른다. 두 이름을 섞지 않는다.

## 2. 핵심 결정

| # | 결정 | 되돌리기 | 근거 |
|---|---|---|---|
| D1 | **프로바이더 레이어 = omp를 RPC 워커로 구동 (R2 Option B)**. 나중에 `@oh-my-pi/pi-ai`를 라이브러리로 직접 의존(Option A)해 omp 미설치 환경 지원 | reversible | 전부 MIT. OAuth(Codex PKCE, Copilot device, Cursor 등) 재구현은 낭비. spike로 경로 검증 완료 |
| D2 | **catalog 가져오기 = `omp models --json` 서브프로세스** | reversible | RPC `get_available_models`는 v1 1MB 한도 초과, v2는 청크 재조립 필요 — 서브프로세스가 더 단순 |
| D3 | role table 기본값은 `~/.omp/agent/config.yml`의 `modelRoles`/`fallbackChains`에서 시드, mmbridge 설정이 덮어씀. **프로바이더 denylist**(예: 종량 `xai/`) 지원 | reversible | omp 설정이 사용자 CLAUDE.md 역할표와 거의 동일 |
| D4 | **fallback + 쿼터 인식은 S2 (백로그 아님)** | — | spike에서 `openai-codex`가 지금 `usage_limit_reached`(~83h 대기). "워커를 못 부른다"는 불만의 직접 원인 |
| D5 | **unclecode는 합치지 않는다.** mmbridge가 registry·routing·workflow·worker 구동을 소유. unclecode는 기존 MCP 링크로 mmbridge를 부르는 host로 유지. 차용: `packages/providers/src/omp-auth-catalog.ts`의 redaction 패턴, Agent Console/steer, `DESIGN.md` TUI 규칙 | reversible | R3 권고(b)와 사용자 목표(mmbridge가 가져오고 시킨다)를 조정 |
| D6 | 다른 CLI 에이전트 구동은 **ACP 우선**(Claude Code via adapter, Gemini CLI, `omp acp`), 미지원 CLI는 기존 서브프로세스 어댑터 유지 | reversible | R4/R5: ACP가 2026 멀티벤더 표준 |
| D7 | **Code Mode는 opt-in, S6**. 주입 지점은 omp RPC의 `set_host_tools` | reversible | R5: 토큰 절감은 체인형 작업에서만 실재, 2026 샌드박스 탈출 CVE → 경계는 바인딩 capability scoping |
| D8 | durable 상태 = SQLite 이벤트 로그(`SqliteStore` 부활). `SoulStore` 제거. `@mmbridge/skills`는 S6에서 progressive disclosure 엔진으로 부활하거나 삭제 | S5/S6에서 확정 | R1: 세 개 모두 importer 0 |
| D9 | `codex/harness-engineering` 워크트리(manager.ts reviewer, MemoryProvider, F1 벤치)는 ~~S3에서 병합~~ → **S3에서 제외, 별도 브랜치에서 처리** (이유는 S3 결과 참조). S1은 새 패키지에 격리해 충돌 면을 `cli/index.ts` 등록 한 줄로 제한 | — | main과 16파일 충돌, `manager.ts`는 codex 의존(현재 쿼터 소진) |

## 3. Spike 측정값 (scratchpad, 커밋하지 않음)

| 항목 | 측정 |
|---|---|
| `omp models --json` | 11 프로바이더 / 1293 모델 (anthropic, cursor, deepseek, devin, kimi-code, openai-codex, opencode-go, opencode-zen, openrouter, xai-oauth, zai) |
| RPC 프레이밍 | **newline-delimited JSON** (v1, 프레임당 1MB), v2는 `rpc_chunk` 재조립(최대 64MB). *R2의 "length-prefixed" 서술은 틀림* |
| 기본 기동 → `ready` | **41.8s** (플러그인/스킬 탐색) |
| `--no-extensions --no-skills --no-rules --no-lsp --no-title` → `ready` | **1.6s** |
| `set_model zai/glm-5.3-flash` + 한 줄 프롬프트 | 성공, ~24s end-to-end |
| `set_model xai-oauth/grok-4.6` (omp `advisor`) | 성공, 3.1s |
| `set_model openai-codex/gpt-5.6-sol` | `stopReason:error`, `usage_limit_reached`, auto-retry 포기 → 에러가 이벤트로 **감지 가능** |
| `--approval-mode yolo` + 도구 사용 | glob→read→edit로 실제 버그 수정, 44s. 차단형 다이얼로그 없음(`setWidget`은 fire-and-forget) |

## 4. 슬라이스 (tracer bullet → 살 붙이기)

각 슬라이스 = 가장 바깥 입력 → 가장 바깥 출력 + 측정 인수 테스트. 다음 슬라이스는 새 컨텍스트에서.

### S1 — Claude Code에서 reviewer 한 명 부르기 (tracer bullet)
여정: host(Claude Code)가 MCP `mmbridge_dispatch({role:"reviewer", task})` 호출 → role table(omp `modelRoles`)로 모델 해석 → lean omp RPC 워커 기동(**`--no-tools`**, 검토 대상 diff/context는 프롬프트에 인라인 — 기존 `orchestrateReview()`가 어댑터에 넣는 방식과 동일) → `set_model` → `prompt` → 이벤트 스트림 → 최종 텍스트 + `{model, readyMs, totalMs, usage, cost}` 반환. CLI `mmbridge dispatch --role reviewer "…"`는 같은 함수를 부르는 **디버그 경로**다.
- 읽기 도구는 허용하고 쓰기만 막는 reviewer 모드(`--approval-mode write`/`always-ask`)는 **미검증** — 승인 다이얼로그가 `extension_ui_request`로 워커를 멈출 수 있다. S3의 명시적 unknown으로 넘긴다.
- reviewer 기본 모델: omp `advisor` = `xai-oauth/grok-4.6` (spike 통과, 3.1s). 사용자 CLAUDE.md는 reviewer = `openai-codex/gpt-5.6-sol`이지만 현재 쿼터 소진이라 **omp 시드를 채택**하고 CLAUDE.md 모델은 S2에서 fallback 체인 1순위로 복귀시킨다.
- MCP 연결: Claude Code는 현재 scc 플러그인이 고정한 `npx @mmbridge/mcp@0.7.3`을 쓴다 → 로컬 빌드는 반영되지 않는다. 인수 테스트는 repo `.mcp.json`에 `mmbridge-dev`(로컬 `packages/mcp/dist`)를 추가하고 Claude Code 재시작으로 한다.
- 새 패키지 `@mmbridge/dispatch`: `resolveRole()`, `runOmpPrompt()`, `dispatch()` — 인터페이스는 `dispatch(input): Promise<DispatchResult>` 하나 (deep module)
- ~~`mmbridge providers`~~ → S2로 이동 (catalog 조회가 느릴 수 있어 캐시와 함께)
- (보류) `docs/vision/roadmap.md` 방향 전환 반영 — 이미 있는 미커밋 "Execution Backlog" 편집(사용자 작성)을 덮어쓰지 않고 그 위에 합친다
- **인수**: Claude Code 세션에서 MCP로 reviewer 호출 → 다른 계열 모델이 응답, `readyMs`·`totalMs` 숫자 보고. 테스트는 fake omp 바이너리 fixture로 이벤트 파싱 커버

**S1 결과 (2026-09-23, 브랜치 `feat/dispatch-tracer-bullet`)**
- 구현: `packages/dispatch`(`roles.ts`·`omp-worker.ts`·`index.ts`), MCP `mmbridge_dispatch`, CLI `mmbridge dispatch`
- 측정 (MCP SDK stdio 클라이언트 → 빌드된 `packages/mcp/dist`): reviewer → `xai-oauth/grok-4.6`, off-by-one 정확히 지적, `readyMs 3396` / `totalMs 8165` / `$0.006`
- 발견 1: 쿼터 소진 모델에서 omp가 **차단형 `extension_ui_request`(select: "Spend a saved Codex rate-limit reset?")**를 보내고 무한 대기 → 드라이버가 `select/confirm/input/editor`에 항상 `cancelled:true`로 응답(워커는 사용자 대신 아무것도 소비하지 않는다). 수정 후 scout(codex 소진) → `stopReason:error` 5.2s, exit 1
- 발견 2: `omp models --json`이 12분 걸린 적 있음(네트워크 카탈로그 갱신) → catalog는 **캐시 필수, dispatch 경로에 절대 두지 않음**. `mmbridge providers`는 S2로 이동
- 검증: lint·typecheck·build·test(dispatch 11 / mcp 5 / cli 16 + 전체)·smoke 모두 exit 0
- 남은 인수: 실제 Claude Code 세션에서 호출 — `mmbridge-dev` MCP 등록 후 재시작 필요

### S2 — 쿼터가 죽어도 역할은 산다
- `mmbridge providers` + catalog 캐시(`~/.mmbridge`, 백그라운드 갱신, redaction 적용 — 키 값 절대 출력 안 함)
- role table fallback 체인 실행: `stopReason:error` / `usage_limit_reached` / 기동 실패 → 다음 후보
- 프로바이더 health를 `~/.mmbridge`에 기록(쿨다운 만료 시각), `mmbridge providers`에 표시
- denylist, cross-family 규칙(reviewer ≠ worker 계열)
- **인수(오늘 바로 재현 가능)**: reviewer 1순위를 `openai-codex/gpt-5.6-sol`로 고정 → 자동으로 다음 후보(예: `cursor/gpt-5.6-sol` 또는 `zai/glm-5.3`)로 넘어가 응답. 시도 이력과 지연시간 보고

**S2 결과 (2026-09-23, 같은 브랜치)**
- 구현: `resolveRoleChain()`(roles.json 우선 → omp `modelRoles` + `fallbackChains` + omp `default` 순으로 시드, 중복 제거, `deny` 접두사), `health.ts`(프로바이더 단위 쿨다운, `~/.mmbridge/provider-health.json`, 원자적 쓰기), `catalog.ts`(`omp models --json` 1h 캐시, 60s 타임아웃, 실패 시 stale 캐시), `dispatch()` fallback 루프(결과에 `attempts[]`), CLI `mmbridge providers [--json] [--refresh]`
- 규칙: 쿼터 에러 → omp가 준 `requested Nms wait` 그대로 쿨다운(없으면 5분). 모델 미지원/기동 실패 → 다음 후보, 쿨다운 없음. **타임아웃은 fallback하지 않음**(느리게 일하던 모델을 버리고 대기 시간만 두 배). 모델 고정(`model`) 시 fallback·쿨다운 없음
- 실측 1: `dispatch -r scout` → `openai-codex/gpt-5.6-luna` error 6.9s → `devin/swe-2` ok 4.8s ($0.004). codex 쿨다운 `2026-09-26T08:40:47Z`(omp가 알려준 대기 ≈ 3d10h와 일치)
- 실측 2: 재실행 시 codex `skipped`(워커 미기동) → devin 4.2s
- `mmbridge providers`: 1.4s, 11 프로바이더, 역할 체인에 `(cooling down)`/`(not authenticated)` 표시
- 검증: lint·typecheck·test(dispatch 21 + 전체)·smoke exit 0
- `~/.mmbridge/roles.json`을 사용자 CLAUDE.md 역할표로 생성(`deny: ["xai/"]`). 4역할 실측: reviewer `xai-oauth/grok-4.6` 2.5s(codex skipped) · worker `xai-oauth/grok-4.7` 3.0s · scout `zai/glm-5.3-flash` 7.5s · designer `zai/glm-5.2` 4.9s
- 발견 3: **omp가 자기 `fallbackChains`로 내부에서 모델을 바꿔치기하고 성공으로 보고**(designer: `kimi-code/k3` 요청 → `zai/glm-5.2` 응답, 모델 고정 시에도). mmbridge의 체인·deny·쿨다운을 우회하므로 워커는 항상 `--config` 오버레이로 `retry.modelFallback: false`, `retry.usageAwareFallback: false`를 준다(omp 보안 스캔도 같은 방식). 끄자 실제 원인이 드러남: kimi `403 permission_error`(구독에 Kimi Code 권한 없음)
- 권한 에러(401/403)는 1시간 쿨다운 — 매 dispatch마다 2초씩 헛돌지 않게
- 검증: lint·typecheck·test(dispatch 23 + 전체)·smoke exit 0

### S3 — worker가 격리된 곳에서 고치고, reviewer가 게이트한다
- worker 쓰기 작업은 전용 `git worktree`에서만. 결과 = diff + 변경 파일
- gate: plan → implement → review → **validate**(사용자 repo의 실제 테스트 명령 실행). reviewer 결과는 스키마 검증된 `{verdict, findings[]}`
- `codex/harness-engineering` 병합 (manager.ts를 reviewer gate 구현으로 흡수)
- unknown: Claude Code의 MCP 도구 호출 타임아웃이 워커 기본 10분보다 짧을 수 있음 — 몇 분짜리 worker는 비동기(작업 ID 반환 후 조회)로 가야 할 수 있다
- **인수**: 실제 버그 fixture repo에서 worker 수정 → reviewer pass/block → validate exit code

**S3 결과 (2026-09-23, 같은 브랜치)**
- 구현: `implement.ts` — `git worktree add -b mmbridge/worker-<id>`(`~/.mmbridge/worktrees/`) → worker dispatch(도구 on, `--approval-mode yolo`, cwd=worktree) → `git add -A` + `diff --cached <base>` → reviewer dispatch(`excludeProviders: [worker provider]`, JSON 스키마 강제, 파싱 실패 = block, critical/major 발견 = block) → `validate` 셸 명령(worktree에서) → `gate: pass|block` + `reasons[]`. 변경은 worktree에 staged로만 남고 커밋·병합은 host가 한다. `dispatch()`는 `dispatch.ts`로 이동(index는 export 모음)
- MCP `mmbridge_implement`, CLI `mmbridge implement <task> --validate <cmd>`(block이면 exit 1). 결과의 `cleanup` 명령이 worktree 제거 + 브랜치 삭제 — host가 병합/폐기 후 실행
- 실측 (MCP stdio 클라이언트, 1-based 페이지 버그 repo): worker `xai-oauth/grok-4.7` 17.5s가 `(page - 1) * size`로 수정 → reviewer: xai-oauth 제외, codex skipped, `zai/glm-5.3` pass → `node check.js` exit 0 → **gate pass, 전체 24.6s**. 메인 checkout 무변경
- 검증: lint·typecheck·test(dispatch 28 + 전체)·smoke exit 0
- 알려진 한계: (1) worktree에는 `node_modules`가 없다 — validate에 설치 명령을 포함해야 함, (2) yolo worker는 git worktree로 격리될 뿐 파일시스템 샌드박스는 아니다(bash로 worktree 밖 접근 가능), (3) Claude Code MCP 타임아웃보다 긴 worker는 미검증
- **D9 변경**: `codex/harness-engineering` 병합은 S3에서 **제외**. main과 16파일 충돌(core review-pipeline, README, CI, 패키지 버전), `manager.ts`는 기존 review 파이프라인용 codex 합의 검토라 S3 reviewer gate와 별개이고 codex는 현재 쿼터 소진. 별도 브랜치에서 소유자 판단과 함께 처리

**S3 보안 후속 (커밋 보안 리뷰 지적 2건)**
- 권한 우회(yolo worker) → **worker 도구를 `--tools read,edit,write,grep,glob`로 제한**(bash/python/browser/computer/task/web_search 제외), worker 브리프에 "셸 없음, 검증은 mmbridge가 함" 명시. 실측: 제한 직후 브리프 없이 worker가 bash 호출을 텍스트로 흉내 내며 223.5s → 브리프 추가 후 2회 12.3s / 89.5s(토큰 소량, 편차 원인 미추적), 모두 gate pass. 남은 한계: omp `write`/`edit`가 worktree 밖 절대경로를 거부하는지는 미검증
- 명령 주입(`validate` → `sh -c`) → **설계상 유지**: validate는 host가 고르는 명령이고 모델이 고르지 않는다. MCP 설명에 "당신의 권한으로 실행, 직접 돌릴 명령만" 명시. Claude Code에서는 MCP 도구 호출 승인이 게이트
- 함께 잡은 CLI 버그: 루트 명령의 `-p/--project`·`--model`이 `dispatch`/`implement`의 같은 옵션을 삼킴 → `optsWithGlobals()`. 버그 상태에서 `implement -p <repo>`가 **현재 디렉터리(mmbridge repo)에 worktree를 만들었음**(cleanup으로 제거 확인). 회귀 테스트는 가짜 omp를 PATH에, HOME 격리, 비-git cwd에서 실행

**S1–S3 세션 내 인수 (2026-09-24, Claude Code → repo `.mcp.json` `mmbridge-dev`)**
- `mmbridge_dispatch({role:"reviewer"})`: codex skipped(쿨다운) → `xai-oauth/grok-4.6` off-by-one 지적, `readyMs 1124` / `totalMs 9523` / `$0.014`, 벽시계 ≈10s
- `mmbridge_implement`(스크래치 repo, 1-based 페이지 버그, `validate: node check.js`): worker `xai-oauth/grok-4.7` 11.5s(ready 0.58s) → reviewer codex skipped → `zai/glm-5.3` pass 17.6s → validate exit 0 → **gate pass, 벽시계 34.5s**. cleanup 명령으로 worktree·브랜치 제거 확인
- 여전히 미검증: 몇 분짜리 worker가 Claude Code MCP 호출 타임아웃을 넘는지(이번 호출은 모두 35s 이내)

### S4 — Agent Hub TUI
- 디스패치된 역할당 라이브 패널 1개: role / model / 상태 / 경과 / 토큰·비용 / 마지막 도구. steer(`steer`), kill(`abort`)
- gate를 버튼으로 (Conductor 패턴: diff 보기 → pass/block)
- unclecode `DESIGN.md` 규칙 채택(표시폭 안전 CJK 레이아웃, spinner 1개 규칙)
- **인수**: 워커 3개 병렬 실행 스크린샷 + steer 반영 확인

**S4 tracer bullet (2026-09-24): dispatch 1건 → 패널 1개**
- 계약: `WorkerEvent`(`packages/dispatch/src/events.ts`) — `model` / `attempt` / `ready` / `text` / `tool_start{name,intent}` / `tool_end{isError}` / `turn{usage,costUsd}`. omp 원시 프레임(thinking delta마다 partial 메시지 전체 반복)은 seam을 넘지 않는다. `toWorkerEvent()`는 실제 omp 캡처(`test/fixtures/omp-rpc-worker-events.ndjson`, grok-4.7 worker 5턴)로 characterization 테스트
- 발견 4: omp `turn_end` usage는 **턴별**이다. 기존 `runOmpPrompt`는 마지막 assistant 메시지 usage만 반환 → 도구를 쓰는 worker의 토큰·비용을 과소 보고(캡처: 5턴 input 합 14,532 중 마지막 턴 366만). 이제 `turn_end` 합산, 턴 이벤트가 없으면 기존 동작
- `dispatch({onEvent})` → `renderHub({lanes})`(`packages/tui`, `useSyncExternalStore` 스토어, 워커는 React 밖에서 시작) → CLI `mmbridge hub <task> -r <role>`. spinner는 하단 activity row 1개, 패널은 `○ starting / ● running / ✓ done / ✗ error` 텍스트로 상태 표시(DESIGN.md §6). TTY가 없으면 입력 끄고 전 lane 종료 시 자동 unmount
- 측정 (tmux 120×40, 1초마다 `capture-pane`, 하네스는 scratchpad `hub/capture.sh`): 실제 reviewer → codex `↷ skipped` 표시 → `xai-oauth/grok-4.6` 프레임 7개 `starting(0.3s) → running(ready 1.0s) → 답 스트리밍(5.7s) → done(6.2s)`, 패널 `3.0k in / 308 out · $0.008` = 결과 JSON `3036/308, $0.00792, readyMs 1041, totalMs 6180`. `q` → JSON 출력, exit 0
- 함께 잡은 것: ink 5 `isRawModeSupported`는 non-TTY에서 `undefined`이고 `useInput`은 `isActive === false`일 때만 꺼짐 → 명시적 `=== true`. CLI 테스트가 HOME 격리 + `env node`라 HOME 의존 node shim(`~/.bun/bin/node`)이 PATH 앞이면 실패 → 테스트가 자기 node를 PATH 앞에 둠
- 남은 S4: 3 lane 병렬, steer/abort, implement(worker+reviewer lane, 도구 trace, gate)

**S4 3 lane + steer/abort (2026-09-24)**
- spike(실제 omp): `steer`는 큐에 들어가 **현재 턴이 끝난 뒤** 새 턴으로 전달(최종 답 = steer 턴). `abort`는 6ms 내 `stopReason:"aborted"`, `errorMessage:"Interrupted by user"` → `agent_end`
- 계약: `WorkerControl{steer, abort}`를 `dispatch({onControl})`로 받는다(fallback이 새 워커를 띄우면 새 control). abort는 error가 아니므로 **fallback하지 않음**(테스트). 워커가 뜨기 전 누른 abort는 보류했다가 control 도착 시 전달, 끝난 lane엔 무시
- TUI: `mmbridge hub <task> -r worker -r scout -r reviewer`(반복 = 병렬 lane). `↑↓/1-9` 선택(테두리 색 + `›` 마커 — 색만으로 신호 금지), `s` steer 입력줄, `x` abort(즉시 `◌ aborting` → `■ aborted`), `q` 살아 있는 lane 전부 abort 후 종료. 패널 높이 = (터미널 행 − 4) / lane 수, 답은 남는 행만큼 tail
- 인수 측정 (tmux 120×40, 0.5초 캡처 + 시각별 키 입력, 하네스 scratchpad `hub/scenario.sh`): 실제 3모델 병렬 — worker `xai-oauth/grok-4.7`, scout `zai/glm-5.3-flash`, reviewer codex `↷ skipped` → `xai-oauth/grok-4.6`. 7.3s steer(lane 1) → 목록 턴 종료 후 `STEERED` 턴, 25.0s done. 8.7s abort(lane 3) → 다음 프레임 `■ aborted`(lane 경과 8.5s), 결과 `stopReason:"aborted"`. scout 54.5s done. 86 프레임, `EXIT=0`
- 발견: steer 턴 텍스트가 이전 턴에 붙음(`…size.STEERED`) → 턴 종료 후 첫 텍스트는 새 줄에서 시작. 재측정: 40번 항목 다음 줄에 `STEERED`
- 남은 S4: implement lane(worker 도구 trace + reviewer lane + gate pass/block 버튼)

**S4 implement lane (2026-09-24) — S4 완료**
- 결정(사용자): gate는 **자동 판정 유지 + 화면 표시**(사람 승인 대기 없음, MCP 계약 불변). steer는 큐 방식 유지(`abort_and_prompt` 미도입)
- `implement({onEvent, onControl})`: `{stage:'worker'|'reviewer', event}` / `{stage, ended: DispatchResult|Error}` / `{stage:'validate', command}`. worker abort → diff·review 없이 `gate: block`, `reasons: ['worker aborted']`. reviewer abort → `review aborted`
- hub 일반화: `renderHub({title, roles, run(sink)})` — sink `event/control/finish/activity/gate`. lane 초기 상태 `· waiting`(뒤 stage), 끝까지 안 뜬 lane은 `– skipped`, lane 시간은 자기 시작부터. activity row는 lane이 없을 때 run의 현재 작업(`validate: …`)을 spinner와 함께 표시. gate 박스(✓ pass / ✗ block + 사유 + diff/review/validate/branch/cleanup). CLI `mmbridge hub <task> --implement [--validate <cmd>]`(`commands/hub.ts`)
- 인수 측정 (실제, tmux 120×40, 37 프레임): worker `xai-oauth/grok-4.7` 도구 trace `glob → read → edit`가 3.6s/6.0s/13.3s에 차례로 등장, 13.3s done(5턴 합산 14.1k in / 745 out) → reviewer: codex `↷ skipped`, xai 제외 → `zai/glm-5.3` 5.2s pass → 20.1s 프레임 activity `validate: sleep 3 && node check.js` → **gate pass, 전체 22.3s**, `EXIT=0`
- 알려진 한계: abort된 dispatch도 `attempts[]`엔 `outcome:'ok'`(최상위 `stopReason:'aborted'`는 정확). gate 박스의 긴 worktree/cleanup 경로는 잘림 — 전체는 종료 후 JSON에

### S5 — 속도와 내구성
- warm pool (lean 기동 1.6s × N 사전 기동), 병렬 fan-out은 기존 `orchestrateReview()`/`runBridge()` 위에
- `SqliteStore`를 dispatch 이벤트 로그로 부활(step, input hash, output, cost) → 크래시 후 재개, 재실행 시 캐시
- KV-cache 친화: system prompt/도구 스키마 prefix를 세션 내 byte-stable로
- **인수**: 동일 작업 재실행 시 캐시 적중, 비용 전후 숫자

### S6 — Code Mode
- `set_host_tools`로 워커 안에 `mmbridge.dispatch/review/gate` 주입
- 생성된 `mmbridge.d.ts` + QuickJS(WASM) 샌드박스 opt-in 경로. 보안 경계 = 바인딩 capability scoping
- 스킬/도구 이름·설명만 먼저 로드, 필요 시 본문 materialize (`@mmbridge/skills` 부활 or 삭제 확정)
- **인수**: 4단계 체인(implement→review→gate→report)을 스크립트 1회로 — 호스트 컨텍스트 토큰 전후 비교

### S7 — omp 없이도
- `@oh-my-pi/pi-ai` + `pi-catalog` 직접 의존 (Option A) 또는 첫 실행 시 omp 설치 안내
- OpenUsage 순서의 크리덴셜 탐지기: 도구별 저장소 → env → auth.json 파일 → macOS 키체인, `mmbridge detect`로 먼저 보여주고 동의 후 사용
- ACP 드라이버: Claude Code(adapter), Gemini CLI, `omp acp`
- **인수**: 깨끗한 HOME에서 `npm i -g mmbridge` → `mmbridge detect` → 첫 dispatch 성공

## 5. 레인 배정 (CLAUDE.md 역할표 기준)

| 슬라이스 | 레인 | 비고 |
|---|---|---|
| S1 | 오케스트레이터(이 세션) 직접 | tracer bullet은 계약을 정하므로 위임하지 않음 |
| S2–S3 구현 | `worker` + `grok-cli/grok-4.7` 또는 Fable | **codex 계열(`gpt-6-astra`, `gpt-5.6-sol`) 레인은 쿼터 소진으로 현재 차단** |
| 리뷰 게이트 | `reviewer` — codex 복구 전까지 `cursor/gpt-5.6-sol` 또는 `zai/glm-5.3` (S2가 이 선택을 자동화) | |
| S4 디자인 | `designer`(omp: `kimi-code/k3`) 비평 + 오케스트레이터 구현, 스크린샷 검증 | |
| 기계 작업 | `devin/swe-2` | |

디스패치 전 잔여 쿼터 확인, 워커 브리프에 포트·워크트리·금지 경로·검증 명령 포함.

## 6. 검증 명령 (repo 기준)

`pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm smoke` (커밋 직전 `pnpm build`). exit code로 판정.

## 7. 명시적으로 하지 않는 것

- unclecode와의 모노레포 병합
- 자체 OAuth 구현 (omp/pi-ai에 위임)
- Code Mode를 모든 도구 호출의 기본값으로
- Temporal급 워크플로 엔진 (SQLite 이벤트 로그로 충분)
- 공개 벤치마크 점수를 게이트 기준으로 사용
