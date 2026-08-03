#!/bin/bash
# 커밋 전 스테이징된 파일에서 시크릿 탐지 / Scan staged files for secrets before commit.
# PreToolUse 이벤트로 트리거됨 (matcher: Bash) / Triggered by PreToolUse event (matcher: Bash).
# 시크릿 발견 시 exit 1로 커밋 차단 / Exit 1 to block the commit if secrets are found.

SECRETS_FOUND=0

# 탐지 패턴 / Patterns to detect
PATTERNS=(
    'AKIA[0-9A-Z]{16}'                          # AWS Access Key ID
    # 가변 길이 lookbehind는 grep -P(PCRE1)가 거부 -> \K 로 매치 시작점만 리셋 (동일 의미)
    # A variable-length lookbehind is rejected by grep -P (PCRE1) -> \K resets the match start instead
    'aws_secret_access_key\s{0,5}[=:]\s{0,5}\K[A-Za-z0-9/+=]{40}' # AWS Secret Key (context-aware)
    'sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}' # OpenAI API Key
    'sk-ant-[A-Za-z0-9-]{90,}'                   # Anthropic API Key
    'ghp_[A-Za-z0-9]{36}'                        # GitHub Personal Access Token
    'gho_[A-Za-z0-9]{36}'                        # GitHub OAuth Token
    'github_pat_[A-Za-z0-9_]{82}'                # GitHub Fine-grained PAT
    'xoxb-[0-9]+-[A-Za-z0-9]+'                   # Slack Bot Token
    'xoxp-[0-9]+-[A-Za-z0-9]+'                   # Slack User Token
    'sk_live_[A-Za-z0-9]{24,}'                   # Stripe Secret Key
    'rk_live_[A-Za-z0-9]{24,}'                   # Stripe Restricted Key
    'AIza[A-Za-z0-9_-]{35}'                      # Google API Key
    'ya29\.[A-Za-z0-9_-]{50,}'                   # Google OAuth Token
    'DefaultEndpointsProtocol=https;Account'     # Azure Connection String
    'password\s*[:=]\s*["\x27][^"\x27]{8,}'      # Password assignments
    'secret\s*[:=]\s*["\x27][^"\x27]{8,}'        # Secret assignments
    'api[_-]?key\s*[:=]\s*["\x27][^"\x27]{8,}'   # API key assignments
)

# 제외 파일 / Files to skip
SKIP_PATTERNS=('.env.example' 'secret-scan.sh' '*.md' 'package-lock.json' 'yarn.lock')

# 스테이징된 파일 목록 / Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
[ -z "$STAGED_FILES" ] && exit 0

for file in $STAGED_FILES; do
    # 바이너리·제외 패턴 건너뜀 / Skip binary files and excluded patterns
    skip=false
    for pattern in "${SKIP_PATTERNS[@]}"; do
        [[ "$file" == $pattern ]] && skip=true && break
    done
    $skip && continue
    [ ! -f "$file" ] && continue

    for regex in "${PATTERNS[@]}"; do
        if grep -qP "$regex" "$file" 2>/dev/null; then
            echo "[secret-scan] Potential secret found in $file (pattern: ${regex:0:30}...)"
            SECRETS_FOUND=1
        fi
    done
done

if [ "$SECRETS_FOUND" -eq 1 ]; then
    echo ""
    echo "[secret-scan] BLOCKED: Potential secrets detected in staged files. / 스테이징된 파일에서 시크릿 의심 항목이 발견되었습니다."
    echo "[secret-scan] Review the files above and remove secrets before committing. / 위 파일을 확인하고 시크릿을 제거한 뒤 커밋하세요."
    echo "[secret-scan] Use .env files for secrets and .env.example for templates. / 시크릿은 .env, 템플릿은 .env.example을 사용하세요."
    exit 1
fi
