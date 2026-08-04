/**
 * AI 분석 패널 — 버튼을 눌러야 생성한다. Bedrock 호출은 비용이 드는 유일한 경로이므로 폴링하지 않는다.
 * The AI analysis panel; it generates only on a click. The Bedrock call is the one path that costs money, so
 * nothing here polls.
 *
 * 응답은 **SSE로 흘러 들어온다** (`useStockAIStream`): 단계(`phase`)가 먼저 오고, 토큰이 `streamText`에
 * 누적되다가 마지막에 완결된 `data`가 도착한다. 그래서 화면은 세 국면을 가진다 — 텍스트가 아직 없으면
 * 스피너 + 단계 문구, 텍스트가 흐르기 시작하면 그것을 그대로 마크다운으로, final이 오면 `data.analysis`.
 * The response **arrives as SSE** (`useStockAIStream`): the phase first, then tokens accumulating into
 * `streamText`, and a settled `data` at the end. The panel therefore has three faces: spinner plus phase
 * wording while no text exists, the live text as markdown once it flows, and `data.analysis` after the final.
 *
 * 결과는 한국어 마크다운이라 `react-markdown` + `remark-gfm`으로 렌더한다 (표를 쓰는 프롬프트가 있다).
 * 원문을 `dangerouslySetInnerHTML`로 넣지 않는 것이 중요하다 — 모델 출력은 신뢰 경계 밖이고,
 * react-markdown은 기본적으로 HTML을 통과시키지 않는다(rehype-raw 같은 플러그인을 넣지 않는 한).
 * The result is Korean markdown, rendered with `react-markdown` plus `remark-gfm` (the prompt asks for tables).
 * Not routing it through `dangerouslySetInnerHTML` matters: model output sits outside the trust boundary, and
 * react-markdown does not pass raw HTML through by default (absent a plugin such as rehype-raw).
 *
 * **오류 문구는 `lib/aiMessages.ts`가 갖는다** — 기사 분석 화면(F7)과 같은 표를 써야 사용자가 같은
 * 실패를 두 사건으로 읽지 않는다 (429 → "잠시 후 다시 시도해주세요", 503 → "AI 기능을 사용할 수 없습니다",
 * 그 외 → 일반 문구). 503은 스펙 7의 "graceful degradation": 이 패널만 안내 문구가 되고 나머지 화면은 산다.
 * **The error wording lives in `lib/aiMessages.ts`**, shared with F7's article screen so one failure never
 * reads as two different events. The 503 case is spec 7's graceful degradation: this panel becomes a notice
 * while the rest of the page lives on.
 */
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useStockAIStream } from '../../api/aiStream.ts'
import { aiErrorMessage, aiPhaseLabel } from '../../lib/aiMessages.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

export interface AIPanelProps {
  /**
   * 종목 심볼 — 그대로 스트리밍 훅에 넘긴다 / The symbol, handed straight to the streaming hook.
   *
   * 심볼이 바뀌면 이 패널은 **다시 마운트되어야 한다** (`StockDetail`이 `key={symbol}`로 그렇게 한다):
   * 훅 상태는 마운트에 묶여 있어서, 리마운트 없이는 이전 종목의 분석과 누적 텍스트가 새 종목 화면에 남는다.
   * A symbol change must **remount** this panel (`StockDetail` does that with `key={symbol}`): the hook's state
   * is tied to a mount, so without one the previous symbol's analysis and text linger on the new symbol's page.
   */
  symbol: string
}

export function AIPanel({ symbol }: AIPanelProps) {
  const { phase, streamText, data, asOf, isLoading, error, analyze } = useStockAIStream(symbol)

  /*
   * 재시도는 같은 호출을 다시 하는 것이다 (`analyze`) — 429·503에도 버튼을 남긴다. 둘 다 시간이 지나면
   * 풀릴 수 있는 상태이고, 버튼이 사라지면 사용자는 페이지를 새로 고치는 수밖에 없다.
   * A retry re-runs the same call (`analyze`), and the button survives 429 and 503 as well: both can clear with
   * time, and without it the only way back would be a page reload.
   */
  const run = () => analyze()

  /*
   * final이 도착하면 완결된 `data.analysis`가 누적 텍스트를 대신한다 (스펙 §2) — 훅은 final 뒤에도
   * `streamText`를 지우지 않으므로 여기서 우선순위를 정한다. 마지막 델타와 최종본은 보통 같은 문자열이지만,
   * 권위는 언제나 서버가 마감한 `data`에 있다.
   * Once the final lands, the settled `data.analysis` replaces the accumulated text (spec §2): the hook keeps
   * `streamText` afterwards, so the precedence is decided here. The last delta and the final usually hold the
   * same string, but authority always rests with the `data` the server settled on.
   */
  const body = data?.analysis ?? streamText

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
      {isLoading && streamText === '' ? (
        /*
         * 아직 토큰이 없는 구간 — 스피너와 단계 문구가 진행을 대신한다. 토큰이 흐르기 시작하면 텍스트
         * 자체가 진행 표시이므로 둘 다 물러난다.
         * The stretch before any token: the spinner and the phase wording stand in for progress. Once tokens
         * flow the text is the progress, so both step aside.
         */
        <div className="ai-pending">
          <Spinner />
          <p className="empty">{aiPhaseLabel(phase)}</p>
        </div>
      ) : error !== null ? (
        /*
         * 실패는 부분 텍스트보다 앞선다 — 잘린 분석을 결과처럼 남겨 두면 사용자가 그것을 완성된 답으로
         * 읽는다. 재시도 버튼이 있는 오류 카드가 정직하다.
         * A failure outranks partial text: leaving a truncated analysis on screen invites reading it as a
         * finished answer, so the error card with its retry is the honest state.
         */
        <ErrorCard onRetry={run} message={aiErrorMessage(error)} />
      ) : body === '' ? (
        <p className="empty">버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다</p>
      ) : (
        <div className="markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
        </div>
      )}
    </Card>
  )
}
