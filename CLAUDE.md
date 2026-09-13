# Project Context

## Overview

**stock-monitoring** — Yahoo Finance 기반 실시간 주식 모니터링 대시보드 (시세·차트·재무지표·뉴스·AI 분석).
Real-time stock monitoring dashboard on Yahoo Finance data — quotes, charts, fundamentals, news, and AI analysis.

- 프로덕션 / Production: https://d2wa9w1vbqlndl.cloudfront.net (`ap-northeast-2`, `StockMonitoringStack`)
- 데이터 소스: Yahoo Finance (yfinance) — KRX Open API는 키 미승인으로 보류 / KRX Open API deferred (key not approved)
- AI 분석: Amazon Bedrock `global.anthropic.claude-sonnet-4-6`
- 설계 근거 / Design spec: `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`

## Tech Stack

### Backend (`backend/`)
- Python 3.12, FastAPI + uvicorn (**단일 워커 고정** — L1 캐시·AI 세마포어가 프로세스 단위 / single worker is load-bearing), pydantic v2
- yfinance (시세/재무), httpx (RSS/기사 조회), boto3 (DynamoDB·Bedrock), defusedxml (RSS 파싱 — 엔티티 확장 DoS 차단)
- 테스트 / Tests: pytest 437개 (`backend/tests/`)

### Frontend (`frontend/`)
- React 19 + TypeScript (strict) + Vite 8
- @tanstack/react-query (서버 상태·폴링), react-router-dom 7.18.3, lightweight-charts, react-markdown, @fontsource/pretendard
- 테스트 / Tests: vitest + @testing-library/react 452개 (colocated `.test.tsx`) · Playwright 브라우저 회귀 15개 · 린트 / Lint: oxlint
- UI: 터미널 디자인 언어 (ADR-001) — 패널 그리드 워크스페이스, 마켓 스트립, 워치리스트 레일, 앰버 액센트, JetBrains Mono 숫자 / Terminal design language: panel-grid workspace, market strip, watchlist rail, amber accent, mono numerals

### Infrastructure (`infra/`)
- AWS CDK v2 (Python), 단일 스택: CloudFront → ALB(CloudFront prefix-list SG) → ECS Fargate(ARM64) + DynamoDB(TTL 캐시)
- 기존 `cc-on-bedrock-vpc` 재활용 (lookup만 — 네트워크 리소스 생성 금지 / never create network resources)

## Project Structure

```
backend/              - Python 3.12 FastAPI (venv: backend/.venv)
  app/api/            - 라우트: ai, health, market, stocks + deps(캐시 키·심볼 검증), ratelimit
  app/services/       - bedrock_ai, charts, fundamentals, market_data, news, simulation, summary
  app/cache/          - memory(L1) / dynamo(L2) / tiered(오케스트레이션 + 키별 single-flight 락)
  app/core/           - config(심볼 유니버스·TTL·env), scheduler(선제 갱신 루프), market_hours
  app/models.py       - pydantic 모델 + envelope
  app/main.py         - 앱 팩토리, lifespan(L2 교체 + 스케줄러), SPA 정적 서빙
  tests/              - pytest
frontend/             - React 19 + TS + Vite 8
  src/api/            - client(fetch 래퍼·ApiError), queries(react-query 훅·폴링 상수·useSymbolUniverse), types
  src/components/     - common/(Panel·MarketStrip·SymbolSearch·StatusBar·UpdateToast·NewsList…) market/(MarketPulse·StockTable…) stock/(Watchlist·PriceChart·OrderBook·AIPanel…)
  src/pages/          - Dashboard(시장 워크스페이스), StockDetail(종목 워크스페이스), ArticleAnalysis
  src/lib/            - format, clock, search(+hangul 초성), markets(QuoteScope), scopedQuotes, newsFilter, localStore(+watchlist/alerts/panel 스토어 — 브라우저 전용), online(오프라인 배지), stickyOffsets(고정 블록 실측 높이 → 토스트 앵커), aiMessages, articleLink, sse
  public/icons/       - PWA 아이콘 — 192/512/maskable은 vite.config.ts의 VitePWA 매니페스트가, apple-touch는 index.html이 참조
  e2e/                - Playwright browser regressions (production build, offline API snapshots)
  src/styles/         - tokens.css(디자인 토큰 — 색상 하드코딩 금지), global.css, workspace.css
infra/                - CDK v2 Python (venv: infra/.venv, cdk.json app = .venv/bin/python3 app.py)
  stacks/stock_monitoring_stack.py - 단일 스택 전체 (캐시/시크릿/ECS/ALB/CloudFront/알람)
docs/reference/       - 계층별 구현 레퍼런스 (아래 Implementation References)
docs/superpowers/     - 승인된 설계 스펙 + backend/frontend/infra 구현 계획
docs/decisions/       - ADR (ADR-001 터미널 디자인 언어, ADR-002 PWA 앱 셸 서비스 워커)
docs/runbooks/        - 운영 런북 (quotes-cache-poisoning)
scripts/smoke.sh      - 배포 후 스모크 (CloudFront 경유 4종 + ALB 직접 차단 확인)
scripts/setup.sh      - 신규 개발자 원커맨드 셋업 (venv/npm ci/훅 설치 → make test)
.github/workflows/ci.yml - CI: 백엔드 pytest + 프론트 tsc·oxlint·vitest (Dockerfile은 tsc 생략 — 타입 검사는 CI 책임)
Dockerfile            - 멀티스테이지 (node:20-slim 프론트 빌드 → python:3.12-slim + static)
Makefile              - build(프론트→backend/static) / run(:8000) / test(백엔드+프론트)
```

## Key Commands

```bash
# 테스트 / Tests
cd backend && .venv/bin/pytest -q          # 백엔드 (437)
cd frontend && npx vitest run              # 프론트 (452)
make test                                  # 전체 (두 스위트 모두 실행 후 종합 판정)
# CI: .github/workflows/ci.yml — push/PR마다 위 두 스위트 + tsc -b + oxlint

# 로컬 실행 / Local run
make run                                   # 통합 빌드+실행 → http://localhost:8000
cd frontend && npm run dev                 # 프론트 dev 서버 (vite 프록시 /api → :8000)
cd frontend && npm run test:e2e            # production build + Chromium (port 4317, API fixtures)
cd frontend && npm run lint                # oxlint

# 배포 / Deploy (~4분)
cd infra && .venv/bin/cdk deploy --require-approval never

# 스모크 / Smoke (CDK Outputs의 CloudFrontURL, AlbDNS 사용)
bash scripts/smoke.sh https://d2wa9w1vbqlndl.cloudfront.net stock-monitoring-alb-1937169801.ap-northeast-2.elb.amazonaws.com
```

## Conventions

- **주석/문서**: 한국어+영어 병기 (기존 코드 스타일 유지 — 영문 주석 파일은 영문 유지)
  / Comments and docs are bilingual (Korean + English), following the surrounding style.
- **커밋**: Conventional Commits — 제목 영어, 본문 한/영 병기
  / Conventional Commits: English subject, bilingual body.
- **Contributors에 Claude/AI 절대 금지. `Co-Authored-By` 금지** (사용자 지시 — commit-msg 훅이 자동 제거)
  / Never add Claude/AI as a contributor or Co-Authored-By (explicit user directive; a commit-msg hook strips it).
- **Python**: 타입힌트 필수, async 우선. 동기 서비스(yfinance/boto3)는 반드시 `asyncio.to_thread`로 감싼다 (이벤트 루프 블로킹 금지).
- **TypeScript**: strict, 함수형 컴포넌트만. 라우트 테이블은 `main.tsx`에 (oxlint `react/only-export-components` — HMR 보존).
- **UI 등락 색 — 한국 관례**: 상승=빨강(`--up`) / 하락=파랑(`--down`) / 보합(정확히 0)=본문색. 액센트는 앰버(`--accent`), `--ok`(초록)는 장 상태 점 전용.
  색상 하드코딩 금지 — 항상 `frontend/src/styles/tokens.css` 변수 사용. 테마는 `<html data-theme="dark|light">`로만 전환.
  / Korean market convention: up=red, down=blue, flat=body color. Amber accent; green is state-only. Never hardcode colors; use the tokens.
- **위젯은 `Panel`(eyebrow 대문자 영문 + 한국어 제목 + 액션)로 감싼다** — 데이터 없는 가짜 패널 금지 (ADR-001).
  / Every widget sits in a `Panel`; never add a panel without real data behind it.
- **사용자 상태(관심 종목 ★·가격 알림·패널 접힘)는 브라우저 localStorage에만** — `frontend/src/lib/localStore.ts` 스토어를 거치고 백엔드는 모른다.
  / User state (watchlist, price alerts, collapsed panels) lives only in the browser via the localStore helpers; the backend never sees it.
- **조용한 실패 금지 / No silent failures**: 실패는 단일 라인 JSON 로그 + `source_status` degraded 반영.
- **오류 본문은 고정 문구만** (`ai_unavailable`, `ai_failed`, `article_unavailable`, `rate_limited` 등) — 예외 문자열/ARN/계정 정보는 서버 로그에만.
- **워커 1개 고정** (`--workers 1`, `desired_count=1`): L1 캐시와 AI 전역 세마포어가 프로세스 단위 — 스케일아웃 전 반드시 설계 재검토.
- **폴링은 상수만**: `QUOTE_POLL_MS`(45s), `NEWS_POLL_MS`(120s) — 수동 `setInterval` 금지.
- **PWA 서비스 워커는 앱 셸만 캐시한다 (ADR-002)**: `/api/*`에 워커 라우트를 두지 않는다(백엔드 캐시·비용 방어 바깥의 두 번째 진실 금지), 업데이트는 `prompt` 방식(사용자가 "새로 고침"을 눌러야 적용).
  / The service worker caches the app shell only — never `/api/*`; updates are prompt-mode.
- 시뮬레이션 데이터(호가/수급)는 응답에 반드시 `"simulated": true`.

---

## Auto-Sync Rules

Rules below are applied automatically after Plan mode exit and on major code changes.
아래 규칙은 Plan 모드 종료 후와 주요 코드 변경 시 자동 적용된다.

### Post-Plan Mode Actions
After exiting Plan mode (`/plan`), before starting implementation:

1. **아키텍처 결정 / Architecture decision made** → 해당 계층의 `docs/reference/{layer}.md` 갱신
2. **기술 선택·트레이드오프 / Technical choice or trade-off made** → `docs/decisions/ADR-NNN-title.md` 생성
3. **새 모듈 추가 / New module added** → 그 모듈 디렉터리에 `CLAUDE.md` 생성
4. **운영 절차 정의 / Operational procedure defined** → `docs/runbooks/`에 런북 생성
5. **이 파일에 영향 / Changes needed in this file** → 위 관련 섹션 갱신

### Code Change Sync Rules
- `backend/app/api/` 라우트 추가/변경 → `docs/reference/api.md` 갱신
- `backend/app/cache/`·캐시 키·TTL(`config.py`) 변경 → `docs/reference/data.md` 갱신
- `backend/app/services/bedrock_ai.py`·`backend/app/api/ai.py` (모델/프롬프트/레이트리밋) 변경 → `docs/reference/agent-llm.md` 갱신
- `backend/app/services/news.py` 가드(SSRF/크기 상한/태그 regex 선형성)·오리진 검증·레이트리밋 키 변경 → `docs/reference/security.md` 갱신
- `infra/stacks/` 변경 → `docs/reference/iac.md` + `docs/reference/infrastructure.md` 갱신
- `Dockerfile`·`scripts/smoke.sh` 변경 → `docs/reference/infrastructure.md` 갱신
- `frontend/src/api/`·라우트 구조 변경 → `docs/reference/frontend.md` 갱신
- `frontend/src/styles/tokens.css`·테마·등락 색 변경 → `docs/reference/ui.md` 갱신
- `docs/reference/` 문서 추가/삭제 → 아래 Implementation References 블록과 `docs/reference/INDEX.md` 재생성

### ADR Numbering
Find the highest number in `docs/decisions/ADR-*.md` and increment by 1.
Format: `ADR-NNN-concise-title.md`

---

## Implementation References

계층별 구현 상세 문서. 코드 수정 전 해당 계층 문서를 먼저 읽는다.
Per-layer implementation details; read the matching doc before touching a layer.

문서 시작점 / Documentation entry: [docs/README.md](docs/README.md).
검증·운영 반영 / Verified deployment: [2026-09-13 deployment record](docs/deployments/2026-09-13-router7-quality-upgrade.md) — Router 7.18.3, 904 tests, npm audit 0 findings, task revision 13.

<!-- AUTO-MANAGED:references -->
- [Infrastructure / 인프라](docs/reference/infrastructure.md) — CloudFront → ALB → Fargate(ARM64) 런타임 토폴로지, Dockerfile, 알람, 스모크
- [Data / 데이터](docs/reference/data.md) — L1(메모리)+L2(DynamoDB) 계층 캐시, single-flight 락, TTL 표, 가격 오버레이
- [API](docs/reference/api.md) — FastAPI 라우트, envelope 규약, 심볼 유니버스, 오류 문구, SPA 서빙
- [IaC](docs/reference/iac.md) — CDK 단일 스택, VPC lookup 고정, 오리진 시크릿, origin request policy
- [Frontend](docs/reference/frontend.md) — React SPA 구조, 쿼리 훅·폴링, AI 스트리밍·자유 질의, 한글·초성 검색, 브라우저 전용 사용자 상태 스토어, PWA(앱 셸 워커·prompt 업데이트), ApiError 분기, 빌드 경로
- [UI](docs/reference/ui.md) — 터미널 디자인 언어(ADR-001), 디자인 토큰, 다크/라이트 테마, 상승=빨강/하락=파랑 규칙, 앰버 액센트
- [Security / 보안](docs/reference/security.md) — 오리진 검증, AI 레이트리밋 키, SSRF 가드, 태그 regex 선형성 가드
- [Agent · LLM](docs/reference/agent-llm.md) — Bedrock 모델 선택 근거, 3중 비용 방어, AI 캐시 키, 프롬프트 입력
<!-- /AUTO-MANAGED:references -->
