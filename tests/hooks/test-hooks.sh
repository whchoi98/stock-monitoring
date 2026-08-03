#!/bin/bash
# .claude/hooks/*.sh 검증 / Tests for .claude/hooks/*.sh
# tests/run-all.sh 가 source 하여 실행 (단독 실행 아님) / Sourced by tests/run-all.sh (not standalone).

# --- 존재·권한·문법 / Existence, permissions, syntax ---
HOOKS=(check-doc-sync secret-scan session-context notify)
for hook in "${HOOKS[@]}"; do
    assert_file_exists "$hook.sh exists" ".claude/hooks/$hook.sh"
    assert_file_executable "$hook.sh is executable" ".claude/hooks/$hook.sh"
    assert_bash_syntax "$hook.sh valid bash" ".claude/hooks/$hook.sh"
done

# --- settings.json 훅 등록 / settings.json hook registration ---
assert_file_exists "settings.json exists" ".claude/settings.json"
assert_json_valid "settings.json is valid JSON" ".claude/settings.json"

# 이벤트별 등록을 JSON 구조로 정확히 검사 / Verify registration per event via JSON structure
check_hook_registered() {
    local event="$1" script="$2"
    if python3 - "$event" "$script" <<'PY' 2>/dev/null
import json, sys
event, script = sys.argv[1], sys.argv[2]
cfg = json.load(open(".claude/settings.json"))
entries = cfg.get("hooks", {}).get(event, [])
found = any(script in h.get("command", "")
            for e in entries for h in e.get("hooks", []))
sys.exit(0 if found else 1)
PY
    then
        pass "settings.json: $script registered under $event"
    else
        fail "settings.json: $script registered under $event" "not found in hooks.$event"
    fi
}

check_hook_registered "SessionStart" "session-context.sh"
check_hook_registered "PreToolUse" "secret-scan.sh"
check_hook_registered "PostToolUse" "check-doc-sync.sh"
check_hook_registered "Notification" "notify.sh"

SETTINGS=$(cat .claude/settings.json)
assert_contains "PostToolUse matcher is Write|Edit" "$SETTINGS" "Write|Edit"

# --- 동작 테스트 / Behavior tests ---

# check-doc-sync: 빈 경로는 출력 없음 / empty path produces no output
OUTPUT=$(bash .claude/hooks/check-doc-sync.sh "" 2>&1 || true)
assert_eq "check-doc-sync: empty path produces no output" "" "$OUTPUT"

# check-doc-sync: 소스 루트(backend/app, frontend/src, infra/stacks) 밖 경로는 조용함
# / paths outside source roots stay silent
OUTPUT=$(bash .claude/hooks/check-doc-sync.sh "README.md" 2>&1 || true)
assert_eq "check-doc-sync: non-source path produces no output" "" "$OUTPUT"

# session-context: 프로젝트 정보 출력 / outputs project info
OUTPUT=$(bash .claude/hooks/session-context.sh 2>&1 || true)
assert_contains "session-context: shows project header" "$OUTPUT" "Project Context"
assert_contains "session-context: reports CLAUDE.md count" "$OUTPUT" "CLAUDE.md files:"
assert_contains "session-context: identifies this project" "$OUTPUT" "stock-monitoring"

# notify: 웹훅 URL 없으면 조용히 종료 / no webhook URL exits silently
OUTPUT=$(CLAUDE_NOTIFY_WEBHOOK="" bash .claude/hooks/notify.sh "test" "msg" 2>&1 || true)
assert_eq "notify.sh: no webhook URL produces no output" "" "$OUTPUT"

# secret-scan: 스테이징된 파일이 없으면(git 리포 밖) 조용히 exit 0
# / with no staged files (outside a git repo) it exits 0 silently
SECRET_SCAN_ABS="$PROJECT_ROOT/.claude/hooks/secret-scan.sh"
TMP_NOGIT=$(mktemp -d "${TMPDIR:-/tmp}/harness-test.XXXXXX")
if OUTPUT=$( (cd "$TMP_NOGIT" && bash "$SECRET_SCAN_ABS") 2>&1 ); then
    assert_eq "secret-scan: no staged files exits 0 silently" "" "$OUTPUT"
else
    fail "secret-scan: no staged files exits 0 silently" "expected exit 0, got non-zero"
fi
rm -rf "$TMP_NOGIT"
