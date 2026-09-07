/**
 * 종목 상세 페이지 테스트 — 심볼이 바뀔 때 AI 패널이 이전 종목의 분석을 물고 있지 않은지 고정한다.
 * StockDetail tests, pinning that the AI panel never carries a previous symbol's analysis over.
 *
 * **왜 이 테스트가 있는가** (Task 3 리뷰 finding #4): 스트리밍 훅의 상태는 마운트에 묶여 있다. 상세
 * 페이지는 `/stocks/:symbol` 한 라우트를 재사용하므로 심볼만 바뀌면 컴포넌트는 그대로 살아 있고, 키가
 * 없으면 AAPL의 분석이 MSFT 화면에 남는다(뒤늦게 도착한 final이 새 심볼의 상태로 들어가는 경로도 같다).
 * 그래서 이 페이지가 `key={symbol}`로 패널을 다시 마운트한다는 것이 계약이다.
 * **Why this test exists** (finding #4 of the Task 3 review): the streaming hook's state is tied to a mount.
 * The detail page reuses the single `/stocks/:symbol` route, so a symbol change leaves the component alive and,
 * without a key, AAPL's analysis lingers on MSFT's screen (a late final committing into the new symbol's state
 * is the same defect). The contract is therefore that this page remounts the panel via `key={symbol}`.
 *
 * 위젯 훅(react-query)은 모두 로딩으로 모킹한다 — 여기서 관심 있는 것은 AI 패널뿐이고, 로딩 분기는
 * canvas(lightweight-charts)를 만들지 않으므로 jsdom에서 안전하다. 반대로 **스트리밍 훅은 실물**이다:
 * 실제 상태 유지가 이 결함의 원인이므로 모킹하면 확인할 대상이 사라진다. SSE는 `fetch`만 가짜로 만든다.
 * Every widget hook (react-query) is mocked as loading: only the AI panel matters here, and the loading branch
 * builds no canvas (lightweight-charts), which keeps jsdom safe. The **streaming hook is real**, though — the
 * state retention *is* the defect, so mocking it would erase what is under test. Only `fetch` is faked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StockDetail from './StockDetail.tsx'

/** 위젯 훅의 로딩 상태 — 각 위젯은 스피너만 그린다 / The widget hooks' loading state; each widget draws only a spinner */
const LOADING = {
  data: undefined,
  asOf: undefined,
  marketOpen: undefined,
  isLoading: true,
  error: null,
}

vi.mock('../api/queries.ts', () => ({
  useStock: () => LOADING,
  useChart: () => LOADING,
  useOrderBook: () => LOADING,
  useInvestors: () => LOADING,
  useStockNews: () => LOADING,
  // 워치리스트 레일 — 상세가 로딩 중이면 마운트되지 않지만, 모듈 계약은 완전해야 한다 / The watchlist rail; not mounted while the detail loads, but the module contract must be complete
  useQuotes: () => LOADING,
}))

/** SSE 프레임 하나 / One SSE frame */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 완결된 SSE 본문을 한 번에 돌려주는 응답 / A response handing back one complete SSE body */
function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * 읽기 루프가 본문을 모두 소화할 때까지 기다린다 / Wait until the read loop has digested the body.
 *
 * 루프는 청크마다 여러 마이크로태스크를 건너므로 매크로태스크 한 번으로 큐를 비운다. `act`로 감싸므로
 * 그 사이의 상태 갱신에 경고가 없다.
 * The loop hops several microtasks per chunk, so one macrotask drains the queue; the `act` wrapper keeps every
 * update inside an act scope.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

/**
 * 실제 라우트와 같은 자리에 페이지를 앉히고, 다른 종목으로 넘어갈 링크를 함께 둔다.
 * Mount the page where the real route puts it, with a link across to another symbol.
 *
 * 링크를 쓰는 이유: 라우트는 그대로 두고 파라미터만 바꿔야 실제 이동(대시보드→다른 종목)이 재현된다.
 * 트리를 다시 렌더하면 모든 것이 리마운트되어 검증할 결함이 사라진다.
 * The link matters: only a parameter change on the same route reproduces a real navigation. Re-rendering the
 * tree would remount everything and the defect under test would vanish.
 */
function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/stocks/AAPL']}>
        <Link to="/stocks/MSFT">MSFT로 이동</Link>
        <Routes>
          <Route path="/stocks/:symbol" element={<StockDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StockDetail', () => {
  it('심볼이 바뀌면 이전 종목의 AI 분석을 보여주지 않는다 / a symbol change never shows the previous symbol’s AI analysis', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse(
          sseFrame('phase', { phase: 'analyzing' }) +
            sseFrame('delta', { text: 'AAPL 전용 ' }) +
            sseFrame('final', {
              asOf: '2026-08-03T04:00:00+00:00',
              marketOpen: false,
              data: { symbol: 'AAPL', analysis: 'AAPL 전용 분석입니다.' },
            }),
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'AI 분석' }))
    await flush()

    expect(screen.getByText('AAPL 전용 분석입니다.')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/ai/stocks/AAPL')

    fireEvent.click(screen.getByRole('link', { name: 'MSFT로 이동' }))
    await flush()

    // 새 종목은 아무 것도 실행하지 않은 상태에서 시작한다 / The new symbol starts from a state where nothing ran
    expect(screen.queryByText('AAPL 전용 분석입니다.')).toBeNull()
    expect(screen.getByText('버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다')).toBeTruthy()
    // 이동만으로 유료 호출이 다시 나가지도 않는다 / Navigating alone never fires the paid call again
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('심볼이 없으면 안내만 보여준다 / with no symbol it shows only a notice', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/stocks']}>
          <Routes>
            <Route path="/stocks" element={<StockDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(screen.getByText('종목을 지정해 주세요')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'AI 분석' })).toBeNull()
  })
})
