---
description: 현재 변경분을 신뢰도 기반 필터링으로 코드 리뷰 / Run code review on current changes with confidence-based filtering
argument-hint: "[files or git ref]"
allowed-tools: Read, Glob, Grep, Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git branch:*)
---

# Code Review

현재 코드 변경분을 신뢰도 기반 스코어링으로 리뷰한다.
Review the current code changes using confidence-based scoring.

## Step 1: 변경분 확보 / Get Changes

리뷰 범위 결정 / determine the scope of review:

- $ARGUMENTS 에 파일이나 git ref가 있으면 그것을 리뷰 / if $ARGUMENTS specifies files or a ref, review those
- 없으면 unstaged 변경 / otherwise, review unstaged changes: `git diff`
- unstaged 변경이 없으면 staged 변경 / if none, review staged changes: `git diff --cached`

## Step 2: 리뷰 / Review

변경된 각 파일에 code-review 스킬 기준(`.claude/skills/code-review/SKILL.md`)을 적용한다.
For each changed file, apply the code-review skill criteria:
- 프로젝트 가이드라인 준수 (CLAUDE.md: Python 타입힌트·async 우선, TS strict·함수형 컴포넌트, 한/영 병기 주석)
- 버그 탐지 / bug detection (로직 오류, 캐시 계층 경합, 보안, 성능)
- 프로젝트 고유 보안 가드 훼손 여부 / project-specific security guards:
  SSRF 가드·2MB 캡(압축 해제 상한 포함)·태그 regex 선형성(`<` 제외), CloudFront-Viewer-Address 레이트리밋 키, X-Origin-Verify
- 코드 품질 / code quality (중복, 복잡도, 테스트 커버리지)

## Step 3: 스코어링과 필터 / Score and Filter

각 이슈를 0-100으로 평가하고 신뢰도 75 이상만 보고한다.
Rate each issue 0-100. Only report issues with confidence >= 75.

## Step 4: 출력 / Output

파일 경로, 라인 번호, 수정 제안을 포함한 구조화 형식으로 제시한다.
Present findings with file paths, line numbers, and fix suggestions.
고신뢰 이슈가 없으면 코드가 기준을 충족함을 확인한다.
If no high-confidence issues, confirm code meets standards.

## 오류 복구 / Error Recovery

### 변경분이 없을 때 (Step 1) / If no changes found
diff 출력이 없으면 리뷰할 것이 없다. 사용자에게 안내한다 / inform the user:
- 이미 커밋됐는지 확인 / check if changes are committed: `git log -1 --oneline`
- 브랜치 확인 / check the branch: `git branch --show-current`
- 파일 직접 지정 제안 / suggest specifying files: `/review backend/app/services/market_data.py`

### CLAUDE.md가 없거나 비어 있을 때 (Step 2) / If CLAUDE.md is missing or empty
프로젝트 가이드라인 평가가 불가능하다. 일반 기준(버그·보안·품질)만으로 리뷰하고, CLAUDE.md 생성을 제안한다.
Review with generic criteria only and suggest generating CLAUDE.md.

### diff가 너무 클 때 (>500줄) / If diff is too large
고위험 파일부터 / focus on high-risk files first:
1. 보안 민감 변경 / security-sensitive changes: `backend/app/api/ratelimit.py`, `backend/app/services/news.py`, `infra/stacks/`, `scripts/`
2. 로직 변경 / logic changes: `backend/app/services/`, `backend/app/cache/`, `frontend/src/api/`
3. 문서 변경은 후순위 / documentation changes (lower priority)
