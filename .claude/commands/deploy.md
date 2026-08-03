---
description: 빌드 → CDK 배포 → 스모크 테스트로 프로덕션 배포 / Build, deploy via CDK, and run the post-deploy smoke test
allowed-tools: Read, Glob, Bash(make build:*), Bash(cd infra && .venv/bin/cdk deploy:*), Bash(cd infra && .venv/bin/cdk diff:*), Bash(bash scripts/smoke.sh:*), Bash(git status:*), Bash(git log:*), Bash(git branch:*)
---

# Deploy

stock-monitoring을 프로덕션(ap-northeast-2, StockMonitoringStack)에 배포한다.
Deploy stock-monitoring to production (ap-northeast-2, StockMonitoringStack).

## Step 1: 배포 전 점검 / Pre-Deploy Checks

1. 워킹 트리 클린 확인 / verify working tree is clean: `git status`
2. 현재 브랜치 확인 — master/main이 아니면 경고 / verify current branch (warn if not master/main)
3. 테스트 통과 확인 — 미실행 상태면 먼저 `/test-all` 제안 / ensure tests pass; suggest `/test-all` first if not run

## Step 2: 빌드 / Build

프론트엔드를 빌드해 `backend/static`에 배치한다 (Docker 빌드가 이 산출물 구조를 따른다).
Build the frontend into `backend/static` (the Docker build follows this layout).

```bash
make build
```

## Step 3: CDK 배포 / CDK Deploy

```bash
cd infra && .venv/bin/cdk deploy --require-approval never
```

- 소요 약 4분 / takes about 4 minutes
- 스택은 기존 cc-on-bedrock-vpc를 lookup으로 재활용한다 / the stack reuses the existing VPC via lookup

> **주의 / Note:** 권한 분류기(permission classifier)가 `cdk deploy`를 차단할 수 있다.
> 그 경우 사용자에게 터미널에서 `!` 접두사(bash 모드)로 직접 실행해 달라고 요청한다:
> The permission classifier may block `cdk deploy`. If so, ask the user to run it
> themselves with the `!` prefix (bash mode) in the Claude Code prompt:
>
> ```
> !cd infra && .venv/bin/cdk deploy --require-approval never
> ```

## Step 4: 스모크 테스트 / Smoke Test

CDK 스택 Outputs의 CloudFrontURL / AlbDNS를 인자로 스모크 테스트를 실행한다. 현재 프로덕션 값:
Run the smoke test with the stack outputs CloudFrontURL / AlbDNS. Current production values:

```bash
bash scripts/smoke.sh https://d2wa9w1vbqlndl.cloudfront.net stock-monitoring-alb-1937169801.ap-northeast-2.elb.amazonaws.com
```

배포로 Outputs가 바뀌었으면 새 값을 사용한다. 검사 1~3은 CloudFront 경유 정상 동작, 검사 4는 ALB 직접 접근 차단(403 또는 타임아웃 = 통과)을 확인한다.
If the deploy changed the outputs, use the new values. Checks 1-3 assert service health via CloudFront; check 4 asserts direct ALB access is blocked (403 or timeout = pass).

## Step 5: 요약 / Summary

- 배포 대상과 위치 / what was deployed and where (StockMonitoringStack, ap-northeast-2)
- 스모크 테스트 결과 / smoke test results
- 서비스 URL / service URL: https://d2wa9w1vbqlndl.cloudfront.net

## 오류 복구 / Error Recovery

### 배포 전 점검 실패 시 (Step 1) / If pre-deploy checks fail
- 미커밋 변경이 있으면 커밋 또는 stash 후 진행 여부를 사용자에게 확인한다
  / with uncommitted changes, ask the user whether to commit/stash before proceeding

### CDK 배포 실패 시 (Step 3) / If deployment fails
- CloudFormation은 자동 롤백한다 — 콘솔에서 실패 이벤트 확인 / CloudFormation auto-rolls back; check failure events
- 변경 내용을 먼저 검토 / inspect the diff first: `cd infra && .venv/bin/cdk diff`
- VPC lookup 실패면 AWS 자격 증명·리전(ap-northeast-2) 확인 / if VPC lookup fails, check credentials and region

### 배포 후 스모크 실패 시 (Step 4) / If smoke test fails after deployment
- ECS Fargate 서비스 로그에서 기동 오류 확인 / check ECS service logs for startup errors
- CACHE_TABLE, BEDROCK_REGION 환경변수 주입 확인 / verify injected env vars
- X-Origin-Verify 헤더와 prefix-list SG 구성 확인 (검사 4 실패 시) / verify header + SG config if check 4 fails
- 복구 불가면 직전 정상 커밋으로 되돌려 재배포 / if unrecoverable, revert to the last good commit and redeploy:
  `git revert HEAD` 후 Step 2부터 다시 / then repeat from Step 2
