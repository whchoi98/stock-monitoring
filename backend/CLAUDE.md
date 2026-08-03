# Backend Module (FastAPI)

## 역할 / Role
Yahoo Finance(yfinance) 시세·차트·재무·뉴스 + Bedrock AI 분석 API. SPA 정적 빌드(`static/`)도 함께 서빙.
FastAPI app serving market data, news, and Bedrock AI analysis; also serves the SPA build.

## 레이어링 / Layering (api → services → cache)
- `app/api/` — 라우터(ai, health, market, stocks) + `deps.py`, `ratelimit.py`. 라우터는 yfinance를 직접 호출하지 않는다.
- `app/services/` — market_data, charts, fundamentals, news, bedrock_ai, simulation, summary. yfinance 함수는 전부 동기이므로 호출부에서 `asyncio.to_thread`로 감싼다.
- `app/cache/` — `memory.py`(L1) / `dynamo.py`(L2, TTL) / `tiered.py`(오케스트레이션).
- `app/core/` — config, scheduler(백그라운드 갱신 루프), market_hours. `app/state.py`의 `AppState`가 `app.state.ctx`로 주입된다.

## 핵심 규칙 / Key Rules
- **Tiered cache + single-flight**: L1 → L2 → fetch → L2 stale fallback. 키별 락으로 콜드 키 동시 요청도 upstream fetch는 1회만. 락 맵은 in-flight 수에 비례해야 한다(`ai:article:{sha1(url)}`처럼 키 우주가 무한한 경우 존재).
- **가격 오버레이 / Price overlay**: quotes 캐시(60s)가 detail 캐시(600s)의 price/change/volume을 응답 시 덮어쓴다 — `api/stocks.py`의 `overlay_live_price`. AI 분석(`api/ai.py`)도 오버레이된 detail을 쓴다(화면과 같은 가격으로 분석).
- **AI 레이트리밋 키**: `CloudFront-Viewer-Address` 헤더 (XFF는 위조 가능 — 사용 금지). 3회/분/IP, `SlidingWindowLimiter`(단조 시계, 프로세스 로컬 — Fargate 태스크별 적용).
- **`services/news.py` 보안 가드 — 절대 완화 금지 / never weaken**:
  - 클라이언트 제공 URL fetch에 SSRF 가드(사설/내부 IP 차단) + 2MB 스트리밍 캡
    (2026-08-03 사용자 승인으로 256KB에서 상향 — 실측 Yahoo 기사 ~856KB, 본문 오프셋 ~310KB로
    옛 값이 기사 분석을 전멸시켰음. 캡은 유한해야 하며 선언 content-length가 아니라 **실제 읽은
    바이트**에 걸린다 — 선언값 사전 거부는 같은 회귀를 재도입하므로 금지).
  - regex 백트래킹 상한 `[^<>]{0,1000}` (O(n²) DoS 차단), RSS 파싱은 `defusedxml`만 (XXE/엔티티 확장 차단).
- **워커는 정확히 1개** (`uvicorn app.main:app`): L1 캐시와 AI 전역 세마포어가 프로세스 단위 — 워커를 늘리면 캐시 분열 + 동시 실행 상한 붕괴.
- `create_app(background=False)`가 기본 — 테스트는 절대 `background=True`를 쓰지 않는다 (네트워크/AWS 미접촉). L2 연결 실패는 기동을 막지 않는다(NullL2 유지, 로컬 개발).
- 정적 마운트(`/`)는 항상 마지막 라우트. API 404는 index.html로 재작성하지 않는다.

## 명령 / Commands
```bash
cd backend && .venv/bin/pytest -q   # 테스트 (295개, 오프라인)
make run                             # 로컬 실행 (repo 루트, :8000)
```

## 컨벤션 / Conventions
- 주석·docstring은 한국어+영어 병기 (기존 스타일 유지) / Comments and docstrings are bilingual ko+en.
- 타입힌트 필수, async 우선. 실패는 조용히 삼키지 않고 단일 라인 JSON 로그(`_warn`/`_info` 패턴).
- 환경변수 기본값은 `app/core/config.py` 참조 — `CACHE_TABLE`, `BEDROCK_REGION`은 인프라가 주입.
