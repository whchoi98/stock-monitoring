---
name: sync-docs
description: 프로젝트 문서를 현재 코드 상태와 동기화. 문서 동기화, 문서 갱신, CLAUDE.md 업데이트 요청 시 사용. / Synchronize project documentation with current code state. Use for doc sync, documentation update, or CLAUDE.md update.
---

# Sync Docs Skill

프로젝트 문서를 현재 코드 상태와 동기화한다.
Synchronize project documentation with current code state.

모든 문서는 프로젝트 관례에 따라 한국어+영어 병기로 유지한다.
Keep all documentation bilingual (Korean + English) per project convention.

## 작업 / Actions

### 1. 품질 평가 / Quality Assessment
각 CLAUDE.md 파일을 0-100으로 채점한다 / score each CLAUDE.md file (0-100) across:
- 명령/워크플로 / commands & workflows (20 pts)
- 아키텍처 명확성 / architecture clarity (20 pts)
- 비자명 패턴 / non-obvious patterns (15 pts)
- 간결성 / conciseness (15 pts)
- 최신성 / currency (15 pts)
- 실행 가능성 / actionability (15 pts)

안티패턴 감점 / anti-pattern deductions:
- 500줄 초과 / over 500 lines (-15)
- 모호한 지시 / vague instructions (-10)
- 문서 중복 / duplicated docs (-10)
- 테스트 안내 없음 / no test guidance (-10)
- 시크릿 포함 / contains secrets (-20)

변경 전에 등급(A-F) 품질 리포트를 출력한다 / output quality report with grades (A-F) before making changes.

### 2. 루트 CLAUDE.md 동기화 / Root CLAUDE.md Sync
- Overview, Tech Stack, Conventions, Key Commands 갱신 / update those sections
- 명령이 실제 스크립트와 일치하는지 검증 / verify commands are copy-paste ready:
  - `Makefile` (build/run/test), `frontend/package.json` scripts, `infra/cdk.json`, `scripts/smoke.sh`

### 3. 아키텍처 문서 동기화 / Architecture Doc Sync
- `docs/architecture.md`를 현재 구조에 맞게 갱신 / update to reflect current system structure:
  CloudFront → (prefix-list SG) → ALB → ECS Fargate + DynamoDB(stock-monitoring-cache), 기존 cc-on-bedrock-vpc 재활용
- 설계 근거는 승인 스펙과 대조 / cross-check rationale against the approved spec:
  `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 신규 컴포넌트 추가, 데이터 흐름·인프라 변경 반영 / add new components, update data flows and infra changes

### 4. 모듈 CLAUDE.md 감사 / Module CLAUDE.md Audit
- 대상 모듈 / target modules: `backend/`, `frontend/`, `infra/`
- CLAUDE.md 없는 모듈에 생성, 낡은 것은 갱신 / create for modules missing one, update stale ones
- 각 모듈 CLAUDE.md 채점 / score each module CLAUDE.md

### 5. ADR·런북 감사 / ADR and Runbook Audit
- 최근 커밋에서 문서화 안 된 아키텍처 결정 확인 / check recent commits for undocumented architectural decisions
  (예: 캐시 계층 변경, 레이트리밋 정책, Bedrock 모델 교체 / e.g. cache-tier changes, rate-limit policy, Bedrock model swap)
- 런북 커버리지 검증 (배포·롤백·스모크) / verify runbook coverage (deploy, rollback, smoke)
- 오래된 ADR·런북 플래그 / flag stale ADRs and outdated runbooks

### 6. README.md 동기화 / README.md Sync
- 프로젝트 구조 섹션을 실제 디렉터리 배치와 일치시킴 / update project structure section to match actual layout
- 한/영 병기 형식 유지 / keep the bilingual format

### 7. 리포트 / Report
변경 전후 품질 점수, 발견된 안티패턴, 전체 변경 목록을 출력한다.
Output before/after quality scores, anti-patterns detected, and list of all changes.
