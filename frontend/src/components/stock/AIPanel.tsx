/**
 * AI 리서치 패널 — 버튼을 눌러야 생성한다. Bedrock 호출은 비용이 드는 유일한 경로이므로 폴링하지 않는다.
 * 질문 입력을 비워 두면 기본 3섹션 분석, 질문을 넣으면(또는 프리셋을 누르면) 그 질문에 대한 답을 요청한다.
 * The AI research panel; it generates only on a click. The Bedrock call is the one path that costs money, so nothing
 * here polls. An empty question asks for the default three-section analysis; a typed question (or a preset) asks for an
 * answer to it.
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
import { type FormEvent, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useStockAIStream } from '../../api/aiStream.ts'
import { aiErrorMessage, aiPhaseLabel } from '../../lib/aiMessages.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 질문 길이 상한 — 백엔드 `MAX_QUESTION_LEN`과 같은 값 / The question cap, the same value as the backend's `MAX_QUESTION_LEN` */
const MAX_QUESTION_LEN = 200

/** 자주 묻는 질문 프리셋 — 누르면 바로 실행된다 / Common question presets; a click runs at once */
const PRESETS = [
  '지금 밸류에이션은 어떤 수준인가요?',
  '가장 큰 리스크는 무엇인가요?',
  '최근 뉴스가 주가에 미칠 영향은?',
  '52주 범위에서 현재 위치는 어떤 의미인가요?',
]

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
  const [question, setQuestion] = useState('')
  /** 마지막으로 보낸 질문 — 스트리밍 중·오류 시에도 무엇을 물었는지 보이고, 재시도가 같은 질문을 다시 보낸다 / The question last sent, shown while streaming and re-sent by a retry */
  const [asked, setAsked] = useState<string | null>(null)

  /** 질문이 비어 있으면 기본 분석, 아니면 그 질문 / Empty asks the default analysis, otherwise that question */
  const ask = (text: string) => {
    const trimmed = text.trim().slice(0, MAX_QUESTION_LEN)
    setAsked(trimmed === '' ? null : trimmed)
    if (trimmed === '') analyze()
    else analyze({ question: trimmed })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    ask(question)
  }

  // 재시도는 같은 호출을 다시 하는 것 — 429·503에도 버튼을 남긴다 (둘 다 시간이 지나면 풀린다) / A retry re-runs the same call; the button survives 429 and 503
  const retry = () => (asked === null ? analyze() : analyze({ question: asked }))

  // final이 도착하면 완결된 `data.analysis`가 누적 텍스트를 대신한다 / Once the final lands, `data.analysis` replaces the accumulated text
  const body = data?.analysis ?? streamText
  // 캐시 히트는 `data.question`으로, 진행 중에는 보낸 질문으로 무엇에 대한 답인지 보인다 / A cache hit names its question via `data.question`; in flight the sent one shows
  const shownQuestion = data === undefined ? asked : (data.question ?? null)

  return (
    <Panel id="ai-research" eyebrow="AI RESEARCH" title="AI 분석" action={<AsOfBadge asOf={asOf} />}>
      <form className="ai-ask" onSubmit={onSubmit}>
        <input
          className="ai-ask-input"
          type="text"
          aria-label="AI 질문"
          placeholder="이 종목에서 무엇을 확인할까요? (비우면 기본 분석)"
          maxLength={MAX_QUESTION_LEN}
          value={question}
          disabled={isLoading}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button type="submit" className="ai-button" disabled={isLoading}>
          {data === undefined ? 'AI 분석' : '다시 분석'}
        </button>
      </form>
      <div className="ai-presets" role="group" aria-label="질문 프리셋">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="tab"
            disabled={isLoading}
            onClick={() => {
              setQuestion(preset)
              ask(preset)
            }}
          >
            {preset}
          </button>
        ))}
      </div>

      {isLoading && streamText === '' ? (
        // 아직 토큰이 없는 구간 — 스피너와 단계 문구가 진행을 대신한다 / Before any token, the spinner and the phase wording stand in
        <div className="ai-pending">
          <Spinner />
          <p className="empty">{aiPhaseLabel(phase)}</p>
        </div>
      ) : error !== null ? (
        // 실패는 부분 텍스트보다 앞선다 — 잘린 분석을 결과처럼 남기지 않는다 / A failure outranks partial text
        <ErrorCard onRetry={retry} message={aiErrorMessage(error)} />
      ) : body === '' ? (
        <p className="empty">버튼을 누르면 이 종목에 대한 AI 분석을 생성합니다</p>
      ) : (
        <>
          {shownQuestion !== null && (
            <p className="ai-question">
              <span className="ai-question-mark" aria-hidden="true">
                Q
              </span>
              {shownQuestion}
            </p>
          )}
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
          </div>
        </>
      )}
    </Panel>
  )
}
