/**
 * AI 오류 문구 — 종목 패널(F6 `AIPanel`)과 기사 화면(F7 `ArticleAnalysis`)이 같은 표를 쓴다.
 * The AI error wording, one table shared by F6's stock `AIPanel` and F7's `ArticleAnalysis`.
 *
 * F6이 `AIPanel` 안에 두었던 `messageFor`를 그대로 옮겨 왔다 — 두 화면이 같은 유료 엔드포인트 계열을
 * 부르므로 문구가 갈라지면 사용자에게는 같은 실패가 다른 사건처럼 보인다. 세 번째 사본을 만들지 않기 위해
 * 이 파일이 유일한 출처다.
 * F6's `messageFor` moved here unchanged: both screens call the same family of paid endpoints, and diverging
 * wording would make one failure look like two different events. This file exists so no third copy appears.
 *
 * **분기는 `ApiError.status`(+ 502만 `detail`)로 갈린다** (`api/client.ts`가 둘을 함께 노출한다):
 * - **429** `rate_limited` — 분당 한도(백엔드 `AI_RATE_PER_MIN`)를 넘었다. 기다리면 풀리므로 재시도를 남긴다.
 * - **503** `ai_unavailable` — 자격 증명/모델 접근이 없다. 스펙 7의 graceful degradation.
 * - **502** `article_unavailable` — 기사 본문을 얻지 못했다 (기사 엔드포인트 전용). Bedrock은 부르지도
 *   않았으므로 "AI 분석 실패"가 아니라 수집 실패라고 말해야 정직하다.
 * - 그 외(500 `ai_failed`, 네트워크 실패, ALB/CloudFront가 만든 5xx) — 일반 문구.
 * **The branches key off `ApiError.status`** (plus `detail` for 502 alone; `api/client.ts` exposes both).
 */
import type { AiPhase } from '../api/aiStream.ts'
import { ApiError } from '../api/client.ts'

/** 레이트리밋(429) 문구 / The rate-limit (429) wording */
export const AI_RATE_LIMITED = '잠시 후 다시 시도해주세요'

/** AI 사용 불가(503) 문구 / The unavailable (503) wording */
export const AI_UNAVAILABLE = 'AI 기능을 사용할 수 없습니다'

/** 기사 수집 실패(502 `article_unavailable`) 문구 / The article-fetch failure (502 `article_unavailable`) wording */
export const ARTICLE_UNAVAILABLE = '기사 본문을 가져올 수 없습니다'

/** 그 외 실패 문구 / The wording for any other failure */
export const AI_FAILED = 'AI 분석에 실패했습니다'

/**
 * 백엔드가 기사 본문을 얻지 못했을 때의 detail (`backend/app/api/ai.py`).
 * The detail the backend sends when it could not obtain the article body.
 */
const DETAIL_ARTICLE_UNAVAILABLE = 'article_unavailable'

/**
 * 오류를 사용자 문구로 / An error as user-facing wording.
 *
 * 502에서 `detail`까지 보는 이유: ALB/CloudFront가 만든 502는 본문이 HTML이라 detail이 `http_502`가 되고
 * (`api/client.ts`의 폴백), 그때 "기사 본문을 가져올 수 없습니다"는 사실이 아니다. 게이트웨이 오류와
 * 백엔드의 수집 실패는 다른 사건이므로 문구도 달라야 한다.
 * Why 502 also inspects `detail`: an ALB or CloudFront 502 carries an HTML body, so the detail falls back to
 * `http_502` (see `api/client.ts`) and the article wording would be a false claim. A gateway error and the
 * backend's fetch failure are different events and must read differently.
 */
export function aiErrorMessage(error: Error): string {
  if (!(error instanceof ApiError)) return AI_FAILED
  if (error.status === 429) return AI_RATE_LIMITED
  if (error.status === 503) return AI_UNAVAILABLE
  if (error.status === 502 && error.detail === DETAIL_ARTICLE_UNAVAILABLE) return ARTICLE_UNAVAILABLE
  return AI_FAILED
}

/**
 * 진행 단계 문구 — 두 화면이 같은 표를 쓴다 (오류 문구와 같은 이유).
 * The phase wording, one table for both screens, for the same reason the error wording is shared.
 *
 * 문구는 백엔드 `phase` 이벤트를 그대로 옮긴 것이다: `fetching`은 기사 본문 수집(종목 분석에서는 시세·지표
 * 수집), `analyzing`은 Bedrock 스트림, `waiting`은 **같은 대상을 이미 분석 중인 다른 요청**의 결과를
 * 기다리는 상태(백엔드의 선점자-팔로워 구조)다. 마지막이 중요하다 — 그때 이 사용자의 요청은 모델을 부르지
 * 않으므로, "분석 중"이라고 말하면 비용이 두 번 드는 것처럼 읽힌다.
 * The wording mirrors the backend's `phase` event: `fetching` is the article (or quote) collection, `analyzing`
 * is the Bedrock stream, and `waiting` means another request is already analysing the same subject and this one
 * is waiting for its result (the backend's leader-follower arrangement). That last one matters: this request
 * calls no model at all, so calling it "analysing" would read as paying twice.
 *
 * `null`은 요청은 보냈지만 첫 `phase`가 아직 오지 않은 사이다 (그리고 기사 화면의 첫 렌더). 그 짧은 구간에도
 * 문구가 있어야 스피너만 도는 화면이 생기지 않는다.
 * `null` covers the gap after the request but before the first `phase` (and the article screen's first render);
 * wording there keeps a bare spinner from ever standing alone.
 */
export function aiPhaseLabel(phase: AiPhase | null): string {
  if (phase === 'fetching') return '본문을 가져오는 중…'
  if (phase === 'waiting') return '다른 요청의 결과를 기다리는 중…'
  if (phase === 'analyzing') return '분석 중…'
  return '분석 준비 중…'
}
