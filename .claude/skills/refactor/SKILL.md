---
name: refactor
description: 동작을 바꾸지 않고 코드 구조를 개선 (SRP, DRY, 점진적 단계). 리팩토링, 코드 정리, 코드 개선 요청 시 사용. / Refactor existing code to improve quality without changing behavior, using SRP, DRY, and incremental steps. Use for refactoring, code cleanup, or code improvement.
---

# Refactor Skill

동작을 바꾸지 않고 기존 코드 품질을 개선한다.
Refactor existing code to improve quality without changing behavior.

## 원칙 / Principles
- 동작 보존: 구조만 개선한다 / improve structure without changing behavior
- 단일 책임 원칙 / Single Responsibility Principle (SRP)
- 중복 제거 / remove duplicate code (DRY)
- 작은 단계로 나누고 매 단계 검증 / small, incremental steps with verification

## 절차 / Process

### 1. 분석 / Analysis
- 대상 코드와 해당 테스트를 식별 / identify the target code and its tests
  - backend: `backend/tests/` (pytest 328개), frontend: colocated `.test.tsx` (vitest 176개)
- 호출자와 의존성 전부 파악 / map all callers and dependencies
  - backend 레이어: `app/api/` → `app/services/` → `app/cache/`(memory L1 / dynamo L2 / tiered) + `app/core/`
  - frontend 레이어: `src/pages/` → `src/components/` → `src/api/`(client, queries, types)
- 테스트 커버리지 확인 — 없으면 테스트 먼저 추가 제안 / confirm test coverage exists (suggest adding tests first if not)

### 2. 계획 / Plan
리팩토링 계획을 사용자에게 제시한다 / present the refactoring plan to the user:
- 무엇이 바뀌는가 / what will change
- 무엇이 바뀌지 않는가 (동작 보존) / what will NOT change (behavior preservation)
  - 특히: 캐시 TTL·가격 오버레이 동작, 레이트리밋 키, SSRF 가드 등 보안 가드는 동작 계약이다
  - Especially: cache TTLs, price-overlay behavior, rate-limit key, SSRF guards are behavioral contracts
- 위험도 평가 / risk assessment (low/medium/high)

### 3. 실행 / Execute
- 작고 검증 가능한 단계로 변경 / make changes in small, verifiable steps
- 각 단계 후 해당 영역 테스트 실행 / run the affected suite after each step:
  - `cd backend && .venv/bin/pytest -q`
  - `cd frontend && npx vitest run`
- 커밋은 원자적으로 유지 (Conventional Commits, 제목 영어 + 본문 한/영 병기) / keep commits atomic

### 4. 검증 / Verify
- 기존 테스트 전부 통과 확인 (양쪽 스위트 모두) / confirm all existing tests pass (both suites)
- 동작 변화 없음 확인 / verify no behavior changes
- 리팩토링 목표 달성 여부 점검 / check that the refactoring achieved its goal
