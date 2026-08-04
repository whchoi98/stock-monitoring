---
name: release
description: semver, CHANGELOG, git tag, 릴리스 노트로 릴리스 절차를 자동화. 릴리스, 버저닝, 체인지로그, 태깅 요청 시 사용. / Automate the release process with semver, CHANGELOG, tags, and release notes. Use for release, versioning, changelog, or tagging.
---

# Release Skill

검증 단계를 포함한 릴리스 절차를 자동화한다.
Automate the release process with validation checks.

## 절차 / Procedure

### 1. 릴리스 전 점검 / Pre-release Checks
- 워킹 트리 클린 확인 / verify working tree is clean: `git status`
- 전체 테스트 통과 확인 (두 스위트 모두 — Makefile test는 fail-fast이므로 직접 실행) / verify all tests pass (run both suites directly; the Makefile target is fail-fast):
  - `cd backend && .venv/bin/pytest -q` (328개)
  - `cd frontend && npx vitest run` (176개)
- 미커밋 변경 확인 / check for uncommitted changes

### 2. 버전 결정 / Determine Version
- 마지막 태그 이후 변경 검토 / review changes since last tag:
  `git log $(git describe --tags --abbrev=0)..HEAD --oneline`
- **태그가 아직 없으면** (현재 상태: 태그 0개, 버전 0.1.0) 전체 히스토리를 기준으로 첫 태그 `v0.1.0`을 제안한다.
  **If no tag exists yet** (current state: zero tags, version 0.1.0), propose the first tag `v0.1.0` from the full history.
- semver 규칙 / apply semver rules:
  - MAJOR: API 호환성 파괴 / breaking API changes
  - MINOR: 하위 호환 신규 기능 / new features, backward compatible
  - PATCH: 버그 수정만 / bug fixes only

### 3. CHANGELOG 갱신 / Update Changelog
- Keep a Changelog 형식, 한/영 병기 (프로젝트 문서 관례) / Keep a Changelog format, bilingual per project convention
- 유형별 그룹화 (Added, Changed, Fixed, Removed) / group changes by type
- 커밋 참조 포함, 날짜와 버전 헤더 추가 / include commit references, add date and version header

### 4. 릴리스 생성 / Create Release
- 버전 파일 갱신 / update version in relevant files: `frontend/package.json` 등 버전이 명시된 파일
- git tag 생성 / create git tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
- 릴리스 노트 생성 / generate release notes
- **주의 / Note:** 커밋·태그·릴리스 노트 어디에도 Claude/AI를 기여자로 넣지 않는다. Co-Authored-By 금지 (사용자 지시, commit-msg 훅이 자동 제거).
  Never credit Claude/AI as a contributor anywhere; no Co-Authored-By trailers (user directive, enforced by the commit-msg hook).

### 5. 요약 / Summary
- 버전 변경 표시 / display version bump
- 주요 변경 목록 / list key changes
- 다음 단계 안내 / show next steps: 태그 push, `/deploy`로 프로덕션 배포 (CloudFront: https://d2wa9w1vbqlndl.cloudfront.net)
