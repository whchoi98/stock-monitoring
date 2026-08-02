build: ## frontend 빌드 → backend/static
	cd frontend && npm run build:deploy
run: build ## 통합 로컬 실행
	cd backend && .venv/bin/uvicorn app.main:app --port 8000
test:
	cd backend && .venv/bin/pytest -q
	cd frontend && npx vitest run
