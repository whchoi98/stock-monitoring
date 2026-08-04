/**
 * aiMessages 테스트 — 두 화면(F6 `AIPanel`, F7 `ArticleAnalysis`)이 공유하는 문구 표를 직접 고정한다.
 * aiMessages tests, pinning the wording table both screens share (F6's `AIPanel`, F7's `ArticleAnalysis`).
 *
 * 스트리밍 훅 테스트(`api/aiStream.test.ts`)가 `aiErrorMessage`를 곁들여 검증하지만, 그것은 훅이 만든
 * `ApiError`가 어떤 문구로 읽히는지를 보는 것이라 **훅이 만들 수 없는 입력**은 덮이지 않는다:
 * ApiError가 아닌 평범한 `Error`(옛 mutation 경로에서 오던 입력 — 훅은 이제 전부 `ApiError`로 감싼다),
 * 게이트웨이가 만든 502, 그리고 `aiPhaseLabel`의 네 라벨. 그 빈칸을 이 파일이 메운다.
 * The streaming-hook tests (`api/aiStream.test.ts`) check `aiErrorMessage` in passing, but only for errors the
 * hook itself produces, so **inputs the hook cannot make** stay uncovered: a plain `Error` that is not an
 * ApiError (what the old mutation path delivered; the hook now wraps everything in `ApiError`), a
 * gateway-manufactured 502, and all four `aiPhaseLabel` labels. This file fills that gap.
 */
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client.ts'
import {
  AI_FAILED,
  AI_RATE_LIMITED,
  AI_UNAVAILABLE,
  ARTICLE_UNAVAILABLE,
  aiErrorMessage,
  aiPhaseLabel,
} from './aiMessages.ts'

describe('aiErrorMessage', () => {
  it('ApiError가 아니면 일반 문구 / falls back to the generic wording for a non-ApiError', () => {
    expect(aiErrorMessage(new Error('boom'))).toBe(AI_FAILED)
    expect(aiErrorMessage(new TypeError('Failed to fetch'))).toBe(AI_FAILED)
  })

  it('429는 레이트리밋 문구 / 429 reads as the rate limit', () => {
    expect(aiErrorMessage(new ApiError(429, 'rate_limited'))).toBe(AI_RATE_LIMITED)
  })

  it('503은 사용 불가 문구 / 503 reads as unavailable', () => {
    expect(aiErrorMessage(new ApiError(503, 'ai_unavailable'))).toBe(AI_UNAVAILABLE)
  })

  it('502 + article_unavailable은 기사 수집 실패 문구 / a 502 with article_unavailable reads as a fetch failure', () => {
    expect(aiErrorMessage(new ApiError(502, 'article_unavailable'))).toBe(ARTICLE_UNAVAILABLE)
  })

  it('그 외 502는 기사 문구를 쓰지 않는다 (게이트웨이 오류) / any other 502 must not claim the article failed', () => {
    // ALB/CloudFront가 만든 502는 본문이 HTML이라 detail이 `http_502`로 떨어진다 (`api/client.ts`)
    // An ALB or CloudFront 502 carries an HTML body, so the detail falls back to `http_502` (`api/client.ts`)
    expect(aiErrorMessage(new ApiError(502, 'http_502'))).toBe(AI_FAILED)
  })

  it('500·404·네트워크 실패는 일반 문구 / 500, 404 and a network failure read as the generic wording', () => {
    expect(aiErrorMessage(new ApiError(500, 'ai_failed'))).toBe(AI_FAILED)
    expect(aiErrorMessage(new ApiError(404, 'unknown symbol: NOPE'))).toBe(AI_FAILED)
    // status 0 = HTTP 응답 자체가 없었다 (`api/aiStream.ts`의 네트워크 실패 래핑)
    // status 0 means no HTTP response happened at all (the network-failure wrapping in `api/aiStream.ts`)
    expect(aiErrorMessage(new ApiError(0, 'network_error'))).toBe(AI_FAILED)
  })

  it('문구는 서로 다르고 사용자에게 읽히는 한국어다 / the four wordings are distinct, user-facing Korean', () => {
    expect([AI_RATE_LIMITED, AI_UNAVAILABLE, ARTICLE_UNAVAILABLE, AI_FAILED]).toEqual([
      '잠시 후 다시 시도해주세요',
      'AI 기능을 사용할 수 없습니다',
      '기사 본문을 가져올 수 없습니다',
      'AI 분석에 실패했습니다',
    ])
  })
})

describe('aiPhaseLabel', () => {
  it('phase마다 다른 라벨, null도 문구가 있다 / one label per phase, and null has wording too', () => {
    // null은 요청 직후 첫 `phase` 이전 (스피너만 도는 화면을 만들지 않는다)
    // null covers the gap before the first `phase`, so a bare spinner never stands alone
    expect(aiPhaseLabel(null)).toBe('분석 준비 중…')
    expect(aiPhaseLabel('fetching')).toBe('본문을 가져오는 중…')
    /*
     * `waiting`의 원인은 셋이고(팔로워 대기·Bedrock permit 대기·기사 fetch permit 대기) 프론트는 어느
     * 쪽인지 구분할 수 없다 — 그래서 문구는 원인에 중립이어야 한다. "다른 요청의 결과를 기다린다"고
     * 말하면 permit 대기(자기 분석을 곧 시작하는 요청)에서는 거짓이 된다.
     * A `waiting` has three causes (a follower wait, a Bedrock permit queue, an article fetch permit queue)
     * and the frontend cannot tell them apart, so the wording must stay neutral about the cause: claiming
     * it waits for "another request's result" would be false during a permit queue, where this very request
     * is about to run its own analysis.
     */
    expect(aiPhaseLabel('waiting')).toBe('순서를 기다리는 중…')
    expect(aiPhaseLabel('analyzing')).toBe('분석 중…')
  })

  it('네 라벨이 모두 구별된다 / all four labels differ', () => {
    const labels = [null, 'fetching', 'waiting', 'analyzing' as const].map((phase) =>
      aiPhaseLabel(phase as Parameters<typeof aiPhaseLabel>[0]),
    )
    expect(new Set(labels).size).toBe(4)
  })
})
