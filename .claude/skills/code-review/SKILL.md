---
name: code-review
description: 변경된 코드를 신뢰도 기반 스코어링으로 리뷰 (오탐 필터링). 코드 리뷰, PR 리뷰, 코드 품질 점검 요청 시 사용. / Review changed code with confidence-based scoring to filter false positives. Use for code review, PR review, or code quality checks.
---

# Code Review Skill

변경된 코드를 신뢰도 기반 스코어링으로 리뷰하여 오탐을 걸러낸다.
Review changed code with confidence-based scoring to filter false positives.

## 리뷰 범위 / Review Scope

기본값은 unstaged 변경(`git diff`)이다. 사용자가 파일이나 범위를 지정하면 그것을 따른다.
By default, review unstaged changes from `git diff`. The user may specify different files or scope.

## 리뷰 기준 / Review Criteria

### 프로젝트 가이드라인 준수 / Project Guidelines Compliance
- Backend (Python 3.12 FastAPI): 타입힌트 필수, async 우선 / type hints required, async-first
- Frontend (React 19 + TypeScript): strict 모드, 함수형 컴포넌트, @tanstack/react-query 패턴 / strict mode, function components, react-query patterns
- Infra (CDK v2 Python): 단일 스택 `infra/stacks/stock_monitoring_stack.py`, 기존 cc-on-bedrock-vpc lookup 재활용 / single stack, reuse existing VPC via lookup
- 주석·문서는 한국어+영어 병기 유지 / keep comments and docs bilingual (Korean + English)
- CLAUDE.md의 네이밍·모듈 경계 규칙 / naming and module-boundary rules from CLAUDE.md

### 버그 탐지 / Bug Detection
- 로직 오류, None/undefined 처리 / logic errors, null handling
- 캐시 계층(L1 memory / L2 DynamoDB tiered) 경합, single-flight 키 락 위반 / cache-tier races, single-flight lock violations
- 가격 오버레이 규칙 훼손: quotes 캐시(60s)가 detail 캐시(600s)의 price/change/volume을 덮어써야 함 / price-overlay rule: quotes cache must overwrite detail cache price fields
- 보안 취약점 (OWASP Top 10) — 특히 아래 프로젝트 고유 가드 / security vulnerabilities, especially project-specific guards:
  - 뉴스 본문 추출의 SSRF 가드 + 2MB 스트리밍 캡(원시 읽기 16MB·스텝 64KB 압축 해제 상한 포함) + regex 백트래킹 상한(`[^<>]{0,MAX_TAG_SCAN}`) 약화 여부
  - AI 레이트리밋 키는 CloudFront-Viewer-Address 헤더 (XFF는 위조 가능 — 사용 금지)
  - ALB 접근은 CloudFront prefix-list SG + X-Origin-Verify 헤더 경유만 허용
- 성능 문제 / performance problems

### 코드 품질 / Code Quality
- 중복 코드, 불필요한 복잡도 / duplication, unnecessary complexity
- 핵심 에러 처리 누락 / missing critical error handling
- 테스트 커버리지 공백 (backend pytest, frontend vitest colocated `.test.tsx`) / test coverage gaps
- 프론트엔드 접근성 + UI 관례: 다크 테마, 한국 관례 상승=빨강/하락=파랑 / accessibility and UI conventions (dark theme, KR up=red/down=blue)

## 신뢰도 스코어링 / Confidence Scoring

각 이슈를 0-100으로 평가한다 / Rate each issue 0-100:
- **0-24**: 오탐 또는 기존 이슈 가능성 높음. 보고하지 않음. / Likely false positive or pre-existing. Do not report.
- **25-49**: 실제일 수 있으나 nitpick 가능성. 보고하지 않음. / Might be real but possibly a nitpick. Do not report.
- **50-74**: 실제이나 사소함. critical일 때만 보고. / Real but minor. Report only if critical.
- **75-89**: 검증된 중요 이슈. 수정안과 함께 보고. / Verified important issue. Report with fix suggestion.
- **90-100**: 확인된 치명적 이슈. 반드시 보고. / Confirmed critical issue. Must report.

**신뢰도 75 이상 이슈만 보고한다. / Only report issues with confidence >= 75.**

## 출력 형식 / Output Format

각 이슈에 대해 / For each issue:

```
### [CRITICAL|IMPORTANT] <이슈 제목 / issue title> (confidence: XX)
**File:** `path/to/file.ext:line`
**Issue:** 문제 설명 / clear description of the problem
**Guideline:** CLAUDE.md 규칙 또는 보안 표준 참조 / reference to CLAUDE.md rule or security standard
**Fix:** 구체적 코드 제안 / concrete code suggestion
```

고신뢰 이슈가 없으면 코드가 기준을 충족함을 간단히 요약한다.
If no high-confidence issues found, confirm code meets standards with a brief summary.
