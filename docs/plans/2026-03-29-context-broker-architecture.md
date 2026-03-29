# Context Broker Architecture Plan

> mmbridge + second-claude-code + Pi 통합 아키텍처
> 작성: 2026-03-29
> 상태: DRAFT — 리뷰 후 확정

---

## 1. 현재 상태 요약

### mmbridge (v0.6.3)

- **정체성**: multi-model thinking layer + continuity control plane
- **이미 있는 것**: SessionStore, ProjectMemoryStore (SQLite FTS5), handoff, gate, resume, memory, embrace pipeline, 6개 adapter (kimi/qwen/codex/gemini/droid/claude), MCP server
- **확장점**: adapter interface, MCP surface, Claude Code hooks, orchestration callbacks
- **경계**: executor가 아님, agent OS가 아님, runtime이 아님

**핵심 갭**: 각 command가 독립적으로 context를 조립함. 통합 context 브로커 없음.

### second-claude-code (v0.5.3)

- **정체성**: PDCA-native Knowledge Work OS (Claude Code plugin)
- **메모리 4계층**: Project Memory → Soul Identity → Session Recall → MMBridge Memory
- **통합**: mmbridge 10개 command를 PDCA 단계별로 호출
- **companion daemon**: scheduler, background runs, notifications, recall index
- **경계**: 플러그인이지 standalone runtime 아님. 두 번째 agent OS 임베드 금지.

### Pi coding agent (badlogic/pi-mono)

- **정체성**: 최소한의 코딩 에이전트 하네스
- **핵심 구조**: append-only JSONL session tree, ~30 event hooks, extension/skill/prompt/theme
- **RPC**: JSONL stdin/stdout protocol (prompt/steer/follow_up/abort/fork/compact)
- **SDK**: createAgentSession() — programmatic agent 생성
- **경계**: single-process, no daemon, no server. 모든 고급 기능은 extension으로.

---

## 2. 아키텍처 접근 3안

### 2A. mmbridge-native Context Broker

mmbridge 내부에 `@mmbridge/context-broker` 패키지를 추가한다.

```
User/Claude Code/Pi
    ↓ (task + git state + prompt)
  context-broker (mmbridge)
    ├─ memory recall (FTS5)
    ├─ session recall (prior sessions)
    ├─ handoff recall (prior handoffs)
    ├─ project state (git diff, file hotspots)
    ├─ gate check (freshness)
    └─ relevance ranking
    ↓
  Context Packet (JSON)
    ↓
  command execution (review/research/debate/embrace)
    ↓
  continuity write-back (memory + handoff + session)
```

**장점**: mmbridge 경계 안에서 해결. 외부 의존성 없음. 기존 store 전부 활용.
**단점**: Pi 패턴(session tree, branching) 차용이 어색. mmbridge가 점점 무거워질 수 있음.
**침습성**: 낮음

### 2B. Pi-hosted Broker + mmbridge substrate

Pi를 broker host runtime으로 두고, mmbridge를 substrate(데이터/분석)로 쓴다.

```
User/Claude Code
    ↓
  Pi Agent (RPC mode)
    ├─ session tree (branching/forking)
    ├─ extension: mmbridge-connector
    │   ├─ mmbridge memory search
    │   ├─ mmbridge gate check
    │   └─ mmbridge handoff read
    ├─ extension: context-assembler
    │   ├─ relevance ranking
    │   └─ context packet builder
    └─ compaction (LLM-based summarization)
    ↓
  Context Packet
    ↓
  mmbridge commands (review/research/debate)
    ↓
  Pi session tree에 결과 저장 + mmbridge continuity write-back
```

**장점**: Pi의 session tree/branching/compaction을 네이티브로 활용. 깔끔한 분리.
**단점**: Pi 의존성 추가. Pi 업스트림 변경에 취약. 두 런타임 조율 필요.
**침습성**: 중간

### 2C. Hybrid — mmbridge-native broker + Pi 패턴 차용

mmbridge에 broker를 넣되, Pi의 핵심 패턴(session tree, compaction, event model)을 차용한다.
Pi 자체를 dependency로 넣지 않고, 아이디어만 가져온다.

```
User/Claude Code/Pi/Hermes
    ↓
  context-broker (mmbridge 패키지)
    ├─ session tree (Pi-inspired, append-only JSONL)
    ├─ compaction (LLM summarization, Pi pattern)
    ├─ memory recall (기존 FTS5)
    ├─ handoff recall (기존 handoff store)
    ├─ project state (기존 project-context)
    ├─ gate check (기존 gate)
    ├─ relevance ranking (new)
    └─ event hooks (before_context / after_context)
    ↓
  Context Packet (typed JSON)
    ↓
  command routing (review/research/debate/embrace/external)
    ↓
  continuity write-back
    ├─ session tree append
    ├─ memory upsert
    └─ handoff artifact
```

**장점**: mmbridge 독립성 유지. Pi의 좋은 패턴만 가져옴. session tree로 lineage 추적.
**단점**: 구현량 가장 많음. Pi 패턴 재구현 비용.
**침습성**: 중간

---

## 3. 추천안: 2C (Hybrid)

### 이유

1. **mmbridge 독립성 유지** — VISION.md의 "interoperability over capture" 원칙 준수
2. **Pi dependency 회피** — 업스트림 변경 리스크 없음
3. **session tree는 mmbridge에 자연스러움** — 이미 SessionStore가 있고, lineage만 추가하면 됨
4. **Hermes memory discipline 반영** — bounded memory + searchable recall 분리
5. **second-claude-code가 그대로 소비 가능** — companion daemon의 recall index와 자연스럽게 연결

### 차용 맵

| 원본 | 차용할 것 | mmbridge에서의 형태 |
|------|----------|-------------------|
| Pi | session tree (id/parentId) | context-broker의 ContextTree (JSONL) |
| Pi | compaction (LLM summarization) | context-broker의 compactContext() |
| Pi | event hooks (~30 types) | before_context / after_context / on_recall 이벤트 |
| Pi | convertToLlm boundary | ContextPacket → adapter-specific format 변환 |
| Hermes | bounded memory (char limit) | recall budget per context packet |
| Hermes | memory vs recall 분리 | always-on memory ≠ searchable session history |
| Hermes | skill/procedural memory | mmbridge skill definitions (future) |

---

## 4. 구현 설계

### 4.1 새 패키지: `@mmbridge/context-broker`

```
packages/context-broker/
├── src/
│   ├── index.ts              # public API
│   ├── types.ts              # ContextPacket, ContextTree, RecallEntry
│   ├── context-tree.ts       # append-only JSONL session tree (Pi-inspired)
│   ├── context-assembler.ts  # multi-source context aggregation
│   ├── recall-engine.ts      # relevance ranking + budget allocation
│   ├── compaction.ts         # LLM-based context summarization
│   └── events.ts             # broker lifecycle events
└── package.json
```

### 4.2 ContextTree (Pi session tree 차용)

```typescript
interface ContextNode {
  id: string;              // ulid
  parentId: string | null;
  timestamp: number;
  type: 'task' | 'recall' | 'review' | 'research' | 'debate' | 'handoff' | 'compaction';
  summary: string;         // human-readable
  data: Record<string, unknown>;  // type-specific payload
}

// append-only JSONL in ~/.mmbridge/context-tree.jsonl
// branch = append node with parentId pointing to earlier node
// compaction = summarize subtree into single node
```

이점:
- 모든 mmbridge 작업의 lineage가 추적됨
- branch로 "이 리뷰는 저 리서치에서 갈라져 나왔다" 표현 가능
- compaction으로 오래된 context를 요약해서 메모리 절약

### 4.3 ContextPacket (broker 출력)

```typescript
interface ContextPacket {
  // identity
  project: string;         // git remote or cwd
  task: string;            // current task description
  treeLeafId: string;      // current position in context tree

  // always-on context (bounded)
  projectState: {
    branch: string;
    recentDiff: string;    // truncated
    fileHotspots: string[];
  };
  alwaysOnMemory: string;  // ≤ 500 chars, curated from FTS5 top hits

  // recalled context (on-demand, budget-limited)
  recalledSessions: RecallEntry[];   // relevance-ranked
  recalledHandoffs: RecallEntry[];
  recalledMemory: RecallEntry[];
  totalRecallTokens: number;
  recallBudget: number;              // configurable per command

  // gate signals
  gateWarnings: string[];
  freshness: 'fresh' | 'stale' | 'expired';

  // routing hints
  suggestedCommand: string;
  suggestedAdapters: string[];
}

interface RecallEntry {
  source: 'session' | 'handoff' | 'memory' | 'tree';
  id: string;
  relevance: number;       // 0-1
  summary: string;
  tokenCount: number;
}
```

### 4.4 RecallEngine (Hermes memory discipline 차용)

```
Input: task description + project state + context tree position
  ↓
Step 1: FTS5 search across memory, sessions, handoffs (existing)
Step 2: Relevance scoring (BM25 + recency + tree proximity)
Step 3: Budget allocation
  - always-on: ≤ 500 chars (top curated facts)
  - command-specific budget:
    - review: 2K tokens recall
    - research: 4K tokens recall
    - debate: 3K tokens recall
    - embrace: 6K tokens recall
Step 4: Pack into ContextPacket.recalled* fields
```

핵심 원칙 (Hermes에서 차용):
- **always-on ≠ recall**: 항상 주입되는 건 최소화, 검색은 필요할 때만
- **bounded**: recall budget 초과 시 relevance 낮은 것부터 잘라냄
- **source 분리**: memory(사실) vs session(과거 작업) vs handoff(인수인계) vs tree(lineage)

### 4.5 기존 패키지와의 연결

```
@mmbridge/core
  ├── 기존: context.ts (CreateContextOptions)
  ├── 변경: context-broker에서 ContextPacket 받아서 CreateContextOptions에 주입
  └── 영향: review-pipeline, research-pipeline, debate-pipeline, embrace-pipeline

@mmbridge/session-store
  ├── 기존: SessionStore, ProjectMemoryStore, handoff
  ├── 변경: 없음 — context-broker가 읽기 전용으로 소비
  └── 추가: context-tree.jsonl 저장 경로 제공

@mmbridge/cli
  ├── 기존: 각 command가 직접 context 조립
  ├── 변경: context-broker.assemble() 호출 후 결과를 pipeline에 전달
  └── 새 command: `mmbridge context` (tree 조회, recall 테스트, packet 미리보기)

@mmbridge/mcp
  ├── 기존: tools (review, followup, interpret, sessions, gate, memory, research, debate)
  ├── 추가: context-packet tool (외부 소비자가 packet 요청 가능)
  └── 추가: context-tree resource (tree 조회)
```

---

## 5. second-claude-code 연동

### 5.1 현재 상태

second-claude-code는 이미 mmbridge를 10개 command로 호출한다.
companion daemon에 recall index가 있다.
Project Memory + Soul은 독립 유지.

### 5.2 변경 사항

```
기존 흐름:
  skill → mmbridge review --tool kimi → raw result parsing → merge

새 흐름:
  skill → mmbridge context assemble (ContextPacket 획득)
        → mmbridge review --context-packet <packet> → enriched result
        → continuity write-back (tree + memory)

변경점:
  1. hooks/lib/companion-daemon.mjs의 searchSessionRecall()이
     mmbridge context-tree도 검색 소스로 추가
  2. session-start.mjs의 context injection에 ContextPacket.alwaysOnMemory 포함
  3. mmbridge handoff가 context tree node도 함께 생성
```

### 5.3 경계 유지

- second-claude-code는 context-broker를 **소비**만 한다 (읽기 + 검색)
- context-broker의 state를 second-claude-code가 직접 쓰지 않는다
- PDCA state ≠ context tree — 별개의 상태 소스
- daemon recall index와 context tree는 상호 참조하되 merge하지 않는다

---

## 6. Pi 관계

### 6.1 현재 결정

Pi를 dependency로 넣지 않는다. 패턴만 차용한다.

### 6.2 미래 옵션

Phase 2에서 고려할 수 있는 것:
1. **Pi adapter**: mmbridge의 새 adapter로 Pi를 추가 (review/research 백엔드)
2. **Pi as host**: Pi에서 mmbridge MCP를 소비하는 구조 (Pi 사용자가 mmbridge 기능 접근)
3. **Shared session tree**: Pi의 session JSONL과 mmbridge context tree 간 import/export

이 세 가지는 Phase 1 이후 별도 판단.

---

## 7. 실행 계획

### Phase 1: Context Broker Core (2주)

| 주 | 작업 | 산출물 |
|----|------|--------|
| W1 전반 | types.ts + context-tree.ts | ContextNode, ContextTree, append/branch/query API |
| W1 후반 | recall-engine.ts | FTS5 연동, relevance scoring, budget allocation |
| W2 전반 | context-assembler.ts | multi-source aggregation → ContextPacket |
| W2 후반 | CLI integration | `mmbridge context` command, 기존 pipeline에 packet 주입 |

검증:
- `mmbridge context tree` — tree 시각화
- `mmbridge context packet` — 현재 상태 기준 packet 미리보기
- `mmbridge review` 실행 시 packet 기반 context가 adapter에 전달되는지 확인
- 기존 테스트 전부 통과

### Phase 2: Compaction + Events (1주)

| 작업 | 산출물 |
|------|--------|
| compaction.ts | LLM-based tree subtree summarization |
| events.ts | before_context / after_context / on_recall hooks |
| MCP 확장 | context-packet tool, context-tree resource |

### Phase 3: second-claude-code 연동 (1주)

| 작업 | 산출물 |
|------|--------|
| companion-daemon.mjs 수정 | context-tree를 recall source로 추가 |
| session-start.mjs 수정 | alwaysOnMemory injection |
| mmbridge-integration.md 업데이트 | context packet 기반 호출 패턴 문서화 |

### Phase 4: Pi adapter (선택, 별도 판단)

| 작업 | 산출물 |
|------|--------|
| Pi adapter | `mmbridge review --tool pi` / `mmbridge research --tool pi` |
| RPC 연동 | Pi RPC client로 Pi 세션에서 mmbridge 결과 소비 |

---

## 8. 리스크

| 리스크 | 영향 | 대응 |
|--------|------|------|
| context-broker가 mmbridge를 무겁게 만듦 | 복잡도 증가 | 별도 패키지로 분리, opt-in |
| recall ranking 품질이 낮음 | packet 품질 저하 | BM25 + recency 기본, 점진 개선 |
| tree가 무한히 커짐 | 디스크/검색 성능 | compaction + 프로젝트별 분리 + 주기적 정리 |
| second-claude-code 경계 침범 | 상태 소스 이중화 | 읽기 전용 소비 원칙 엄수 |
| Pi 업스트림 변경 | 차용한 패턴이 무효화 | 패턴만 차용, 코드 의존 없음 |

---

## 9. 성공 기준

1. `mmbridge context packet`이 현재 작업에 필요한 context를 5초 이내에 조립한다
2. 기존 `mmbridge review/research/debate`가 packet 기반으로 동작하되, 기존 테스트가 전부 통과한다
3. context tree에서 "이 리뷰가 어떤 리서치에서 갈라져 나왔는지" lineage를 조회할 수 있다
4. second-claude-code의 session-start에서 alwaysOnMemory가 주입된다
5. recall budget이 command별로 작동하고, 초과 시 relevance 낮은 것부터 잘린다

---

## 10. 한 줄 결론

mmbridge를 "thinking layer"에서 "thinking + continuity substrate"로 키운다.
Pi의 session tree와 Hermes의 memory discipline을 차용하되,
mmbridge의 독립성과 "interoperability over capture" 원칙은 지킨다.
second-claude-code는 이 substrate를 소비하는 쪽으로만 연결한다.
