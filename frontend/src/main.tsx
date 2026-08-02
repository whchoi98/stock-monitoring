/**
 * 엔트리 — QueryClient 설정 + Provider 조립.
 * The entry point: the QueryClient configuration and the provider assembly.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import './styles/global.css'
import { ApiError } from './api/client.ts'
import App, { NotFound, RouteError } from './App.tsx'

/**
 * 기본 재시도/신선도 정책 / The default retry and freshness policy.
 *
 * - **4xx는 재시도하지 않는다.** 없는 심볼(404)이나 레이트리밋(429)은 다시 물어도 같은 답이므로,
 *   기본값 `retry: 3`이면 화면이 에러 상태에 도달하기까지 지연만 늘어난다. 화면은 즉시 분기해야 한다.
 * - 네트워크 실패와 5xx는 일시적일 수 있어 1회만 더 시도한다 (총 2회).
 * - `staleTime`은 폴링 주기(시세 45초 / 뉴스 120초)보다 짧게 둔다 — 재마운트 시에는 즉시 갱신되되,
 *   같은 데이터를 쓰는 위젯이 동시에 마운트될 때의 중복 요청은 캐시가 흡수한다.
 * - 뮤테이션(AI 분석)은 재시도하지 않는다 — 호출마다 비용이 발생하는 유일한 엔드포인트다.
 * - 백그라운드 탭에서 폴링이 멈추는 것(스펙 6.3)은 TanStack 기본값
 *   `refetchIntervalInBackground: false`가 이미 보장하므로 따로 설정하지 않는다.
 *
 * - **4xx is never retried**: an unknown symbol (404) or a rate limit (429) answers the same way the
 *   second time, so the default `retry: 3` would only delay the error state the UI must branch on.
 * - A network failure or a 5xx can be transient, so those get exactly one more attempt (two total).
 * - `staleTime` stays below the polling intervals (45s for quotes, 120s for news): a remount refetches
 *   promptly, while widgets mounting together over the same data are absorbed by the cache.
 * - Mutations (AI analysis) are never retried; they are the only endpoints that cost money per call.
 * - Polling stopping in a background tab (spec 6.3) is already guaranteed by TanStack's default
 *   `refetchIntervalInBackground: false`, so it is not configured here.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
        return failureCount < 1
      },
      staleTime: 30_000,
    },
    mutations: { retry: false },
  },
})

/**
 * 라우트 테이블 — F7에서 완성됐다 / The route table, completed in F7.
 *
 * 세 페이지 모두 lazy 라우트다 — 페이지 코드를 첫 진입 때 내려받게 해 초기 번들을 셸로 유지한다
 * (상세는 lightweight-charts, 상세·기사 화면은 react-markdown을 끌고 온다).
 * All three pages are lazy routes, keeping the initial bundle down to the shell by fetching a page's code on
 * first entry (the detail page pulls in lightweight-charts, and both it and the article screen react-markdown).
 *
 * 죽은 링크와 렌더 예외에도 사용자에게 react-router 기본 화면(스택 트레이스)을 보이지 않는다:
 * 셸 라우트의 `errorElement`가 예외를 받고(스펙 7 "ErrorBoundary로 전체 붕괴 방지"), 셸 **안쪽**의
 * `*` 자식 라우트가 매칭 실패를 받는다 — 후자는 네비·티커를 살려 둔 채 페이지 영역만 안내로 바꾼다.
 * Neither a dead link nor a render-time exception shows react-router's default screen: the shell route's
 * `errorElement` catches the exception (spec 7's "an ErrorBoundary prevents total collapse") while a `*` child
 * *inside* the shell catches the no-match, swapping only the page area and leaving the nav and ticker alive.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('./pages/Dashboard.tsx')).default }),
      },
      {
        /*
         * 심볼은 yfinance 티커 그대로다 (`AAPL`, `005930.KS`) — 점이 들어가도 한 세그먼트이므로
         * `:symbol` 하나로 받는다. F4의 시세 표가 `navigate(`/stocks/${symbol}`)`로 여기 들어온다.
         * The symbol is the yfinance ticker as-is (`AAPL`, `005930.KS`); a dot stays inside one segment, so a
         * single `:symbol` captures it. F4's quote table arrives here via `navigate(`/stocks/${symbol}`)`.
         */
        path: 'stocks/:symbol',
        lazy: async () => ({ Component: (await import('./pages/StockDetail.tsx')).default }),
      },
      {
        /*
         * 기사 식별 정보(url/title/language)는 경로가 아니라 **쿼리 파라미터**로 온다 — 기사 URL 자체를
         * 경로에 넣을 수 없고, 쿼리로 실어야 새로고침·공유가 동작한다 (스펙 6.2 ③).
         * 뉴스 목록(F4 `NewsFeed`, F6 `StockNews`)의 링크가 이 라우트로 들어온다.
         * The article's identity (url/title/language) arrives as **query parameters**, not path segments: an
         * article URL cannot live in a path, and the query is what makes a refresh or a shared link work
         * (spec 6.2 ③). The news lists' links (F4's `NewsFeed`, F6's `StockNews`) land here.
         */
        path: 'articles',
        lazy: async () => ({ Component: (await import('./pages/ArticleAnalysis.tsx')).default }),
      },
      {
        // 매칭 실패 — 셸 안에서 안내한다 / A no-match, explained inside the shell
        path: '*',
        element: <NotFound />,
      },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
