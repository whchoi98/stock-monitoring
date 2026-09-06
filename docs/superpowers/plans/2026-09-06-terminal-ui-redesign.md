# 구현 계획: 터미널 UI 개편 / Implementation Plan: Terminal UI Redesign

- 스펙 / Spec: `docs/superpowers/specs/2026-09-06-terminal-ui-redesign-design.md`
- ADR: `docs/decisions/ADR-001-terminal-design-language.md`
- 범위 / Scope: `frontend/` 전용 (백엔드 API 무변경) + 문서 동기화
- 검증 / Verification: `cd frontend && npx vitest run && npx oxlint && npx tsc -b` + Playwright 스크린샷

각 태스크는 "테스트 먼저 → 구현 → 전체 테스트 녹색 → 커밋" 순서로 진행한다.

## T1. 토큰·서체·전역 스타일 뼈대
- `npm i @fontsource/jetbrains-mono`
- `tokens.css` 새 토큰 세트(스펙 §5), `--card` 제거
- `global.css` 전면 교체: 리셋, 셸(`.terminal/.term-top/.term-main`), `Panel`, 버튼/탭/칩, 표, 뉴스, 차트, 호가, 수급, 통계 셀, 마크다운, 반응형, reduced-motion
- `PriceChart.readStyles()` 토큰명 갱신

## T2. 공용 컴포넌트
- `Panel`(Card 대체) → 모든 사용처 교체, `Card.tsx` 삭제
- `NewsList` 추출 → `NewsFeed`/`StockNews`가 사용 (기존 테스트 그대로 통과)
- `lib/format.ts`: `formatClock`, `formatClockSeconds` (+ 테스트)

## T3. 셸: TopBar · MarketStrip · StatusBar · Clock · MarketStatus · SymbolSearch
- `lib/search.ts` `searchSymbols` (+ 테스트)
- `queries.ts` `useSymbolUniverse(enabled)`
- `MarketStrip`(TickerBar 대체, 테스트 이관), `Clock`, `MarketStatus`, `StatusBar`, `SymbolSearch` (+ 각 테스트)
- `App.tsx` 재구성, `App.test.tsx`/`main.test.tsx` 갱신, `TickerBar*` 삭제

## T4. 시장 워크스페이스
- `MarketPulse`(MarketSummary 개명), `SectorBars` 스킨, `StockTable` 헤더 탭 이동 + 밀집 표, `NewsFeed`
- `Dashboard.tsx` 그리드, `IndexCards` 삭제

## T5. 종목 워크스페이스
- `Watchlist` (+ 테스트), `StockHeader` 확장, `chartData.ts` `bollingerBands` (+ 테스트)
- `PriceChart` 지표 토글 + OHLC 레전드 (+ 테스트 갱신), `OrderBook` 현재가 구분행·합계 (+ 테스트)
- `InvestorPanel`/`FundamentalCards`/`ReturnsRow`/`StockNews`/`AIPanel` 스킨
- `StockDetail.tsx` 그리드, `StockDetail.test.tsx` 모킹 보강

## T6. 기사 분석 스킨 + 404/에러 화면
## T7. 시각 검증 (Playwright: 3화면 × 2뷰포트 × 2테마, 390px 가로 스크롤 0) → 수정 반복
## T8. 문서 동기화 (`ui.md`, `frontend.md`, `frontend/CLAUDE.md`, 루트 `CLAUDE.md`, `INDEX.md`)
