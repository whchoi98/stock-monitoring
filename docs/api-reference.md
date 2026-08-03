# API Reference

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#한국어"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="한국어"></a>

---

<a id="english"></a>

# English

## Base URL

| Environment | Base URL |
|-------------|----------|
| Production | `https://d2wa9w1vbqlndl.cloudfront.net` |
| Local (`make run`) | `http://localhost:8000` |

All API paths are prefixed with `/api`. Non-`/api` GET paths serve the React SPA (with `index.html` fallback for deep links).

## Authentication

None at the application level — the API serves public market data. Access control is enforced by the infrastructure instead: the ALB only accepts traffic from the CloudFront prefix list that carries the secret `X-Origin-Verify` header, so the origin cannot be called directly. The AI endpoints are additionally rate-limited per IP (see [Rate Limits](#rate-limits)).

## Response Envelope

Every data endpoint (everything except `/api/health`) wraps its payload:

```json
{
  "asOf": "2026-08-02T05:30:00+00:00",
  "marketOpen": true,
  "data": { }
}
```

- `asOf` — ISO 8601 timestamp of when the data was fetched (cache write time). For stock detail with a live-price overlay, it is the quote's timestamp.
- `marketOpen` — whether any tracked market (US or KR) is currently open.
- `data` — the endpoint-specific payload documented below.

## Symbols

Routes with a `{symbol}` path parameter only accept the fixed universe of **US 50 + KR 50** symbols (case-insensitive, normalized to upper case):

- US: plain tickers — `AAPL`, `MSFT`, `BRK-B`, …
- KR: 6-digit code + exchange suffix — `005930.KS` (KOSPI), `247540.KQ` (KOSDAQ)

Any other symbol returns `404 {"detail": "unknown symbol: <input>"}`. The full lists live in `backend/app/core/config.py` (`US_STOCKS`, `KR_STOCKS`).

## Endpoints

### Health

#### Get health
```
GET /api/health
```

Liveness endpoint used by the ALB target group and the ECS container health check. **Always returns 200** and never calls an external dependency. Not enveloped.

**Response** `200 OK`

```json
{
  "status": "ok",
  "sources": { "yahoo": "ok", "rss": "ok", "bedrock": "unknown" },
  "cacheAge": { "overview": 12, "quotes:us": 12, "quotes:kr": 12, "news:feed": 45 }
}
```

| Field | Description |
|-------|-------------|
| `sources` | Last-fetch status per upstream: `ok` \| `degraded` (last query failed, serving from cache) \| `unknown` (never queried) |
| `cacheAge` | Age in seconds of each pre-warmed cache key (read from L1 only); keys not yet warm are absent |

---

### Market

#### Get market overview
```
GET /api/market/overview
```

Indices (S&P 500, NASDAQ, DOW, KOSPI, KOSDAQ), economic indicators (WTI, gold, FX, US 10Y, BTC/ETH, …), market summary, and per-sector moves for both markets.

No parameters.

**Response** `200 OK` — envelope with `data`:

| Field | Type | Description |
|-------|------|-------------|
| `indices` | array | Index quotes |
| `indicators` | array | Economic indicator quotes |
| `summary` | object | Aggregated market summary (US + KR) |
| `sectors` | object | `{"us": [...], "kr": [...]}` sector aggregations |

**Caching**: key `overview`, stored TTL 24 h; pre-warmed by the scheduler every **45 s** (market open) / **600 s** (closed) — the scheduler, not the TTL, defines freshness.

**Errors**: `503 {"detail": "data unavailable: overview"}` when both cache (stale included) and upstream fail.

#### Get market quotes
```
GET /api/market/quotes?market=us
```

One market's 50-symbol quote table.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `market` | `"us"` \| `"kr"` | Yes | Any other value → `422` |

**Response** `200 OK` — envelope; `data` is an array of quote objects (`symbol`, `name`, `price`, `change`, `change_pct`, `volume`, `market_cap`, `sector`, …).

**Caching**: key `quotes:{market}`, stored TTL 24 h; pre-warmed every **45 s** open / **600 s** closed. `market_cap` refreshes on its own 600 s window.

#### Get news feed
```
GET /api/market/news
```

Aggregated RSS feed (Yahoo Finance, Hankyung, MK).

**Response** `200 OK` — envelope; `data` is an array of news items (`title`, `link`, `source`, `published`, …).

**Caching**: key `news:feed`, stored TTL 24 h; pre-warmed every **120 s** open / **600 s** closed.

---

### Stocks

All routes below take `{symbol}` (see [Symbols](#symbols); unknown → `404`).

#### Get stock detail
```
GET /api/stocks/{symbol}
```

Detail header, key ratios (P/E, EPS, P/B, beta), 52-week range, market cap, sector, and period returns.

**Response** `200 OK` — envelope; `data` is the detail object.

**Caching**: fundamentals under key `detail:{symbol}`, TTL **12 h** (`FUNDAMENTALS_TTL=43200`). Price-like fields (`price`, `change`, `change_pct`, `volume`, plus the `day_change`/`day_change_pct` mirrors) are **overlaid at request time** from the `quotes:{market}` L1 cache (45 s refresh); when overlaid, `asOf` is the quote's timestamp. If the L1 quote is missing, the cached detail's own price serves as fallback (not an error).

#### Get stock chart
```
GET /api/stocks/{symbol}/chart?period=1m
```

OHLCV candles plus MA5/MA20 and golden/dead-cross signals.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `period` | `"1w"` \| `"1m"` \| `"3m"` \| `"1y"` | No (default `1m`) | Any other value → `422` |

**Response** `200 OK` — envelope; `data` contains `candles` (`time`, `open`, `high`, `low`, `close`, `volume`), moving averages, and cross signals.

**Caching**: key `chart:{symbol}:{period}` with per-period TTL:

| Period | TTL |
|--------|-----|
| `1w` | 600 s (10 min) |
| `1m` | 3600 s (1 h) |
| `3m` | 21600 s (6 h) |
| `1y` | 86400 s (24 h) |

#### Get stock news
```
GET /api/stocks/{symbol}/news
```

Up to eight per-symbol news items.

**Response** `200 OK` — envelope; `data` is an array of news items.

**Caching**: key `news:{symbol}`, TTL **24 h** (`L2_TTL=86400`; not pre-warmed — fetched on first request).

#### Get order book (simulated)
```
GET /api/stocks/{symbol}/orderbook
```

Order book **simulated** from the current price — not real depth. Deterministic: seed = `price × 100`, so a given price always yields the same book.

**Response** `200 OK` — envelope; `data`:

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | Normalized symbol |
| `market` | string | `us` \| `kr` |
| `price` | number | Live price the book was built from |
| `entries` | array | Bid/ask levels |
| `simulated` | boolean | Always `true` |

**Caching**: derives from the detail view (12 h fundamentals + 45 s live-price overlay); the book itself is computed per request.

#### Get investor flows (simulated)
```
GET /api/stocks/{symbol}/investors
```

Ten days of investor flows **derived** from daily volume and close direction — not real data.

**Response** `200 OK` — envelope; `data`: `symbol`, `market`, `rows` (10 daily rows), `simulated: true`.

**Caching**: derives from the `1m` chart cache (TTL 1 h).

---

### AI (Bedrock)

Both routes call Amazon Bedrock (`global.anthropic.claude-sonnet-4-6`) and are the only endpoints that cost money. They are defended in this order: **(1) per-IP rate limit → (2) result cache → (3) global concurrency cap (2)**. The rate limit precedes the cache, so even cache hits spend budget. Error bodies are fixed strings — exception details never reach the client.

#### Analyze stock
```
POST /api/ai/stocks/{symbol}
```

AI stock analysis as Korean markdown. **No request body.** Prompt inputs (price, P/E, 52-week range, sector, recent news titles) come from the already-cached detail and per-symbol news.

**Response** `200 OK` — envelope; `data`:

```json
{ "symbol": "AAPL", "analysis": "## 요약\n..." }
```

**Caching**: key `ai:stock:{symbol}`, TTL **6 h** (`AI_TTL=21600`). Concurrent requests for the same symbol trigger a single Bedrock call (per-key lock).

**Errors**: `404` unknown symbol · `429` rate limited · `503 {"detail": "ai_unavailable"}` (no credentials / no model access) · `500 {"detail": "ai_failed"}` (any other failure).

#### Analyze article
```
POST /api/ai/articles
```

Article summary, insights, and (for English articles) Korean translation, as Korean markdown. The server fetches the article body itself — SSRF guards apply (public http/https hosts only, 256 KB cap).

**Request Body**

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `url` | string | Yes | 1–2048 chars | Article URL (server-fetched) |
| `title` | string | Yes | 1–512 chars | Article title (goes into the prompt) |
| `language` | `"ko"` \| `"en"` | Yes | | `ko`: summary/analysis only; `en`: adds Korean translation |

**Response** `200 OK` — envelope; `data`:

```json
{ "url": "https://…", "title": "…", "language": "en", "analysis": "## 요약\n..." }
```

**Caching**: key `ai:article:{sha1(url)[:16]}` — **URL only**, TTL **6 h**. Re-requesting the same URL with a different title returns the first analysis.

**Errors**: `422` body validation · `429` rate limited · `502 {"detail": "article_unavailable"}` (article body could not be obtained — not cached, Bedrock not called) · `503 ai_unavailable` · `500 ai_failed`.

## Error Codes

| Code | Where | Body / Meaning |
|------|-------|----------------|
| 403 | ALB direct access | `Forbidden` — request bypassed CloudFront (no `X-Origin-Verify`) |
| 404 | `{symbol}` routes | `{"detail": "unknown symbol: <input>"}` — outside the US 50 + KR 50 universe |
| 422 | Any validated param/body | FastAPI validation error (bad `market`, `period`, or article body) |
| 429 | AI routes | `{"detail": "rate_limited", "retryAfter": 60}` + `Retry-After: 60` header |
| 500 | AI routes | `{"detail": "ai_failed"}` — Bedrock call failed (non-availability) |
| 502 | `POST /api/ai/articles` | `{"detail": "article_unavailable"}` — article body unobtainable |
| 503 | Data routes | `{"detail": "data unavailable: <key>"}` — cache (stale included) and upstream both failed |
| 503 | AI routes | `{"detail": "ai_unavailable"}` — no credentials or model access |
| 503 | Any (except health) | `{"detail": "app_not_ready"}` — app context not initialized |

<a id="rate-limits"></a>
## Rate Limits

Only the AI routes are rate-limited:

| Scope | Limit | Mechanism |
|-------|-------|-----------|
| Per IP | **3 requests / 60 s** sliding window (`AI_RATE_PER_MIN`) | Keyed on `CloudFront-Viewer-Address` (CloudFront-generated, unforgeable); falls back to first `X-Forwarded-For` entry, then socket address, off CloudFront only |
| Global | **2 concurrent Bedrock calls** (`AI_GLOBAL_CONCURRENCY`) | Process-wide `asyncio.Semaphore` |

Notes:

- The limit is checked **before** the cache: cache hits also consume budget, so one IP cannot poll without bound.
- On `429`, wait the `retryAfter` seconds (also sent as the `Retry-After` header) before retrying.
- The 6 h result cache means repeated analyses of the same symbol/URL are served without a Bedrock call.

---

<a id="한국어"></a>

# 한국어

## Base URL

| 환경 | Base URL |
|------|----------|
| 프로덕션 | `https://d2wa9w1vbqlndl.cloudfront.net` |
| 로컬 (`make run`) | `http://localhost:8000` |

모든 API 경로는 `/api` 프리픽스를 갖는다. `/api`가 아닌 GET 경로는 React SPA를 서빙한다 (딥링크는 `index.html` fallback).

## 인증

애플리케이션 레벨 인증은 없다 — 공개 시장 데이터를 서빙한다. 접근 제어는 인프라가 담당한다: ALB는 시크릿 `X-Origin-Verify` 헤더를 가진 CloudFront prefix list 트래픽만 받으므로 오리진을 직접 호출할 수 없다. AI 엔드포인트는 추가로 IP당 레이트리밋이 걸린다 ([레이트리밋](#레이트리밋) 참조).

## 응답 Envelope

모든 데이터 엔드포인트(`/api/health` 제외)는 페이로드를 다음과 같이 감싼다:

```json
{
  "asOf": "2026-08-02T05:30:00+00:00",
  "marketOpen": true,
  "data": { }
}
```

- `asOf` — 데이터를 조회한 시각(캐시 기록 시각)의 ISO 8601 타임스탬프. 가격 오버레이가 적용된 종목 상세에서는 시세의 타임스탬프다.
- `marketOpen` — 추적 중인 시장(미국 또는 한국) 중 하나라도 장중인지 여부.
- `data` — 아래에 문서화된 엔드포인트별 페이로드.

## 심볼

`{symbol}` 경로 파라미터를 받는 라우트는 **미국 50 + 한국 50** 고정 유니버스만 허용한다 (대소문자 무관, 대문자로 정규화):

- 미국: 일반 티커 — `AAPL`, `MSFT`, `BRK-B`, …
- 한국: 6자리 코드 + 거래소 접미사 — `005930.KS`(KOSPI), `247540.KQ`(KOSDAQ)

그 외 심볼은 `404 {"detail": "unknown symbol: <입력값>"}`을 반환한다. 전체 목록은 `backend/app/core/config.py`(`US_STOCKS`, `KR_STOCKS`)에 있다.

## 엔드포인트

### Health

#### 헬스 조회
```
GET /api/health
```

ALB 타깃 그룹과 ECS 컨테이너 헬스체크가 사용하는 생존 판정 엔드포인트. **항상 200**을 반환하며 외부 의존성을 호출하지 않는다. envelope 미적용.

**응답** `200 OK`

```json
{
  "status": "ok",
  "sources": { "yahoo": "ok", "rss": "ok", "bedrock": "unknown" },
  "cacheAge": { "overview": 12, "quotes:us": 12, "quotes:kr": 12, "news:feed": 45 }
}
```

| 필드 | 설명 |
|------|------|
| `sources` | 업스트림별 최근 조회 상태: `ok` \| `degraded`(최근 조회 실패, 캐시로 서빙 중) \| `unknown`(조회 이력 없음) |
| `cacheAge` | 선제 갱신 캐시 키별 age(초, L1만 조회); 아직 채워지지 않은 키는 빠진다 |

---

### Market

#### 시장 개요 조회
```
GET /api/market/overview
```

지수(S&P 500, NASDAQ, DOW, KOSPI, KOSDAQ), 경제지표(WTI, 금, 환율, 미국 10년물, BTC/ETH 등), 시장 요약, 양 시장의 섹터 등락.

파라미터 없음.

**응답** `200 OK` — envelope, `data`:

| 필드 | 타입 | 설명 |
|------|------|------|
| `indices` | array | 지수 시세 |
| `indicators` | array | 경제지표 시세 |
| `summary` | object | 시장 요약 집계 (미국 + 한국) |
| `sectors` | object | `{"us": [...], "kr": [...]}` 섹터별 집계 |

**캐싱**: 키 `overview`, 저장 TTL 24시간; 스케줄러가 **45초**(장중) / **600초**(휴장) 주기로 선제 갱신 — 신선도는 TTL이 아니라 스케줄러가 결정한다.

**오류**: 캐시(stale 포함)와 업스트림이 모두 실패하면 `503 {"detail": "data unavailable: overview"}`.

#### 시장 시세 조회
```
GET /api/market/quotes?market=us
```

한 시장의 50종목 시세 테이블.

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `market` | `"us"` \| `"kr"` | 예 | 그 외 값 → `422` |

**응답** `200 OK` — envelope; `data`는 시세 객체 배열 (`symbol`, `name`, `price`, `change`, `change_pct`, `volume`, `market_cap`, `sector`, …).

**캐싱**: 키 `quotes:{market}`, 저장 TTL 24시간; **45초**(장중) / **600초**(휴장) 주기 선제 갱신. `market_cap`은 별도 600초 창에서 갱신된다.

#### 뉴스 피드 조회
```
GET /api/market/news
```

통합 RSS 피드 (Yahoo Finance, 한국경제, 매일경제).

**응답** `200 OK` — envelope; `data`는 뉴스 항목 배열 (`title`, `link`, `source`, `published`, …).

**캐싱**: 키 `news:feed`, 저장 TTL 24시간; **120초**(장중) / **600초**(휴장) 주기 선제 갱신.

---

### Stocks

아래 모든 라우트는 `{symbol}`을 받는다 ([심볼](#심볼) 참조; 유니버스 밖 → `404`).

#### 종목 상세 조회
```
GET /api/stocks/{symbol}
```

상세 헤더, 핵심지표(PER, EPS, PBR, 베타), 52주 범위, 시가총액, 섹터, 기간수익률.

**응답** `200 OK` — envelope; `data`는 상세 객체.

**캐싱**: 펀더멘털은 키 `detail:{symbol}`, TTL **12시간**(`FUNDAMENTALS_TTL=43200`). 가격 계열 필드(`price`, `change`, `change_pct`, `volume`과 미러 필드 `day_change`/`day_change_pct`)는 **요청 시점에** `quotes:{market}` L1 캐시(45초 갱신)에서 덮어쓴다; 덮어쓴 경우 `asOf`는 시세의 타임스탬프다. L1에 시세가 없으면 캐시된 상세의 가격으로 폴백한다(오류 아님).

#### 종목 차트 조회
```
GET /api/stocks/{symbol}/chart?period=1m
```

OHLCV 캔들 + MA5/MA20 + 골든/데드 크로스 신호.

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `period` | `"1w"` \| `"1m"` \| `"3m"` \| `"1y"` | 아니오 (기본 `1m`) | 그 외 값 → `422` |

**응답** `200 OK` — envelope; `data`는 `candles`(`time`, `open`, `high`, `low`, `close`, `volume`), 이동평균, 크로스 신호 포함.

**캐싱**: 키 `chart:{symbol}:{period}`, 기간별 TTL:

| 기간 | TTL |
|------|-----|
| `1w` | 600초 (10분) |
| `1m` | 3600초 (1시간) |
| `3m` | 21600초 (6시간) |
| `1y` | 86400초 (24시간) |

#### 종목 뉴스 조회
```
GET /api/stocks/{symbol}/news
```

종목별 뉴스 최대 8건.

**응답** `200 OK` — envelope; `data`는 뉴스 항목 배열.

**캐싱**: 키 `news:{symbol}`, TTL **24시간**(`L2_TTL=86400`; 선제 갱신 없음 — 첫 요청 시 조회).

#### 호가 조회 (시뮬레이션)
```
GET /api/stocks/{symbol}/orderbook
```

현재가에서 **시뮬레이션**한 호가 — 실제 호가 아님. 결정적: 시드 = `현재가 × 100`이므로 같은 가격은 항상 같은 호가를 만든다.

**응답** `200 OK` — envelope; `data`:

| 필드 | 타입 | 설명 |
|------|------|------|
| `symbol` | string | 정규화된 심볼 |
| `market` | string | `us` \| `kr` |
| `price` | number | 호가 생성에 사용한 실시간 가격 |
| `entries` | array | 매수/매도 호가 단계 |
| `simulated` | boolean | 항상 `true` |

**캐싱**: 상세 뷰(12시간 펀더멘털 + 45초 가격 오버레이)에서 파생; 호가 자체는 요청마다 계산된다.

#### 수급 조회 (시뮬레이션)
```
GET /api/stocks/{symbol}/investors
```

일봉 거래량·종가 방향에서 **파생**한 수급 10일치 — 실데이터 아님.

**응답** `200 OK` — envelope; `data`: `symbol`, `market`, `rows`(일별 10행), `simulated: true`.

**캐싱**: `1m` 차트 캐시(TTL 1시간)에서 파생.

---

### AI (Bedrock)

두 라우트 모두 Amazon Bedrock(`global.anthropic.claude-sonnet-4-6`)을 호출하며 비용이 드는 유일한 엔드포인트다. 방어 순서: **① IP당 레이트리밋 → ② 결과 캐시 → ③ 전역 동시 실행 제한(2)**. 레이트리밋이 캐시보다 앞이라 캐시 히트도 예산을 소비한다. 오류 본문은 고정 문구다 — 예외 상세는 절대 클라이언트로 나가지 않는다.

#### 종목 분석
```
POST /api/ai/stocks/{symbol}
```

한국어 마크다운 형식의 AI 종목 분석. **요청 본문 없음.** 프롬프트 입력(가격, PER, 52주 범위, 섹터, 최근 뉴스 제목)은 이미 캐시된 상세·종목뉴스에서 가져온다.

**응답** `200 OK` — envelope; `data`:

```json
{ "symbol": "AAPL", "analysis": "## 요약\n..." }
```

**캐싱**: 키 `ai:stock:{symbol}`, TTL **6시간**(`AI_TTL=21600`). 같은 심볼의 동시 요청은 Bedrock을 한 번만 호출한다(키별 락).

**오류**: `404` 유니버스 밖 심볼 · `429` 레이트리밋 · `503 {"detail": "ai_unavailable"}`(자격 증명/모델 접근 불가) · `500 {"detail": "ai_failed"}`(그 외 실패).

#### 기사 분석
```
POST /api/ai/articles
```

기사 요약·인사이트와 (영문 기사는) 한국어 번역을 한국어 마크다운으로. 서버가 기사 본문을 직접 조회한다 — SSRF 가드 적용(공개 http/https 호스트만, 256KB 캡).

**요청 본문**

| 필드 | 타입 | 필수 | 제약 | 설명 |
|------|------|------|------|------|
| `url` | string | 예 | 1–2048자 | 기사 URL (서버가 조회) |
| `title` | string | 예 | 1–512자 | 기사 제목 (프롬프트에 포함) |
| `language` | `"ko"` \| `"en"` | 예 | | `ko`: 요약·분석만; `en`: 한국어 번역 추가 |

**응답** `200 OK` — envelope; `data`:

```json
{ "url": "https://…", "title": "…", "language": "en", "analysis": "## 요약\n..." }
```

**캐싱**: 키 `ai:article:{sha1(url)[:16]}` — **URL만** 사용, TTL **6시간**. 같은 URL을 다른 제목으로 재요청하면 먼저 생성된 분석이 반환된다.

**오류**: `422` 본문 검증 실패 · `429` 레이트리밋 · `502 {"detail": "article_unavailable"}`(기사 본문 조회 실패 — 캐시하지 않으며 Bedrock도 호출하지 않음) · `503 ai_unavailable` · `500 ai_failed`.

## 오류 코드

| 코드 | 위치 | 본문 / 의미 |
|------|------|-------------|
| 403 | ALB 직접 접근 | `Forbidden` — CloudFront를 우회한 요청 (`X-Origin-Verify` 없음) |
| 404 | `{symbol}` 라우트 | `{"detail": "unknown symbol: <입력값>"}` — 미국 50 + 한국 50 유니버스 밖 |
| 422 | 검증되는 파라미터/본문 | FastAPI 검증 오류 (잘못된 `market`, `period`, 기사 본문) |
| 429 | AI 라우트 | `{"detail": "rate_limited", "retryAfter": 60}` + `Retry-After: 60` 헤더 |
| 500 | AI 라우트 | `{"detail": "ai_failed"}` — Bedrock 호출 실패 (가용성 외 원인) |
| 502 | `POST /api/ai/articles` | `{"detail": "article_unavailable"}` — 기사 본문 조회 불가 |
| 503 | 데이터 라우트 | `{"detail": "data unavailable: <key>"}` — 캐시(stale 포함)와 업스트림 모두 실패 |
| 503 | AI 라우트 | `{"detail": "ai_unavailable"}` — 자격 증명 또는 모델 접근 불가 |
| 503 | 전체 (health 제외) | `{"detail": "app_not_ready"}` — 앱 컨텍스트 미초기화 |

<a id="레이트리밋"></a>
## 레이트리밋

AI 라우트에만 레이트리밋이 적용된다:

| 범위 | 한도 | 메커니즘 |
|------|------|----------|
| IP당 | **60초 슬라이딩 윈도우당 3회** (`AI_RATE_PER_MIN`) | `CloudFront-Viewer-Address` 기준(CloudFront 생성, 위조 불가); CloudFront를 거치지 않을 때만 `X-Forwarded-For` 첫 항목 → 소켓 주소 순 폴백 |
| 전역 | **Bedrock 동시 호출 2건** (`AI_GLOBAL_CONCURRENCY`) | 프로세스 전역 `asyncio.Semaphore` |

참고:

- 한도 검사가 캐시보다 **앞**이다: 캐시 히트도 예산을 소비하므로 한 IP가 무한히 폴링할 수 없다.
- `429`를 받으면 `retryAfter`초(응답의 `Retry-After` 헤더와 동일) 후 재시도한다.
- 결과 캐시가 6시간이므로 같은 심볼/URL의 반복 분석은 Bedrock 호출 없이 서빙된다.
