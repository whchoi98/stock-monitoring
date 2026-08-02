/**
 * API 클라이언트 테스트 — `globalThis.fetch`를 stub으로 대체해 HTTP 경계만 가짜로 만든다.
 * API client tests; only the HTTP boundary is faked by stubbing `globalThis.fetch`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiGet, apiPost } from './client.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
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
})

describe('apiPost', () => {
  it('본문 없이 POST한다 (종목 AI 분석) / posts without a body (stock AI analysis)', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        asOf: '2026-08-02T00:00:00+00:00',
        marketOpen: false,
        data: { symbol: 'AAPL', analysis: '## 분석' },
      }),
    )

    const envelope = await apiPost<{ symbol: string; analysis: string }>('/api/ai/stocks/AAPL')

    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(init.headers).toBeUndefined()
    expect(envelope.data.analysis).toBe('## 분석')
  })

  it('본문을 JSON으로 직렬화해 보낸다 (기사 AI 분석) / sends the body as JSON (article AI analysis)', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        asOf: '2026-08-02T00:00:00+00:00',
        marketOpen: false,
        data: { url: 'https://e.com/a', title: 'A', language: 'en', analysis: '## 분석' },
      }),
    )

    await apiPost('/api/ai/articles', { url: 'https://e.com/a', title: 'A', language: 'en' })

    const init = fetchMock.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(init.body).toBe('{"url":"https://e.com/a","title":"A","language":"en"}')
  })

  it('429는 rate_limited detail을 가진 ApiError가 된다 / maps 429 to ApiError with the rate_limited detail', async () => {
    stubFetch(jsonResponse(429, { detail: 'rate_limited', retryAfter: 60 }))

    const error = await apiPost('/api/ai/stocks/AAPL').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(429)
    expect((error as ApiError).detail).toBe('rate_limited')
  })
})
