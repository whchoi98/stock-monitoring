/**
 * AI 분석 패널 — 버튼을 눌러야 생성한다. Bedrock 호출은 비용이 드는 유일한 경로이므로 폴링하지 않는다.
 * The AI analysis panel; it generates only on a click. The Bedrock call is the one path that costs money, so
 * nothing here polls.
 *
 * 결과(`data.analysis`)는 한국어 마크다운이라 `react-markdown`으로 렌더한다. 원문을 `dangerouslySetInnerHTML`
 * 로 넣지 않는 것이 중요하다 — 모델 출력은 신뢰 경계 밖이고, react-markdown은 기본적으로 HTML을 통과시키지
 * 않는다(rehype-raw 같은 플러그인을 넣지 않는 한).
 * The result (`data.analysis`) is Korean markdown, rendered with `react-markdown`. Not routing it through
 * `dangerouslySetInnerHTML` matters: model output sits outside the trust boundary, and react-markdown does not
 * pass raw HTML through by default (absent a plugin such as rehype-raw).
 *
 * **오류 분기는 `ApiError.status`로 갈린다** (`api/client.ts`가 status + detail을 함께 노출한다):
 * - **429** `rate_limited` — 분당 한도(백엔드 `AI_RATE_PER_MIN`)를 넘었다. 기다리면 풀리므로 재시도를 남긴다.
 * - **503** `ai_unavailable` — 자격 증명/모델 접근이 없다. 스펙 7의 "graceful degradation": 이 패널만
 *   안내 문구가 되고 나머지 화면은 그대로 산다.
 * - 그 외(500 `ai_failed`, 네트워크 실패 등) — 일반 문구.
 * **The error branches key off `ApiError.status`** (`api/client.ts` exposes status alongside detail):
 * - **429** `rate_limited`: the per-minute budget (the backend's `AI_RATE_PER_MIN`) is spent; waiting clears
 *   it, so the retry stays.
 * - **503** `ai_unavailable`: no credentials or model access. Spec 7's graceful degradation — this panel
 *   becomes a notice while the rest of the page lives on.
 * - anything else (500 `ai_failed`, a network failure): the generic wording.
 */
import Markdown from 'react-markdown'

import { ApiError } from '../../api/client.ts'
import { useStockAI } from '../../api/queries.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 레이트리밋(429) 문구 — 브리프 지정 / The rate-limit (429) wording, as the brief specifies */
const RATE_LIMITED = '잠시 후 다시 시도해주세요'

/** AI 사용 불가(503) 문구 — 브리프 지정 / The unavailable (503) wording, as the brief specifies */
const UNAVAILABLE = 'AI 기능을 사용할 수 없습니다'

/** 그 외 실패 문구 / The wording for any other failure */
const FAILED = 'AI 분석에 실패했습니다'

/** 오류를 사용자 문구로 / An error as user-facing wording */
function messageFor(error: Error): string {
  if (!(error instanceof ApiError)) return FAILED
  if (error.status === 429) return RATE_LIMITED
  if (error.status === 503) return UNAVAILABLE
  return FAILED
}

export interface AIPanelProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function AIPanel({ symbol }: AIPanelProps) {
  const { data, asOf, isLoading, error, analyze } = useStockAI(symbol)

  /*
   * 뮤테이션이므로 재시도는 쿼리 무효화가 아니라 같은 호출을 다시 하는 것이다 (`analyze`).
   * 429·503에도 버튼을 남긴다 — 둘 다 시간이 지나면 풀릴 수 있는 상태이고, 버튼이 사라지면 사용자는
   * 페이지를 새로 고치는 수밖에 없다.
   * This is a mutation, so a retry re-runs the same call (`analyze`) rather than invalidating a query. The
   * button survives 429 and 503 as well: both can clear with time, and without it the only way back would be
   * a page reload.
   */
  const run = () => analyze()

  return (
    <Card
      title="AI 분석"
      action={
        <>
          <button type="button" className="ai-button" onClick={run} disabled={isLoading}>
            {data === undefined ? 'AI 분석' : '다시 분석'}
          </button>
          <AsOfBadge asOf={asOf} />
        </>
      }
    >
      {isLoading ? (
        <div className="ai-pending">
          <Spinner />
          <p className="empty">분석 중입니다…</p>
        </div>
      ) : error !== null ? (
        <ErrorCard onRetry={run} message={messageFor(error)} />
      ) : data === undefined ? (
        <p className="empty">버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다</p>
      ) : (
        <div className="markdown">
          <Markdown>{data.analysis}</Markdown>
        </div>
      )}
    </Card>
  )
}
