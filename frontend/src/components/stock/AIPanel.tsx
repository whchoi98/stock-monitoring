/**
 * AI 리서치 패널 — 버튼을 눌러야 생성한다. Bedrock 호출은 비용이 드는 유일한 경로이므로 폴링하지 않는다.
 * The AI research panel; it generates only on a click. The Bedrock call is the one path that costs money, so nothing
 * here polls.
 *
 * 응답은 **SSE로 흘러 들어온다** (`useStockAIStream`): 단계(`phase`)가 먼저 오고, 토큰이 `streamText`에 누적되다가
 * 마지막에 완결된 `data`가 도착한다. 그래서 화면은 세 국면을 가진다 — 텍스트가 아직 없으면 스피너 + 단계 문구,
 * 텍스트가 흐르기 시작하면 그것을 그대로 마크다운으로, final이 오면 `data.analysis`.
 * The response **arrives as SSE**: the phase first, then tokens accumulating into `streamText`, and a settled `data`
 * at the end — spinner plus phase wording while no text exists, the live text as markdown once it flows, and
 * `data.analysis` after the final.
 *
 * 결과는 한국어 마크다운이라 `react-markdown` + `remark-gfm`으로 렌더한다. 모델 출력은 신뢰 경계 밖이므로
 * `dangerouslySetInnerHTML`을 쓰지 않는다. **오류 문구는 `lib/aiMessages.ts`가 갖는다** — 기사 화면과 같은 표.
 * Korean markdown rendered with react-markdown plus remark-gfm; model output sits outside the trust boundary, so no
 * `dangerouslySetInnerHTML`. **Error wording lives in `lib/aiMessages.ts`**, shared with the article screen.
 */
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useStockAIStream } from '../../api/aiStream.ts'
import { aiErrorMessage, aiPhaseLabel } from '../../lib/aiMessages.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

export interface AIPanelProps {
  /**
   * 종목 심볼 — 심볼이 바뀌면 이 패널은 **다시 마운트되어야 한다** (`StockDetail`이 `key={symbol}`로 그렇게 한다):
   * 훅 상태는 마운트에 묶여 있어서, 리마운트 없이는 이전 종목의 분석이 새 종목 화면에 남는다.
   * The symbol. A symbol change must **remount** this panel (`StockDetail` does that with `key={symbol}`): the hook's
   * state is tied to a mount, so without one the previous symbol's analysis lingers on the new symbol's page.
   */
  symbol: string
}

export function AIPanel({ symbol }: AIPanelProps) {
  const { phase, streamText, data, asOf, isLoading, error, analyze } = useStockAIStream(symbol)

  // 재시도는 같은 호출을 다시 하는 것 — 429·503에도 버튼을 남긴다 (둘 다 시간이 지나면 풀린다) / A retry re-runs the call; the button survives 429 and 503
  const run = () => analyze()

  // final이 도착하면 완결된 `data.analysis`가 누적 텍스트를 대신한다 / Once the final lands, `data.analysis` replaces the accumulated text
  const body = data?.analysis ?? streamText

  return (
    <Panel
      eyebrow="AI RESEARCH"
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
      {isLoading && streamText === '' ? (
        // 아직 토큰이 없는 구간 — 스피너와 단계 문구가 진행을 대신한다 / Before any token, the spinner and the phase wording stand in
        <div className="ai-pending">
          <Spinner />
          <p className="empty">{aiPhaseLabel(phase)}</p>
        </div>
      ) : error !== null ? (
        // 실패는 부분 텍스트보다 앞선다 — 잘린 분석을 결과처럼 남기지 않는다 / A failure outranks partial text
        <ErrorCard onRetry={run} message={aiErrorMessage(error)} />
      ) : body === '' ? (
        <p className="empty">버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다</p>
      ) : (
        <div className="markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
        </div>
      )}
    </Panel>
  )
}
