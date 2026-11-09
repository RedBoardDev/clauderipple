# 휴대전화에서 데스크톱 세션 제어

기준일: 2026-10-23. 읽기 전용 설계이며 구현·실기기 검증은 하지 않았다. 호스트 수정 `b35d1f7`을 반영했다. 아래 필드와 동작 중 ‘제안’은 신규 계약이며, 현재 지원 사실과 구분한다.

## 공통 전송과 결과 확인

기존 인증·릴레이 E2EE·단일 소켓을 재사용한다. Remote Control 입력은 `POST /v1/code/sessions/<bridgeSessionId>/events`, 본문은 `{"session_id":"<bridgeSessionId>","events":[{"payload":<메시지>}]}`다. `/worker/events`는 CLI 출력 업로드 경로이지 휴대전화의 명령 전송 경로가 아니다. 근거: `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/bridge-client.ts:152–188`, CLI 문자열 `postWorkerEvents`, `worker_epoch`.

설정 요청 메시지는 `{"type":"control_request","request_id":"<UUID>","request":<요청>}`. 호스트가 제한된 요청만 구성하며, 휴대전화에 임의 제어 payload API를 주지 않는다. HTTP 성공과 적용 성공을 구분한다. `response.request_id`가 일치하는 **worker의** `control_response` success/error로 완료하고, 다른 클라이언트의 승인 답변과 구별한다.

제안 계약은 `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/protocol.ts`에만 정의한다.

- `HostInfo.capabilities?: {sessionFiles:boolean}`.
- `SessionSummary.controls?: {model:boolean,effort:boolean,permissionModes:PermissionMode[]}`. 연결·버전·정책에 따라 제공하고 필드 부재는 비활성화한다. 실제 CLI 거절은 여전히 최종 판정이다.
- 기존 `set_model`, `set_mode`, `decide`와 `reqId`를 재사용한다(`protocol.ts:254–258`). 설정 명령의 성공 `res.data`는 `{status:"applied"|"partial"|"unknown",model?,effort?,permissionMode?,errors?:{model?:string,effort?:string,permissionMode?:string}}`; 거절은 기존 `ok:false,error`를 유지한다.
- 제안 `EventBody` 설정 결과: `{kind:"settings",reqId,status,model?,effort?,permissionMode?,errors?}`. 재연결에도 결과를 복구한다. 세션별 직렬화·동일 `reqId` 중복 방지와 영속 작업 기록을 두고, 호스트 재시작 뒤 미확정 write를 자동 재전송하지 않는다.

`BridgeClient`에 제어 응답 대기·재연결 조회를 통합하고 `sessions.ts:1402–1433`의 ‘모든 control_response는 승인 종료’ 처리를 분리한다. 앱의 15초 제한은 실패 확정이 아니라 ‘결과 미확인’이다. 늦은 응답도 수용하며 CLI의 `verdict_pending`은 적용 완료로 취급하지 않는다.

## 1. 전달받은 파일 열기

**가능. 현재는 이미지에 한정된다.** `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/images.ts:149–176`은 `SendUserFile.input.files`에서 PNG/JPEG/GIF/WebP만 읽으며, 절대경로의 세션 경계를 검사하지 않는다. 이 허용 범위를 일반 파일로 확대해서는 안 된다.

**호스트 경계.** 세션 자신의 SendUserFile 또는 검증된 첨부가 지목한 파일만 허용한다. 신뢰할 수 있는 세션 메타데이터에서 얻은 cwd·추가 작업 폴더·정확한 세션 scratchpad 아래여야 한다. 도구 입력이나 휴대전화가 허용 루트를 추가할 수 없다. scratchpad 출처를 확인하지 못하면 제공을 거절한다. CLI `scratchpad_dir` 문자열만으로 원격 세션 경로를 안다고 간주하지 않는다. 전체 `/tmp`·사용자 홈·`~/.claude` 허용은 금지한다.

경로 정규화 및 lexical/realpath containment, symlink 거부, 일반 파일·열린 핸들 identity 검증, 부모 경로 교체 경합 검사를 공통 경계에서 수행한다. 안전한 접근을 보장하지 못하면 거절한다. 파일당 8MiB, 호출당 8개·합계 32MiB를 제안한다. 명시적 전달도 키·토큰 등 비밀 파일 제공을 허용하지 않는다. MIME은 확장자만 믿지 않는다. 검증된 bytes를 한 번 snapshot하고 이후 원본 경로를 다시 읽지 않는다.

**프로토콜.** `ToolCall.files?: SessionFile[]`와 사용자 첨부 표시용 `EventBody.files?: SessionFile[]`를 추가한다. `SessionFile={id,name,mediaType,bytes,status:"ready"|"blocked"|"missing"|"too_large",blob?:string}`. 경로는 보내지 않는다. `ready`의 blob은 해당 세션·epoch의 전달 목록에 귀속시키고, 기존 `op:"blob",session,id,offset`과 base64 청크를 재사용한다. 다른 세션의 blob·임의 파일 경로 요청은 거부한다. 이름 길이와 목록 크기도 제한한다.

**수정 지점.** `images.ts`의 이미지 전용 수집을 일반 파일 수집 경계로 통합한다. `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/desktop.ts:176–258`의 `transcriptEvents`, `sessions.ts:1899,2010`의 SDK 본문·워커 처리에 동일 경계를 적용한다. `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/eventlog.ts:253–273`의 blob 저장과 `server.ts:508–515`의 조회를 확장한다. `rebaseDesktop`이 로그를 재구축할 때 snapshot을 보존하거나 새 epoch로 다시 발급하고, 폐기한 참조는 명확히 만료시킨다.

**앱.** `/Users/pbj/Documents/ClaudeRipple/apps/ripple-remote/src/tool-sheet.tsx:86–185`에 파일 카드를 넣고 공유 타임라인 reducer에도 필드를 보존한다. HTML은 별도 비신뢰 WebView로 연다. JavaScript·네이티브 메시지 bridge·외부 요청·팝업·폼·로컬 파일 접근을 차단한다. CSP는 `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'`를 기본으로 한다. 플랫폼별 네트워크 차단까지 검증하며, 기존 위젯 WebView의 권한을 재사용하지 않는다. 상대 리소스 자동 읽기는 금지한다.

Markdown은 기존 `Markdown` 렌더러를 쓰되 외부 이미지 차단·링크 확인을 적용한다. 텍스트는 선택 가능하게, 이미지는 기존 뷰어로 표시한다. PDF는 앱 전용 캐시에 내려받아 iOS Quick Look/Android 시스템 PDF 뷰어로 연다. 나머지는 시스템 공유/열기다. 현재 `package.json:12–46`에 PDF·공유 모듈이 없으므로 Expo 호환 네이티브 연동과 새 빌드가 필요하다. 캐시는 세션·파일 ID 기반으로 분리하고 공유 완료·만료 시 정리한다.

문구: ‘파일 열기’, ‘다른 앱으로 열기’, ‘이 파일은 허용된 세션 폴더 밖에 있어 열 수 없습니다’, ‘8MiB를 초과한 파일은 열 수 없습니다’. **기기 확인:** iOS/Android 각 형식, 한글 파일명, 잠금·재연결·중간 다운로드 복구, 공유 후 복귀. **위험:** 악성 HTML/PDF, base64 메모리 증가, 삭제·변경·symlink 경합. 경계 실패가 대화 이벤트 전체 누락으로 이어지면 안 된다.

## 2. 모델과 추론 강도 변경

**CLI 제어는 조건부 가능. 데스크톱 선택 메뉴의 즉시 반영은 미확인이다.** 설치 CLI 2.1.308의 문자열과 handler에서 다음 요청을 확인했다.

- 모델: `{"subtype":"set_model","model":"<모델 ID>"}`. 이후 대화 턴에 적용된다. Remote Control에서는 `only_if_model_is_current`를 사용하지 않는다.
- Claude 추론 강도: `{"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}`. `null`은 기본값 복원이다. `set_max_thinking_tokens`는 thinking 토큰 예산이며 강도 설정의 대체물이 아니다.

CLI 근거 문자열: `set_model: Remote Control does not implement only_if_model_is_current`, `only effortLevel and ultracode can`, `CLAUDE_CODE_EFFORT_LEVEL`. 기능 gate·환경변수 override·모델별 지원 수준으로 거절될 수 있다. 설치 데스크톱 `/Applications/Claude.app/Contents/Resources/app.asar`의 `.vite/build/index.chunk-DNPOm2Zc.js`도 `query.applyFlagSettings({effortLevel:i})`를 사용한다.

**호스트.** `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/sessions.ts:1725–1745`의 데스크톱 거절을 bridge 제어로 교체한다. Claude는 모델 성공 후 강도를 요청하고 두 결과를 별도로 기록한다. 실패 시 모델까지 성공했음을 숨기거나 무조건 rollback하지 않는다. 번역 프로바이더는 기존 `modelArg`의 `model@effort`를 단일 출처로 쓰며, CLI가 해당 ID를 수용하는지는 추가 검증이 필요하다. 이를 Claude `effortLevel`과 중복 적용하지 않는다. 호스트 SDK도 Claude 모델+강도를 함께 바꿀 때 강도를 실제 query에 반영하거나 안전하게 다음 턴 재시작하도록 보완한다. 현재는 모델이 같을 때만 `restartAfterTurn`을 설정한다.

`refreshBridgeMeta`의 최신 transcript 모델 반영(`sessions.ts:1337–1355`, b35d1f7)을 보존한다. 과거 assistant 모델·강도와 ‘다음 턴 설정’을 분리해 오래된 transcript가 확인된 설정을 덮어쓰지 않게 한다.

**앱.** `/Users/pbj/Documents/ClaudeRipple/apps/ripple-remote/src/composer.tsx:572–588,716–760`의 일괄 desktop 비활성화를 `controls` 기준으로 교체한다. `/Users/pbj/Documents/ClaudeRipple/apps/ripple-remote/app/session/[id].tsx:177–179`도 다음 턴 설정을 우선한다. 문구: ‘모델과 추론 강도’, ‘다음 대화부터 적용됩니다’, ‘모델은 변경됐지만 추론 강도는 변경하지 못했습니다’, ‘변경 결과를 아직 확인하지 못했습니다’.

**기기 확인:** 유휴·실행 중 변경, 다음 실제 요청의 모델·강도, 두 번째 요청만 실패, 늦은 응답·재연결, 데스크톱 메뉴·휴대전화 표시 일치. **위험:** 검증 hook 지연, 외부 클라이언트 동시 변경, 라우터 자동 강도 정책의 override. CLI 상태 변경과 데스크톱 메뉴 갱신은 별개이며 후자는 보장하지 않는다.

## 3. 권한 모드와 ‘항상 허용’

**조건부 가능.** 모드는 `{"subtype":"set_permission_mode","mode":"acceptEdits"}`를 공통 제어 envelope로 보낸다. CLI는 `bypass_restricted`, `bypass_disabled`, `bypass_not_launched`와 auto 제한을 검사한다. 우회 모드를 강제로 열기 위한 재시작·spawn flag 변경은 금지한다. `sessions.ts:1701–1722`를 확장하되 `scheduleModeChange`와 계획 승인 취소 시 rollback 직렬화를 보존한다. transcript의 지난 user permissionMode가 새 확인값을 덮어쓰지 않게 한다.

**항상 허용 메시지.** 기존 승인 응답은 `{"type":"control_response","uuid":"<UUID>","response":{"subtype":"success","request_id":"<승인 요청 ID>","response":{"behavior":"allow","updatedInput":<원래 입력>,"toolUseID":"<도구 호출 ID>","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"<도구>","ruleContent":"<CLI가 제시한 조건>"}],"behavior":"allow","destination":"session"}]}}}`다.

CLI 문자열 `permission_suggestions`, `updatedPermissions`, `suppressAlwaysAllowRule` 및 승인 handler의 필터·적용 경로를 확인했다. `/Users/pbj/Documents/ClaudeRipple/packages/remote/src/bridge-client.ts:228–259`의 재조회와 `sessions.ts:1402–1497`의 실시간 경로 모두 suggestions·suppression 메타데이터를 보존한다. `decideBridge:1608–1632`의 일괄 거절을 대체하되 휴대전화는 기존 `decision:"allow_always"`만 보낸다. 호스트가 검증된 제안을 세션 범위로 제한한다. 규칙 조건을 제거하거나 도구 전체 허용 규칙을 임의 생성하지 않는다. 안전한 제안이 없거나 suppression 여부를 판단할 수 없으면 버튼을 숨긴다. 계획 승인·질문에는 노출하지 않는다.

**데스크톱 저장 의미.** 위 asar 멤버의 `recordSessionPermissionUpdates`는 `destination:"session"`인 규칙을 `sessionPermissionUpdates`에 누적하고 `saveSession`을 호출한다. telemetry의 `always_scope`는 `session` 또는 SSH 예외의 `ssh_host`다. 따라서 일반 카드의 ‘항상 허용’을 사용자 전역 설정 파일 저장이라고 설명하면 틀린다. 정확한 디스크 저장 위치와 원격으로 추가한 규칙을 데스크톱이 재시작 후 복구하는지는 미확인이다.

**프로토콜·앱.** permission event에 `alwaysAllow?:{scope:"session",summary:string}`를 추가하고 기존 `canAlways`와 일치시킨다. 원시 규칙은 보내지 않는다. `permission_decided`에 `ruleStatus?:"sent"|"confirmed"|"unknown"`을 추가한다. CLI가 규칙을 걸러낼 수 있으므로 POST 성공으로 영구 적용을 확정하지 않는다. `/Users/pbj/Documents/ClaudeRipple/apps/ripple-remote/src/timeline.tsx:285–359,449–461`에 범위와 확인 상태를 표시하고 composer의 기존 `ModeList`를 재사용한다. SDK 경로도 제안된 저장 범위를 표시하며 확인되지 않은 영속 허용으로 확대하지 않는다.

문구: ‘권한 모드’, ‘이 세션에서 항상 허용’, ‘허용할 범위를 확인해 주세요’, ‘허용 규칙을 보냈습니다. 적용 여부는 아직 확인되지 않았습니다’. 우회 모드는 ‘도구 실행 전 승인을 요청하지 않습니다. 위험을 확인한 경우에만 변경해 주세요’로 재확인한다.

**기기 확인:** 반복 도구 호출의 실제 무승인 실행, 조건 밖 호출의 재승인, 다른 세션 격리, suppression·우회 제한, 데스크톱과 동시 승인, 재연결 중 중복 답변, 계획 취소 경합, 호스트·데스크톱 재시작 후 범위. **위험:** 무응답의 재전송으로 권한이 중복·확대되는 문제. 기존 요청 ID에 귀속하고 만료된 카드는 재사용하지 않는다.

## 구현 완료 판정

호스트·앱 단위/통합 테스트와 위 실기기 항목을 별도로 통과해야 한다. 특히 파일 경계 우회, 설정 부분 성공, 승인 동시성, 재연결 중 요청 유실을 행동으로 검증한다. 이번 조사에서는 소스 수정·서비스 실행·실기기 조작을 하지 않았으며, 금지된 운영 경로에 접근하지 않았다.

적용 규율: 설계(a) + 정적 검토(c).
