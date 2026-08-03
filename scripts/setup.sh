#!/usr/bin/env bash
#
# 신규 개발자용 원커맨드 셋업 / One-command setup for new developers.
#
# Usage: bash scripts/setup.sh
#
# backend(venv+pip) → frontend(npm ci) → infra(venv+pip) 의존성 설치 후
# git 훅을 설치하고 `make test` 로 검증한다.
# Installs backend (venv+pip), frontend (npm ci), and infra (venv+pip)
# dependencies, installs git hooks, then verifies with `make test`.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== stock-monitoring setup ==="

# 필수 도구 확인 / Check prerequisites (Python 3.12+, Node 20+ 권장 / recommended)
for cmd in git python3 node npm make; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' is required" >&2; exit 1; }
done

# 프로젝트는 Python 3.12 대상 — `python3` 가 구버전(예: Amazon Linux 의 3.9)인 호스트가 있어
# python3.12 를 우선 선택한다. venv 생성에만 쓰이므로 이후 명령은 venv 경로를 사용한다.
# The project targets Python 3.12 — some hosts alias `python3` to an older build (e.g. 3.9 on
# Amazon Linux), so prefer python3.12 explicitly. Only venv creation uses this; everything
# afterwards goes through the venv paths.
PYTHON="$(command -v python3.12 || command -v python3)"
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || {
  echo "ERROR: Python 3.12+ is required (found: $("$PYTHON" --version 2>&1))" >&2; exit 1;
}

# --- [1/3] backend — Python 3.12 FastAPI --------------------------------------
echo "--- [1/3] backend: venv + dependencies ---"
if [ ! -d backend/.venv ]; then
  "$PYTHON" -m venv backend/.venv
fi
backend/.venv/bin/pip install --quiet --upgrade pip
# requirements-dev.txt 가 `-r requirements.txt` 를 포함한다 (런타임+개발 의존성 모두 설치)
# requirements-dev.txt pulls in requirements.txt (installs runtime + dev dependencies)
backend/.venv/bin/pip install -r backend/requirements-dev.txt

# --- [2/3] frontend — React 19 + TypeScript + Vite -----------------------------
echo "--- [2/3] frontend: npm ci ---"
(cd frontend && npm ci)

# --- [3/3] infra — Python CDK v2 (CLI는 venv에 고정 / CDK CLI pinned in venv) ---
echo "--- [3/3] infra: venv + dependencies ---"
if [ ! -d infra/.venv ]; then
  "$PYTHON" -m venv infra/.venv
fi
infra/.venv/bin/pip install --quiet --upgrade pip
infra/.venv/bin/pip install -r infra/requirements.txt

# --- 환경변수 / Environment -----------------------------------------------------
# 모든 변수는 선택 — 코드 기본값으로 로컬 실행 가능 / All optional — code defaults work locally.
if [ -f .env.example ] && [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (모든 변수는 선택 / all variables are optional)"
fi

# --- git 훅 / Git hooks ---------------------------------------------------------
if [ -d .claude/hooks ]; then
  chmod +x .claude/hooks/*.sh
fi
if git rev-parse --git-dir >/dev/null 2>&1; then
  # commit-msg 훅: Co-Authored-By 라인 제거 (AI를 contributor로 기록하지 않는 프로젝트 규칙)
  # commit-msg hook: strips Co-Authored-By lines (project rule: no AI contributors)
  bash scripts/install-hooks.sh
fi

# --- 검증 / Verify (backend pytest + frontend vitest) ---------------------------
echo "--- verify: make test ---"
make test

echo "=== Setup complete ==="
echo "Next steps:"
echo "  make run                      # 통합 로컬 실행 / run locally (http://localhost:8000)"
echo "  cd frontend && npm run dev    # 프론트 dev 서버 / frontend dev server"
echo "  CLAUDE.md, docs/              # 컨벤션·설계 문서 / conventions & design docs"
