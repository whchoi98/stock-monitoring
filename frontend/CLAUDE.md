# Frontend Module (React 19 + TypeScript + Vite)

## 역할 / Role
주식 모니터링 SPA — Dashboard / StockDetail / ArticleAnalysis 3개 페이지 (react-router-dom v6).
Stock monitoring SPA with three pages, served by the FastAPI backend in production.

## 구조 / Key Files
- `src/api/` — `client.ts`(fetch 래퍼), `queries.ts`(**서버 데이터는 @tanstack/react-query 훅으로만**), `aiStream.ts`+`lib/sse.ts`(**유일한 예외**: 두 AI 엔드포인트는 SSE `phase`→`delta`*→`final`이라 fetch 직접 사용), `types.ts`(백엔드 `app/models.py` 응답 형태와 일치 유지).
- `src/components/` — `common/`(Card, ChangeText, TickerBar, ThemeToggle...), `market/`(StockTable, IndexCards...), `stock/`(PriceChart, OrderBook, AIPanel...).
- `src/components/stock/chartData.ts` — 차트 데이터 순수 변환 함수 (직접 단위 테스트 대상).
- `src/pages/`, `src/lib/`(format 유틸), `src/styles/`(`tokens.css` 디자인 토큰, `global.css`).

## 명령 / Commands
```bash
cd frontend
npm run dev            # dev 서버 (백엔드는 make run으로 :8000)
npx vitest run         # 테스트 168개 (colocated *.test.tsx / *.test.ts)
npx oxlint             # 린트
npm run build:deploy   # vite build --outDir ../backend/static (emptyOutDir — 배포 산출물)
```

## 규칙 / Rules
- **TypeScript strict** + 함수형 컴포넌트만. 서버 상태는 react-query, 수동 fetch/useEffect 데이터 로딩 금지 (AI 스트리밍 `api/aiStream.ts`만 예외 — 그 파일 밖으로 넓히지 말 것).
- **차트는 lightweight-charts** (v4). 데이터 변환은 `chartData.ts` 같은 순수 함수로 분리해 테스트한다.
- **테스트는 colocated**: 소스 옆에 `Foo.test.tsx` (vitest + @testing-library/react + jsdom).
- **테마 / Theme**: `<html data-theme="dark|light">`로만 전환 (다크 기본, Toss Invest 참조). 색상은 반드시 `styles/tokens.css`의 CSS 변수 사용 — 하드코딩 금지.
- **한국 관례 색상**: 상승 = 빨강(`--up`), 하락 = 파랑(`--down`). 서구권 관례(green/red)로 바꾸지 않는다.
- 폰트는 Pretendard (`@fontsource/pretendard`). AI 응답 렌더링은 react-markdown + `remark-gfm`(표) — 스타일은 `global.css`의 `.markdown`.

## 주의 / Gotchas
- `build:deploy`는 `../backend/static`을 **비우고** 다시 쓴다 — 백엔드 static에 수동 파일을 두지 말 것.
- `src/api/types.ts` 변경 시 백엔드 모델과의 정합을 먼저 확인한다 (계약 소스는 백엔드).
- 주석은 한국어+영어 병기 관례 유지 / Keep comments bilingual ko+en per project convention.
