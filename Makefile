build: ## frontend 빌드 → backend/static
	cd frontend && npm run build:deploy
run: build ## 통합 로컬 실행
	cd backend && .venv/bin/uvicorn app.main:app --port 8000
test: ## 백엔드+프론트 전체 — 한쪽이 실패해도 다른 쪽까지 돌리고 마지막에 실패 / run both suites, fail at the end if either failed
	@status=0; \
	(cd backend && .venv/bin/pytest -q) || status=1; \
	(cd frontend && npx vitest run) || status=1; \
	exit $$status
