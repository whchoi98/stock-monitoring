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
import App from './App.tsx'

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
 * 라우트 테이블 — 점진적으로 추가한다 / The route table, added to incrementally.
 *
 * 존재하지 않는 페이지 파일을 미리 import하면 빌드가 깨지므로, 각 태스크가 자기 페이지 파일을 만들 때
 * 아래 `children`에 lazy 라우트를 추가한다. F4가 index(`/` Dashboard)를 연결했고,
 * F6(`/stocks/:symbol` StockDetail)·F7(`/articles` ArticleAnalysis)이 같은 형식으로 이어 붙인다:
 *
 *   { path: 'articles', lazy: async () => ({ Component: (await import('./pages/Articles.tsx')).default }) }
 *
 * lazy 라우트는 페이지 코드를 첫 진입 때 내려받게 해 초기 번들을 셸로 유지한다.
 * Importing a page file that does not exist yet would break the build, so each task appends its lazy route
 * to `children` when its page file lands. F4 wired the index route (`/` Dashboard); F6 (`/stocks/:symbol`)
 * and F7 (`/articles`) follow the same shape. A lazy route keeps the initial bundle down to the shell by
 * fetching the page's code on first entry.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('./pages/Dashboard.tsx')).default }),
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
