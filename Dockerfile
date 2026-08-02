# frontend 빌드 스테이지 - `npm ci` 레이어를 소스보다 먼저 캐시한다.
# Frontend build stage: the `npm ci` layer is cached ahead of the sources.
# `tsc -b`는 생략한다 (로컬 `build:deploy`와 동일 - 타입 검사는 CI/로컬 책임).
# `tsc -b` is skipped, matching the local `build:deploy`: type checking belongs to CI/local.
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build --outDir /web/dist

FROM python:3.12-slim
WORKDIR /srv
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
# app.main의 DEFAULT_STATIC_DIR은 app/의 부모 + "static" = /srv/static이다.
# `DEFAULT_STATIC_DIR` in app.main resolves to app/'s parent + "static" = /srv/static.
COPY --from=web /web/dist ./static
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/api/health')"
# `--workers 1`은 load-bearing이다: L1 캐시와 AI 전역 세마포어가 프로세스 단위다.
# `--workers 1` is load-bearing: the L1 cache and the AI global semaphore are per-process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
