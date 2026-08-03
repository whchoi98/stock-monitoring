#!/usr/bin/env bash
#
# git 훅 설치 / Install git hooks.
#
# Usage: bash scripts/install-hooks.sh
#
# commit-msg: 커밋 메시지에서 Co-Authored-By 라인을 제거한다 — Claude 등 AI 어시스턴트가
# contributor 로 기록되지 않게 하는 프로젝트 규칙을 강제한다.
# commit-msg: strips Co-Authored-By lines from commit messages — enforces the
# project rule that Claude and other AI assistants never appear as contributors.
set -euo pipefail

cd "$(dirname "$0")/.."

# git worktree 에서도 동작하도록 git-path 로 훅 디렉터리를 찾는다.
# Resolve the hooks dir via git-path so this also works inside git worktrees.
HOOKS_DIR="$(git rev-parse --git-path hooks 2>/dev/null)" || {
  echo "ERROR: not a git repository" >&2
  exit 1
}
mkdir -p "$HOOKS_DIR"

# commit-msg 훅 설치 / Install commit-msg hook (Co-Authored-By removal)
cat > "$HOOKS_DIR/commit-msg" << 'HOOK'
#!/bin/bash
# Remove Co-Authored-By lines from commit messages.
# Prevents Claude and other AI assistants from appearing as contributors.
sed -i '/^[Cc]o-[Aa]uthored-[Bb]y:.*/d' "$1"
sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$1"
HOOK
chmod +x "$HOOKS_DIR/commit-msg"
echo "Installed commit-msg hook (AI co-author removal)"

echo "=== Git hooks installed ==="
