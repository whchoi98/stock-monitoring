/**
 * 기사 AI 분석 페이지 테스트 — 쿼리 파라미터 해석 · 자동 실행(정확히 한 번) · 스트리밍 상태 · 오류 문구.
 * Article AI analysis page tests: how the query parameters are read, that the run fires exactly once, the
 * streaming states, and the error wording.
 *
 * 스트리밍 훅(`useArticleAIStream`)을 모킹한다 — 이 화면의 계약은 "훅에 무엇을 넘기고, 훅이 돌려준 상태를
 * 어떻게 보여주는가"이고, SSE 읽기·파싱은 `api/aiStream.test.ts`가 이미 덮는다. 다만 `ApiError`는
 * **모킹하지 않고** 실물을 쓴다 — 문구 분기가 `instanceof ApiError` + `status`/`detail`에 달려 있어서
 * 가짜 오류로는 그 계약을 확인할 수 없다.
 * The streaming hook (`useArticleAIStream`) is mocked: this screen's contract is what it hands the hook and how
 * it renders what comes back, and `api/aiStream.test.ts` already covers the SSE read and parse. `ApiError` is
 * *not* mocked, though — the wording branches on `instanceof ApiError` plus `status`/`detail`, which a fake
 * error could not pin.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiPhase, AiStream } from '../api/aiStream.ts'
import { useArticleAIStream } from '../api/aiStream.ts'
import { ApiError } from '../api/client.ts'
import type {
  ArticleAnalysis as ArticleAnalysisData,
  ArticleAnalysisRequest,
} from '../api/types.ts'
import ArticleAnalysis from './ArticleAnalysis.tsx'

vi.mock('../api/aiStream.ts', () => ({ useArticleAIStream: vi.fn() }))

const ARTICLE_URL = 'https://example.com/news/fed-holds-rates'
const ARTICLE_TITLE = 'Fed holds rates steady'

/** 뉴스 항목이 만드는 것과 같은 형태의 쿼리 문자열 / The same query string a news item produces */
const SEARCH = `?url=${encodeURIComponent(ARTICLE_URL)}&title=${encodeURIComponent(
  ARTICLE_TITLE,
)}&language=en`

const analyze = vi.fn()

function streamState(
  over: Partial<AiStream<ArticleAnalysisData, ArticleAnalysisRequest>>,
): AiStream<ArticleAnalysisData, ArticleAnalysisRequest> {
  return {
    phase: null,
    streamText: '',
    data: undefined,
    asOf: undefined,
    isLoading: false,
    error: null,
    analyze,
    ...over,
  }
}

/** 성공 final이 담고 오는 분석 결과 / The analysis a successful final carries */
function analysisData(analysis: string): ArticleAnalysisData {
  return { url: ARTICLE_URL, title: ARTICLE_TITLE, language: 'en', analysis }
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
 * 페이지는 `analyze`를 다음 매크로태스크로 미룬다 (StrictMode에서 결과가 유실되는 것을 피하려고 —
 * `ArticleAnalysis.tsx` 주석 참고). 같은 지연(0ms)의 타이머는 예약 순서대로 실행되므로 여기서 한 틱만
 * 흘리면 이미 예약된 호출이 먼저 끝난다.
 * The page defers `analyze` to the next macrotask (to avoid the result being lost under StrictMode — see the
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
  vi.mocked(useArticleAIStream).mockReturnValue(streamState({}))
})

describe('ArticleAnalysis', () => {
  it('빈 메뉴 진입은 분석 입력 화면이며 요청을 보내지 않는다 / an empty entry offers a form without making an AI call', async () => {
    renderPage('')
    await flushAutoRun()

    expect(screen.getByRole('heading', { level: 1, name: '기사 분석' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '기사 주소' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '시장 화면으로 이동' }).getAttribute('href')).toBe('/')
    // 훅 자체가 불리지 않아야 한다 — 빈 url로 유료 엔드포인트를 두드리는 경로가 아예 없어야 한다.
    // The hook must not even run: no path may exist that hits the paid endpoint with an empty url.
    expect(vi.mocked(useArticleAIStream)).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
  })

  it('사용자가 입력한 기사와 언어로 분석을 시작한다 / submits the entered article and language', async () => {
    renderPage('')
    fireEvent.change(screen.getByRole('textbox', { name: '기사 주소' }), { target: { value: ARTICLE_URL } })
    fireEvent.change(screen.getByRole('textbox', { name: '기사 제목 (선택)' }), { target: { value: ARTICLE_TITLE } })
    fireEvent.change(screen.getByRole('combobox', { name: '기사 언어' }), { target: { value: 'en' } })
    fireEvent.click(screen.getByRole('button', { name: '기사 분석 시작' }))
    await flushAutoRun()
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(analyze).toHaveBeenCalledWith({ url: ARTICLE_URL, title: ARTICLE_TITLE, language: 'en' })
  })

  it.each(['javascript:alert(1)', 'data:text/html,news', 'not-a-url'])('잘못된 링크 %s는 AI 요청 없이 고칠 수 있다 / invalid links remain editable', async (url) => {
    renderPage(`?url=${encodeURIComponent(url)}`)
    await flushAutoRun()
    expect(screen.getByRole('textbox', { name: '기사 주소' })).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(analyze).not.toHaveBeenCalled()
  })

  it('성공하면 마크다운을 렌더한다 / renders the markdown on success', () => {
    vi.mocked(useArticleAIStream).mockReturnValue(
      streamState({ data: analysisData('## 핵심 요약\n\n- 기준금리 동결\n') }),
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

  /*
   * 단계 라벨 — 백엔드가 `phase` 이벤트로 알려주는 실제 단계를 그대로 문구로 옮긴다. 예전 화면은 경계를
   * 관측할 수 없어서 `[1/2] 기사 수집 중` / `[2/2] Claude 분석 중`을 **둘 다** 세워 두었는데, 이제는
   * 서버가 어느 단계인지 말해 주므로 한 줄로 정직하게 표시한다.
   * The phase labels carry the backend's `phase` event straight to wording. The old screen could not observe
   * the boundary and so listed both stages at once; the server now says which stage it is in, so one honest
   * line replaces the pair.
   */
  const phaseLabels: [AiPhase | null, string][] = [
    [null, '분석 준비 중…'],
    ['fetching', '본문을 가져오는 중…'],
    ['waiting', '순서를 기다리는 중…'],
    ['analyzing', '분석 중…'],
  ]

  for (const [phase, label] of phaseLabels) {
    it(`진행 중 phase ${String(phase)} → "${label}"`, () => {
      vi.mocked(useArticleAIStream).mockReturnValue(streamState({ isLoading: true, phase }))

      renderPage(SEARCH)

      expect(screen.getByText(label)).toBeTruthy()
      expect(screen.getByRole('status')).toBeTruthy()
    })
  }

  it('훅이 아직 시작되지 않은 첫 렌더도 진행 중으로 본다 / the first render, before the run starts, counts as running', () => {
    renderPage(SEARCH)

    // 한 프레임짜리 빈 화면을 만들지 않는다 / No one-frame empty state flashes
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('분석 준비 중…')).toBeTruthy()
  })

  it('토큰이 도착하면 스피너 없이 누적 텍스트를 마크다운으로 렌더한다 / once tokens arrive it renders the accumulated text as markdown, with no spinner', () => {
    vi.mocked(useArticleAIStream).mockReturnValue(
      streamState({ isLoading: true, phase: 'analyzing', streamText: '## 핵심 요약\n\n첫 문장' }),
    )

    renderPage(SEARCH)

    expect(screen.getByRole('heading', { level: 2, name: '핵심 요약' })).toBeTruthy()
    expect(screen.getByText('첫 문장')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('분석 중…')).toBeNull()
  })

  it('final이 도착하면 누적 텍스트보다 data.analysis가 우선이다 / after the final, data.analysis wins over the accumulated text', () => {
    vi.mocked(useArticleAIStream).mockReturnValue(
      streamState({
        // 훅은 final 뒤에도 누적 텍스트를 지우지 않는다 (권위는 `data`) / The hook keeps the text after the final; `data` is authoritative
        streamText: '잘린 문장',
        data: analysisData('최종 문장입니다.'),
        asOf: '2026-08-03T04:00:00+00:00',
      }),
    )

    renderPage(SEARCH)

    expect(screen.getByText('최종 문장입니다.')).toBeTruthy()
    expect(screen.queryByText('잘린 문장')).toBeNull()
  })

  /*
   * GFM 표 — remark-gfm이 붙어 있다는 증거다. 플러그인이 없으면 파이프 줄이 문단 하나로 렌더되므로
   * `<table>`이 존재하지 않는다.
   * The GFM table is the evidence remark-gfm is wired in: without the plugin the pipe lines render as a single
   * paragraph and no `<table>` exists.
   */
  it('GFM 파이프 표를 <table>로 렌더한다 / renders a GFM pipe table as a <table>', () => {
    vi.mocked(useArticleAIStream).mockReturnValue(
      streamState({ data: analysisData('| 항목 | 값 |\n| --- | --- |\n| 기준금리 | 4.5% |\n') }),
    )

    renderPage(SEARCH)

    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '항목' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '기준금리' })).toBeTruthy()
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
   * 네트워크 실패는 스트리밍 훅이 status 0 `network_error`로 감싸 넘긴다 (`api/aiStream.ts`).
   * The four wording branches, the table `lib/aiMessages.ts` shares with F6's AIPanel. A 502 only gets the
   * article wording when the backend says `article_unavailable`: an ALB/CloudFront 502 carries an HTML body,
   * so its detail is `http_502`, and claiming the article body was unreachable would be false. A network
   * failure arrives wrapped as status 0 `network_error` (see `api/aiStream.ts`).
   */
  const errorCases: [ApiError, string][] = [
    [new ApiError(429, 'rate_limited'), '잠시 후 다시 시도해주세요'],
    [new ApiError(503, 'ai_unavailable'), 'AI 기능을 사용할 수 없습니다'],
    [new ApiError(502, 'article_unavailable'), '기사 본문을 가져올 수 없습니다'],
    [new ApiError(502, 'http_502'), 'AI 분석에 실패했습니다'],
    [new ApiError(500, 'ai_failed'), 'AI 분석에 실패했습니다'],
    [new ApiError(0, 'network_error'), 'AI 분석에 실패했습니다'],
  ]

  for (const [error, expected] of errorCases) {
    it(`${error.status} ${error.detail} → "${expected}"`, () => {
      vi.mocked(useArticleAIStream).mockReturnValue(streamState({ error }))

      renderPage(SEARCH)

      expect(screen.getByRole('alert').textContent).toContain(expected)
    })
  }

  it('재시도는 같은 본문으로 분석을 다시 실행한다 / a retry re-runs the analysis with the same body', async () => {
    vi.mocked(useArticleAIStream).mockReturnValue(
      streamState({ error: new ApiError(500, 'ai_failed') }),
    )

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
