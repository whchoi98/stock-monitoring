# ADR-003: Market workbench and recoverable reads

- Date / 날짜: 2026-09-13
- Status / 상태: Implemented and deployed / 구현·운영 반영
- Scope / 범위: Frontend workflow and read-path reliability; existing infrastructure retained.

## Context / 배경

The terminal already had substantial charting and AI functionality, but mobile users reached market selection only after secondary panels. Quotes could only be sorted, transient HTTP failures hid useful cached data, and the watch scope refreshed US quotes without a corresponding KR poll. The overview's advancing/declining counts also omitted unchanged quotes.

기존 터미널은 차트와 AI 기능을 갖췄지만 모바일 시장 선택이 늦게 나타났고, 시세 탐색은 정렬에 제한되어 있었다. 일시적 조회 실패가 기존 데이터를 가렸으며 관심 목록의 한국 시세에는 주기적 갱신이 없었다. 시장 개요의 상승/하락 집계만으로는 보합을 포함한 전체 추적 종목 수를 알 수 없었다.

## Decision / 결정

1. Keep React/FastAPI, TanStack Query keys, backend caching, SSE cost controls, and ADR-001/002.
2. Put market/watch selection in the URL (`market=us|kr`, `watch=1`) and expose it above the workspace. Keep query filters local and remember density through the existing browser store.
3. Derive breadth and sign-correct leaders from the same quotes displayed by the table. Label the tracked universe explicitly; this is not an exchange-wide breadth statistic.
4. Use one filtered/sorted row list for display and CSV export. Keep missing values last regardless of sort direction; preserve currencies and raw values in CSV, escaping spreadsheet-sensitive text.
5. Distinguish initial failure, pending requests, empty results, and retained data plus a refresh error. Only the last case uses `DataNotice`.
6. Poll both shared quote keys for watch mode and pass query cancellation into bounded GET requests. Keep search observers passive.
7. Preserve every quote column on mobile through a full-column toggle; contain wide tables and wrap chart controls inside their panels.
8. Test the production build in Chromium with deterministic snapshots. Use a dedicated port and reject server reuse so another project's preview can never satisfy the readiness check.

기술 스택·캐시·SSE·PWA 구조를 유지하면서 시장 선택을 URL로 보존한다. 시장 요약은 시세 표와 같은 데이터로 계산하고, 표시 행과 CSV 행을 일치시킨다. 초기 오류·대기·빈 결과·갱신 실패를 구분하며 관심 목록은 양쪽 시장을 갱신한다. 모바일에서도 전체 열과 모든 지표 버튼에 접근할 수 있어야 한다. 브라우저 검증은 전용 서버에서 프로덕션 빌드를 대상으로 한다.

## Consequences / 결과

- No new backend endpoint, database or external service is required.
- A failed refresh does not erase data; timestamps and retry controls remain visible.
- KST timestamps are consistent across the strip, news and footer. Fundamentals and period returns prioritize their own `last_updated`, not the price overlay's time.
- HTTP timeout/cancellation and partial-market behaviors have direct regression coverage.
- View filters reset when the scope changes; density and existing watch/alert/panel preferences remain browser-local.
- Cross-currency monetary sorting is nominal in the displayed currencies; no FX conversion or portfolio valuation is implied.
- Market snapshots and synthetic AI outputs are test fixtures only and never application fallbacks.

새 API·데이터베이스·외부 서비스를 추가하지 않는다. 실패 시 남은 데이터와 기준 시각을 유지하고 재시도를 제공한다. 표시 시각은 KST로 통일하며 재무·기간수익률은 자체 갱신 시각을 우선한다. 필터는 스코프 전환 시 초기화하고 밀도와 관심·알림·접힘 설정은 브라우저에만 저장한다. 통화가 섞인 금액 정렬은 표시 통화의 숫자 기준이며 환산 가치나 포트폴리오 평가를 뜻하지 않는다.

## Deployment follow-up / 운영 반영

The user approved React Router 7.18.3 and deployment to the existing stack. All 904 automated tests, npm audit (zero findings), and live API/UI/SSE checks passed. The current verified rollout is recorded in [the deployment report](../deployments/2026-09-13-router7-quality-upgrade.md). The initial local implementation scope was extended by that explicit approval.

사용자 명시 승인으로 Router 7.18.3 전환과 기존 스택 배포를 수행했다. 904개 자동 테스트·npm audit 0건·실제 API·화면·SSE 검증을 통과했다. 처음의 로컬 구현 범위 이후 승인된 운영 반영이며 상세 상태는 배포 기록에 남겼다.

## Related / 관련

- [Quality upgrade design](../superpowers/specs/2026-09-13-quality-upgrade-design.md)
- [Frontend reference](../reference/frontend.md)
- [UI reference](../reference/ui.md)
- [ADR-001](ADR-001-terminal-design-language.md)
- [ADR-002](ADR-002-pwa-app-shell.md)
