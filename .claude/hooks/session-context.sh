#!/bin/bash
# Claude Code 세션 시작 시 프로젝트 컨텍스트 로드 / Load project context at Claude Code session start.
# 핵심 프로젝트 정보를 출력해 즉시 컨텍스트로 사용 / Outputs key project information for immediate context.

echo "=== Project Context ==="

# 프로젝트 식별 / Project identification
# stock-monitoring: FastAPI(backend/) + React+Vite(frontend/) + CDK(infra/)
echo "Project: $(basename "$(pwd)") (Python FastAPI backend/ + React Vite frontend/ + CDK infra/)"

# 최근 활동 / Recent activity
LAST_COMMIT=$(git log -1 --format="%h %s (%cr)" 2>/dev/null)
[ -n "$LAST_COMMIT" ] && echo "Last commit: $LAST_COMMIT"

# 브랜치 정보 / Branch info
BRANCH=$(git branch --show-current 2>/dev/null)
[ -n "$BRANCH" ] && echo "Branch: $BRANCH"

# 커밋되지 않은 변경 / Uncommitted changes
CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$CHANGES" -gt 0 ] && echo "Uncommitted changes: $CHANGES file(s)"

# 핵심 문서 로드 / Load key documents
# 루트 CLAUDE.md와 docs/architecture.md를 세션 컨텍스트로 안내
for DOC in "CLAUDE.md" "docs/architecture.md"; do
    if [ -f "$DOC" ]; then
        TITLE=$(grep -m1 '^#' "$DOC" 2>/dev/null | sed 's/^#* *//')
        echo "Key doc: $DOC${TITLE:+ — $TITLE} (read before making changes)"
    fi
done

# 문서화 상태 / Documentation status
CLAUDE_COUNT=$(find . -name "CLAUDE.md" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "*/.venv/*" 2>/dev/null | wc -l | tr -d ' ')
echo "CLAUDE.md files: $CLAUDE_COUNT"

echo "======================"
