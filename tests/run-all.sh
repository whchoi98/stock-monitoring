#!/bin/bash
# 하네스 테스트 러너 (TAP 스타일) / Harness test runner (TAP-style).
# 스캐폴딩 자체를 검증한다 — 앱 테스트는 backend/tests, frontend에 있음.
# Validates the scaffolding itself — app tests live in backend/tests and frontend.
#
# Usage: bash tests/run-all.sh [test-file-pattern]
# Example: bash tests/run-all.sh            # run all tests
#          bash tests/run-all.sh hooks      # run only hook tests
#          bash tests/run-all.sh structure  # run only structure tests

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0
FAILURES=()

export TEST_RUNNER_ACTIVE=1

# --- TAP 스타일 결과 함수 / TAP-style result functions ---

pass() {
    TOTAL=$((TOTAL + 1))
    PASSED=$((PASSED + 1))
    echo -e "  ${GREEN}ok${NC} $TOTAL - $1"
}

fail() {
    TOTAL=$((TOTAL + 1))
    FAILED=$((FAILED + 1))
    FAILURES+=("$1: $2")
    echo -e "  ${RED}not ok${NC} $TOTAL - $1"
    echo -e "    ${RED}# $2${NC}"
}

skip() {
    TOTAL=$((TOTAL + 1))
    SKIPPED=$((SKIPPED + 1))
    echo -e "  ${YELLOW}ok${NC} $TOTAL - $1 ${YELLOW}# SKIP $2${NC}"
}

# --- 어서션 헬퍼 / Assertion helpers ---

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    [ "$expected" = "$actual" ] && pass "$desc" || fail "$desc" "expected '$expected', got '$actual'"
}

assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    echo "$haystack" | grep -qF -- "$needle" && pass "$desc" || fail "$desc" "output does not contain '$needle'"
}

assert_file_exists() {
    local desc="$1" filepath="$2"
    [ -f "$filepath" ] && pass "$desc" || fail "$desc" "file not found: $filepath"
}

assert_dir_exists() {
    local desc="$1" dirpath="$2"
    [ -d "$dirpath" ] && pass "$desc" || fail "$desc" "directory not found: $dirpath"
}

assert_file_executable() {
    local desc="$1" filepath="$2"
    [ -x "$filepath" ] && pass "$desc" || fail "$desc" "file not executable: $filepath"
}

# 파일 내용에 고정 문자열 포함 / File content contains fixed string
assert_file_contains() {
    local desc="$1" filepath="$2" needle="$3"
    if [ ! -f "$filepath" ]; then
        fail "$desc" "file not found: $filepath"
    elif grep -qF -- "$needle" "$filepath"; then
        pass "$desc"
    else
        fail "$desc" "'$needle' not found in $filepath"
    fi
}

assert_json_valid() {
    local desc="$1" filepath="$2"
    python3 -m json.tool "$filepath" > /dev/null 2>&1 && pass "$desc" || fail "$desc" "invalid JSON: $filepath"
}

assert_bash_syntax() {
    local desc="$1" filepath="$2"
    bash -n "$filepath" 2>/dev/null && pass "$desc" || fail "$desc" "bash syntax error in: $filepath"
}

assert_grep_match() {
    local desc="$1" pattern="$2" input="$3"
    echo "$input" | grep -qP -- "$pattern" 2>/dev/null && pass "$desc" || fail "$desc" "pattern '$pattern' did not match"
}

assert_grep_no_match() {
    local desc="$1" pattern="$2" input="$3"
    echo "$input" | grep -qP -- "$pattern" 2>/dev/null && fail "$desc" "pattern '$pattern' matched (expected no match)" || pass "$desc"
}

export -f pass fail skip assert_eq assert_contains assert_file_exists
export -f assert_dir_exists assert_file_executable assert_file_contains
export -f assert_json_valid assert_bash_syntax
export -f assert_grep_match assert_grep_no_match

# --- 테스트 파일 수집 및 실행 / Collect and run test files ---

FILTER="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PROJECT_ROOT
cd "$PROJECT_ROOT"

echo -e "${CYAN}=== Harness Test Suite (stock-monitoring) ===${NC}"
echo ""

# tests/hooks/*.sh 와 tests/structure/*.sh 를 실행 / Runs tests/hooks/*.sh and tests/structure/*.sh
TEST_FILES=$(find "$SCRIPT_DIR/hooks" "$SCRIPT_DIR/structure" -name "test-*.sh" 2>/dev/null | sort)

if [ -z "$TEST_FILES" ]; then
    echo -e "${RED}No test files found under tests/hooks or tests/structure.${NC}"
    exit 1
fi

for test_file in $TEST_FILES; do
    test_name=$(basename "$test_file" .sh)
    if [ -n "$FILTER" ] && ! echo "$test_file" | grep -q "$FILTER"; then
        continue
    fi
    echo -e "${CYAN}# $test_name${NC}"
    # 테스트 파일은 source 됨 — 변수가 파일 간에 유지됨 / Test files are sourced — variables persist across files
    source "$test_file"
    echo ""
done

# --- 결과 요약 / Summary ---

echo -e "${CYAN}=== Results ===${NC}"
echo "1..$TOTAL"
echo -e "  Total:   $TOTAL"
echo -e "  ${GREEN}Passed:  $PASSED${NC}"
[ "$FAILED" -gt 0 ] && echo -e "  ${RED}Failed:  $FAILED${NC}" || echo -e "  Failed:  0"
[ "$SKIPPED" -gt 0 ] && echo -e "  ${YELLOW}Skipped: $SKIPPED${NC}" || echo -e "  Skipped: 0"

if [ "$FAILED" -gt 0 ]; then
    echo ""
    echo -e "${RED}=== Failures ===${NC}"
    for f in "${FAILURES[@]}"; do
        echo -e "  ${RED}not ok${NC} $f"
    done
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed.${NC}"
fi
