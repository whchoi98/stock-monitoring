/**
 * 기사 AI 분석 페이지 테스트 — 쿼리 파라미터 해석 · 자동 실행(정확히 한 번) · 4가지 상태.
 * Article AI analysis page tests: how the query parameters are read, that the run fires exactly once,
 * and the four states.
 *
 * F2 훅(`useArticleAI`)을 모킹한다 — 이 화면의 계약은 "훅에 무엇을 넘기고, 훅이 돌려준 상태를 어떻게
 * 보여주는가"이고, HTTP 계층은 `api/client.test.ts`가 이미 덮는다. 다만 `ApiError`는 **모킹하지 않고**
 * 실물을 쓴다 — 문구 분기가 `instanceof ApiError` + `status`/`detail`에 달려 있어서 가짜 오류로는
 * 그 계약을 확인할 수 없다.
 * The F2 hook (`useArticleAI`) is mocked: this screen's contract is what it hands the hook and how it renders
 * what comes back, and `api/client.test.ts` already covers the HTTP layer. `ApiError` is *not* mocked, though
 * — the wording branches on `instanceof ApiError` plus `status`/`detail`, which a fake error could not pin.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client.ts'
import type { MutationResult } from '../api/queries.ts'
import { useArticleAI } from '../api/queries.ts'
import type {
  ArticleAnalysis as ArticleAnalysisData,
  ArticleAnalysisRequest,
} from '../api/types.ts'
import ArticleAnalysis from './ArticleAnalysis.tsx'

vi.mock('../api/queries.ts', () => ({ useArticleAI: vi.fn() }))

const ARTICLE_URL = 'https://example.com/news/fed-holds-rates'
const ARTICLE_TITLE = 'Fed holds rates steady'

/** 뉴스 항목이 만드는 것과 같은 형태의 쿼리 문자열 / The same query string a news item produces */
const SEARCH = `?url=${encodeURIComponent(ARTICLE_URL)}&title=${encodeURIComponent(
  ARTICLE_TITLE,
)}&language=en`

const analyze = vi.fn()

function hookResult(
  over: Partial<MutationResult<ArticleAnalysisRequest, ArticleAnalysisData>>,
): MutationResult<ArticleAnalysisRequest, ArticleAnalysisData> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    analyze,
    ...over,
  }
}

/**
 * 실제 라우트와 같은 자리에 페이지를 앉힌다 / Mount the page where the real route puts it.
 *
 * `strict`는 StrictMode 이중 이펙트를 재현한다 — 유료 호출이 두 번 나가지 않는지 확인하는 데 쓴다.
 * `strict` reproduces StrictMode's double effect, used to check the paid call does not fire twice.
 */
function renderPage(search: string, { strict = false } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[`/articles${search}`]}>
      <Routes>
        <Route path="/articles" element={<ArticleAnalysis />} />
        <Route path="/" element={<p>대시보드 자리</p>} />
      </Routes>
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

/**
 * 자동 실행을 흘려보낸다 / Let the automatic run through.
 *
 * 페이지는 `mutate`를 다음 매크로태스크로 미룬다 (StrictMode에서 결과가 유실되는 것을 피하려고 —
 * `ArticleAnalysis.tsx` 주석 참고). 같은 지연(0ms)의 타이머는 예약 순서대로 실행되므로 여기서 한 틱만
 * 흘리면 이미 예약된 호출이 먼저 끝난다.
 * The page defers `mutate` to the next macrotask (to avoid the result being lost under StrictMode — see the
 * comment in `ArticleAnalysis.tsx`). Timers with the same 0ms delay fire in scheduling order, so letting one
 * tick pass here drains the already-scheduled call first.
 */
async function flushAutoRun() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  // 호출 이력을 테스트마다 지운다 (F5/F6 리뷰 지적) / Clear call history per test (raised in the F5/F6 reviews)
  vi.clearAllMocks()
  vi.mocked(useArticleAI).mockReturnValue(hookResult({}))
})

describe('ArticleAnalysis', () => {
  it('url 파라미터가 없으면 잘못된 접근을 안내하고 훅을 부르지 않는다 / without a url it states the bad entry and never calls the hook', async () => {
    renderPage('')
    await flushAutoRun()

    expect(screen.getByText('잘못된 접근')).toBeTruthy()
    expect(screen.getByRole('link', { name: '대시보드로 이동' }).getAttribute('href')).toBe('/')
    // 훅 자체가 불리지 않아야 한다 — 빈 url로 유료 엔드포인트를 두드리는 경로가 아예 없어야 한다.
    // The hook must not even run: no path may exist that hits the paid endpoint with an empty url.
    expect(vi.mocked(useArticleAI)).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
  })

  it('성공하면 마크다운을 렌더한다 / renders the markdown on success', () => {
    vi.mocked(useArticleAI).mockReturnValue(
      hookResult({
        data: {
          url: ARTICLE_URL,
          title: ARTICLE_TITLE,
          language: 'en',
          analysis: '## 핵심 요약\n\n- 기준금리 동결\n',
        },
      }),
    )

    renderPage(SEARCH)

    expect(screen.getByRole('heading', { level: 2, name: '핵심 요약' })).toBeTruthy()
    expect(screen.getByText('기준금리 동결')).toBeTruthy()
  })

  it('진입하면 url/title/language를 그대로 실어 한 번만 실행한다 (StrictMode) / entering runs it once with url/title/language, even under StrictMode', async () => {
    renderPage(SEARCH, { strict: true })
    await flushAutoRun()

    expect(analyze).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledWith({
      url: ARTICLE_URL,
      title: ARTICLE_TITLE,
      language: 'en',
    })
  })

  it('title이 없으면 url을 제목으로, language가 없으면 ko로 보낸다 / falls back to the url as title and ko as language', async () => {
    renderPage(`?url=${encodeURIComponent(ARTICLE_URL)}`)
    await flushAutoRun()

    expect(analyze).toHaveBeenCalledWith({
      url: ARTICLE_URL,
      title: ARTICLE_URL,
      language: 'ko',
    })
  })

  it('language가 ko/en이 아니면 ko로 보낸다 / an unknown language falls back to ko', async () => {
    renderPage(`?url=${encodeURIComponent(ARTICLE_URL)}&title=t&language=jp`)
    await flushAutoRun()

    expect(analyze).toHaveBeenCalledWith({ url: ARTICLE_URL, title: 't', language: 'ko' })
  })

  it('진행 중에는 두 단계와 스피너를 보여준다 / shows both stages and a spinner while running', () => {
    vi.mocked(useArticleAI).mockReturnValue(hookResult({ isLoading: true }))

    renderPage(SEARCH)

    expect(screen.getByText('[1/2] 기사 수집 중')).toBeTruthy()
    expect(screen.getByText('[2/2] Claude 분석 중')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('원문 링크를 새 탭으로 준다 / links to the original article in a new tab', () => {
    renderPage(SEARCH)

    const link = screen.getByRole('link', { name: '원문 보기' })
    expect(link.getAttribute('href')).toBe(ARTICLE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('heading', { level: 1, name: ARTICLE_TITLE })).toBeTruthy()
  })

  /*
   * 오류 문구 4분기 — `lib/aiMessages.ts`가 AIPanel(F6)과 공유하는 표다.
   * 502는 백엔드의 `article_unavailable`일 때만 기사 문구를 쓴다: ALB/CloudFront가 만든 502는
   * 본문이 HTML이라 detail이 `http_502`가 되고, 그때 "기사 본문을 가져올 수 없습니다"는 거짓이 된다.
   * The four wording branches, the table `lib/aiMessages.ts` shares with F6's AIPanel. A 502 only gets the
   * article wording when the backend says `article_unavailable`: an ALB/CloudFront 502 carries an HTML body,
   * so its detail is `http_502`, and claiming the article body was unreachable would be false.
   */
  const errorCases: [Error, string][] = [
    [new ApiError(429, 'rate_limited'), '잠시 후 다시 시도해주세요'],
    [new ApiError(503, 'ai_unavailable'), 'AI 기능을 사용할 수 없습니다'],
    [new ApiError(502, 'article_unavailable'), '기사 본문을 가져올 수 없습니다'],
    [new ApiError(502, 'http_502'), 'AI 분석에 실패했습니다'],
    [new ApiError(500, 'ai_failed'), 'AI 분석에 실패했습니다'],
    [new TypeError('network down'), 'AI 분석에 실패했습니다'],
  ]

  for (const [error, expected] of errorCases) {
    const label = error instanceof ApiError ? `${error.status} ${error.detail}` : 'network failure'
    it(`${label} → "${expected}"`, () => {
      vi.mocked(useArticleAI).mockReturnValue(hookResult({ error }))

      renderPage(SEARCH)

      expect(screen.getByRole('alert').textContent).toContain(expected)
    })
  }

  it('재시도는 같은 본문으로 분석을 다시 실행한다 / a retry re-runs the analysis with the same body', async () => {
    vi.mocked(useArticleAI).mockReturnValue(hookResult({ error: new ApiError(500, 'ai_failed') }))

    renderPage(SEARCH)
    await flushAutoRun()
    // 진입 시 자동 실행 1회 / The automatic run on entry
    expect(analyze).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))

    expect(analyze).toHaveBeenCalledTimes(2)
    expect(analyze).toHaveBeenLastCalledWith({
      url: ARTICLE_URL,
      title: ARTICLE_TITLE,
      language: 'en',
    })
  })
})
