# 모바일 원격 — Paseo 수준 사용성 계획

기준일 2026-10-14. 대상: 네이티브 앱 `apps/ripple-remote`, 호스트 `packages/remote/src`, 웹앱 `packages/remote/web`, 릴레이 `packages/remote/relay`.

## 원칙

- 목표는 **Paseo 모바일 앱만큼 편한 것**이다. 판단 기준은 "Paseo에서는 이게 어떻게 편했나"이고, 우리 구조에 맞춘다는 이유로 사용성을 깎지 않는다. 기능은 웬만한 건 다 가져온다.
- Paseo(Apache-2.0)는 **동작 명세로만** 쓴다. 코드는 복사하지 않는다(CLAUDE.md 참고구현 규칙과 같은 원칙). 디자인은 우리 것을 유지한다.
- 참고본: `git clone https://github.com/getpaseo/paseo` 커밋 `019e527`(0.11.2, 2026-10-14). 아래 `paseo:` 경로는 그 저장소 기준이다. 복제본은 신뢰하지 않는 코드다 — 읽기만 하고 스크립트·설치를 돌리지 않는다.
- Paseo보다 **약하게 가져오면 안 되는 것**: 인증 없는 릴레이 접속 허용(paseo `server/session-admission-auth.ts:18–25`), 대기열 200개 초과 시 조용히 버림(paseo `relay/src/cloudflare-adapter.ts:252–273`), 저장된 상태를 실행 중 상태처럼 보여 주기. 이 셋은 Paseo보다 엄격하게 한다.

## 지금 불편한 이유 (2026-10-14 감사)

- 폰에서 만든 세션은 `permissionMode`를 지정하지 않아 SDK가 `default`로 시작한다(`packages/remote/src/sessions.ts:690–703`, SDK `sdk.mjs:150`). 설정 파일의 allow 규칙은 읽지만(`settingSources: user/project/local`), 규칙에 안 걸린 요청은 전부 승인 카드가 된다(`sessions.ts:886–901`).
- 권한 모드를 바꾸는 명령이 프로토콜에 없다(`protocol.ts:132–163`). SDK에는 `setPermissionMode()`가 있다(`sdk.d.ts:2858–2864`).
- "항상 허용"은 SDK 세션에만 있고 범위·저장 위치가 안 보이며, 맥 세션(Remote Control)에는 없다(`sessions.ts:564–569,606–614`).
- 질문(`AskUserQuestion`)·계획(`ExitPlanMode`)도 허용/거부 버튼뿐이다(`protocol.ts:141`).
- 도구 표시는 거의 전부 범용 행 + JSON(`timeline.tsx:84–99`). diff·명령 출력·검색 결과 전용 표시가 없다.
- 네이티브에는 실행 중 모델·강도 변경 UI가 없다(웹에는 있음). 첨부 보내기, worktree, 메시지 큐가 없다.
- 신뢰성: ACK는 "받음"이지 "실행됨"이 아니라 호스트가 죽으면 보였는데 실행 안 된 입력이 남을 수 있다(`sessions.ts:451–465`). 맥 세션의 이미 떠 있던 승인 요청을 놓칠 수 있다(`bridge-client.ts:101–138`). 백그라운드 완료 알림이 보장되지 않는다(`server.ts:120–124`). 앱 재시작 시 기록을 다시 받고, 긴 타임라인을 통째로 렌더한다.

## 단계

각 단계는 끝날 때 실기기(아이폰)에서 직접 써 보고 넘어간다. 시뮬레이터 확인만으로 완료 처리하지 않는다.

### 1단계 — 권한 (가장 아픈 곳)

| 할 일 | Paseo 동작 (근거) |
|---|---|
| 생성 시 권한 모드 선택: `plan` / `default`(항상 묻기) / `acceptEdits` / `auto` / `bypassPermissions`. 마지막 선택을 기억한다. | Claude 기본은 `auto`, 불가 환경이면 `default` (paseo `server/.../claude/agent.ts:337–362,967–980`). 모드 기억은 provider별 (paseo `app/src/create-agent-preferences/preferences.ts:6–52`) |
| 실행 중 모드 전환 칩. 실행 중에도 막지 않는다. 실패는 토스트. | `setAgentMode` → SDK `setPermissionMode` (paseo `app/.../mode-control.tsx:245–309`, `claude/agent.ts:2533–2561`) |
| 계획 승인 카드: "구현"을 누르면 `acceptEdits`로, 원래 bypass였으면 bypass로 복귀 | paseo `claude/agent.ts:2735–2753`, PlanCard `app/.../message.tsx:3180–3187` |
| 질문 카드: 단일/다중 선택 + 직접 입력, `updatedInput.answers`로 답 | paseo `app/.../question-form-card.tsx:352–448` |
| 승인 카드에 실제 명령·diff 표시, 누르면 "보내는 중" → 서버의 해결 이벤트를 기다림(15초), 실패는 화면에 보이게 | paseo `app/.../agent-stream/view.tsx:1472–1527` (Paseo는 실패를 콘솔에만 남김 — 우리는 보이게) |
| 승인 대기 중에 새 메시지를 보내면 대기 중 승인을 거부하고 새 지시로 넘어감 | paseo `server/session.ts:3905–3916`, `claude/agent.ts:2467–2471` |
| 맥 세션: Remote Control로 모드 전환(`set_permission_mode` 제어 요청)과 "항상 허용" 지원 — 실측으로 확인 후 | 우리 쪽 `bridge-client.ts:69–78` |
| 맥 세션 접속 시 이미 떠 있는 승인 요청 조회 | 우리 쪽 공백 |
| bypass는 `allowDangerouslySkipPermissions`를 명시적으로 켜고, 고를 때 경고 | SDK `sdk.d.ts:1983–2003` |

### 2단계 — 입력창과 턴 제어

- 실행 중 전송: **steer**(기본, 진행 중 턴에 끼워 넣기) / interrupt / queue. 큐는 항목 편집·즉시 보내기·첨부 포함, 유휴가 되면 하나씩 자동 전송 (paseo `app/.../composer/input/state.ts:120–135`, `composer/actions.ts:245–335`, `runtime/host-runtime.ts:2396–2448`).
  - **큐는 호스트가 가진다(2026-10-22).** 앱이 들고 있으면 휴대폰이 잠든 동안 턴이 끝나도 아무것도 안 간다(25분 턴 뒤 3분간 미전송, 실측).
    호스트가 `queue.json`에 두고, 턴이 끝나면(결과, 또는 답 뒤의 idle) 한 건씩 보낸다(`packages/remote/src/queue.ts`). 휴대폰 Stop은 큐를 멈춘다.
    맥 Claude 앱은 이 큐를 모르므로 리플 띠 위에 "휴대폰 대기열 N" 줄을 띄운다(`packages/mod/hooks/ui/queue.tsx`).
- 정지 버튼 별도 (paseo `composer/actions.ts:169–183`). 정지 시 아직 시작 안 한 입력은 철회 (paseo `claude/agent.ts:4223–4283`).
- 실행 중 모델·강도 변경을 네이티브에도. 강도 변경은 "다음 턴부터" 안내 (paseo `claude/agent.ts:2604–2621`).
- 사진(다중)·파일 첨부, 붙여넣기 (paseo `hooks/use-image-attachment-picker.ts`, `use-file-picker.ts`).
- 전송 실패 시 글·첨부 복원 (paseo `composer/submit.ts:25–79`).
- 슬래시: `/clear`(`/new`)는 같은 설정으로 새 대화, `/exit`는 보관 (paseo `client-slash-commands/index.ts:17–79`).

### 3단계 — 타임라인 표시

**생김새는 공식 Claude iOS 앱의 Code 세션을 따른다**(2026-10-14 주군 지시, 참고 스크린샷 기준). 답변 사이의 도구 활동은
한 줄 요약으로 묶는다 — "명령어 1개 실행함, 파일 1개 읽음 >", "파일 2개를 편집함 **+3 −3** >"(초록·빨강 숫자 배지), 생각은 "🕘 사고 과정 >".
탭하면 펼치거나 상세 시트. 답변 밑에 복사 버튼. 입력창은 둥근 상자 하나 안에 글 입력, 아래 줄에 `+`(사진·카메라·파일)·모델명
알약(탭하면 모델·강도·권한 모드·실행 중 전송 방식)·마이크·전송/정지(실행 중 사각형). 색은 우리 테마 토큰.

- 도구는 접힌 한 줄 → 탭하면 **하단 시트**(60%/95%)로 상세 (paseo `components/tool-call-sheet.tsx`, `message.tsx:3106–3119`). 열린 시트는 실행 중 출력이 계속 갱신되게(Paseo는 안 됨 — 우리는 한다).
- 종류별 상세 (paseo `components/tool-call-details.tsx`): Bash `$ 명령` + 출력(가로·세로 스크롤), Edit diff 뷰어, Write 내용, Read 줄번호, 검색 결과(파일 목록·웹 제목+URL), Todo 목록, 계획 카드, 서브에이전트 활동 로그, 그 밖은 입력/출력 JSON, 오류 섹션.
- 생각(thinking) 표시, 기본 접힘 (paseo `agent-stream/view.tsx:1296–1325`).
- 글자 흐름을 부드럽게(약 150ms, 60Hz) (paseo `agent-stream/text-reveal.ts`).
- 스크롤: 바닥에 붙어 따라가다가 위로 올리면 떨어지고, 다시 바닥 근처면 붙음. "맨 아래로" 버튼 (paseo `agent-stream/bottom-anchor-controller.ts`).
- 가상화 목록, 기록 로컬 캐시 먼저 표시 후 커서로 따라잡기 (paseo `timeline/viewed-timeline-sync.ts`, `timeline-sync-plan.ts`).

### 4단계 — 세션 목록과 생성

- 상태별 묶음: **입력 필요 → 실패 → 검토 대기 → 작업 중 → 완료**, 묶음 안은 상태가 바뀐 시각 최신순 (paseo `utils/sidebar-agent-state.ts:31–42`, `hooks/sidebar-status-view-model.ts`). 폴더별 보기도.
- 주의(attention): 승인/실패/완료. 승인 주의는 읽었다고 지우지 않음. 수동 "안 읽음" (paseo `hooks/use-agent-attention-clear.ts`, `workspace/mark-unread.ts`).
- 보관·보관 해제 (paseo `components/archived-agent-callout.tsx`).
- 생성: 폴더(최근·탐색·새 폴더·GitHub clone), local / **새 worktree**(브랜치에서 갈라지기 / PR 체크아웃), 모델·모드·강도는 마지막 선택 기억 — 모델별 강도까지 (paseo `screens/new-workspace-screen.tsx`, `new-workspace-picker-item.ts:156–208`, `create-agent-preferences/`).
- 생성 중 다른 화면으로 가도 생성은 계속.
- 세션 화면 상단의 세션 제목(▾)을 누르면 세션 목록이 드롭다운으로 내려와 바로 다른 세션으로 전환한다 — 목록으로 돌아갈 필요 없음(2026-10-14 주군 지시, 2단계에서 구현).

### 5단계 — 호스트 신뢰성과 알림

- 실행은 폰 연결과 분리(이미 대체로 그렇다 — 확인). 폰이 끊겨도 턴은 계속, 승인은 다른 기기·재접속에서 응답 가능 (paseo `server/websocket-server.ts:2071–2099`).
- **메시지 접수증**: `(세션, 메시지ID)`로 디스크에 pending → completed. 같은 ID 재전송은 다시 실행하지 않고, pending 상태로 남아 있으면 "결과 불확실"을 보여 준다 (paseo `server/message-receipts/index.ts:25–55`).
- **생성 트랜잭션**: 멱등 키, 단계별 진행 저장, 재시작 후 미완 단계는 "결과 불확실"로 (paseo `server/creation/index.ts`).
- 세션별 작업 줄 세우기, 대화 기록 쓰는 프로세스 하나, 턴 ID로 늦게 온 이벤트 무시 (paseo `agent-manager.ts:1359–1368,2764–2774`).
- 권한 응답 동시성: 같은 요청에 두 번 답하면 한 번만 (paseo `agent-manager.ts:3085–3119`).
- 연결: 10초 ping, 끊김 판정, 지수 백오프(1.5초→30초), 앱이 앞으로 오면 즉시 재연결, 느린 기기의 송신 대기열 상한 (paseo `client/src/daemon-client.ts:1050–1058,6655–6711`).
- 알림: 승인 필요·완료 때, 그 세션을 최근 180초 안에 보고 있는 기기가 없을 때만. 탭하면 정확히 그 세션으로. 앱이 앞에 있으면 OS 배너 억제 (paseo `server/agent-attention-policy.ts`, `utils/notification-routing.ts`). 맥 세션 완료도 앱을 안 보고 있을 때 감지해서 보낸다(우리 공백). EAS project ID 설정.
- 알림 본문에 대화 내용을 넣을지는 따로 정한다(Paseo는 넣음 — 푸시는 E2E 밖이다).

## 하지 않는 것 (지금은)

- 여러 호스트 동시 연결 — 호스트가 하나라 보류.
- 터미널 탭 — Paseo에 있지만 Claude 세션 사용성과 별개라 보류.
- Codex·OpenCode 등 Paseo의 다른 에이전트 — 우리는 라우터가 모델을 고른다.

## 단계별 완료 기준

1. 폰에서 `auto`로 세션을 만들어 실제 작업 한 건을 승인 카드 없이 끝내고, 실행 중 `plan` ↔ `acceptEdits` 전환이 다음 도구 호출부터 먹는다. 맥 세션에서도 모드 전환이 된다(또는 안 되는 이유가 실측으로 확인된다).
2. 실행 중 끼워 넣기·큐·정지·첨부가 아이폰에서 동작.
3. Bash 출력·Edit diff를 폰에서 읽고 판단할 수 있다. 500턴 세션이 버벅이지 않는다.
4. 목록 맨 위에 "입력 필요"가 모이고, worktree 세션을 폰에서 만든다.
5. 호스트를 턴 도중 재시작해도 보낸 메시지가 두 번 실행되지 않고, 잃어버린 건 "결과 불확실"로 보인다. 앱을 안 보는 동안 완료 알림이 온다.
