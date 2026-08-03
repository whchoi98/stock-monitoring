# Infra Module (AWS CDK v2, Python)

## 역할 / Role
단일 스택 `StockMonitoringStack` (ap-northeast-2): CloudFront → ALB(:80) → ECS Fargate(private subnet)
→ DynamoDB 캐시(`stock-monitoring-cache`) + Bedrock. 프로덕션: https://d2wa9w1vbqlndl.cloudfront.net

## 절대 제약 / Hard Constraint (user directive)
- **VPC/서브넷/NATGW/IGW를 절대 생성하지 않는다** — 기존 `cc-on-bedrock-vpc`(`vpc-0dfa5610180dfa628`)를
  고정 ID로 참조만 한다 (`stacks/stock_monitoring_stack.py` 상단 상수). Never create network resources.
- 공유 VPC이므로 모든 리소스 이름에 `stock-monitoring` 프리픽스 필수.

## 보안 구성 / Security Wiring
- ALB SG 인바운드는 CloudFront origin-facing prefix list(`pl-22a6434b`) **단일 규칙**의 전용 SG —
  prefix list 하나가 SG 규칙 슬롯 ~55개를 소비하므로 다른 규칙과 섞지 않는다.
- ALB 리스너는 `X-Origin-Verify` 헤더(Secrets Manager 시크릿) 일치 시에만 포워딩 — CloudFront 우회 차단.
- `CloudFront-Viewer-Address` 헤더를 origin request policy에 명시적으로 화이트리스트 — 백엔드 AI
  레이트리밋 키 (`backend/app/api/ai.py`의 VIEWER_ADDRESS_HEADER와 쌍).

## 명령 / Commands
```bash
cd infra && .venv/bin/cdk deploy --require-approval never   # 배포 (~4분)
cd infra && .venv/bin/cdk diff                              # 변경 확인
bash scripts/smoke.sh https://d2wa9w1vbqlndl.cloudfront.net \
  stock-monitoring-alb-1937169801.ap-northeast-2.elb.amazonaws.com   # 배포 후 스모크 (repo 루트)
```

## 주의 / Gotchas
- `cdk.json`이 `app = ".venv/bin/python3 app.py"`로 venv python을 고정 — 시스템 python으로 실행하지
  말 것. CDK 명령도 항상 `infra/.venv` 경유.
- `cdk.context.json`은 VPC lookup 캐시 — 함부로 삭제하지 않는다 (삭제 시 AWS 자격증명으로 재조회 필요).
- 컨테이너 이미지 빌드 컨텍스트는 **repo 루트** (루트 `Dockerfile`이 frontend+backend 멀티스테이지 빌드).
- 컨테이너 헬스체크는 태스크 정의에 재선언되어 있다 — ECS는 이미지의 HEALTHCHECK를 무시한다.
- Bedrock 모델 ID는 `global.anthropic.claude-sonnet-4-6` (ap-northeast-2에는 `global.` 프리픽스만 존재).
- Fargate 태스크 수를 늘리면 L1 캐시·레이트리밋이 태스크별로 갈라진다는 점을 고려할 것 (backend/CLAUDE.md 참조).
- 주석은 한국어+영어 병기 유지 / Keep comments bilingual ko+en.
