/**
 * AI 스트리밍 훅 테스트 — `globalThis.fetch`만 가짜로 만들고 SSE 바이트는 실제 `ReadableStream`으로 흘린다.
 * The AI streaming hook tests: only `globalThis.fetch` is faked, and the SSE bytes flow through a real
 * `ReadableStream` so the parser, the decoder and the reader loop are all exercised as they run in a browser.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AI_FAILED,
  AI_RATE_LIMITED,
  AI_UNAVAILABLE,
  ARTICLE_UNAVAILABLE,
  aiErrorMessage,
} from '../lib/aiMessages.ts'
import { useArticleAIStream, useStockAIStream } from './aiStream.ts'
import { ApiError } from './client.ts'

const encoder = new TextEncoder()

/** SSE 프레임 하나를 문자열로 / One SSE frame as a string */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 테스트가 직접 밀어 넣는 SSE 응답 / An SSE response the test feeds by hand */
interface FakeStream {
  response: Response
  push(frame: string): void
  pushBytes(bytes: Uint8Array): void
  close(): void
  /** 훅이 리더를 취소했는지 / Whether the hook cancelled the reader */
  cancelled(): boolean
}

function sseStream(): FakeStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(source) {
      controller = source
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (frame) => controller.enqueue(encoder.encode(frame)),
    pushBytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
    cancelled: () => cancelled,
  }
}

/** JSON 본문을 가진 응답 (스트림 전 실패 경로) / A JSON-bodied response (the pre-stream failure path) */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(...responses: Response[]) {
  let call = 0
  const fetchMock = vi.fn<typeof fetch>(() => {
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    return Promise.resolve(response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 읽기 루프가 밀린 바이트를 모두 소화할 때까지 기다린다 / Wait until the read loop has digested every pushed byte.
 *
 * 루프는 `read()` → 파싱 → `setState` → 다음 `read()`로 여러 마이크로태스크를 건너므로, 매크로태스크
 * 한 번(`setTimeout(0)`)을 기다려 큐를 비운다. `act`로 감싸므로 그 사이의 상태 갱신에 경고가 없다.
 * The loop hops several microtasks per chunk, so one macrotask tick drains the queue; wrapping it in
 * `act` keeps every update inside an act scope (no "not wrapped in act" warnings).
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

/** 프레임 하나를 흘리고 훅이 처리할 때까지 기다린다 / Emit one frame and let the hook process it */
async function emit(stream: FakeStream, event: string, data: unknown): Promise<void> {
  stream.push(sseFrame(event, data))
  await flush()
}

/** 종목 성공 final의 envelope / The envelope a successful stock final carries */
const STOCK_FINAL = {
  asOf: '2026-08-03T04:00:00+00:00',
  marketOpen: false,
  data: { symbol: 'AAPL', analysis: '## 분석\n- 한 줄' },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useStockAIStream', () => {
  it('delta를 순서대로 streamText에 누적한다 / accumulates deltas into streamText in order', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    expect(result.current.isLoading).toBe(false)
    expect(result.current.phase).toBeNull()

    act(() => {
      result.current.analyze()
    })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.streamText).toBe('')

    await emit(stream, 'phase', { phase: 'analyzing' })
    expect(result.current.phase).toBe('analyzing')

    await emit(stream, 'delta', { text: '## 분석\n' })
    await emit(stream, 'delta', { text: '- 한 줄' })

    expect(result.current.streamText).toBe('## 분석\n- 한 줄')
    expect(result.current.isLoading).toBe(true)
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeNull()
  })

  it('phase는 마지막 값이 이긴다 (waiting 하트비트 뒤 analyzing 재알림) / phase is latest-wins', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })

    await emit(stream, 'phase', { phase: 'analyzing' })
    expect(result.current.phase).toBe('analyzing')
    await emit(stream, 'phase', { phase: 'waiting' })
    expect(result.current.phase).toBe('waiting')
    await emit(stream, 'phase', { phase: 'waiting' })
    expect(result.current.phase).toBe('waiting')
    await emit(stream, 'phase', { phase: 'analyzing' })
    expect(result.current.phase).toBe('analyzing')
  })

  it('성공 final이 data/asOf를 채우고 streamText는 남긴다 / a successful final sets data and asOf, keeping streamText', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await emit(stream, 'phase', { phase: 'analyzing' })
    await emit(stream, 'delta', { text: '## 분석\n- 한 줄' })
    await emit(stream, 'final', STOCK_FINAL)

    expect(result.current.data).toEqual({ symbol: 'AAPL', analysis: '## 분석\n- 한 줄' })
    expect(result.current.asOf).toBe('2026-08-03T04:00:00+00:00')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.phase).toBeNull()
    expect(result.current.error).toBeNull()
    // 텍스트는 지우지 않는다 — 다만 화면이 믿는 값은 data다 / The text stays; data is what the UI trusts
    expect(result.current.streamText).toBe('## 분석\n- 한 줄')
    // final은 항상 마지막이라 더 읽지 않는다 / final is always last, so the body is released
    expect(stream.cancelled()).toBe(true)
  })

  it('오류 final은 aiErrorMessage가 매핑하는 ApiError가 된다 / an error final becomes an ApiError aiErrorMessage maps', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await emit(stream, 'phase', { phase: 'analyzing' })
    await emit(stream, 'final', { error: 'ai_unavailable', status: 503 })

    const error = result.current.error
    expect(error).toBeInstanceOf(ApiError)
    expect(error?.status).toBe(503)
    expect(error?.detail).toBe('ai_unavailable')
    expect(aiErrorMessage(error as ApiError)).toBe(AI_UNAVAILABLE)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.phase).toBeNull()
    expect(result.current.data).toBeUndefined()
  })

  it('429 JSON 응답은 스트림을 읽지 않고 ApiError가 된다 / a 429 JSON response yields an ApiError without stream parsing', async () => {
    stubFetch(jsonResponse(429, { detail: 'rate_limited', retryAfter: 60 }))
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await flush()

    const error = result.current.error
    expect(error).toBeInstanceOf(ApiError)
    expect(error?.status).toBe(429)
    expect(error?.detail).toBe('rate_limited')
    expect(aiErrorMessage(error as ApiError)).toBe(AI_RATE_LIMITED)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.phase).toBeNull()
    expect(result.current.streamText).toBe('')
  })

  it('final 없이 끊긴 스트림은 오류로 마감한다 / a stream that ends without a final settles as an error', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await emit(stream, 'delta', { text: '조각' })
    stream.close()
    await flush()

    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(aiErrorMessage(result.current.error as ApiError)).toBe(AI_FAILED)
    expect(result.current.streamText).toBe('조각')
  })

  it('멀티바이트 문자가 청크 경계에서 쪼개져도 온전히 조립한다 / stitches a multi-byte character split across chunks', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })

    const bytes = encoder.encode(sseFrame('delta', { text: '한글' }))
    // '글'(UTF-8 3바이트)의 첫 바이트만 앞 청크에 남긴다 / Leave only the first byte of '글' (3 bytes) in the head
    const cut = bytes.length - encoder.encode('글"}\n\n').length + 1

    stream.pushBytes(bytes.slice(0, cut))
    await flush()
    // 쪼개진 문자는 대체 문자(U+FFFD)로 새지 않는다 / A split character must not leak as U+FFFD
    expect(result.current.streamText).toBe('')

    stream.pushBytes(bytes.slice(cut))
    await flush()
    expect(result.current.streamText).toBe('한글')
  })

  it('본문 없이 POST하고 심볼을 경로에 인코딩한다 / posts without a body, encoding the symbol into the path', async () => {
    const stream = sseStream()
    const fetchMock = stubFetch(stream.response)
    const { result } = renderHook(() => useStockAIStream('005930.KS'))

    act(() => {
      result.current.analyze()
    })
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/stocks/005930.KS')
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('Content-Type')).toBeNull()
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('두 번째 analyze()가 이전 스트림 상태를 초기화한다 / a second analyze() resets the prior stream state', async () => {
    const first = sseStream()
    const second = sseStream()
    const fetchMock = stubFetch(first.response, second.response)
    const { result } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await emit(first, 'phase', { phase: 'analyzing' })
    await emit(first, 'delta', { text: '이전 결과' })
    expect(result.current.streamText).toBe('이전 결과')

    // 이미 도착해 대기 중인 델타가 새 실행의 상태를 되살리는 경합을 고정한다 — `read()`는 취소보다
    // 먼저 이 값으로 resolve된다 / Pin the race where a delta already delivered to the pending `read()`
    // resurrects the new run's state: that read resolves with the chunk before the cancellation lands
    first.push(sseFrame('delta', { text: '유령 델타' }))
    act(() => {
      result.current.analyze()
    })

    expect(result.current.streamText).toBe('')
    expect(result.current.phase).toBeNull()
    expect(result.current.data).toBeUndefined()
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(true)
    // 이전 스트림은 계속 읽지 않는다 (비용·상태 오염 방지) / The superseded stream is dropped, not kept reading
    await waitFor(() => {
      expect(first.cancelled()).toBe(true)
    })
    // 낡은 시도의 갱신은 버려진다 / The superseded attempt's update is dropped
    expect(result.current.streamText).toBe('')

    await emit(second, 'delta', { text: '새 결과' })
    await emit(second, 'final', STOCK_FINAL)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.streamText).toBe('새 결과')
    expect(result.current.data).toEqual({ symbol: 'AAPL', analysis: '## 분석\n- 한 줄' })
  })

  it('언마운트하면 리더를 취소하고 이후 상태를 갱신하지 않는다 / unmounting cancels the reader and stops updating state', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    // act 경고를 포함한 어떤 콘솔 오류도 없어야 한다 / No console error, act warnings included
    const consoleError = vi.spyOn(console, 'error')
    const { result, unmount } = renderHook(() => useStockAIStream('AAPL'))

    act(() => {
      result.current.analyze()
    })
    await emit(stream, 'phase', { phase: 'analyzing' })
    expect(stream.cancelled()).toBe(false)

    unmount()
    await flush()

    expect(stream.cancelled()).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('useArticleAIStream', () => {
  it('요청 본문을 JSON으로 POST한다 / posts the request body as JSON', async () => {
    const stream = sseStream()
    const fetchMock = stubFetch(stream.response)
    const { result } = renderHook(() => useArticleAIStream())

    act(() => {
      result.current.analyze({ url: 'https://e.com/a', title: 'A', language: 'en' })
    })
    await flush()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/articles')
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.body).toBe('{"url":"https://e.com/a","title":"A","language":"en"}')
  })

  it('fetching → analyzing → delta → final을 끝까지 처리한다 / handles fetching, analyzing, deltas and the final', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useArticleAIStream())

    act(() => {
      result.current.analyze({ url: 'https://e.com/a', title: 'A', language: 'en' })
    })
    await emit(stream, 'phase', { phase: 'fetching' })
    expect(result.current.phase).toBe('fetching')
    await emit(stream, 'phase', { phase: 'analyzing' })
    await emit(stream, 'delta', { text: '## 요약' })
    await emit(stream, 'final', {
      asOf: '2026-08-03T04:05:00+00:00',
      marketOpen: true,
      data: {
        url: 'https://e.com/a',
        title: 'A',
        language: 'en',
        analysis: '## 요약',
      },
    })

    expect(result.current.data).toEqual({
      url: 'https://e.com/a',
      title: 'A',
      language: 'en',
      analysis: '## 요약',
    })
    expect(result.current.asOf).toBe('2026-08-03T04:05:00+00:00')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('502 article_unavailable final은 기사 수집 실패 문구로 매핑된다 / a 502 article_unavailable final maps to the article wording', async () => {
    const stream = sseStream()
    stubFetch(stream.response)
    const { result } = renderHook(() => useArticleAIStream())

    act(() => {
      result.current.analyze({ url: 'https://e.com/a', title: 'A', language: 'en' })
    })
    await emit(stream, 'phase', { phase: 'fetching' })
    await emit(stream, 'final', { error: 'article_unavailable', status: 502 })

    const error = result.current.error
    expect(error?.status).toBe(502)
    expect(error?.detail).toBe('article_unavailable')
    expect(aiErrorMessage(error as ApiError)).toBe(ARTICLE_UNAVAILABLE)
    expect(result.current.isLoading).toBe(false)
  })
})
