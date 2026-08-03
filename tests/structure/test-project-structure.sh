#!/bin/bash
# 프로젝트 스캐폴딩 구조 검증 / Project scaffolding structure tests.
# stock-monitoring: Python FastAPI backend/ + React Vite frontend/ + CDK infra/
# 앱 코드가 아니라 Claude Code 하네스(문서·훅·스킬·커맨드) 산출물을 검증한다.
# Validates the Claude Code harness output (docs, hooks, skills, commands), not app code.

# --- 루트 파일 / Root files ---
ROOT_FILES=(CLAUDE.md README.md CHANGELOG.md LICENSE .mcp.json .editorconfig .env.example)
for f in "${ROOT_FILES[@]}"; do
    assert_file_exists "root: $f" "$f"
done

assert_json_valid ".mcp.json is valid JSON" ".mcp.json"

# --- 핵심 문서 / Core docs ---
for f in docs/architecture.md docs/api-reference.md docs/onboarding.md; do
    assert_file_exists "docs: $f" "$f"
done

# --- 구현 레퍼런스 문서 (사용자 확인 8개 레이어) / Implementation reference docs (8 user-confirmed layers) ---
assert_file_exists "docs/reference/INDEX.md" "docs/reference/INDEX.md"
LAYERS=(infrastructure data api iac frontend ui security agent-llm)
for layer in "${LAYERS[@]}"; do
    assert_file_exists "layer doc: docs/reference/$layer.md" "docs/reference/$layer.md"
done

# --- ADR·런북 템플릿 / ADR and runbook templates ---
assert_file_exists "docs/decisions/.template.md" "docs/decisions/.template.md"
assert_file_exists "docs/runbooks/.template.md" "docs/runbooks/.template.md"

# --- .claude 설정 / .claude configuration ---
assert_file_exists ".claude/settings.json" ".claude/settings.json"
assert_json_valid ".claude/settings.json is valid JSON" ".claude/settings.json"

# --- 스킬 4종 / 4 skills ---
SKILLS=(code-review refactor release sync-docs)
for skill in "${SKILLS[@]}"; do
    assert_file_exists "skill: $skill/SKILL.md" ".claude/skills/$skill/SKILL.md"
done

# --- 커맨드 3종 (frontmatter 포함) / 3 commands with frontmatter ---
COMMANDS=(deploy review test-all)
for cmd in "${COMMANDS[@]}"; do
    assert_file_exists "command: $cmd.md" ".claude/commands/$cmd.md"
    if [ -f ".claude/commands/$cmd.md" ]; then
        assert_file_contains "command $cmd: has description" ".claude/commands/$cmd.md" "description:"
        assert_file_contains "command $cmd: has allowed-tools" ".claude/commands/$cmd.md" "allowed-tools:"
    fi
done

# --- 에이전트 YML 2종 / 2 agent YMLs ---
AGENT_YML_COUNT=$(find .claude/agents -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$AGENT_YML_COUNT" -ge 2 ]; then
    pass ".claude/agents has >= 2 agent YMLs ($AGENT_YML_COUNT found)"
else
    fail ".claude/agents has >= 2 agent YMLs" "found $AGENT_YML_COUNT yml/yaml file(s) in .claude/agents"
fi

# --- 모듈 CLAUDE.md / Module CLAUDE.md files ---
for module in backend frontend infra; do
    assert_file_exists "module doc: $module/CLAUDE.md" "$module/CLAUDE.md"
done

# --- 스크립트 / Scripts ---
for script in scripts/setup.sh scripts/install-hooks.sh scripts/smoke.sh; do
    assert_file_exists "script: $script" "$script"
    if [ -f "$script" ]; then
        assert_file_executable "$script is executable" "$script"
        assert_bash_syntax "$script valid bash" "$script"
    fi
done

# --- 루트 CLAUDE.md 내용 / Root CLAUDE.md content ---
assert_file_contains "CLAUDE.md: has Auto-Sync Rules section" "CLAUDE.md" "Auto-Sync Rules"
assert_file_contains "CLAUDE.md: has AUTO-MANAGED:references open marker" "CLAUDE.md" "<!-- AUTO-MANAGED:references -->"
assert_file_contains "CLAUDE.md: has AUTO-MANAGED close marker" "CLAUDE.md" "<!-- /AUTO-MANAGED:references -->"

# --- README 이중 언어 앵커 / README bilingual anchors ---
assert_file_contains "README: has #english anchor" "README.md" "#english"
assert_file_contains "README: has #korean anchor" "README.md" "#korean"
