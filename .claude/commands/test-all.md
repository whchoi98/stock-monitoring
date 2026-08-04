---
description: 백엔드 pytest(320) + 프론트엔드 vitest(168) 전체 테스트 실행 후 결과 보고 / Execute the full test suite (backend pytest 320 + frontend vitest 168) and report results
allowed-tools: Read, Glob, Bash(cd backend && .venv/bin/pytest:*), Bash(cd frontend && npx vitest run:*), Bash(git log:*), Bash(git diff:*)
---

# Test All

이 프로젝트의 전체 테스트 스위트를 실행한다.
Execute the full test suite for this project.

## Step 1: 두 스위트를 모두 직접 실행 / Run Both Suites Directly

`make test`는 fail-fast라서 백엔드가 실패하면 프론트엔드가 아예 실행되지 않는다.
**한쪽이 실패해도 두 스위트를 모두 실행해야 하므로, 각 스위트 명령을 직접 별도로 실행한다.**
The Makefile `test` target is fail-fast — if the backend fails, the frontend never runs.
**Both suites must run even if one fails, so run each suite command directly:**

```bash
# Backend — pytest 320개 / 320 pytest tests
cd backend && .venv/bin/pytest -q
```

```bash
# Frontend — vitest 168개 (colocated .test.tsx) / 168 vitest tests
cd frontend && npx vitest run
```

첫 번째 명령이 실패해도 두 번째 명령을 반드시 실행한다. 두 결과를 모두 수집한 뒤 보고한다.
Run the second command even if the first fails. Collect both results before reporting.

## Step 2: 보고 / Report

다음을 제시한다 / present:
- 스위트별 실행/통과/실패/스킵 수 (기대값: backend 320, frontend 168, 총 488)
  / per-suite totals: run, passed, failed, skipped (expected: backend 320, frontend 168, 488 total)
- 실패 테스트 상세: 파일 경로와 에러 메시지 / failed test details with file paths and error messages
- 원인이 명백하면 수정 제안 / suggest fixes for failing tests if the cause is apparent

## 오류 복구 / Error Recovery

### 테스트 러너 자체가 실패할 때 / If a test runner itself fails
- `backend/.venv` 없음 → `cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt` (requirements 파일명은 실제 확인)
- `frontend/node_modules` 없음 → `cd frontend && npm install`

### 흔한 실패 유형 / Common failure categories

| 실패 패턴 / Failure Pattern | 원인 / Likely Cause | 조치 / Fix |
|---|---|---|
| ImportError / ModuleNotFoundError | venv 의존성 누락 / missing dep in venv | backend 의존성 재설치 / reinstall backend deps |
| "Cannot find module" (vitest) | node_modules 불일치 / stale node_modules | `cd frontend && npm install` |
| 네트워크 호출 실패 / network call failure | 외부 API 실호출 테스트 / test hitting live API | 테스트는 모킹되어야 함 — 모킹 누락 확인 / tests must be mocked; check for missing mocks |
| 스냅샷 불일치 / snapshot mismatch | 의도된 UI 변경 / intended UI change | 변경이 의도됐는지 확인 후 스냅샷 갱신 / verify intent, then update snapshot |

### 다수 테스트가 한꺼번에 실패할 때 / If many tests fail at once
구조적 변경이 여러 가정을 깨뜨렸을 가능성이 크다 / likely a structural change:
1. `git log -1` — 마지막 변경은? / what was the last change?
2. `git diff HEAD~1` — 구체적으로 무엇이 바뀌었나? / what specifically changed?
3. 개별 테스트가 아닌 근본 원인을 수정한다 / fix the root cause, not individual tests
