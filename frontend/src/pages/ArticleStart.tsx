import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Language } from '../api/types.ts'
import { Panel } from '../components/common/Panel.tsx'
import { isArticleUrl } from '../lib/articleInput.ts'

/** 기사 분석의 정상 진입점. 제출 전에는 AI 요청을 보내지 않는다.
 * A useful entry point for article analysis. No AI request runs before submission.
 */
export function ArticleStart({ initialUrl = '' }: { initialUrl?: string }) {
  const [, setParams] = useSearchParams()
  const [url, setUrl] = useState(initialUrl)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState<Language>('ko')
  const [error, setError] = useState(initialUrl === '' ? '' : 'http:// 또는 https://로 시작하는 기사 원문 주소를 입력해 주세요.')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const address = url.trim()
    if (!isArticleUrl(address)) {
      setError('http:// 또는 https://로 시작하는 기사 원문 주소를 입력해 주세요.')
      return
    }
    if (new URL(address).hostname === 'news.google.com') {
      setError('Google 뉴스에서 원문 보기로 이동한 뒤, 발행사의 기사 주소를 붙여 넣어 주세요.')
      return
    }
    setParams({ url: address, title: title.trim() || address.slice(0, 512), language })
  }

  return (
    <div className="article article-start">
      <header className="workspace-title">
        <span className="eyebrow">ARTICLE RESEARCH</span>
        <h1>기사 분석</h1>
        <p>기사의 핵심 내용과 시장에 미치는 영향을 한곳에서 살펴보세요.</p>
      </header>
      <Panel eyebrow="AI RESEARCH" title="분석할 기사">
        <form className="article-form" aria-label="기사 분석 입력" onSubmit={submit}>
          <label className="article-field">
            <span>기사 주소</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              required
              maxLength={2048}
              placeholder="https://…"
              value={url}
              onChange={event => { setUrl(event.target.value); setError('') }}
              aria-invalid={error !== ''}
              aria-describedby={error !== '' ? 'article-input-error' : 'article-input-hint'}
            />
          </label>
          <p className="article-input-hint" id="article-input-hint">발행사에서 공개한 기사 원문 링크를 입력해 주세요.</p>
          <div className="article-form-details">
            <label className="article-field">
              <span>기사 제목 (선택)</span>
              <input maxLength={512} value={title} onChange={event => setTitle(event.target.value)} placeholder="제목을 함께 입력할 수 있습니다" />
            </label>
            <label className="article-field">
              <span>기사 언어</span>
              <select value={language} onChange={event => setLanguage(event.target.value as Language)}>
                <option value="ko">한국어</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>
          {error !== '' && <p className="article-input-error" id="article-input-error" role="alert">{error}</p>}
          <div className="article-form-footer">
            <span>영문 기사도 한국어로 분석합니다.</span>
            <button className="ai-button" type="submit">기사 분석 시작 <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </Panel>
      <div className="article-entry-help">
        <div>
          <strong>시장 뉴스에서 시작하기</strong>
          <p>시장 화면의 뉴스 목록에서도 기사를 선택해 분석할 수 있습니다.</p>
        </div>
        <Link className="btn" to="/">시장 화면으로 이동 <span aria-hidden="true">→</span></Link>
      </div>
    </div>
  )
}
