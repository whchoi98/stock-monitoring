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
 * **오류 문구는 `lib/aiMessages.ts`가 갖는다** — 기사 분석 화면(F7)과 같은 표를 써야 사용자가 같은
 * 실패를 두 사건으로 읽지 않는다 (429 → "잠시 후 다시 시도해주세요", 503 → "AI 기능을 사용할 수 없습니다",
 * 그 외 → 일반 문구). 503은 스펙 7의 "graceful degradation": 이 패널만 안내 문구가 되고 나머지 화면은 산다.
 * **The error wording lives in `lib/aiMessages.ts`**, shared with F7's article screen so one failure never
 * reads as two different events. The 503 case is spec 7's graceful degradation: this panel becomes a notice
 * while the rest of the page lives on.
 */
import Markdown from 'react-markdown'

import { useStockAI } from '../../api/queries.ts'
import { aiErrorMessage } from '../../lib/aiMessages.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

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
        <ErrorCard onRetry={run} message={aiErrorMessage(error)} />
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
