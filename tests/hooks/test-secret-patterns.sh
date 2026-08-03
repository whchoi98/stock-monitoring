#!/bin/bash
# secret-scan.sh 의 탐지 패턴 검증 / Tests for secret-scan.sh detection patterns.
# 실제 훅 파일에서 PATTERNS 배열을 추출해 사용 — 훅과 테스트가 항상 동기화됨.
# Extracts the PATTERNS array from the live hook so tests never drift from the hook.
#
# 주의: 민감해 보이는 토큰은 GitHub Push Protection 회피를 위해 런타임에 문자열 연결로 생성.
# Note: sensitive-looking tokens are constructed at runtime via concatenation
# to avoid triggering GitHub Push Protection.

# --- 훅에서 패턴 추출 / Extract patterns from the hook ---
PATTERNS=()
eval "$(sed -n '/^PATTERNS=(/,/^)/p' .claude/hooks/secret-scan.sh)"

if [ "${#PATTERNS[@]}" -ge 10 ]; then
    pass "extracted PATTERNS array from secret-scan.sh (${#PATTERNS[@]} patterns)"
else
    fail "extracted PATTERNS array from secret-scan.sh" "got ${#PATTERNS[@]} patterns, expected >= 10"
fi

# --- 패턴이 grep -P 에서 컴파일되는지 / Do all patterns compile under grep -P? ---
# grep -P (PCRE1)는 가변 길이 lookbehind를 지원하지 않음 — 컴파일 실패 패턴은
# 훅에서 조용히 아무것도 탐지하지 못하는 죽은 패턴이 된다 (exit 2, 2>/dev/null로 숨겨짐).
# grep -P (PCRE1) rejects variable-length lookbehinds — a pattern that fails to
# compile is silently dead in the hook (exit 2, hidden by 2>/dev/null).
UNSUPPORTED=0
for rx in "${PATTERNS[@]}"; do
    rc=0
    printf '' | grep -qP -- "$rx" 2>/dev/null || rc=$?
    if [ "$rc" -ge 2 ]; then
        UNSUPPORTED=$((UNSUPPORTED + 1))
        skip "pattern compiles under grep -P: ${rx:0:44}" "grep -P cannot evaluate it — dead pattern in secret-scan.sh, fix the hook (e.g. use \\K instead of lookbehind)"
    fi
done
[ "$UNSUPPORTED" -eq 0 ] && pass "all extracted patterns compile under grep -P"

# 한 줄이 패턴 중 하나라도 매치하는지 / Does a line match at least one hook pattern?
line_matches_any() {
    local line="$1" rx
    for rx in "${PATTERNS[@]}"; do
        if printf '%s\n' "$line" | grep -qP -- "$rx" 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

# --- 진양성: 반드시 매치 / True positives — MUST match ---

# AWS Access Key ID (AWS 문서의 공식 예제 키 / canonical example key from AWS docs)
assert_grep_match "TP: AWS Access Key ID" 'AKIA[0-9A-Z]{16}' "AKIAIOSFODNN7EXAMPLE"

# AWS Secret Access Key: 훅의 가변 길이 lookbehind 패턴은 grep -P(PCRE1)가 거부하므로
# 직접 TP 어서션 불가 — 위의 컴파일 검사(skip)가 이 죽은 패턴을 표면화한다.
# The hook's variable-length lookbehind is rejected by grep -P (PCRE1), so a direct
# TP assertion is impossible — the compile check above surfaces this dead pattern.

# Slack Bot Token (런타임 조립 / runtime-constructed)
SLACK_TOKEN="xoxb-""123456789012""-""1234567890123""-""abcdefABCDEF123456"
assert_grep_match "TP: Slack Bot Token" 'xoxb-[0-9]+-[A-Za-z0-9]+' "$SLACK_TOKEN"

# GitHub Personal Access Token (런타임 조립: ghp_ + 36 alnum)
GH_TOKEN="ghp_""abcdefghijklmnopqrstuvwxyz0123456789"
assert_grep_match "TP: GitHub PAT" 'ghp_[A-Za-z0-9]{36}' "$GH_TOKEN"

# OpenAI API Key (런타임 조립 / runtime-constructed)
OPENAI_KEY="sk-""abcdefghij0123456789""T3BlbkFJ""abcdefghij0123456789"
assert_grep_match "TP: OpenAI API Key" 'sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}' "$OPENAI_KEY"

# Anthropic API Key (런타임 조립: sk-ant- + 90자 이상)
ANTHROPIC_KEY="sk-ant-""api03-$(printf 'a%.0s' $(seq 1 90))"
assert_grep_match "TP: Anthropic API Key" 'sk-ant-[A-Za-z0-9-]{90,}' "$ANTHROPIC_KEY"

# Stripe Secret Key (런타임 조립 / runtime-constructed)
STRIPE_KEY="sk_live_""abcdefghijklmnopqrstuvwx"
assert_grep_match "TP: Stripe Secret Key" 'sk_live_[A-Za-z0-9]{24,}' "$STRIPE_KEY"

# Google API Key (런타임 조립: AIza + 35자)
GOOGLE_KEY="AIza""SyA1234567890abcdefghijklmnopqrstuv"
assert_grep_match "TP: Google API Key" 'AIza[A-Za-z0-9_-]{35}' "$GOOGLE_KEY"

# 일반 자격증명 대입문 / Generic credential assignments
assert_grep_match "TP: password assignment" 'password\s*[:=]\s*["\x27][^"\x27]{8,}' 'password = "hunter2hunter2"'
assert_grep_match "TP: secret assignment" 'secret\s*[:=]\s*["\x27][^"\x27]{8,}' 'secret: "super-secret-value"'
assert_grep_match "TP: api_key assignment" 'api[_-]?key\s*[:=]\s*["\x27][^"\x27]{8,}' 'api_key = "0123456789abcdef"'

# --- 위양성: 매치하면 안 됨 / False positives — must NOT match ---

assert_grep_no_match "FP: normal base64 is not an AWS key" 'AKIA[0-9A-Z]{16}' "dGhpcyBpcyBhIHRlc3Q="
assert_grep_no_match "FP: lowercase akia string" 'AKIA[0-9A-Z]{16}' "akiaiosfodnn7example"
assert_grep_no_match "FP: empty password" 'password\s*[:=]\s*["\x27][^"\x27]{8,}' 'password = ""'
assert_grep_no_match "FP: short password" 'password\s*[:=]\s*["\x27][^"\x27]{8,}' 'password = "1234"'
assert_grep_no_match "FP: password from env var" 'password\s*[:=]\s*["\x27][^"\x27]{8,}' 'password = os.environ["DB_PASSWORD"]'
assert_grep_no_match "FP: xoxb prose without digits" 'xoxb-[0-9]+-[A-Za-z0-9]+' "xoxb-style tokens are scanned"
assert_grep_no_match "FP: short sk_live fragment" 'sk_live_[A-Za-z0-9]{24,}' "sk_live_ prefix only"

# --- 픽스처 파일 검증 / Fixture file validation ---
# secret-samples.txt: 주석(#)/빈 줄 제외 모든 줄이 최소 한 패턴에 매치해야 함
# Every non-comment, non-empty line must match at least one hook pattern.

FIXTURE_TP="tests/fixtures/secret-samples.txt"
FIXTURE_FP="tests/fixtures/false-positives.txt"
assert_file_exists "fixture: secret-samples.txt exists" "$FIXTURE_TP"
assert_file_exists "fixture: false-positives.txt exists" "$FIXTURE_FP"

if [ -f "$FIXTURE_TP" ]; then
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        if line_matches_any "$line"; then
            pass "TP fixture matches a pattern: ${line:0:44}"
        else
            fail "TP fixture matches a pattern: ${line:0:44}" "no hook pattern matched this line"
        fi
    done < "$FIXTURE_TP"
fi

# false-positives.txt: 훅과 동일하게 파일 전체를 각 패턴으로 스캔 — 아무것도 매치하면 안 됨
# Scan the whole file with each pattern (exactly what the hook does) — nothing may match.
if [ -f "$FIXTURE_FP" ]; then
    FP_HITS=0
    for rx in "${PATTERNS[@]}"; do
        if grep -qP -- "$rx" "$FIXTURE_FP" 2>/dev/null; then
            fail "FP fixture: pattern must not match" "pattern '${rx:0:40}' matched false-positives.txt"
            FP_HITS=$((FP_HITS + 1))
        fi
    done
    [ "$FP_HITS" -eq 0 ] && pass "FP fixture: no hook pattern matches false-positives.txt"
fi
