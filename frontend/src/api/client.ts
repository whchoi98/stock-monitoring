/**
 * HTTP 클라이언트 — 모든 API 호출은 이 파일을 경유한다.
 * The HTTP client; every API call goes through this file.
 *
 * 경로는 항상 같은 오리진의 절대 경로(`/api/...`)다 — 개발은 vite 프록시, 운영은 CloudFront가
 * 같은 도메인에서 ALB로 넘긴다. 그래서 base URL 설정이 없다.
 * Paths are always same-origin absolute paths (`/api/...`): the vite proxy in development and
 * CloudFront in production both serve them from one domain, so there is no base URL to configure.
 *
 * envelope 언래핑은 여기서 하지 않는다 (쿼리 훅의 책임) — `asOf`/`marketOpen`을 잃지 않기 위해서다.
 * Unwrapping the envelope is the query hooks' job, so `asOf`/`marketOpen` are never dropped here.
 */
import type { Envelope } from './types.ts'

/**
 * 비 2xx 응답 / A non-2xx response.
 *
 * `status`와 `detail`을 함께 노출한다 — 화면은 이 둘로 분기한다
 * (429 `rate_limited`, 503 `ai_unavailable`, 500 `ai_failed`, 502 `article_unavailable`, 404 등).
 * Both `status` and `detail` are exposed because the UI branches on them.
 */
export class ApiError extends Error {
  status: number
  detail: string

  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * 오류 본문에서 detail 문자열을 뽑는다 / Extract the detail string from an error body.
 *
 * 백엔드 오류는 `{"detail": "..."}`이지만 422(검증 오류)의 detail은 객체 배열이고, ALB/CloudFront가
 * 만든 5xx는 HTML일 수 있다. 어느 경우든 여기서 예외가 나가서는 안 되므로 상태 코드로 폴백한다.
 * Backend errors are `{"detail": "..."}`, but a 422's detail is an array of objects and an ALB or
 * CloudFront 5xx can be HTML. This must never throw, so it falls back to the status code.
 */
async function readDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object') {
      const detail = (body as { detail?: unknown }).detail
      if (typeof detail === 'string') return detail
    }
  } catch {
    // 본문이 JSON이 아니다 — 상태 코드만으로 설명한다 / Not a JSON body; the status code has to describe it
  }
  return `http_${response.status}`
}

/**
 * 요청을 보내고 envelope을 돌려준다 / Send the request and return the envelope.
 *
 * 네트워크 실패(fetch의 reject)는 감싸지 않고 그대로 전파한다 — HTTP 오류와 구분되어야 하고,
 * 그때는 status라는 게 존재하지 않는다.
 * A network failure (a rejected fetch) propagates unchanged: it must stay distinguishable from an
 * HTTP error, and no status exists for it.
 */
async function request<T>(path: string, init: RequestInit): Promise<Envelope<T>> {
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response))
  }
  return (await response.json()) as Envelope<T>
}

/** GET 요청 / A GET request */
export function apiGet<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path, { method: 'GET' })
}

/**
 * POST 요청 / A POST request.
 *
 * `body`가 없으면 Content-Type도 붙이지 않는다 — `POST /api/ai/stocks/{symbol}`은 본문을 받지 않는다.
 * Without a `body` no Content-Type is sent either, because `POST /api/ai/stocks/{symbol}` takes none.
 */
export function apiPost<T>(path: string, body?: unknown): Promise<Envelope<T>> {
  if (body === undefined) return request<T>(path, { method: 'POST' })
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
