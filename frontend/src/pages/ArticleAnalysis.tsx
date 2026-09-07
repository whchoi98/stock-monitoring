/**
 * 기사 AI 분석 `/articles?url=&title=&language=` — 스펙 6.2 ③.
 * The article AI analysis screen at `/articles?url=&title=&language=` (spec 6.2 ③).
 *
 * 뉴스 항목(F4 `NewsFeed`, F6 `StockNews`)을 누르면 여기로 온다. 기사 식별 정보는 **쿼리 파라미터**로
 * 실린다 — 그래야 새로고침과 링크 공유가 동작한다. 진입하면 바로 분석을 시작한다(버튼 없음): 사용자는
 * 이 화면에 오는 것으로 이미 "분석해 달라"고 말했다.
 * A click on a news item (F4's `NewsFeed`, F6's `StockNews`) lands here. The article's identity travels in the
 * **query parameters**, which is what makes a refresh or a shared link work. Entering starts the analysis at
 * once, with no button: arriving here *is* the request.
 *
 * **유료 호출을 정확히 한 번만 낸다.** StrictMode(main.tsx)는 이펙트를 두 번 실행하므로 ref로 막고,
 * 파라미터가 바뀌면(같은 라우트에서 다른 기사로 이동) 다시 실행되도록 요청 내용을 키로 쓴다.
 * 스트리밍 훅도 재시도하지 않는다 (`api/aiStream.ts` — 실패는 그대로 `error`가 된다).
 * **The paid call fires exactly once.** StrictMode (in main.tsx) runs effects twice, so a ref guards it, keyed
 * on the request itself so a parameter change (another article on the same route) does run again. The streaming
 * hook never retries either (`api/aiStream.ts`: a failure simply becomes `error`).
 *
 * 응답은 SSE로 흘러 들어온다 — 단계(`phase`)가 먼저, 토큰이 `streamText`에 누적되고, 마지막에 완결된
 * `data`가 온다. 그래서 진행 표시가 단계 문구 → 실시간 마크다운 → 최종본으로 이어진다.
 * The response arrives as SSE: the phase first, tokens accumulating into `streamText`, and a settled `data` at
 * the end — so progress reads as phase wording, then live markdown, then the final text.
 */
import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import { Link, useSearchParams } from 'react-router-dom'
import remarkGfm from 'remark-gfm'

import { useArticleAIStream } from '../api/aiStream.ts'
import type { Language } from '../api/types.ts'
import { AsOfBadge } from '../components/common/AsOfBadge.tsx'
import { ErrorCard } from '../components/common/ErrorCard.tsx'
import { Panel } from '../components/common/Panel.tsx'
import { Spinner } from '../components/common/Spinner.tsx'
import { aiErrorMessage, aiPhaseLabel } from '../lib/aiMessages.ts'

/** 제목 길이 상한 — 백엔드 `MAX_TITLE_LEN`과 같은 값 / The title cap, the same value as the backend's `MAX_TITLE_LEN` */
const MAX_TITLE_LEN = 512

/**
 * 파라미터를 확인하고 본문에 넘긴다 / Check the parameters, then hand them to the body.
 *
 * 확인은 **훅을 부르기 전에** 끝난다 (F6 `StockDetail`이 세운 형태) — F2 훅에 `enabled`가 없으므로
 * 빈 url로 유료 엔드포인트를 두드리는 경로가 아예 존재해서는 안 된다. 셸 네비의 "기사 분석" 링크는
 * 파라미터 없이 `/articles`로 오므로 이 분기는 실제로 자주 밟힌다.
 * The check finishes **before any hook runs** (the shape F6's `StockDetail` set): the F2 hooks take no
 * `enabled` flag, so no path may exist that pokes the paid endpoint with an empty url. The shell nav's
 * "기사 분석" link arrives at a bare `/articles`, so this branch is walked often.
 */
export default function ArticleAnalysis() {
  const [params] = useSearchParams()
  const url = params.get('url') ?? ''
  const title = params.get('title') ?? ''

  /*
   * 언어는 백엔드가 `ko|en`만 받는다 (그 외는 422). 모르는 값·빈 값은 `ko`로 떨어뜨린다 — 최악의 경우
   * 번역 없이 요약만 나오지만(백엔드는 `en`일 때만 한국어 번역을 요구한다) 요청이 거절되지는 않는다.
   * The backend accepts only `ko|en` (anything else is a 422), so an unknown or missing value falls back to
   * `ko`: at worst the summary arrives without a translation (the backend asks for one only for `en`), but the
   * request is never rejected.
   */
  const language: Language = params.get('language') === 'en' ? 'en' : 'ko'

  if (url === '') {
    return (
      <div className="article">
        <Panel eyebrow="ARTICLE" title="잘못된 접근">
          <p className="empty">
            분석할 기사 주소가 없습니다. 뉴스 와이어에서 기사를 고르면 분석이 시작됩니다.
          </p>
          <p className="notice-back">
            <Link to="/">시장 화면으로 이동</Link>
          </p>
        </Panel>
      </div>
    )
  }

  /*
   * 제목이 없으면 url을 제목 자리에 쓴다 — 백엔드가 `title`을 1자 이상 요구하고(422), 없는 제목을
   * 지어내는 것보다 주소를 그대로 보여주는 편이 정직하다. 길이는 백엔드 상한(512자)에 맞춰 자른다:
   * 표시와 요청에 같은 값을 쓰므로 화면에 보이는 제목이 곧 모델에 들어간 제목이다.
   * With no title the url takes its place: the backend requires at least one character (else a 422), and
   * showing the address beats inventing a headline. The length is clipped to the backend's 512-character cap,
   * and display and request share the value, so the title on screen is the title the model received.
   */
  const heading = (title === '' ? url : title).slice(0, MAX_TITLE_LEN)

  return <ArticleAnalysisBody url={url} title={heading} language={language} />
}

interface ArticleAnalysisBodyProps {
  url: string
  title: string
  language: Language
}

function ArticleAnalysisBody({ url, title, language }: ArticleAnalysisBodyProps) {
  /*
   * `isLoading`은 쓰지 않는다 — 이 화면에는 실행 버튼이 없고(진입이 곧 요청), 아래 `pending`이 "결과도
   * 오류도 텍스트도 없는 상태"로 진행 중을 판정하므로 실행 전 첫 렌더까지 함께 덮인다.
   * `isLoading` is unused: this screen has no run button (arriving is the request) and `pending` below decides
   * progress from "no result, no error, no text", which covers the first render before the run as well.
   */
  const { phase, streamText, data, asOf, error, analyze } = useArticleAIStream()

  const run = () => analyze({ url, title, language })

  /*
   * 진입 시 자동 실행 — 이미 보낸 요청과 같으면 다시 보내지 않는다. ref는 StrictMode의 두 번째 이펙트
   * 실행에서도 초기화되지 않으므로, 이 비교가 유료 호출의 이중 발사를 막는다.
   * The automatic run on entry, skipped when the request matches one already sent. The ref survives
   * StrictMode's second effect pass, so this comparison is what stops the paid call from firing twice.
   *
   * **왜 `setTimeout(…, 0)`으로 한 틱 미루는가** (육안 확인에서 잡은 실제 결함, 스트리밍 훅에서도 유효):
   * 분석 요청을 마운트 이펙트 안에서 **동기로** 부르면 StrictMode 개발 모드에서 결과가 유실된다.
   * StrictMode는 이펙트를 한 번 정리하고 다시 실행하는데, 그 정리에는 **스트리밍 훅 자신의 언마운트
   * 정리**(`api/aiStream.ts`: 실행 번호를 올리고 흐르던 본문을 끊는다)도 포함된다. 그래서 첫 패스에서 시작한
   * 스트림은 폐기되고, 그 패스가 이미 ref를 채워 두었다면 두 번째 패스는 "같은 요청"이라 건너뛴다 —
   * 화면이 영원히 진행 중으로 남는다. 다음 매크로태스크로 미루고 **ref를 그 안에서** 채우면, 취소된 예약은
   * 아무 흔적을 남기지 않으므로 살아남은 패스 하나만 실제로 호출한다 (호출은 정확히 한 번).
   * 예전 원인(TanStack `MutationObserver`가 구독이 끊길 때 뮤테이션에서 떨어져 나가던 문제)은 훅이 바뀌며
   * 사라졌지만, 지연이 필요한 이유는 그대로 남았다.
   * **Why the call is deferred by one tick with `setTimeout(…, 0)`** (a real defect the visual check caught,
   * still live with the streaming hook): calling the analysis *synchronously* inside a mount effect loses the
   * result under StrictMode in development. StrictMode tears effects down once and re-runs them, and that
   * teardown includes the **streaming hook's own unmount cleanup** (`api/aiStream.ts` bumps the run counter and
   * stops the body in flight). The stream the first pass started is therefore discarded, and if that pass had
   * already filled the ref the second pass would skip it as "the same request" — leaving the screen in progress
   * forever. Deferring to the next macrotask and filling the ref *inside* it means a cancelled schedule leaves
   * no trace, so only the surviving pass actually calls (exactly once). The original cause (TanStack's
   * `MutationObserver` detaching from the mutation when its subscription dropped) went away with the hook, but
   * the reason to defer did not.
   */
  const requested = useRef<string | null>(null)
  useEffect(() => {
    const request = JSON.stringify([url, title, language])
    if (requested.current === request) return

    const id = setTimeout(() => {
      requested.current = request
      analyze({ url, title, language })
    }, 0)
    return () => clearTimeout(id)
  }, [url, title, language, analyze])

  /*
   * final이 도착하면 완결된 `data.analysis`가 누적 텍스트를 대신한다 (스펙 §2 — 훅은 final 뒤에도
   * `streamText`를 지우지 않으므로 우선순위를 여기서 정한다).
   * Once the final lands, the settled `data.analysis` replaces the accumulated text (spec §2: the hook keeps
   * `streamText` afterwards, so the precedence is decided here).
   */
  const body = data?.analysis ?? streamText

  /*
   * 아직 아무 상태도 없는 첫 렌더(이펙트 직전)도 진행 중으로 본다 — 한 프레임짜리 빈 화면을 만들지 않는다.
   * 반대로 토큰이 한 조각이라도 도착했으면 그 텍스트가 진행 표시이므로 스피너를 접는다.
   * The very first render (before the effect) counts as running too, so no one-frame empty state flashes.
   * Conversely, once even one token has arrived that text *is* the progress, so the spinner folds away.
   */
  const pending = data === undefined && error === null && body === ''

  return (
    <div className="article">
      <header className="article-head">
        <h1 className="article-title">{title}</h1>
        {/* 원문은 외부 사이트다 — 새 탭으로 열고 rel로 레퍼러/opener를 끊는다 / The source is off-site: a new tab, with the referrer and opener cut by rel */}
        <a className="article-source" href={url} target="_blank" rel="noreferrer">
          원문 보기
        </a>
      </header>

      <Panel eyebrow="AI RESEARCH" title="기사 분석" action={<AsOfBadge asOf={asOf} />}>
        {pending ? (
          /*
           * 지금 어느 단계인지는 **서버가 말해 준다** (`phase` 이벤트). 예전에는 기사 수집과 Claude 호출이
           * 한 번의 POST 안에서 끝나 클라이언트가 경계를 볼 수 없었고, 그래서 `[1/2]`·`[2/2]`를 둘 다
           * 세워 두었다. 이제는 관측되는 단계 하나만 정직하게 보여준다 (문구는 `lib/aiMessages.ts`).
           * The server now **says** which stage it is in (the `phase` event). Previously the fetch and the
           * Claude call finished inside one POST and the client could not see the boundary, so both `[1/2]`
           * and `[2/2]` stood there; today it shows the one observed stage (wording in `lib/aiMessages.ts`).
           */
          <div className="ai-pending">
            <Spinner />
            <p className="empty">{aiPhaseLabel(phase)}</p>
          </div>
        ) : error !== null ? (
          /*
           * 실패는 부분 텍스트보다 앞선다 (F6 AIPanel과 같은 순서) — 잘린 분석을 결과처럼 남겨 두면
           * 사용자가 그것을 완성된 답으로 읽는다.
           * A failure outranks partial text (the same order as F6's AIPanel): a truncated analysis left on
           * screen invites reading it as a finished answer.
           */
          <ErrorCard onRetry={run} message={aiErrorMessage(error)} />
        ) : (
          /*
           * 모델 출력이므로 `dangerouslySetInnerHTML`이 아니라 react-markdown으로 렌더한다 (F6 AIPanel과
           * 같은 이유·같은 `.markdown` 스타일·같은 remark-gfm). 스트리밍 중에는 아직 닫히지 않은 표·목록이
           * 프레임마다 다르게 파싱될 수 있는데, 그것이 곧 "쓰이는 중"의 모습이므로 그대로 보여준다.
           * Model output, so react-markdown renders it rather than `dangerouslySetInnerHTML` (F6's AIPanel,
           * same reason, same `.markdown` styling, same remark-gfm). Mid-stream an unclosed table or list may
           * parse differently frame to frame; that is what "being written" looks like, so it is shown as is.
           */
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
          </div>
        )}
      </Panel>
    </div>
  )
}
