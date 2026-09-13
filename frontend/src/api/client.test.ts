/**
 * API 클라이언트 테스트 — `globalThis.fetch`를 stub으로 대체해 HTTP 경계만 가짜로 만든다.
 * API client tests; only the HTTP boundary is faked by stubbing `globalThis.fetch`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiGet } from './client.ts'

/** JSON 본문을 가진 실제 Response를 만든다 / Build a real Response carrying a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * fetch를 정해진 응답으로 대체하고 호출 기록을 돌려준다 / Stub fetch with a fixed response and return the call log.
 *
 * `vi.fn<typeof fetch>`로 타입을 고정해야 `mock.calls[0]`이 실제 fetch 인자 튜플로 추론된다.
 * Pinning the type with `vi.fn<typeof fetch>` is what makes `mock.calls[0]` the real fetch argument tuple.
 */
function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 헤더 전 또는 본문 도중 멈춘 전송 — 실제 fetch처럼 signal이 전송과 본문을 함께 중단한다.
 * A transport stalled before headers or during the body; like fetch, its signal aborts both.
 */
function stallFetch(at: 'headers' | number) {
  const fetchMock = vi.fn<typeof fetch>((_path, init) => new Promise((resolve, reject) => {
    const signal = init?.signal
    if (at === 'headers') {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      return
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      },
    })
    resolve(new Response(body, { status: at }))
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('apiGet', () => {
  it('2xx 응답의 envelope을 그대로 돌려준다 / returns the envelope of a 2xx response', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        asOf: '2026-08-02T00:00:00+00:00',
        marketOpen: true,
        data: [{ symbol: 'AAPL', price: 231.5 }],
      }),
    )

    const envelope = await apiGet<{ symbol: string; price: number }[]>('/api/market/quotes?market=us')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/market/quotes?market=us')
    expect(envelope.asOf).toBe('2026-08-02T00:00:00+00:00')
    expect(envelope.marketOpen).toBe(true)
    expect(envelope.data).toEqual([{ symbol: 'AAPL', price: 231.5 }])
  })

  it('404 본문의 detail을 담은 ApiError를 throw한다 / throws ApiError carrying the 404 body detail', async () => {
    stubFetch(jsonResponse(404, { detail: 'unknown symbol: NOPE' }))

    const error = await apiGet('/api/stocks/NOPE').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).detail).toBe('unknown symbol: NOPE')
  })

  it('JSON이 아닌 오류 본문도 상태 코드로 설명한다 / falls back to the status code for a non-JSON error body', async () => {
    stubFetch(new Response('<html>504 Gateway Time-out</html>', { status: 504 }))

    const error = await apiGet('/api/market/overview').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(504)
    expect((error as ApiError).detail).toBe('http_504')
  })

  it('네트워크 예외는 그대로 전파한다 / propagates a network failure unchanged', async () => {
    const failure = new TypeError('Failed to fetch')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(failure)),
    )

    const error = await apiGet('/api/market/overview').catch((caught: unknown) => caught)

    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(ApiError)
  })

  it.each(['headers', 200, 503] as const)(
    '20초 업스트림 후 전송 제한 / bounds a stalled %s transfer after allowing the 20s upstream',
    async (at) => {
      vi.useFakeTimers()
      const fetchMock = stallFetch(at)
      let failure: unknown
      const pending = apiGet('/api/market/overview').catch((error: unknown) => { failure = error })

      await vi.advanceTimersByTimeAsync(20_000)
      expect(failure).toBeUndefined()

      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(failure).toMatchObject({ name: 'TimeoutError' })
      await pending
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['headers', 200, 503] as const)(
    '전송 경계까지 호출자 취소 / caller cancellation reaches the %s transfer',
    async (at) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      const reason = new DOMException('Caller cancelled', 'AbortError')
      const fetchMock = stallFetch(at)
      let failure: unknown
      const pending = apiGet('/api/market/overview', caller.signal)
        .catch((error: unknown) => { failure = error })
      await vi.advanceTimersByTimeAsync(0)

      caller.abort(reason)
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(failure).toBe(reason)
      await pending
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('이미 취소된 호출은 fetch를 시작하지 않는다 / does not fetch for an already-aborted caller', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(jsonResponse(200, { data: [] }))
    const caller = new AbortController()
    caller.abort()

    const error = await apiGet('/api/market/overview', caller.signal).catch((caught: unknown) => caught)

    expect(error).toBe(caller.signal.reason)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([200, 503])(
    '완료 후 타이머와 호출자 구독 정리 / cleans up a settled %s request',
    async (status) => {
      vi.useFakeTimers()
      const caller = new AbortController()
      const fetchMock = stubFetch(jsonResponse(status, { data: [], detail: 'unavailable' }))

      await apiGet('/api/market/overview', caller.signal).catch(() => undefined)
      expect(vi.getTimerCount()).toBe(0)
      caller.abort()
      await vi.advanceTimersByTimeAsync(45_000)

      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    },
  )
})
