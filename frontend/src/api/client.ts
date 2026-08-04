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
 *
 * SSE 경로(`api/aiStream.ts`)도 이 함수를 쓴다 — 스트림 시작 전 실패(429/422/404)는 평범한 JSON이라
 * 규칙이 같아야 한다. 사본이 갈라지면 같은 응답이 화면에서 다른 문구로 읽힌다.
 * The SSE path (`api/aiStream.ts`) uses this too: a pre-stream failure (429/422/404) is plain JSON and
 * must follow the same rule — a diverging copy would word one response two ways.
 */
export async function readDetail(response: Response): Promise<string> {
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

/**
 * GET 요청 / A GET request.
 *
 * POST는 여기에 없다 — envelope을 돌려주는 POST 엔드포인트가 남아 있지 않다. 두 AI 엔드포인트는
 * `text/event-stream`으로 답하므로 `api/aiStream.ts`가 fetch를 직접 쓴다 (본문을 한 번에 JSON으로
 * 소비하는 `request`로는 스트림을 읽을 수 없다). 되살릴 일이 생기면 그때 테스트와 함께 다시 만든다.
 * There is no POST here: no POST endpoint returns an envelope any more. The two AI endpoints answer with
 * `text/event-stream`, so `api/aiStream.ts` calls fetch directly — `request` consumes the body as JSON in one
 * go and cannot read a stream. If a POST is ever needed again it comes back with its own test.
 */
export function apiGet<T>(path: string): Promise<Envelope<T>> {
  return request<T>(path, { method: 'GET' })
}
