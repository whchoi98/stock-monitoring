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
- **가격 오버레이 / Price overlay**: detail 캐시(`FUNDAMENTALS_TTL` 12h)의 price/change/change_pct/volume을 응답 시 `quotes:{market}` 캐시(스케줄러가 장중 45s/휴장 600s마다 재기록, 오버레이는 L1에서만 읽음)로 덮어쓴다 — 느린 펀더멘털 + 실시간 가격. `api/stocks.py`의 `overlay_live_price`. AI 분석(`api/ai.py`)도 오버레이된 detail을 쓴다(화면과 같은 가격으로 분석).
- **AI 레이트리밋 키**: `CloudFront-Viewer-Address` 헤더 (XFF는 위조 가능 — 사용 금지). 3회/분/IP, `SlidingWindowLimiter`(단조 시계, 프로세스 로컬 — Fargate 태스크별 적용).
- **AI 라우트는 SSE**: `POST /api/ai/stocks/{symbol}`·`POST /api/ai/articles`는 `text/event-stream`으로 `phase` → `delta`* → `final`을 보내며 `final`은 성공·실패·캐시 히트 어느 경로에서도 항상 나간다. 스트림 시작 전에 JSON으로 끝나는 것은 429(레이트리밋)·422(본문 검증)·404(유니버스 밖 심볼)뿐. Bedrock 호출 프리미티브는 `services/bedrock_ai.stream_invoke`(`converse_stream`) 하나 — IAM에 `bedrock:InvokeModelWithResponseStream`이 필요하다(2026-08-04 라이브 장애). / Both AI routes stream SSE and always end with `final`; only 429/422/404 stay JSON; the sole Bedrock primitive is `stream_invoke` over `converse_stream`.
- **AI 자유 질의 `{question}`**: 종목 라우트의 선택 본문(`StockQuestionRequest`). `max_length=200`은 원문에 먼저 걸리고, `normalize_question`이 제어문자 제거 → `<`/`>` 전각화 → 공백 접기 → trim, 빈 결과는 422. 캐시 키는 `ai:stock:{sym}` 또는 `ai:stock:{sym}:q:{sha256(정규화 질문)[:16]}`(원문은 키에 넣지 않음), 프롬프트에서는 `<question>` 울타리 안에 격리(`QUESTION_LIMIT` 200으로 재절단·전각화). 레이트리밋·세마포어는 질문 유무와 무관. / Optional question body: normalised, hashed into its own cache key, fenced in the prompt; limits unchanged.
- **한글 종목명 `name_ko`**: `config.STOCK_NAMES_KO`(US/KR 관용 표기 중 한글 음절이 있는 이름만 — KT·LG·HMM 같은 라틴 폴백은 제외되어 None)가 `Quote.name_ko`(market_data)·`StockDetailResponse.name_ko`(fundamentals)를 채운다. 프론트 한글·초성 검색의 데이터 소스. / Hangul-only Korean names fill the optional `name_ko` on quotes and detail.
- **`services/news.py` 보안 가드 — 절대 완화 금지 / never weaken**:
  - 클라이언트 제공 URL fetch에 SSRF 가드(사설/내부 IP 차단) + 2MB 스트리밍 캡
    (2026-08-03 사용자 승인으로 256KB에서 상향 — 실측 Yahoo 기사 ~856KB, 본문 오프셋 ~310KB로
    옛 값이 기사 분석을 전멸시켰음. 캡은 유한해야 하며 선언 content-length가 아니라 **실제 읽은
    바이트**에 걸린다 — 선언값 사전 거부는 같은 회귀를 재도입하므로 금지). 읽기는 **원시 스트림**
    (`aiter_raw()`)에서 하고 압축 해제는 `DECOMPRESS_STEP`(64KB) 스텝으로 묶는다 — `aiter_bytes()`는
    청크 1개를 통째로 해제해 원시 64KB 읽기가 ~1029:1로 부풀 수 있었다(실측 청크 67MB, peak 148.6MB
    — 2026-08-04 리뷰 F4). 카운터는 2개다: 해제된 바이트(캡) + **원시 읽기 바이트**(`MAX_RAW_READ_BYTES`
    = 캡×8) — 해제 출력이 0인 스트림(끝나지 않는 gzip FNAME, deflate 빈 stored block 반복)은 캡을
    건드리지 못해 데드라인까지 무제한 읽었다(실측 5초 ~6GB, 2026-08-04 리뷰 F-1 → `article_compressed_overrun`).
    스텝 상한을 걸 수 없는 코덱(br/zstd)은 무한 폴백 대신 경고 + "" (단, `identity` 토큰은 목록에서
    걸러내 `identity, gzip`은 gzip으로 처리 — httpx 시절 동작 복구). 스트림이 `eof`에 닿으면 이후
    청크는 즉시 버린다 — 안 그러면 유효한 짧은 스트림 뒤 쓰레기가 zlib의 `unused_data`에 파이썬
    레벨로는 안 보이게 무제한 쌓인다(2026-08-04 재검증 NEW-1, F-1 자체의 재발).
  - 캡 상향과 함께 들어온 가드 3종 (2026-08-03 적대적 보안 리뷰): **charset 화이트리스트**
    (`SAFE_CHARSETS` — 오리진 charset을 코덱 레지스트리에 그대로 넘기면 punycode 같은 순수 파이썬
    O(n²) 코덱으로 이벤트 루프가 분 단위 정지), **fetch 총 데드라인**(`FETCH_TOTAL_DEADLINE` —
    httpx read당 타임아웃만으로는 trickle이 버퍼 무기한 점유), **fetch를 전용 fetch 세마포어 안에서**
    (`api/ai.py` `get_fetch_semaphore`, `AI_FETCH_CONCURRENCY`=2 — Bedrock 전역 세마포어와 **분리된 전용** 세마포어. 느린 fetch가 Bedrock 예산을 잠식하지 않게 하고 동시 fetch 버퍼 누적을 묶는다. permit은 본문 조회까지만 보유).
  - 태그 스캔 regex는 전부 `<`를 제외한 `[^<>]*`다 — 그 제외가 선형성의 전부이며(후보별 스캔이 다음 `<`에서 끝나고 런 안 위치는 O(1) 실패) `[^>]*`나 `(.*?)</p>` 류로 바꾸면 O(n²)로 돌아간다. 전략 2는 클래스를 이어 붙인 정규식 대신 `<div>` 태그 하나의 `class` 속성만 읽는다(`_body_container_ends`) — 문자 클래스 여러 개를 한 패턴에 이어 붙이는 것이 옛 이차 스캔의 근원이었다. 옛 `{0,1000}` 길이 상한은 2026-09-07 제거(1000자 넘는 태그를 놓치거나 본문에 남기기만 했음). RSS 파싱은 `defusedxml`만 (XXE/엔티티 확장 차단).
- **워커는 정확히 1개** (`uvicorn app.main:app`): L1 캐시와 AI 전역 세마포어가 프로세스 단위 — 워커를 늘리면 캐시 분열 + 동시 실행 상한 붕괴.
- `create_app(background=False)`가 기본 — 테스트는 절대 `background=True`를 쓰지 않는다 (네트워크/AWS 미접촉). L2 연결 실패는 기동을 막지 않는다(NullL2 유지, 로컬 개발).
- 정적 마운트(`/`)는 항상 마지막 라우트. API 404는 index.html로 재작성하지 않는다.

## 명령 / Commands
```bash
cd backend && .venv/bin/pytest -q   # 테스트 (407개, 오프라인)
make run                             # 로컬 실행 (repo 루트, :8000)
```

## 컨벤션 / Conventions
- 주석·docstring은 한국어+영어 병기 (기존 스타일 유지) / Comments and docstrings are bilingual ko+en.
- 타입힌트 필수, async 우선. 실패는 조용히 삼키지 않고 단일 라인 JSON 로그(`_warn`/`_info` 패턴).
- 환경변수 기본값은 `app/core/config.py` 참조 — `CACHE_TABLE`, `BEDROCK_REGION`은 인프라가 주입. `BEDROCK_MODEL_ID`도 env로 덮어쓸 수 있지만 인프라는 의도적으로 주입하지 않는다(코드 기본값이 검증된 값).
