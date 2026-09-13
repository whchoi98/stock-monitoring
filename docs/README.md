# Documentation / 문서 안내

Current implementation and verified deployment baseline: **2026-09-13**.
현행 구현과 배포 검증 기준일은 **2026-09-13**이다.

| Topic / 주제 | Document / 문서 |
| --- | --- |
| Application features, setup and commands / 기능·설치·명령 | [Project README](../README.md) |
| Development environment, tests and deployment / 개발 환경·검증·배포 | [Onboarding](onboarding.md) |
| Runtime layers and data flow / 실행 계층·데이터 흐름 | [Architecture](architecture.md) |
| Endpoints, payloads, caching and SSE / API·캐시·스트림 규약 | [API reference](api-reference.md) |
| Implementation details by layer / 계층별 구현 상세 | [Reference index](reference/INDEX.md) |
| Delivered quality changes and verification / 개선 내용·검증 결과 | [Quality upgrade](quality-upgrade-2026-09-13.md) |
| Router 7.18.3 production rollout / Router 7.18.3 운영 반영 | [Deployment record](deployments/2026-09-13-router7-quality-upgrade.md) |
| Missing quote data diagnosis / 시세 누락 진단 | [Quote cache runbook](runbooks/quotes-cache-poisoning.md) |

## Verified baseline / 검증 기준

- React 19, React Router **7.18.3**, strict TypeScript, Vite 8, Python 3.12 / FastAPI.
- **904 automated tests**: 437 backend, 452 frontend, 15 Chromium scenarios. Build, type checks and lint passed; npm audit reported zero findings.
- Existing AWS `StockMonitoringStack` in `ap-northeast-2`: task revision 13, one healthy application task. The deployment record captures the observed state and image identity, not a promise about all future runs.
- Markets, stock charts, article input, AI SSE, mobile layout and direct-ALB blocking were checked in production. Test fixtures and local logs are not application fallbacks.

React Router 7.18.3과 904개 자동 테스트를 기준으로 현행 문서를 작성했다. 운영 기록은 당시 확인한 상태이며 이후 상태는 운영 API와 AWS에서 다시 확인한다. 브라우저 회귀 테스트의 스냅샷·모의 응답은 실제 시세의 대체 데이터로 배포하지 않는다.

## Decisions and history / 결정과 설계 이력

- [ADR-001](decisions/ADR-001-terminal-design-language.md): terminal design language and Korean price colors / 터미널 디자인·한국 등락색.
- [ADR-002](decisions/ADR-002-pwa-app-shell.md): app-shell-only PWA caching and explicit updates / 앱 셸 캐시·명시적 업데이트.
- [ADR-003](decisions/ADR-003-market-workbench-and-recoverable-reads.md): market workbench, recoverable reads and mobile access / 시장 탐색·복구 상태·모바일 접근.
- [`superpowers/specs/`](superpowers/specs/) and [`superpowers/plans/`](superpowers/plans/) preserve dated requirements and implementation history. For current behavior use the active guides above; older plans can describe decisions subsequently superseded by ADR-003 and the deployment record.

과거 설계·계획의 당시 수치나 선택을 현재 상태로 덮어쓰지 않는다. 현행 동작은 상단 가이드와 코드, 변경 이유는 ADR, 실제 배포 결과는 `deployments/`에서 확인한다.
