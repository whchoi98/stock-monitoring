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
 * `useMutation`은 재시도도 하지 않는다 (main.tsx `mutations: { retry: false }`).
 * **The paid call fires exactly once.** StrictMode (in main.tsx) runs effects twice, so a ref guards it, keyed
 * on the request itself so a parameter change (another article on the same route) does run again. The mutation
 * never retries either (main.tsx's `mutations: { retry: false }`).
 */
import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import { Link, useSearchParams } from 'react-router-dom'

import { useArticleAI } from '../api/queries.ts'
import type { Language } from '../api/types.ts'
import { AsOfBadge } from '../components/common/AsOfBadge.tsx'
import { Card } from '../components/common/Card.tsx'
import { ErrorCard } from '../components/common/ErrorCard.tsx'
import { Spinner } from '../components/common/Spinner.tsx'
import { aiErrorMessage } from '../lib/aiMessages.ts'

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
        <Card title="잘못된 접근">
          <p className="empty">
            분석할 기사 주소가 없습니다. 대시보드의 뉴스 목록에서 기사를 고르면 분석이 시작됩니다.
          </p>
          <p className="notice-back">
            <Link to="/">대시보드로 이동</Link>
          </p>
        </Card>
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
  const { data, asOf, isLoading, error, analyze } = useArticleAI()

  const run = () => analyze({ url, title, language })

  /*
   * 진입 시 자동 실행 — 이미 보낸 요청과 같으면 다시 보내지 않는다. ref는 StrictMode의 두 번째 이펙트
   * 실행에서도 초기화되지 않으므로, 이 비교가 유료 호출의 이중 발사를 막는다.
   * The automatic run on entry, skipped when the request matches one already sent. The ref survives
   * StrictMode's second effect pass, so this comparison is what stops the paid call from firing twice.
   *
   * **왜 `setTimeout(…, 0)`으로 한 틱 미루는가** (육안 확인에서 잡은 실제 결함):
   * `mutate()`를 마운트 이펙트 안에서 **동기로** 부르면 StrictMode 개발 모드에서 결과가 유실된다.
   * TanStack Query v5의 `MutationObserver`에는 `onUnsubscribe`(진행 중인 뮤테이션에서 옵저버를 떼어낸다)만
   * 있고 다시 붙이는 `onSubscribe`가 없다 — StrictMode가 이펙트를 정리·재실행하는 사이 `useSyncExternalStore`의
   * 구독이 끊기면서 옵저버가 떨어져 나가고, 그 뒤 도착한 200 응답이 아무 컴포넌트에도 전달되지 않는다
   * (화면은 영원히 "진행 중"으로 남았다). 다음 매크로태스크로 미루면 구독이 자리를 잡은 뒤에 호출되므로
   * 개발·운영 모두에서 결과가 도착한다. 예약은 정리 함수가 취소하므로 StrictMode에서도 호출은 한 번이다.
   * **Why the call is deferred by one tick with `setTimeout(…, 0)`** (a real defect the visual check caught):
   * calling `mutate()` *synchronously* inside a mount effect loses the result under StrictMode in development.
   * TanStack Query v5's `MutationObserver` has only `onUnsubscribe` (which detaches the observer from the
   * in-flight mutation) and no `onSubscribe` to re-attach it, so when StrictMode tears the
   * `useSyncExternalStore` subscription down between the two effect passes the observer comes off the mutation
   * and the 200 that arrives afterwards reaches no component — the screen stayed "in progress" forever.
   * Deferring to the next macrotask means the call happens once the subscription has settled, so the result
   * arrives in development and in production alike. The cleanup cancels the pending schedule, so StrictMode
   * still yields exactly one call.
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
   * 아직 아무 상태도 없는 첫 렌더(이펙트 직전)도 진행 중으로 본다 — 한 프레임짜리 빈 화면을 만들지 않는다.
   * The very first render (before the effect) counts as running too, so no one-frame empty state flashes.
   */
  const pending = isLoading || (error === null && data === undefined)

  return (
    <div className="article">
      <header className="article-head">
        <h1 className="article-title">{title}</h1>
        {/* 원문은 외부 사이트다 — 새 탭으로 열고 rel로 레퍼러/opener를 끊는다 / The source is off-site: a new tab, with the referrer and opener cut by rel */}
        <a className="article-source" href={url} target="_blank" rel="noreferrer">
          원문 보기
        </a>
      </header>

      <Card title="AI 분석" action={<AsOfBadge asOf={asOf} />}>
        {pending ? (
          /*
           * 두 단계를 **둘 다** 표시한다 (전환 애니메이션 없음). 백엔드는 기사 수집과 Claude 호출을
           * 한 번의 POST 안에서 처리하므로 클라이언트가 관측할 수 있는 것은 "요청 진행 중"뿐이다.
           * 시간 기준으로 [1/2]→[2/2]를 넘기면 실제로는 모르는 경계를 아는 척하게 된다 — 그래서
           * 무엇이 진행되는지만 정직하게 나열한다.
           * **Both** stages show at once, with no transition. The backend does the fetch and the Claude call
           * inside one POST, so all the client can observe is "the request is in flight"; flipping [1/2] to
           * [2/2] on a timer would pretend to know a boundary it cannot see. So it lists what is happening
           * and claims nothing more.
           */
          <div className="ai-pending">
            <Spinner />
            <div>
              <ol className="article-steps">
                <li>[1/2] 기사 수집 중</li>
                <li>[2/2] Claude 분석 중</li>
              </ol>
              <p className="article-steps-note">두 단계를 한 번의 요청으로 처리합니다</p>
            </div>
          </div>
        ) : error !== null ? (
          <ErrorCard onRetry={run} message={aiErrorMessage(error)} />
        ) : (
          /*
           * 모델 출력이므로 `dangerouslySetInnerHTML`이 아니라 react-markdown으로 렌더한다 (F6 AIPanel과
           * 같은 이유·같은 `.markdown` 스타일). 파이프 표는 remark-gfm이 없어 원문 그대로 보인다.
           * Model output, so react-markdown renders it rather than `dangerouslySetInnerHTML` (F6's AIPanel,
           * same reason and the same `.markdown` styling). Pipe tables show as raw text: no remark-gfm.
           */
          <div className="markdown">
            <Markdown>{data?.analysis ?? ''}</Markdown>
          </div>
        )}
      </Card>
    </div>
  )
}
