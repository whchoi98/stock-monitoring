#!/bin/bash
# Claude Code 이벤트 발생 시 웹훅 알림 전송 / Send notifications via webhook on Claude Code events.
# Notification 이벤트로 트리거됨 / Triggered by Notification events.
# WEBHOOK_URL은 .env 또는 export로 설정 / Configure WEBHOOK_URL in .env or export it before use.

WEBHOOK_URL="${CLAUDE_NOTIFY_WEBHOOK:-}"
[ -z "$WEBHOOK_URL" ] && exit 0

EVENT="${1:-unknown}"
MESSAGE="${2:-Claude Code event occurred}"

# 페이로드 구성 / Build payload
PAYLOAD=$(cat <<EOF
{
  "text": "[$EVENT] $MESSAGE",
  "project": "$(basename "$(pwd)")",
  "branch": "$(git branch --show-current 2>/dev/null || echo 'unknown')",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

# 알림 전송 (논블로킹) / Send notification (non-blocking)
curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" > /dev/null 2>&1 &
