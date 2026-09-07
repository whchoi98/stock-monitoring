/**
 * AI 분석 패널 테스트 — 스트리밍 상태(단계 라벨 · 실시간 텍스트 · final 우선)와 오류 문구를 고정한다.
 * AIPanel tests, pinning the streaming states (phase label, live text, final wins) and the error wording.
 *
 * 스트리밍 훅(`useStockAIStream`)을 모킹한다 — 이 패널의 계약은 "훅이 돌려준 상태를 어떻게 보여주는가"이고,
 * SSE 읽기·파싱은 `api/aiStream.test.ts`가 이미 덮는다. `ApiError`는 **모킹하지 않고** 실물을 쓴다:
 * 문구 분기가 `instanceof ApiError` + `status`/`detail`에 달려 있어 가짜 오류로는 그 계약을 확인할 수 없다.
 * The streaming hook (`useStockAIStream`) is mocked: this panel's contract is how it renders what the hook
 * returns, and `api/aiStream.test.ts` already covers the SSE read and parse. `ApiError` is *not* mocked — the
 * wording branches on `instanceof ApiError` plus `status`/`detail`, which a fake error could not pin.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiPhase, AiStream } from '../../api/aiStream.ts'
import { useStockAIStream } from '../../api/aiStream.ts'
import { ApiError } from '../../api/client.ts'
import type { StockAnalysis, StockQuestionRequest } from '../../api/types.ts'
import { AIPanel } from './AIPanel.tsx'

vi.mock('../../api/aiStream.ts', () => ({ useStockAIStream: vi.fn() }))

const analyze = vi.fn()

/** 훅 상태 하나 — 기본은 "아직 아무 것도 시작하지 않은" 상태 / One hook state; the default is "nothing started yet" */
type StockStream = AiStream<StockAnalysis, StockQuestionRequest | void>

function stream(over: Partial<StockStream>): StockStream {
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
const ANALYSIS: StockAnalysis = { symbol: 'AAPL', analysis: '## 최종 분석\n\n최종 문장입니다.\n' }

function renderPanel() {
  return render(<AIPanel symbol="AAPL" />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useStockAIStream).mockReturnValue(stream({}))
})

describe('AIPanel', () => {
  it('심볼을 훅에 넘기고 버튼을 눌러야 분석을 시작한다 / hands the symbol to the hook and starts only on a click', () => {
    renderPanel()

    expect(vi.mocked(useStockAIStream)).toHaveBeenCalledWith('AAPL')
    // 비용이 드는 유일한 경로다 — 렌더만으로는 호출되지 않는다 / The one path that costs money: a render alone never calls it
    expect(analyze).not.toHaveBeenCalled()
    expect(
      screen.getByText('버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'AI 분석' }))

    expect(analyze).toHaveBeenCalledTimes(1)
    // 질문이 비어 있으면 본문 없는 기본 분석이다 / An empty question is the body-less default analysis
    expect(analyze).toHaveBeenCalledWith()
  })

  it('질문을 넣고 제출하면 그 질문으로 요청하고, 보낸 질문을 보여준다 / a typed question is sent as the body and shown', () => {
    renderPanel()

    // 앞뒤 공백은 잘라 보낸다 (안쪽 공백 정규화는 백엔드 몫) / Outer whitespace is trimmed; inner normalisation is the backend's job
    fireEvent.change(screen.getByRole('textbox', { name: 'AI 질문' }), {
      target: { value: '  배당 정책은 어떤가요?  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'AI 분석' }))

    expect(analyze).toHaveBeenCalledWith({ question: '배당 정책은 어떤가요?' })

    // 스트리밍 중에는 보낸 질문이 답 위에 보인다 / While streaming, the sent question sits above the answer
    vi.mocked(useStockAIStream).mockReturnValue(stream({ isLoading: true, streamText: '답변 중' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'AI 질문' }), { target: { value: 'x' } })
    expect(screen.getByText('배당 정책은 어떤가요?')).toBeTruthy()
  })

  it('프리셋을 누르면 바로 그 질문으로 요청한다 / a preset runs that question at once', () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '가장 큰 리스크는 무엇인가요?' }))

    expect(analyze).toHaveBeenCalledWith({ question: '가장 큰 리스크는 무엇인가요?' })
    expect((screen.getByRole('textbox', { name: 'AI 질문' }) as HTMLInputElement).value).toBe(
      '가장 큰 리스크는 무엇인가요?',
    )
  })

  it('final의 question이 누적 상태보다 우선한다 (캐시 히트) / the final’s question wins, as on a cache hit', () => {
    vi.mocked(useStockAIStream).mockReturnValue(
      stream({ data: { symbol: 'AAPL', analysis: '## 답변\n\n좋습니다.', question: '캐시된 질문' } }),
    )

    renderPanel()

    expect(screen.getByText('캐시된 질문')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '답변' })).toBeTruthy()
  })

  it('실행 중에는 입력·프리셋도 잠긴다 / input and presets lock while a run is in flight', () => {
    vi.mocked(useStockAIStream).mockReturnValue(stream({ isLoading: true, phase: 'analyzing' }))

    renderPanel()

    expect(screen.getByRole('textbox', { name: 'AI 질문' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '가장 큰 리스크는 무엇인가요?' }).hasAttribute('disabled')).toBe(true)
  })

  /*
   * 단계 라벨 — 백엔드 `phase` 이벤트를 그대로 문구로 옮긴다. 아직 phase가 오지 않은 사이(요청 직후)에도
   * 문구가 있어야 스피너만 도는 빈 화면이 생기지 않는다.
   * The phase labels map the backend's `phase` event straight to wording. The gap before the first phase
   * arrives needs wording too, so no bare spinner is ever shown on its own.
   */
  const phaseLabels: [AiPhase | null, string][] = [
    [null, '분석 준비 중…'],
    ['fetching', '본문을 가져오는 중…'],
    ['waiting', '순서를 기다리는 중…'],
    ['analyzing', '분석 중…'],
  ]

  for (const [phase, label] of phaseLabels) {
    it(`phase ${String(phase)} → "${label}"`, () => {
      vi.mocked(useStockAIStream).mockReturnValue(stream({ isLoading: true, phase }))

      renderPanel()

      expect(screen.getByText(label)).toBeTruthy()
      expect(screen.getByRole('status')).toBeTruthy()
      // 실행 중에는 버튼을 다시 누를 수 없다 / The button cannot be pressed again while a run is in flight
      expect(screen.getByRole('button', { name: 'AI 분석' }).hasAttribute('disabled')).toBe(true)
    })
  }

  it('토큰이 도착하면 스피너 없이 누적 텍스트를 마크다운으로 렌더한다 / once tokens arrive it renders the accumulated text as markdown, with no spinner', () => {
    vi.mocked(useStockAIStream).mockReturnValue(
      stream({ isLoading: true, phase: 'analyzing', streamText: '## 진행 중\n\n첫 문장' }),
    )

    renderPanel()

    expect(screen.getByRole('heading', { level: 2, name: '진행 중' })).toBeTruthy()
    expect(screen.getByText('첫 문장')).toBeTruthy()
    // 텍스트 자체가 진행 표시다 — 스피너와 단계 문구는 물러난다 / The text is the progress: spinner and phase wording step aside
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('분석 중…')).toBeNull()
  })

  it('final이 도착하면 누적 텍스트보다 data.analysis가 우선이다 / after the final, data.analysis wins over the accumulated text', () => {
    vi.mocked(useStockAIStream).mockReturnValue(
      stream({
        data: ANALYSIS,
        asOf: '2026-08-03T04:00:00+00:00',
        // 훅은 final 뒤에도 누적 텍스트를 지우지 않는다 (권위는 `data`) / The hook keeps the text after the final; `data` is authoritative
        streamText: '## 진행 중\n\n잘린 문장',
      }),
    )

    renderPanel()

    expect(screen.getByRole('heading', { level: 2, name: '최종 분석' })).toBeTruthy()
    expect(screen.getByText('최종 문장입니다.')).toBeTruthy()
    expect(screen.queryByText('잘린 문장')).toBeNull()
    // 두 번째 실행은 "다시 분석" / A second run reads "다시 분석"
    expect(screen.getByRole('button', { name: '다시 분석' })).toBeTruthy()
  })

  /*
   * GFM 표 — remark-gfm이 붙어 있다는 증거다. 플러그인이 없으면 파이프 줄이 문단 하나로 렌더되므로
   * `<table>`이 존재하지 않는다.
   * The GFM table is the evidence remark-gfm is wired in: without the plugin the pipe lines render as a single
   * paragraph and no `<table>` exists.
   */
  const TABLE = '| 항목 | 값 |\n| --- | --- |\n| PER | 12.3 |\n'

  it('GFM 파이프 표를 <table>로 렌더한다 (최종본) / renders a GFM pipe table as a <table> (final)', () => {
    vi.mocked(useStockAIStream).mockReturnValue(
      stream({ data: { symbol: 'AAPL', analysis: TABLE } }),
    )

    renderPanel()

    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '항목' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: 'PER' })).toBeTruthy()
  })

  it('스트리밍 중에도 표를 <table>로 렌더한다 / renders a table while still streaming too', () => {
    vi.mocked(useStockAIStream).mockReturnValue(stream({ isLoading: true, streamText: TABLE }))

    renderPanel()

    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '값' })).toBeTruthy()
  })

  /*
   * 오류 문구는 `lib/aiMessages.ts`가 갖는다 (기사 화면과 같은 표) — 여기서는 패널이 그 표를 쓰는지만 본다.
   * The wording lives in `lib/aiMessages.ts` (the same table the article screen uses); this only checks the
   * panel goes through it.
   */
  const errorCases: [ApiError, string][] = [
    [new ApiError(429, 'rate_limited'), '잠시 후 다시 시도해주세요'],
    [new ApiError(503, 'ai_unavailable'), 'AI 기능을 사용할 수 없습니다'],
    [new ApiError(500, 'ai_failed'), 'AI 분석에 실패했습니다'],
    [new ApiError(0, 'network_error'), 'AI 분석에 실패했습니다'],
  ]

  for (const [error, expected] of errorCases) {
    it(`${error.status} ${error.detail} → "${expected}"`, () => {
      vi.mocked(useStockAIStream).mockReturnValue(stream({ error }))

      renderPanel()

      expect(screen.getByRole('alert').textContent).toContain(expected)
      /*
       * 429·503에도 실행 버튼을 남긴다 — 둘 다 시간이 지나면 풀리는 상태이고, 버튼이 사라지면 사용자는
       * 페이지를 새로 고치는 수밖에 없다.
       * The run button survives 429 and 503: both clear with time, and without it a page reload would be the
       * only way back.
       */
      expect(screen.getByRole('button', { name: 'AI 분석' }).hasAttribute('disabled')).toBe(false)
    })
  }

  it('오류 카드의 재시도는 같은 분석을 다시 실행한다 / the error card retry re-runs the same analysis', () => {
    vi.mocked(useStockAIStream).mockReturnValue(stream({ error: new ApiError(500, 'ai_failed') }))

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))

    expect(analyze).toHaveBeenCalledTimes(1)
  })
})
