# Infrastructure as Code / IaC 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A Python CDK v2 app defining exactly one stack, `StockMonitoringStack`, environment-bound to account `061525506239` / `ap-northeast-2` (required for `Vpc.from_lookup`; the lookup result is pinned into the committed `cdk.context.json`). Deploy with `cd infra && .venv/bin/cdk deploy --require-approval never` (~4 min), then run `scripts/smoke.sh`.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| CDK entry point | `infra/app.py` | Instantiates the stack with an explicit `cdk.Environment` |
| Stack definition | `infra/stacks/stock_monitoring_stack.py` | All resources: cache table, origin-verify secret, ECS, ALB, CloudFront, alarms, outputs (`CloudFrontURL`, `AlbDNS`, `CacheTableName`) |
| CDK config | `infra/cdk.json` | `app = .venv/bin/python3 app.py` |
| Context pin | `infra/cdk.context.json` | Committed `Vpc.from_lookup` result — synth is deterministic and offline |
| Dependencies | `infra/requirements.txt` | `aws-cdk-lib` v2 + `constructs` |
| Image asset | `Dockerfile` (repo root) | `DockerImageAsset(directory=PROJECT_ROOT, platform=LINUX_ARM64)` — the build context is the repo root, derived from the stack file's own path, not the process CWD |

### 3. Key Decisions
- **Fixed identifiers as module constants**: VPC/subnet IDs, the CloudFront origin-facing prefix list (`pl-22a6434b`), header names. The shared VPC is referenced only — nothing network-level is created.
- **`origin_secret.unsafe_unwrap()` is deliberate**: listener-rule conditions and CloudFront custom headers cannot resolve secret dynamic references, so a synth-time value is required; it lands in the template in clear text and rotation means redeploying the stack.
- **`listener open=False` is load-bearing**: the default (`True`) would make CDK add a `0.0.0.0/0:80` ingress rule to the ALB SG, breaking the "single prefix-list rule" constraint.
- **Custom origin request policy** (`allViewerAndWhitelistCloudFront` behavior): the managed `ALL_VIEWER_EXCEPT_HOST_HEADER` forwards *no* CloudFront-generated header, but the AI rate limit keys on `CloudFront-Viewer-Address` — so a custom policy whitelists it (user ruling, 2026-08-02). Cost: the viewer Host header now reaches the origin; nothing depends on it.
- **`BEDROCK_MODEL_ID` is intentionally NOT set in the task environment**: the code default (`global.anthropic.claude-sonnet-4-6`) is the verified production value; only `CACHE_TABLE` and `BEDROCK_REGION` are injected.
- **Least-privilege IAM**: DynamoDB actions scoped to the table ARN; the Bedrock statement grants both `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `*` — the `global.` inference profile resolves to cross-region model ARNs, and the SSE path (`converse_stream`, the sole call primitive) is authorised as `InvokeModelWithResponseStream` (missing it was the 2026-08-04 post-deploy 503).
- **`RemovalPolicy.DESTROY` on the cache table**: it is a pure cache — nothing to preserve.

### 4. Code Pointers
- `infra/app.py` — the explicit `cdk.Environment` and why it must stay
- `infra/stacks/stock_monitoring_stack.py` — section comments `1)`–`10)` walk the whole stack in order
- `infra/stacks/stock_monitoring_stack.py` — §3 origin-verify secret (`unsafe_unwrap` rationale), §8 listener (default 403 + verified forward), §9 CloudFront (origin request policy rationale)
- `infra/cdk.context.json` — pinned VPC lookup; delete only if the VPC itself changes
- `docs/superpowers/plans/2026-08-01-infra.md` — the implementation plan this stack was built from

### 5. Cross-references
- Related modules: [infrastructure.md](infrastructure.md) (what the deployed topology does), [security.md](security.md) (origin verification, IAM), [agent-llm.md](agent-llm.md) (why the model id lives in code)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
Python CDK v2 앱이 단일 스택 `StockMonitoringStack`을 정의하며, 계정 `061525506239` / `ap-northeast-2`에 환경 고정되어 있다 (`Vpc.from_lookup`에 필수; lookup 결과는 커밋된 `cdk.context.json`에 pin). 배포는 `cd infra && .venv/bin/cdk deploy --require-approval never`(~4분), 이후 `scripts/smoke.sh` 실행.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| CDK 엔트리포인트 | `infra/app.py` | 명시적 `cdk.Environment`로 스택 생성 |
| 스택 정의 | `infra/stacks/stock_monitoring_stack.py` | 전체 리소스: 캐시 테이블, 오리진 검증 시크릿, ECS, ALB, CloudFront, 알람, Outputs(`CloudFrontURL`, `AlbDNS`, `CacheTableName`) |
| CDK 설정 | `infra/cdk.json` | `app = .venv/bin/python3 app.py` |
| 컨텍스트 pin | `infra/cdk.context.json` | 커밋된 `Vpc.from_lookup` 결과 — synth가 결정적·오프라인 |
| 의존성 | `infra/requirements.txt` | `aws-cdk-lib` v2 + `constructs` |
| 이미지 애셋 | `Dockerfile` (리포 루트) | `DockerImageAsset(directory=PROJECT_ROOT, platform=LINUX_ARM64)` — 빌드 컨텍스트는 리포 루트이며 프로세스 CWD가 아니라 스택 파일 위치에서 계산 |

### 3. 주요 결정
- **고정 식별자는 모듈 상수**: VPC/서브넷 ID, CloudFront origin-facing prefix list(`pl-22a6434b`), 헤더 이름. 공유 VPC는 참조만 — 네트워크 리소스는 생성하지 않는다.
- **`origin_secret.unsafe_unwrap()`은 의도된 선택**: 리스너 규칙 조건과 CloudFront 커스텀 헤더는 시크릿 동적 참조를 지원하지 않아 synth 시점 값이 필요하다. 값은 템플릿에 평문으로 들어가며, 로테이션 = 스택 재배포.
- **`listener open=False`가 load-bearing**: 기본값(`True`)이면 CDK가 ALB SG에 `0.0.0.0/0:80` 인바운드를 추가해 "prefix-list 단일 규칙" 제약이 깨진다.
- **커스텀 origin request policy** (`allViewerAndWhitelistCloudFront` 동작): 관리형 `ALL_VIEWER_EXCEPT_HOST_HEADER`는 CloudFront 생성 헤더를 하나도 전달하지 못하는데, AI 레이트리밋이 `CloudFront-Viewer-Address`를 키로 쓴다 — 그래서 커스텀 정책으로 화이트리스트 (2026-08-02 사용자 결정). 대가는 뷰어 Host 헤더가 오리진에 전달되는 것뿐이며 아무것도 이에 의존하지 않는다.
- **태스크 환경에 `BEDROCK_MODEL_ID`를 넣지 않는다**: 코드 기본값(`global.anthropic.claude-sonnet-4-6`)이 검증된 운영 값. 주입하는 것은 `CACHE_TABLE`과 `BEDROCK_REGION`뿐.
- **최소 권한 IAM**: DynamoDB 액션은 테이블 ARN 한정. Bedrock 정책은 `bedrock:InvokeModel`과 `bedrock:InvokeModelWithResponseStream` 둘 다 `*`에 허용 — `global.` 추론 프로파일이 교차 리전 모델 ARN으로 해석되고, SSE 경로(`converse_stream`, 유일한 호출 프리미티브)는 `InvokeModelWithResponseStream`으로 평가된다(이게 빠져 2026-08-04 배포 직후 503 장애).
- **캐시 테이블 `RemovalPolicy.DESTROY`**: 순수 캐시 — 보존할 것이 없다.

### 4. 코드 포인터
- `infra/app.py` — 명시적 `cdk.Environment`와 유지해야 하는 이유
- `infra/stacks/stock_monitoring_stack.py` — 섹션 주석 `1)`–`10)`이 스택 전체를 순서대로 안내
- `infra/stacks/stock_monitoring_stack.py` — §3 오리진 검증 시크릿(`unsafe_unwrap` 근거), §8 리스너(기본 403 + 검증 forward), §9 CloudFront(origin request policy 근거)
- `infra/cdk.context.json` — VPC lookup pin. VPC 자체가 바뀔 때만 삭제
- `docs/superpowers/plans/2026-08-01-infra.md` — 이 스택의 구현 계획

### 5. 상호 참조
- 관련 모듈: [infrastructure.md](infrastructure.md) (배포된 토폴로지의 동작), [security.md](security.md) (오리진 검증·IAM), [agent-llm.md](agent-llm.md) (모델 ID가 코드에 있는 이유)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음


## 2026-09-13 deployment / 운영 업데이트

React Router 7.18.3 and the quality upgrade were deployed to the existing stack after explicit user approval. The reviewed template changed only the task definition image; no network or storage definitions changed. Generated screenshots, browser reports, fixtures, local artifacts and frontend dist are excluded from the Docker context. The immutable reviewed assembly was deployed with `cdk deploy --app cdk.out`; see the [deployment record](../deployments/2026-09-13-router7-quality-upgrade.md).

사용자 승인 후 기존 스택의 애플리케이션 이미지만 갱신했다. Docker 컨텍스트에서 검증 산출물을 제외하고, 검토한 CDK assembly를 그대로 배포했다. 운영 태스크 리비전은 13이며 배포 후 공개 주소·AI 스트림·화면·ALB 차단을 확인했다.
