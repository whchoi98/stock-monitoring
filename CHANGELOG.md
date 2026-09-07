# Changelog

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add Korean stock names (`name_ko`) to quotes and stock detail, shown in search results and the quote header, with Korean-name and Hangul-initial (초성) matching in symbol search
- Add free-form questions to the AI stock analysis panel — a question input with presets, an optional `{question}` body (1–200 chars after normalisation), a per-question cache key `ai:stock:{symbol}:q:{sha256[:16]}`, and the question echoed in the result
- Add a crosshair synchronised across the price chart and its RSI/MACD sub-panes, with a notice when a period has too few candles for an indicator
- Add 6M and 5Y (weekly candles) chart periods, RSI(14) and MACD(12,26,9) sub-panes, a candle/table view, and LVL reference lines (previous close, 52-week high/low) to the price chart
- Add a browser-side watchlist (★) toggled from the quote monitor, the watchlist rail and the quote header, with a "관심" scope tab alongside 미국/한국
- Add browser-side price alerts — set a target price from the stock header and get a one-time toast (plus a system notification when permitted) when the price crosses it, with the pending count shown in the status bar
- Add language tabs (전체/한국어/English) and a keyword filter to the news wire, and a MACRO panel ranking economic indicators by absolute change
- Add collapsible panels whose collapsed state is remembered in the browser, with a "레이아웃 초기화" reset in the status bar
- Add a command bar with ⌘K/Ctrl+K symbol search, a top market strip (pinned index cells, economic-indicator crawl, data as-of chip) and a bottom status bar (market state, data source, polling cadence, KST clock)
- Add a watchlist rail and an OHLC-statistics quote header to the stock screen, plus a Bollinger Bands (BOLL) toggle, an OHLC crosshair legend and direction-coloured volume on the price chart
- Add live streaming of AI analyses over SSE (`phase` → `delta`* → `final`) — the stock and article panels render text as it arrives with a stage label (본문을 가져오는 중 / 순서를 기다리는 중 / 분석 중) and GFM markdown tables, replacing the article screen's `[1/2]`/`[2/2]` step labels
- Add a post-deploy smoke check that `/api/market/quotes?market=us` returns a non-empty data array — the outage answered 200 OK with an empty array, which no existing check caught

### Changed
- Redesign the frontend as a terminal-style workspace (ADR-001) — a panel grid with uppercase eyebrows (MARKET PULSE, SECTOR HEAT, QUOTE MONITOR, NEWS WIRE, PRICE ACTION, AI RESEARCH, ORDER BOOK, INVESTOR FLOW…), a terminal palette with an amber accent and JetBrains Mono numerals; the Korean up=red/down=blue convention is kept
- Raise the article AI response cap from 2048 to 4096 tokens so long translation-plus-summary outputs are no longer truncated and cached truncated (stock analyses stay at 1024)

### Fixed
- Fix the main price axis printing 0 / -50000 / -100000 on wide-range periods such as 5Y — the volume moved from an overlay on the main chart into its own synced VOL sub-pane, and the candle series pads below in price units with the autoscale floor clamped at 0 (no pixel margin below, marker margin included), so the axis never extends below zero even when a symbol's 5Y range is many times its low; pane fills run with the time-scale link muted so a cached period switch still fits the main chart to the new data
- Fix article extraction missing `<article>`, body `<div>` and `<p>` tags whose attributes exceed 1000 characters and leaving 1000+ character tags (data-URI images) in the text — the tag regexes drop the length cap (they stay linear by excluding `<`) and stage 2 parses each `<div>`'s `class` attribute instead of chaining several character classes in one regex
- Fix article extraction swallowing the site footer when a page has no `</article>` within the window (a truncated page, or an article longer than it) — an unclosed `<article>` or body-`<div>` window now stops at the next structural boundary (`<footer`, `</main>`, `<nav`) instead of word-filtering paragraphs, and the window grew from 100k to 250k characters so 100k+ articles are read whole; `<pre>`/`<divider>`/`data-class=` no longer pass as `<p>`/`<div>`/`class=`
- Fix `/api/health` and the market overview reporting Yahoo as healthy while the quote table was short — a partial quotes, indices or indicators fetch now marks the source degraded, and one market's failure no longer blocks the other market or the overview refresh in the scheduler
- Fix a cold `/api/market/overview` exceeding the CloudFront 60s origin timeout — the indices and indicators fetches now run under their own deadlines (3s/5s) and the quote budget scales per symbol (0.9s, capped at 20s)
- Fix the blank US stock table (live incident 2026-08-04) — quotes are fetched serially per symbol with an explicit 8s request timeout, a wall-clock deadline, a jittered retry of only the missing symbols and a 60% coverage floor, and an all-empty result no longer evicts the last good quotes from the cache
- Fix streaming AI analyses failing with 503 `ai_unavailable` in production by granting `bedrock:InvokeModelWithResponseStream` to the ECS task role
- Fix AI streams going silent (and hitting the CloudFront idle timeout) while queued for the Bedrock or article-fetch permit — a `phase: waiting` heartbeat now fires every 5s and the panel shows the cause-neutral "순서를 기다리는 중…"
- Fix KR stock-news clicks dead-ending on "기사 본문을 가져올 수 없습니다" — Google News wrapper links now open the source in a new tab marked "원문 보기", and an empty link routes to the analysis screen's invalid-access card instead of reopening the app in a new tab
- Fix wide AI markdown tables (URLs, long digit runs) pushing the page sideways on 390px screens by wrapping table cells with `overflow-wrap: anywhere`
- Fix a cold article AI analysis (~45s) returning 504 by raising the CloudFront origin read timeout from 30s to 60s
- Fix the regression that broke article AI analysis outright (502 `article_unavailable`) — raise the article body cap from 256KB to 2MB and drop the declared content-length rejection, since Yahoo article pages are ~800KB with the body past the 300KB mark
- Fix the clock rendering midnight as 24:xx instead of 00:xx (`hourCycle: 'h23'`)

### Security
- Fence the free-form AI question inside `<question>` delimiters, convert angle brackets to full-width in normalisation and again in the prompt builder so the fence cannot be closed, and pin the prompt to the data scope (no instruction changes, no trade orders)
- Inflate compressed article bodies from the raw stream in bounded 64KB steps, cap raw reads at 16MB (8× the body cap), refuse codecs that cannot be step-bounded (brotli, zstd) and drop data after end-of-stream, closing the decompression-bomb memory spike (a single request peaked at 148MB before)
- Harden article fetching after the 2MB cap raise — decode only whitelisted C-implemented charsets with a utf-8 fallback (a hostile `charset=punycode` could stall the event loop for minutes), run fetches under a dedicated concurrency semaphore separate from the Bedrock one, and bound each fetch with a 20s total deadline

### Removed
- Remove the bottom-fixed indicator ticker and the index cards — indices and indicators now live in the top market strip

## [0.1.0] - 2026-08-02

First production release.

### Added
- Add market dashboard with indices, market summary, sector performance, stock table, news feed, and rolling ticker
- Add stock detail page with candlestick chart (moving averages, cross signals, volume), fundamentals, and simulated orderbook/investor widgets
- Add AI stock analysis powered by Amazon Bedrock, with per-IP rate limiting and result caching
- Add RSS news feed and article AI analysis page with article body extraction
- Add tiered cache (in-memory L1, DynamoDB L2 with TTL) with stale fallback and per-key single-flight locking
- Add AWS CDK stack provisioning CloudFront, ALB, ECS Fargate, and the DynamoDB cache table, reusing the existing VPC
- Add post-deploy smoke test script verifying CloudFront routes and confirming direct ALB access is blocked

### Fixed
- Fix dividend yield interpretation to percent scale instead of a raw fraction
- Fix Bedrock invocation in ap-northeast-2 by using the `global.` inference profile model-ID prefix

### Security
- Key the AI rate limit on the CloudFront-Viewer-Address header instead of the forgeable X-Forwarded-For
- Guard article fetching against SSRF and cap streamed response bodies at 256KB
- Bound backtracking in article-extraction regexes to prevent quadratic-time denial of service

[Unreleased]: https://github.com/whchoi98/stock-monitoring/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/stock-monitoring/releases/tag/v0.1.0

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

### Added
- 시세·종목 상세에 한글 종목명(`name_ko`) 추가 — 검색 결과와 종목 헤더에 표시, 종목 검색에서 한글명·초성 매칭 지원
- AI 종목 분석 패널에 자유 질의 추가 — 질문 입력과 프리셋, 선택 본문 `{question}`(정규화 후 1~200자), 질문별 캐시 키 `ai:stock:{symbol}:q:{sha256[:16]}`, 결과에 질문 에코
- 가격 차트와 RSI/MACD 보조 패널 사이 크로스헤어 동기화 추가 — 지표 계산에 캔들이 부족한 기간에는 안내 표시
- 가격 차트에 6M·5Y(주봉) 기간, RSI(14)·MACD(12,26,9) 보조 패널, 캔들/표 뷰, 기준선 LVL(전일 종가·52주 고/저) 추가
- 브라우저에 저장되는 관심 종목(★) 추가 — 시세 표·워치리스트 레일·종목 헤더에서 토글, 미국/한국 옆에 "관심" 스코프 탭 제공
- 브라우저에 저장되는 가격 알림 추가 — 종목 헤더에서 목표가를 설정하면 돌파 시 1회 토스트(권한이 있으면 시스템 알림) 발동, 상태 바에 대기 알림 수 표시
- 뉴스 와이어에 언어 탭(전체/한국어/English)과 키워드 필터, 경제지표를 |등락률| 내림차순 막대로 보여주는 MACRO 패널 추가
- 패널 접기 추가 — 접힘 상태는 브라우저에 저장되고 상태 바의 "레이아웃 초기화"로 전체 복원
- ⌘K/Ctrl+K 종목 검색이 있는 커맨드 바, 상단 마켓 스트립(지수 고정 셀·경제지표 크롤·데이터 기준 시각 칩), 하단 상태 바(장 상태·데이터 출처·폴링 주기·KST 시계) 추가
- 종목 화면에 워치리스트 레일과 OHLC 통계 헤더, 가격 차트에 볼린저 밴드(BOLL) 토글·OHLC 크로스헤어 레전드·방향색 거래량 추가
- AI 분석의 SSE 실시간 스트리밍 추가(`phase` → `delta`* → `final`) — 종목·기사 패널이 도착하는 텍스트를 단계 라벨(본문을 가져오는 중 / 순서를 기다리는 중 / 분석 중)과 GFM 마크다운 표로 즉시 렌더, 기사 화면의 `[1/2]`/`[2/2]` 단계 표시는 제거
- `/api/market/quotes?market=us`의 data 배열이 비어 있지 않은지 확인하는 배포 후 스모크 검사 추가 — 장애 당시 200 OK + 빈 배열이어서 기존 검사가 모두 놓쳤음

### Changed
- 프론트엔드를 터미널 스타일 워크스페이스로 개편(ADR-001) — 대문자 eyebrow 패널 그리드(MARKET PULSE, SECTOR HEAT, QUOTE MONITOR, NEWS WIRE, PRICE ACTION, AI RESEARCH, ORDER BOOK, INVESTOR FLOW…), 앰버 액센트와 JetBrains Mono 숫자의 터미널 팔레트, 한국 등락색(상승 빨강/하락 파랑) 관례 유지
- 기사 AI 응답 토큰 상한을 2048에서 4096으로 상향 — 긴 번역+요약 결과가 잘린 채 캐시되지 않음(종목 분석은 1024 유지)

### Fixed
- 5Y처럼 범위가 넓은 기간에서 메인 가격축이 0 / -50000 / -100000까지 찍히던 문제 수정 — 거래량을 메인 차트 오버레이에서 별도 동기 VOL 보조 패널로 분리하고, 캔들 시리즈의 아래 여백을 가격 단위로 주며 autoscale 바닥을 0에서 클램프(하단 픽셀 여백·마커 여백 0)해 5Y 범위가 최저가의 수십 배인 종목에서도 축이 0 아래로 내려가지 않음; 패널 채우기는 시간축 링크를 끊고 수행해 캐시 히트 기간 전환에서도 메인 차트가 새 데이터에 맞춰짐
- 속성이 1000자를 넘는 `<article>`·본문 `<div>`·`<p>`를 놓치고 1000자 초과 태그(data-URI 이미지)를 본문에 남기던 기사 추출 문제 수정 — 태그 regex의 길이 상한을 없애고(`<` 제외로 선형 유지) 전략 2는 문자 클래스 여러 개를 한 정규식에 이어 붙이는 대신 `<div>`마다 `class` 속성을 파싱
- 창 안에 `</article>`이 없는 페이지(잘린 페이지, 창보다 긴 기사)에서 기사 추출이 사이트 푸터까지 삼키던 문제 수정 — 닫히지 않은 `<article>`·본문 `<div>` 창은 단락을 단어로 걸러 내는 대신 다음 구조 경계(`<footer`, `</main>`, `<nav`)에서 멈추고, 창을 100k→250k자로 늘려 100k 넘는 기사도 끝까지 읽음; `<pre>`/`<divider>`/`data-class=`는 더 이상 `<p>`/`<div>`/`class=`로 통과하지 않음
- 시세 표가 결손인데 `/api/health`·시장 overview가 Yahoo를 정상으로 보고하던 문제 수정 — 부분 시세·지수·지표 조회는 소스를 degraded로 표시하고, 스케줄러에서 한 시장의 실패가 다른 시장·overview 갱신을 막지 않음
- 콜드 `/api/market/overview`가 CloudFront 오리진 60초 타임아웃을 넘기던 문제 수정 — 지수·지표 조회에 각각 데드라인(3s/5s) 적용, 시세 예산은 심볼당 0.9s(상한 20s)로 스케일
- 미국 종목 표가 빈 화면이 되던 라이브 장애(2026-08-04) 수정 — 시세를 심볼별 직렬 조회(요청 타임아웃 8초, 전체 데드라인, 누락 심볼만 지터 재시도, 커버리지 하한 60%)로 바꾸고, 전 심볼 빈 결과가 캐시의 마지막 정상 시세를 밀어내지 않도록 변경
- 프로덕션에서 스트리밍 AI 분석이 503 `ai_unavailable`로 전멸하던 문제 수정 — ECS 태스크 롤에 `bedrock:InvokeModelWithResponseStream` 권한 부여
- Bedrock·기사 fetch permit 대기 중 AI 스트림이 침묵해 CloudFront 유휴 타임아웃에 걸리던 문제 수정 — 5초마다 `phase: waiting` 하트비트를 보내고 패널에는 원인 중립 문구 "순서를 기다리는 중…" 표시
- 한국 종목 뉴스 클릭이 "기사 본문을 가져올 수 없습니다"로 막히던 문제 수정 — Google News 래퍼 링크는 "원문 보기" 표시와 함께 원문을 새 탭으로 열고, 빈 링크는 앱을 새 탭에 다시 여는 대신 분석 화면의 잘못된 접근 카드로 안내
- URL·긴 숫자열이 든 AI 마크다운 표가 390px 화면에서 페이지를 가로로 밀던 문제 수정 — 표 셀에 `overflow-wrap: anywhere` 적용
- 콜드 기사 AI 분석(~45초)이 504를 반환하던 문제 수정 — CloudFront 오리진 read timeout을 30초에서 60초로 상향
- 기사 AI 분석이 전면 실패(502 `article_unavailable`)하던 회귀 수정 — Yahoo 기사 페이지가 ~800KB이고 본문이 300KB 이후에 시작하므로 본문 캡을 256KB에서 2MB로 상향하고 선언 content-length 사전 거부를 제거
- 시계가 자정을 00:xx 대신 24:xx로 표시하던 문제 수정(`hourCycle: 'h23'`)

### Security
- AI 자유 질의를 `<question>` 울타리 안에 격리하고, 정규화와 프롬프트 조립에서 꺾쇠를 전각으로 바꿔 울타리를 닫을 수 없게 하며, 프롬프트를 데이터 범위에 고정(지시 변경·매매 지시 불이행)
- 압축된 기사 본문을 원시 스트림에서 64KB 스텝 단위로 해제하고, 원시 읽기를 16MB(본문 캡의 8배)로 제한하며, 스텝 상한을 걸 수 없는 코덱(brotli·zstd)은 거부하고 스트림 종료 이후 데이터는 버려 압축 해제 폭탄 메모리 급증 차단(수정 전 요청 1건 peak 148MB)
- 2MB 캡 상향 이후 기사 수집 강화 — 화이트리스트(C 구현) 문자셋만 디코드하고 그 외는 utf-8 폴백(악의적 `charset=punycode`가 이벤트 루프를 수 분 정지시킬 수 있었음), Bedrock과 분리된 전용 동시성 세마포어로 fetch 실행, fetch 전체에 20초 총 데드라인 적용

### Removed
- 하단 고정 지표 티커와 지수 카드 제거 — 지수와 지표는 상단 마켓 스트립으로 이동

## [0.1.0] - 2026-08-02

첫 프로덕션 릴리스입니다.

### Added
- 지수, 시장 요약, 섹터 등락, 종목 테이블, 뉴스 피드, 롤링 티커를 포함한 시장 대시보드 추가
- 캔들스틱 차트(이동평균, 크로스 시그널, 거래량), 재무지표, 모의 호가/투자자 위젯을 갖춘 종목 상세 페이지 추가
- IP별 레이트리밋과 결과 캐시를 포함한 Amazon Bedrock 기반 AI 종목 분석 추가
- RSS 뉴스 피드 및 기사 본문 추출 기반 기사 AI 분석 페이지 추가
- 계층형 캐시(인메모리 L1, TTL 적용 DynamoDB L2) 추가 — stale fallback 및 키별 single-flight 락 포함
- 기존 VPC를 재활용하여 CloudFront, ALB, ECS Fargate, DynamoDB 캐시 테이블을 프로비저닝하는 AWS CDK 스택 추가
- CloudFront 경유 라우트 검증 및 ALB 직접 접근 차단을 확인하는 배포 후 스모크 테스트 스크립트 추가

### Fixed
- dividend yield 값을 raw fraction이 아닌 percent 스케일로 해석하도록 수정
- ap-northeast-2에서 `global.` inference profile 모델 ID 프리픽스를 사용하도록 Bedrock 호출 수정

### Security
- AI 레이트리밋 키를 위조 가능한 X-Forwarded-For 대신 CloudFront-Viewer-Address 헤더로 변경
- 기사 본문 수집에 SSRF 가드 적용 및 스트리밍 응답 본문 256KB 캡 설정
- 기사 추출 regex의 백트래킹 상한 설정으로 quadratic-time 서비스 거부 공격 차단

[Unreleased]: https://github.com/whchoi98/stock-monitoring/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/stock-monitoring/releases/tag/v0.1.0
