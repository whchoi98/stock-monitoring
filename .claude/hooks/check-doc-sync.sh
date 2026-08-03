#!/bin/bash
# 파일 변경 후 문서 동기화 필요 여부 감지 / Detect documentation sync needs after file changes.
# PostToolUse (Write|Edit) 이벤트로 트리거됨 / Triggered by PostToolUse (Write|Edit) events.
# 경고 전에 상위 디렉터리를 거슬러 올라가며 CLAUDE.md를 탐색 / Walks parent directories to find CLAUDE.md before warning.

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && exit 0

# 절대 경로를 프로젝트 상대 경로로 정규화 / Normalize absolute paths to project-relative
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
FILE_PATH="${FILE_PATH#"$PROJECT_DIR"/}"

# 이 프로젝트의 소스 루트 / Source root directories for this project
# backend: FastAPI 앱 / frontend: React+Vite 앱 / infra: CDK 스택
SOURCE_ROOTS="backend/app frontend/src infra/stacks"

for ROOT in $SOURCE_ROOTS; do
    if [[ "$FILE_PATH" == ${ROOT}/* ]]; then
        DIR=$(dirname "$FILE_PATH")
        FOUND_CLAUDE=false
        CHECK_DIR="$DIR"
        while [ "$CHECK_DIR" != "$ROOT" ] && [ "$CHECK_DIR" != "." ]; do
            if [ -f "$CHECK_DIR/CLAUDE.md" ]; then
                FOUND_CLAUDE=true
                break
            fi
            CHECK_DIR=$(dirname "$CHECK_DIR")
        done
        if ! $FOUND_CLAUDE && [ "$DIR" != "$ROOT" ]; then
            echo "[doc-sync] $DIR/CLAUDE.md is missing. Create module documentation. / 모듈 문서가 없습니다."
        fi
        break
    fi
done

# 소스 또는 아키텍처 문서 변경 시 ADR 부재 경고 / Alert if no ADRs exist when source or architecture files change
IS_SOURCE=false
for ROOT in $SOURCE_ROOTS; do
    [[ "$FILE_PATH" == ${ROOT}/* ]] && IS_SOURCE=true && break
done
if $IS_SOURCE || [[ "$FILE_PATH" == docs/architecture.md ]]; then
    ADR_COUNT=$(find docs/decisions -name 'ADR-*.md' -not -name '.template.md' 2>/dev/null | wc -l)
    if [ "$ADR_COUNT" -eq 0 ]; then
        echo "[doc-sync] No ADRs found. Record architectural decisions. / 아키텍처 결정 기록(ADR)이 없습니다."
    fi
fi

# 인프라 파일 변경 시 런북 부재 경고 / Alert if no runbooks exist when infrastructure files change
# 이 프로젝트: Dockerfile, infra/(CDK), scripts/smoke.sh
if [[ "$FILE_PATH" == Dockerfile* ]] || [[ "$FILE_PATH" == infra/* ]] || [[ "$FILE_PATH" == *cdk* ]] || [[ "$FILE_PATH" == scripts/smoke.sh ]]; then
    RUNBOOK_COUNT=$(find docs/runbooks -name '*.md' -not -name '.template.md' 2>/dev/null | wc -l)
    if [ "$RUNBOOK_COUNT" -eq 0 ]; then
        echo "[doc-sync] No runbooks found. Create operational runbooks for deployment/recovery. / 배포·복구 런북이 없습니다."
    fi
fi
