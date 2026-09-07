/**
 * AI 스트리밍 훅 — 백엔드가 SSE로 흘리는 부분 응답(`phase` → `delta`* → `final`)을 화면 상태로 옮긴다.
 * The AI streaming hooks; they turn the backend's partial SSE response (`phase`, deltas, `final`) into UI state.
 *
 * **react-query 규칙의 명시적 예외** — "서버 상태는 react-query로만"(`frontend/CLAUDE.md`)에서 이 파일만
 * fetch를 직접 쓴다. react-query는 키마다 "완결된 결과 하나"를 캐시하는 모델이라 델타마다 갱신되는 점진적
 * 응답을 담을 자리가 없다(진행 중 텍스트·단계를 실어 보낼 통로가 없다). 스트리밍이 아닌 서버 상태는 전부
 * 계속 react-query가 관리한다 — 이 예외를 다른 파일로 넓히지 말 것.
 * **A deliberate exception to the react-query rule**: every other piece of server state stays in react-query,
 * but this one file calls fetch directly. react-query caches one settled result per key and has nowhere to put
 * a progressive response (no channel for in-flight text or a phase). Nothing else may widen this exception.
 *
 * 오류는 언제나 `client.ts`의 `ApiError`다 — `lib/aiMessages.ts`의 문구 표가 `status`(+502의 `detail`)로
 * 분기하므로, 두 번째 오류 타입을 만들면 그 표가 조용히 일반 문구로 떨어진다.
 * Failures are always `client.ts`'s `ApiError`: `lib/aiMessages.ts` branches on `status` (plus `detail` for
 * 502), so a second error type would silently degrade every message to the generic one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { createSseParser } from '../lib/sse.ts'
import { ApiError, readDetail } from './client.ts'
import type {
  ArticleAnalysis,
  ArticleAnalysisRequest,
  Envelope,
  StockAnalysis,
  StockQuestionRequest,
} from './types.ts'

/** 진행 단계 — 백엔드 `phase` 이벤트의 값 그대로 / The phase values, exactly as the backend emits them */
export type AiPhase = 'fetching' | 'analyzing' | 'waiting'

export interface AiStream<TData, TBody = void> {
  /** 진행 단계 — 스트림 전/후엔 null / The phase; null before and after the stream */
  phase: AiPhase | null
  /** 누적 스트리밍 텍스트 (delta 합류) / Accumulated streamed text */
  streamText: string
  data: TData | undefined
  asOf: string | undefined
  isLoading: boolean
  error: ApiError | null
  analyze: (body: TBody) => void
}

/** 훅이 들고 있는 상태 (= 반환 형태에서 `analyze`만 뺀 것) / The hook's state: the return shape minus `analyze` */
type StreamState<TData> = Omit<AiStream<TData>, 'analyze'>

// 이벤트 이름 (백엔드 `app/api/ai.py`의 프로토콜 — 이 셋 외의 이벤트는 없다)
// Event names from the backend protocol (`app/api/ai.py`); there are no others
const EVENT_PHASE = 'phase'
const EVENT_DELTA = 'delta'
const EVENT_FINAL = 'final'

/** 유효한 phase 값 / The valid phase values */
const PHASES: readonly string[] = ['fetching', 'analyzing', 'waiting']

/** HTTP 응답 자체가 없었다는 뜻의 상태 코드 / The status meaning "no HTTP response happened at all" */
const STATUS_NO_RESPONSE = 0

/** fetch가 reject한 네트워크 실패의 detail / The detail for a network failure (a rejected fetch) */
const DETAIL_NETWORK = 'network_error'

/** final 없이 끊긴 스트림의 detail / The detail for a stream that ended without a final */
const DETAIL_STREAM_INCOMPLETE = 'stream_incomplete'

/**
 * 진행 중 시도 하나 / One in-flight attempt.
 *
 * 취소 경로가 둘이라 둘 다 들고 있어야 한다: `controller`는 아직 헤더를 기다리는 fetch를 끊고,
 * `reader`는 이미 흐르고 있는 본문을 끊는다(대기 중인 `read()`가 done으로 깨어난다).
 * Both handles are needed because there are two cancellation paths: the controller aborts a fetch still
 * waiting on headers, the reader stops a body already flowing (a pending `read()` wakes up done).
 */
interface Attempt {
  controller: AbortController
  reader: ReadableStreamDefaultReader<Uint8Array> | null
}

/** 시작 전 상태 / The state before a run (and the state each new run resets to) */
function idleState<TData>(isLoading: boolean): StreamState<TData> {
  return {
    phase: null,
    streamText: '',
    data: undefined,
    asOf: undefined,
    isLoading,
    error: null,
  }
}

/**
 * 시도를 폐기한다 (재실행·언마운트) / Discard an attempt (a re-run or an unmount).
 *
 * 취소 실패는 삼킨다 — 이미 닫힌 스트림을 취소하면 reject될 수 있고, 폐기하는 시도의 뒤처리가
 * 새 시도를 깨뜨릴 이유가 없다.
 * A cancellation failure is swallowed: cancelling an already-closed stream can reject, and cleanup for a
 * discarded attempt must never break the new one.
 */
function discard(attempt: Attempt | null): void {
  if (attempt === null) return
  attempt.controller.abort()
  void attempt.reader?.cancel().catch(() => undefined)
}

/**
 * POST init — 본문이 없으면 Content-Type도 붙이지 않는다: `POST /api/ai/stocks/{symbol}`은 본문을 받지
 * 않으므로 없는 본문의 타입을 선언할 이유가 없다.
 * The POST init; without a body no Content-Type is sent either, because `POST /api/ai/stocks/{symbol}` takes
 * no body and there is no point declaring the type of a body that is not there.
 */
function requestInit(body: unknown, signal: AbortSignal): RequestInit {
  const accept = { Accept: 'text/event-stream' }
  if (body === undefined) return { method: 'POST', headers: accept, signal }
  return {
    method: 'POST',
    headers: { ...accept, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }
}

/**
 * 프레임 data를 JSON으로 / A frame's data as JSON.
 *
 * 파싱 불가한 프레임은 무시한다 — 백엔드는 항상 JSON을 보내므로(`ai.py`의 `_sse`) 여기 걸리는 것은 잘린
 * 응답뿐이고, 그런 스트림에는 `final`도 도착하지 않으므로 아래 `stream_incomplete` 오류로 드러난다.
 * 조용히 성공으로 끝나는 경로는 없다.
 * An unparseable frame is ignored: the backend always sends JSON, so only a truncated response lands here,
 * and such a stream never delivers its `final` either — it surfaces as the `stream_incomplete` error below.
 * No path ends silently in success.
 */
function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

/** `phase` 이벤트의 값 / The value of a `phase` event */
function readPhase(payload: unknown): AiPhase | null {
  if (payload === null || typeof payload !== 'object') return null
  const phase = (payload as { phase?: unknown }).phase
  if (typeof phase !== 'string' || !PHASES.includes(phase)) return null
  return phase as AiPhase
}

/** `delta` 이벤트의 텍스트 / The text of a `delta` event */
function readDelta(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const text = (payload as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

/** `final` 이벤트의 두 형태 / The two shapes a `final` event carries */
type Final<TData> =
  | { ok: true; data: TData; asOf: string }
  | { ok: false; error: ApiError }

/**
 * `final` 이벤트 / A `final` event.
 *
 * 성공은 기존 envelope(`asOf`/`marketOpen`/`data`), 실패는 `{error, status}`다. envelope의 `data` 내부는
 * 백엔드 계약이라 여기서 검증하지 않는다 — `client.ts`가 `as Envelope<T>`로 넘기는 것과 같은 경계다.
 * A success carries the usual envelope, a failure `{error, status}`. What is inside `data` is the backend's
 * contract and is not re-validated here, the same trust boundary `client.ts` crosses with `as Envelope<T>`.
 */
function readFinal<TData>(payload: unknown): Final<TData> | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as { error?: unknown; status?: unknown; asOf?: unknown; data?: unknown }
  if (typeof record.error === 'string' && typeof record.status === 'number') {
    return { ok: false, error: new ApiError(record.status, record.error) }
  }
  if (typeof record.asOf === 'string' && record.data !== undefined) {
    const envelope = payload as Envelope<TData>
    return { ok: true, data: envelope.data, asOf: envelope.asOf }
  }
  return null
}

/**
 * 스트림 시작 전에 결정된 HTTP 실패 / An HTTP failure decided before the stream starts.
 *
 * 429(레이트리밋, Retry-After 포함)·422(검증)·404는 스트림이 아니라 평범한 JSON으로 온다
 * (`backend/app/api/ai.py`). 그래서 detail 추출은 `client.ts`의 `readDetail`을 그대로 쓴다 — 규칙이
 * 갈라지면(HTML 5xx 폴백 포함) 같은 응답이 두 경로에서 다른 문구로 읽힌다.
 * The 429 (rate limit, with Retry-After), 422 and 404 answers are plain JSON, not streams, so the detail
 * comes from `client.ts`'s `readDetail` itself: a diverging rule (the HTML 5xx fallback included) would word
 * one response two ways depending on the path.
 */
async function httpError(response: Response): Promise<ApiError> {
  return new ApiError(response.status, await readDetail(response))
}

/**
 * 잡은 실패를 ApiError로 / A caught failure as an ApiError.
 *
 * 네트워크 실패(fetch의 reject)에는 HTTP 상태가 존재하지 않으므로 status 0으로 감싼다 — `aiErrorMessage`는
 * 429/503/502만 특별히 다루므로 일반 문구로 떨어진다. `client.ts`는 이 실패를 그대로 전파하지만, 이 훅의
 * `error`는 `ApiError | null`로 고정된 계약이라 여기서 감싸는 편이 화면에 조건을 늘리지 않는다.
 * A network failure has no HTTP status, so it is wrapped with status 0 and falls through to the generic
 * wording. `client.ts` propagates such failures unchanged, but this hook's `error` is contractually
 * `ApiError | null`, and wrapping here keeps the UI free of an extra branch.
 */
function asApiError(caught: unknown): ApiError {
  return caught instanceof ApiError ? caught : new ApiError(STATUS_NO_RESPONSE, DETAIL_NETWORK)
}

/**
 * 한 번의 분석 요청을 끝까지 소비한다 / Consume one analysis request from start to finish.
 *
 * `commit`은 낡은 시도(재실행·언마운트)의 갱신을 버리는 책임을 이미 갖고 있으므로 여기서는 자유롭게 부른다.
 * `commit` already drops updates from a superseded attempt, so it can be called freely here.
 */
async function consume<TData>(
  path: string,
  body: unknown,
  attempt: Attempt,
  commit: (update: (prev: StreamState<TData>) => StreamState<TData>) => void,
): Promise<void> {
  try {
    const response = await fetch(path, requestInit(body, attempt.controller.signal))
    // 스트림 전 실패(429/422/404)와 본문 없는 응답은 스트림을 읽지 않고 끝낸다
    // A pre-stream failure (429/422/404) or a body-less response never enters the read loop
    if (!response.ok || response.body === null) throw await httpError(response)

    const reader = response.body.getReader()
    attempt.reader = reader
    // `stream: true`가 아니면 청크 경계에 걸친 한글이 U+FFFD로 깨진다 / Without `stream: true` a Korean
    // character straddling two chunks decodes as U+FFFD
    const decoder = new TextDecoder()
    const parser = createSseParser()
    let text = ''
    let settled = false

    while (!settled) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
        const payload = parseJson(frame.data)
        if (frame.event === EVENT_PHASE) {
          // 최신 값이 이긴다 — `waiting` 하트비트가 섞이고 `analyzing`이 두 번 올 수 있다
          // Latest wins: `waiting` heartbeats interleave and `analyzing` can arrive twice
          const phase = readPhase(payload)
          if (phase !== null) commit((prev) => ({ ...prev, phase }))
        } else if (frame.event === EVENT_DELTA) {
          const delta = readDelta(payload)
          if (delta !== null) {
            text += delta
            commit((prev) => ({ ...prev, streamText: text }))
          }
        } else if (frame.event === EVENT_FINAL) {
          const outcome = readFinal<TData>(payload)
          if (outcome === null) break
          // 누적 텍스트는 지우지 않는다 (성공 결과는 `data`가 권위를 갖는다)
          // The accumulated text is kept; on success `data` is the authoritative value
          commit((prev) =>
            outcome.ok
              ? { ...prev, phase: null, isLoading: false, data: outcome.data, asOf: outcome.asOf }
              : { ...prev, phase: null, isLoading: false, error: outcome.error },
          )
          settled = true
          break
        }
      }
    }

    // `final`은 언제나 마지막에 오므로(백엔드가 모든 경로에서 emit한다) 없이 끝난 스트림은 유실이다.
    // 여기서 오류로 마감하지 않으면 스피너가 영원히 남는다.
    // A `final` is always last (the backend emits one on every path), so its absence means a lost stream;
    // without settling as an error here the spinner would spin forever.
    if (!settled) throw new ApiError(response.status, DETAIL_STREAM_INCOMPLETE)
  } catch (caught) {
    // 폐기된 시도의 취소·중단은 오류가 아니다 / An aborted, discarded attempt is not a failure
    if (attempt.controller.signal.aborted) return
    commit((prev) => ({ ...prev, phase: null, isLoading: false, error: asApiError(caught) }))
  } finally {
    // 성공이든 실패든 본문을 놓아준다 / Release the body, success or failure
    void attempt.reader?.cancel().catch(() => undefined)
  }
}

/**
 * 스트리밍 분석 훅의 공통 몸통 / The shared body of the streaming analysis hooks.
 *
 * 낡은 갱신을 막는 장치가 실행 번호(`runRef`) 하나뿐인 것이 중요하다 — 재실행과 언마운트가 같은 번호를
 * 올리므로, "이 시도가 아직 최신인가"라는 질문 하나로 두 경우가 함께 처리된다.
 * One counter (`runRef`) guards against stale updates: a re-run and an unmount both bump it, so the single
 * question "is this attempt still the current one?" covers both cases.
 */
function useAiStream<TData, TBody>(path: string): AiStream<TData, TBody> {
  const [state, setState] = useState<StreamState<TData>>(() => idleState<TData>(false))
  const runRef = useRef(0)
  const attemptRef = useRef<Attempt | null>(null)

  useEffect(
    () => () => {
      // 언마운트: 실행 번호를 올려 이후 갱신을 버리고, 흐르던 본문을 끊는다
      // Unmount: bump the run so later updates are dropped, then stop the body still flowing
      runRef.current += 1
      discard(attemptRef.current)
      attemptRef.current = null
    },
    [],
  )

  const analyze = useCallback(
    (body: TBody) => {
      discard(attemptRef.current)
      runRef.current += 1
      const run = runRef.current
      const attempt: Attempt = { controller: new AbortController(), reader: null }
      attemptRef.current = attempt
      // 새 실행은 이전 결과·오류·텍스트를 모두 버린다 (구 `useStockAI`의 뮤테이션 재실행과 같은 체감)
      // A new run drops the previous result, error and text, matching how re-running the old mutation felt
      setState(idleState<TData>(true))
      void consume<TData>(path, body, attempt, (update) => {
        if (runRef.current === run) setState(update)
      })
    },
    [path],
  )

  return { ...state, analyze }
}

/**
 * 종목 AI 분석 스트림 / The stock AI analysis stream.
 *
 * `analyze()`는 기본 분석, `analyze({ question })`은 그 질문에 대한 답을 요청한다 — 본문이 없으면 `POST` 본문도
 * Content-Type도 붙지 않는다 (`requestInit`). 두 형태는 백엔드에서 다른 캐시 키를 가진다.
 * `analyze()` requests the default analysis, `analyze({ question })` an answer to that question; without a body neither a
 * POST body nor a Content-Type is sent (`requestInit`). The two shapes have different cache keys on the backend.
 */
export function useStockAIStream(symbol: string): AiStream<StockAnalysis, StockQuestionRequest | void> {
  return useAiStream<StockAnalysis, StockQuestionRequest | void>(
    `/api/ai/stocks/${encodeURIComponent(symbol)}`,
  )
}

/** 기사 AI 분석 스트림 (요약·번역·인사이트) / The article AI analysis stream */
export function useArticleAIStream(): AiStream<ArticleAnalysis, ArticleAnalysisRequest> {
  return useAiStream<ArticleAnalysis, ArticleAnalysisRequest>('/api/ai/articles')
}
