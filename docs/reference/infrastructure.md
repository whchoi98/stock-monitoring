# Infrastructure / 인프라 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
Production runtime topology: CloudFront (redirect-to-https) fronts an internet-facing ALB that accepts only CloudFront traffic, forwarding to a single ECS Fargate task (ARM64/Graviton) that runs the FastAPI container with the built SPA baked in; DynamoDB is the persistent cache tier and Bedrock serves AI analysis. No network resource is ever created — the pre-existing `cc-on-bedrock-vpc` is referenced only.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Container image | `Dockerfile` | Multi-stage build: node:20-slim builds the SPA (`vite build`, `tsc -b` skipped — type checking is CI/local), python:3.12-slim serves FastAPI + `/srv/static`. `--workers 1` is load-bearing |
| CDK stack | `infra/stacks/stock_monitoring_stack.py` | The whole service in one stack: DynamoDB cache, origin-verify secret, ECS cluster/task/service, ALB, CloudFront, alarms |
| ECS service | `infra/stacks/stock_monitoring_stack.py` (§5–6) | 1 task, 0.5 vCPU / 1 GB, ARM64, private subnets, container health check re-declared on the task definition (ECS ignores the image HEALTHCHECK) |
| ALB + listener | `infra/stacks/stock_monitoring_stack.py` (§7–8) | Dedicated SG with a single CloudFront prefix-list rule (`pl-22a6434b`); listener default 403, forwards only on `X-Origin-Verify` match |
| CloudFront | `infra/stacks/stock_monitoring_stack.py` (§9) | HTTP_ONLY origin, `CACHING_DISABLED` default behavior, `/assets/*` long-cache (immutable vite hashes), custom origin header injection; PWA files (`sw.js`, `manifest.webmanifest`, `workbox-*.js`, `icons/*`) sit under the default no-cache behaviour, so a deploy becomes a new worker at once; ALB origin `read_timeout` 60 s (raised from the 30 s default: a cold article-AI generation ~45 s returned 504 — kept after SSE streaming as belt-and-braces) |
| Alarms | `infra/stacks/stock_monitoring_stack.py` (§10) | `stock-monitoring-alb-5xx` (ELB-generated 5xx spike) and `stock-monitoring-task-count` (`LiveTaskCount` < 1, missing = breaching) |
| Smoke test | `scripts/smoke.sh` | Post-deploy: health/overview/quote-rows/SPA fallback via CloudFront + assert direct ALB access is blocked (403 or timeout both pass) |

### 3. Key Decisions
- **Shared VPC, reference-only**: `cc-on-bedrock-vpc` (`vpc-0dfa5610180dfa628`) is looked up, never created; every resource name carries the `stock-monitoring` prefix to avoid collisions.
- **ARM64 image + Fargate Graviton**: the build host is aarch64 with no QEMU for amd64 cross-builds; Graviton is also cheaper.
- **`desired_count=1` + `--workers 1` are deliberate**: the L1 cache and the AI global semaphore are per-process. Scaling out requires a design review first.
- **ALB reachable only via CloudFront**: SG allows only the CloudFront origin-facing prefix list (a dedicated SG because one prefix list consumes ~55 rule slots), and the listener forwards only when `X-Origin-Verify` matches — direct hits get a fixed 403.
- **`LiveTaskCount` (AWS/ECS), not `RunningTaskCount`**: the latter exists only with Container Insights and would leave the alarm in INSUFFICIENT_DATA forever.

### 4. Code Pointers
- `Dockerfile` — build stages; the trailing comment explains why `--workers 1` must not change
- `infra/stacks/stock_monitoring_stack.py` — fixed identifiers block at the top (VPC/subnet/prefix-list IDs, `ORIGIN_VERIFY_HEADER`, `VIEWER_ADDRESS_HEADER`)
- `infra/stacks/stock_monitoring_stack.py` — `CONTAINER_HEALTHCHECK_CMD`: same probe as the image, re-declared for the ECS agent
- `scripts/smoke.sh` — usage: `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>` (values from the CDK stack outputs)
- `backend/app/api/health.py` — `/api/health`: the target-group and container health check endpoint (always 200, no external calls)

### 5. Cross-references
- Related modules: [iac.md](iac.md) (how the stack is defined), [security.md](security.md) (origin verification, SG rationale), [data.md](data.md) (DynamoDB cache table)
- Related ADRs: [ADR-002](../decisions/ADR-002-pwa-app-shell.md) (the PWA files ride the default `CACHING_DISABLED` behaviour — no infra change) — see `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md` for the approved design
- Related runbooks: [quotes-cache-poisoning.md](../runbooks/quotes-cache-poisoning.md) (blank stock table = a fresh empty quotes cache entry). Deploy = `cd infra && .venv/bin/cdk deploy --require-approval never`, then `scripts/smoke.sh`

<a id="korean"></a>
## 한국어

### 1. 개요
프로덕션 런타임 토폴로지: CloudFront(redirect-to-https)가 인터넷 연결 ALB 앞에 서고, ALB는 CloudFront 트래픽만 받아 FastAPI 컨테이너(빌드된 SPA 포함)를 실행하는 단일 ECS Fargate 태스크(ARM64/Graviton)로 전달한다. DynamoDB가 영속 캐시 계층, Bedrock이 AI 분석을 담당한다. 네트워크 리소스는 절대 생성하지 않고 기존 `cc-on-bedrock-vpc`를 참조만 한다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 컨테이너 이미지 | `Dockerfile` | 멀티스테이지: node:20-slim이 SPA 빌드(`tsc -b` 생략 — 타입 검사는 CI/로컬 책임), python:3.12-slim이 FastAPI + `/srv/static` 서빙. `--workers 1`이 load-bearing |
| CDK 스택 | `infra/stacks/stock_monitoring_stack.py` | 단일 스택에 전체 서비스: DynamoDB 캐시, 오리진 검증 시크릿, ECS 클러스터/태스크/서비스, ALB, CloudFront, 알람 |
| ECS 서비스 | `infra/stacks/stock_monitoring_stack.py` (§5–6) | 태스크 1개, 0.5 vCPU / 1GB, ARM64, private 서브넷. 헬스체크를 태스크 정의에 재선언 (ECS는 이미지 HEALTHCHECK를 무시) |
| ALB + 리스너 | `infra/stacks/stock_monitoring_stack.py` (§7–8) | CloudFront prefix-list 단일 규칙(`pl-22a6434b`)의 전용 SG. 리스너 기본 403, `X-Origin-Verify` 일치 시에만 forward |
| CloudFront | `infra/stacks/stock_monitoring_stack.py` (§9) | 오리진 HTTP_ONLY, 기본 동작 `CACHING_DISABLED`, `/assets/*` 장기 캐시(vite 불변 해시), 커스텀 오리진 헤더 주입. PWA 파일(`sw.js`, `manifest.webmanifest`, `workbox-*.js`, `icons/*`)은 기본 무캐시 동작 아래라 배포가 곧 새 워커가 된다. ALB 오리진 `read_timeout` 60초(기본 30초에서 상향 — 콜드 기사 AI 생성 ~45초가 504를 냈음. SSE 스트리밍 도입 후에도 안전벨트로 유지) |
| 알람 | `infra/stacks/stock_monitoring_stack.py` (§10) | `stock-monitoring-alb-5xx` (ELB 생성 5xx 급증), `stock-monitoring-task-count` (`LiveTaskCount` < 1, 결측 = breaching) |
| 스모크 테스트 | `scripts/smoke.sh` | 배포 후: CloudFront 경유 health/overview/시세 행 수/SPA fallback + ALB 직접 접근 차단 확인 (403·타임아웃 모두 통과) |

### 3. 주요 결정
- **공유 VPC, 참조만**: `cc-on-bedrock-vpc`(`vpc-0dfa5610180dfa628`)를 lookup으로만 쓰고 절대 생성하지 않는다. 모든 리소스 이름에 `stock-monitoring` 프리픽스 (충돌·오인 방지).
- **ARM64 이미지 + Fargate Graviton**: 빌드 호스트가 aarch64이고 amd64 크로스빌드용 QEMU가 없다. Graviton이 더 저렴하기도 하다.
- **`desired_count=1` + `--workers 1`은 의도된 값**: L1 캐시와 AI 전역 세마포어가 프로세스 단위다. 스케일아웃 전 설계 재검토 필수.
- **ALB는 CloudFront 경유로만 접근 가능**: SG는 CloudFront origin-facing prefix list 1규칙만 허용(prefix list 하나가 SG 규칙 슬롯 ~55개를 소비해 전용 SG 필수), 리스너는 `X-Origin-Verify` 일치 시에만 forward — 직접 접근은 고정 403.
- **`RunningTaskCount` 대신 `LiveTaskCount`(AWS/ECS)**: 전자는 Container Insights 전용이라 없으면 알람이 영구 INSUFFICIENT_DATA에 머문다.

### 4. 코드 포인터
- `Dockerfile` — 빌드 스테이지 구성. 말미 주석이 `--workers 1`을 바꾸면 안 되는 이유를 설명
- `infra/stacks/stock_monitoring_stack.py` — 파일 상단 고정 식별자 블록 (VPC/서브넷/prefix-list ID, `ORIGIN_VERIFY_HEADER`, `VIEWER_ADDRESS_HEADER`)
- `infra/stacks/stock_monitoring_stack.py` — `CONTAINER_HEALTHCHECK_CMD`: 이미지와 동일한 프로브를 ECS 에이전트용으로 재선언
- `scripts/smoke.sh` — 사용법: `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>` (CDK 스택 Outputs 값)
- `backend/app/api/health.py` — `/api/health`: 타깃 그룹·컨테이너 헬스체크 엔드포인트 (항상 200, 외부 호출 없음)

### 5. 상호 참조
- 관련 모듈: [iac.md](iac.md) (스택 정의 방식), [security.md](security.md) (오리진 검증·SG 근거), [data.md](data.md) (DynamoDB 캐시 테이블)
- 관련 ADR: [ADR-002](../decisions/ADR-002-pwa-app-shell.md)(PWA 파일은 기본 `CACHING_DISABLED` 동작을 그대로 탄다 — 인프라 변경 없음) — 승인된 설계는 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: [quotes-cache-poisoning.md](../runbooks/quotes-cache-poisoning.md) (빈 종목 테이블 = 신선한 빈 시세 캐시 항목). 배포 = `cd infra && .venv/bin/cdk deploy --require-approval never` 후 `scripts/smoke.sh`
