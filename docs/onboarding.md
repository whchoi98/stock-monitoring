# Developer Onboarding

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#한국어"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="한국어"></a>

---

<a id="english"></a>

# English

## Quick Start

### 1. Prerequisites

- [ ] **Python 3.12** installed (backend and infra venvs; the production image is `python:3.12-slim`)
- [ ] **Node.js 20+** installed (frontend; the image build stage uses `node:20-slim`)
- [ ] **Docker** running — required only for `cdk deploy` (the stack builds a **linux/arm64** image; on an x86 host you need QEMU/binfmt for arm64)
- [ ] **AWS CLI** configured with credentials for **ap-northeast-2** (deploy, DynamoDB L2, Bedrock AI)
- [ ] **CDK bootstrap already done** in the target account/region (it is for the production account — do not re-bootstrap unless targeting a new account)
- [ ] Repository access granted

### 2. Setup

All commands run from the repository root.

```bash
# Backend: venv + dependencies (runtime + dev/test)
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cd ..

# Frontend: exact lockfile install
cd frontend
npm ci
cd ..

# Infra (only needed for deploys): venv includes a pinned CDK CLI —
# use infra/.venv/bin/cdk, NOT a globally installed cdk (schema mismatch)
cd infra
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

### 3. Verify

```bash
# Full test suite: backend pytest + frontend vitest (519 tests, all green)
make test
```

Individually:

```bash
cd backend && .venv/bin/pytest -q        # backend (343 tests)
cd frontend && npx vitest run            # frontend (176 tests)
cd frontend && npm run lint              # oxlint
```

### 4. Run Locally

```bash
# Builds the frontend into backend/static, then serves everything on :8000
make run
# → http://localhost:8000  (SPA + API from one process)
```

For frontend-only iteration with hot reload:

```bash
cd frontend && npm run dev               # Vite dev server
```

Local behavior notes:

- **No DynamoDB needed locally.** On startup the app probes the cache table; if unreachable it logs `l2_unavailable` and continues with the in-memory L1 only. That warning is normal in local development.
- **AI endpoints need AWS credentials** with `bedrock:InvokeModel` (model `global.anthropic.claude-sonnet-4-6`, region ap-northeast-2). Without them, `POST /api/ai/*` returns 503 `ai_unavailable` — everything else still works.
- Run uvicorn with **exactly one worker** (the default). The L1 cache and the AI concurrency semaphore are per-process.
- Environment variables (all optional locally): `CACHE_TABLE`, `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `STATIC_DIR` — see `backend/app/core/config.py` for defaults.

## Deploy + Smoke

```bash
# 1) Deploy (~4 minutes; Docker builds the arm64 image)
cd infra && .venv/bin/cdk deploy --require-approval never

# 2) Smoke test with the two stack outputs (CloudFrontURL, AlbDNS)
cd ..
bash scripts/smoke.sh \
  https://d2wa9w1vbqlndl.cloudfront.net \
  stock-monitoring-alb-1937169801.ap-northeast-2.elb.amazonaws.com
```

The smoke script asserts five things: (1) `/api/health` answers, (2) `/api/market/overview` returns a valid envelope, (3) `/api/market/quotes?market=us` returns a **non-empty** data array (the 2026-08-04 blank-table incident answered 200 with `[]`), (4) the SPA fallback serves deep links (`/stocks/005930.KS` → 200), and (5) **direct ALB access is blocked** (403 or timeout — both are a pass). Dedicated deploy and rollback runbooks are **not written yet**: `docs/runbooks/` currently holds [quotes-cache-poisoning.md](runbooks/quotes-cache-poisoning.md) plus the runbook template, so the commands above are the deploy procedure.

## Project Overview

- Read `CLAUDE.md` for project context and conventions
- Read [docs/architecture.md](architecture.md) for system design (layers, diagrams, design decisions)
- Read [docs/api-reference.md](api-reference.md) for every endpoint, cache TTLs and rate limits
- Review [docs/decisions/](decisions/) for architecture decision records
- The approved design spec lives at `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`

## Development Workflow

- Branch naming: `feat/`, `fix/`, `docs/`, `refactor/`
- Commit convention: **Conventional Commits** — English subject, Korean/English bilingual body
- **Never add Claude/AI as a contributor or `Co-Authored-By`** (a commit-msg hook strips it, but do not write it in the first place)
- Python: type hints, async-first (sync yfinance/boto3 calls go through `asyncio.to_thread`)
- TypeScript: strict mode, functional components
- Comments/docs: bilingual Korean + English, following the surrounding style

## Key Concepts

- **Envelope**: every data endpoint returns `{"asOf": <ISO8601>, "marketOpen": <bool>, "data": ...}`.
- **Symbol universe**: only US 50 + KR 50 symbols are accepted (`AAPL`, `005930.KS`, `247540.KQ`); anything else is 404. This keeps cache key/lock maps finite.
- **Tiered cache**: L1 (in-process) → L2 (DynamoDB, TTL) → fetch, with a per-key single-flight lock.
- **Price overlay**: detail responses merge slow fundamentals (12 h cache) with the live quote (45 s scheduler refresh) at request time.
- **Scheduler = freshness**: the pre-warmed keys carry a 24 h TTL; actual freshness comes from the background loops (45 s/600 s market, 120 s/600 s news).
- **Simulated data**: order book and investor flows are simulations and always carry `"simulated": true`.

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `l2_unavailable` warning at startup | No DynamoDB access — normal locally; the app runs on L1 only |
| `POST /api/ai/*` → 503 `ai_unavailable` | No AWS credentials or no Bedrock model access in ap-northeast-2 |
| `cdk deploy` fails with a cloud-assembly schema error | You used a global `cdk` CLI; use `infra/.venv/bin/cdk` (pinned ≥ 2.1134) |
| `cdk deploy` fails building the image | Docker not running, or an x86 host without arm64 emulation (QEMU/binfmt) |
| Port 8000 already in use | Stop the other process or run uvicorn with `--port <other>` |
| Direct ALB URL returns 403 / times out | Expected — the ALB only accepts CloudFront traffic with `X-Origin-Verify` |
| 429 `rate_limited` on AI endpoints | By design: 3 requests/min/IP; wait `retryAfter` seconds |

## Resources

- [docs/architecture.md](architecture.md) — system design
- [docs/api-reference.md](api-reference.md) — API reference
- [docs/runbooks/](runbooks/) — operational runbooks
- [docs/decisions/](decisions/) — ADRs
- Production: https://d2wa9w1vbqlndl.cloudfront.net

---

<a id="한국어"></a>

# 한국어

## 빠른 시작

### 1. 사전 요구 사항

- [ ] **Python 3.12** 설치 (backend/infra venv; 프로덕션 이미지는 `python:3.12-slim`)
- [ ] **Node.js 20+** 설치 (frontend; 이미지 빌드 스테이지는 `node:20-slim`)
- [ ] **Docker** 실행 중 — `cdk deploy`에만 필요 (스택이 **linux/arm64** 이미지를 빌드한다; x86 호스트에서는 arm64용 QEMU/binfmt 필요)
- [ ] **AWS CLI** + **ap-northeast-2** 자격 증명 구성 (배포, DynamoDB L2, Bedrock AI)
- [ ] 대상 계정/리전에 **CDK bootstrap 완료** (프로덕션 계정에는 이미 되어 있다 — 새 계정 대상이 아니면 다시 하지 않는다)
- [ ] 리포지토리 접근 권한

### 2. 설정

모든 명령은 리포지토리 루트 기준이다.

```bash
# 백엔드: venv + 의존성 (런타임 + dev/테스트)
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
cd ..

# 프론트엔드: lockfile 그대로 설치
cd frontend
npm ci
cd ..

# 인프라 (배포할 때만 필요): venv에 CDK CLI가 고정 포함된다 —
# 전역 설치된 cdk가 아니라 infra/.venv/bin/cdk를 쓴다 (스키마 불일치)
cd infra
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

### 3. 검증

```bash
# 전체 테스트: 백엔드 pytest + 프론트엔드 vitest (519개, 전부 그린)
make test
```

개별 실행:

```bash
cd backend && .venv/bin/pytest -q        # 백엔드 (343개)
cd frontend && npx vitest run            # 프론트엔드 (176개)
cd frontend && npm run lint              # oxlint
```

### 4. 로컬 실행

```bash
# 프론트엔드를 backend/static으로 빌드한 뒤 :8000에서 통합 서빙
make run
# → http://localhost:8000  (SPA + API 단일 프로세스)
```

프론트엔드만 핫 리로드로 반복 작업할 때:

```bash
cd frontend && npm run dev               # Vite dev 서버
```

로컬 동작 참고:

- **로컬에서는 DynamoDB가 필요 없다.** 기동 시 캐시 테이블에 프로브를 보내고, 접근 불가면 `l2_unavailable` 경고 후 인메모리 L1만으로 계속 동작한다. 이 경고는 로컬 개발에서 정상이다.
- **AI 엔드포인트는 AWS 자격 증명이 필요하다** — `bedrock:InvokeModel` (모델 `global.anthropic.claude-sonnet-4-6`, 리전 ap-northeast-2). 없으면 `POST /api/ai/*`가 503 `ai_unavailable`을 반환하며, 나머지는 모두 동작한다.
- uvicorn 워커는 **정확히 1개**(기본값)로 실행한다. L1 캐시와 AI 동시 실행 세마포어가 프로세스 단위다.
- 환경변수(로컬에서는 전부 선택): `CACHE_TABLE`, `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `STATIC_DIR` — 기본값은 `backend/app/core/config.py` 참조.

## 배포 + 스모크

```bash
# 1) 배포 (~4분; Docker가 arm64 이미지를 빌드한다)
cd infra && .venv/bin/cdk deploy --require-approval never

# 2) 스택 출력 2개(CloudFrontURL, AlbDNS)로 스모크 테스트
cd ..
bash scripts/smoke.sh \
  https://d2wa9w1vbqlndl.cloudfront.net \
  stock-monitoring-alb-1937169801.ap-northeast-2.elb.amazonaws.com
```

스모크 스크립트는 5가지를 검증한다: (1) `/api/health` 응답, (2) `/api/market/overview`의 유효한 envelope, (3) `/api/market/quotes?market=us`의 **비어 있지 않은** data 배열(2026-08-04 빈 테이블 장애는 200 + `[]`로 응답했다), (4) SPA fallback의 딥링크 서빙(`/stocks/005930.KS` → 200), (5) **ALB 직접 접근 차단**(403 또는 타임아웃 — 둘 다 통과). 전용 배포/롤백 런북은 **아직 없다**: `docs/runbooks/`에는 현재 [quotes-cache-poisoning.md](runbooks/quotes-cache-poisoning.md)와 런북 템플릿만 있으므로, 위 명령이 곧 배포 절차다.

## 프로젝트 개요

- 프로젝트 컨텍스트와 컨벤션: `CLAUDE.md`
- 시스템 설계(계층, 다이어그램, 설계 결정): [docs/architecture.md](architecture.md)
- 전체 엔드포인트, 캐시 TTL, 레이트리밋: [docs/api-reference.md](api-reference.md)
- 아키텍처 결정 기록: [docs/decisions/](decisions/)
- 승인된 설계 스펙: `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`

## 개발 워크플로

- 브랜치 이름: `feat/`, `fix/`, `docs/`, `refactor/`
- 커밋 컨벤션: **Conventional Commits** — 제목 영어, 본문 한/영 병기
- **Claude/AI를 기여자나 `Co-Authored-By`로 절대 넣지 않는다** (commit-msg 훅이 자동 제거하지만, 애초에 쓰지 않는다)
- Python: 타입힌트, async 우선 (동기 yfinance/boto3 호출은 `asyncio.to_thread` 경유)
- TypeScript: strict 모드, 함수형 컴포넌트
- 주석/문서: 주변 스타일을 따라 한국어+영어 병기

## 핵심 개념

- **Envelope**: 모든 데이터 엔드포인트는 `{"asOf": <ISO8601>, "marketOpen": <bool>, "data": ...}`를 반환한다.
- **심볼 유니버스**: 미국 50 + 한국 50 심볼만 허용한다 (`AAPL`, `005930.KS`, `247540.KQ`); 그 외는 404. 캐시 키/락 맵을 유한하게 유지한다.
- **계층 캐시**: L1(프로세스 내) → L2(DynamoDB, TTL) → fetch, 키별 single-flight 락.
- **가격 오버레이**: 상세 응답은 느린 펀더멘털(12시간 캐시)에 실시간 시세(스케줄러 45초 갱신)를 요청 시점에 병합한다.
- **스케줄러 = 신선도**: 선제 갱신 키의 TTL은 24시간이고, 실제 신선도는 백그라운드 루프(시세 45초/600초, 뉴스 120초/600초)가 만든다.
- **시뮬레이션 데이터**: 호가와 수급은 시뮬레이션이며 항상 `"simulated": true`를 담는다.

## 문제 해결

| 증상 | 원인 / 해결 |
|------|-------------|
| 기동 시 `l2_unavailable` 경고 | DynamoDB 접근 불가 — 로컬에서 정상; L1만으로 동작한다 |
| `POST /api/ai/*` → 503 `ai_unavailable` | AWS 자격 증명 없음 또는 ap-northeast-2 Bedrock 모델 접근 불가 |
| `cdk deploy`가 cloud-assembly 스키마 오류로 실패 | 전역 `cdk` CLI를 사용함; `infra/.venv/bin/cdk`(≥ 2.1134 고정)를 쓴다 |
| `cdk deploy` 이미지 빌드 실패 | Docker 미실행, 또는 arm64 에뮬레이션(QEMU/binfmt) 없는 x86 호스트 |
| 포트 8000 사용 중 | 다른 프로세스를 종료하거나 uvicorn을 `--port <다른 포트>`로 실행 |
| ALB URL 직접 접근 시 403 / 타임아웃 | 정상 — ALB는 `X-Origin-Verify`를 가진 CloudFront 트래픽만 받는다 |
| AI 엔드포인트 429 `rate_limited` | 설계된 동작: IP당 분당 3회; `retryAfter`초 후 재시도 |

## 참고 자료

- [docs/architecture.md](architecture.md) — 시스템 설계
- [docs/api-reference.md](api-reference.md) — API 레퍼런스
- [docs/runbooks/](runbooks/) — 운영 런북
- [docs/decisions/](decisions/) — ADR
- 프로덕션: https://d2wa9w1vbqlndl.cloudfront.net
