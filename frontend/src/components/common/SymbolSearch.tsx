/**
 * 종목 검색 콤보박스 — 커맨드 바 중앙. `⌘K`/`Ctrl+K`/`/`로 포커스, 타이핑하면 심볼·종목명으로 걸러 보여주고,
 * ↑↓로 고르고 Enter로 종목 화면으로 간다 (터미널의 기본 진입 동작).
 * The symbol-search combobox in the command bar: `⌘K`/`Ctrl+K`/`/` focuses it, typing filters by symbol and name,
 * ↑↓ selects and Enter opens the stock screen — the terminal's primary way in.
 *
 * 유니버스(US 50 + KR 50)는 **포커스한 뒤에만** 가져온다 (`useSymbolUniverse(focused)`) — 대시보드에서는 시세 표가
 * 이미 채운 캐시를 그대로 읽고, 다른 화면에서는 검색을 열기 전까지 요청이 없다. 순위 규칙은 `lib/search.ts`.
 * The universe (US 50 + KR 50) loads **only after focus** (`useSymbolUniverse(focused)`): on the dashboard it reads
 * the cache the quote table already filled, elsewhere nothing is requested until the search opens. Ranking lives in
 * `lib/search.ts`.
 *
 * ARIA 1.2 콤보박스 패턴: 입력이 `combobox`, 목록이 `listbox`, 활성 항목은 `aria-activedescendant`로 가리킨다.
 * ARIA 1.2 combobox pattern: the input is the `combobox`, the list a `listbox`, the active option pointed at by
 * `aria-activedescendant`.
 */
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useSymbolUniverse } from '../../api/queries.ts'
import type { Quote } from '../../api/types.ts'
import { searchSymbols } from '../../lib/search.ts'

/** 이미 글을 치는 중인 대상 — 그 안에서 `/`는 검색 단축키가 아니다 / A target already taking text; `/` there is not our shortcut */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function SymbolSearch() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const { quotes, isLoading } = useSymbolUniverse(focused)
  const results = useMemo(() => searchSymbols(quotes, query), [quotes, query])

  const expanded = focused && query.trim() !== ''
  // 결과가 줄어들어도 활성 인덱스가 범위를 벗어나지 않게 한다 / Keep the active index inside a shrinking result set
  const active = expanded && results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1
  const optionId = (index: number) => `${listId}-opt-${index}`

  /*
   * 전역 단축키 — `⌘K`/`Ctrl+K`는 어디서나, `/`는 다른 입력에 글을 치는 중이 아닐 때만.
   * Global shortcuts: `⌘K`/`Ctrl+K` anywhere, `/` only when not already typing into another field.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isK = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k'
      const isSlash =
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      if (!isK && !isSlash) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const choose = (quote: Quote) => {
    setQuery('')
    setActiveIndex(0)
    inputRef.current?.blur()
    // 시세 표의 행 이동과 같은 경로 형식 / The same path shape as the quote table's row navigation
    navigate(`/stocks/${quote.symbol}`)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((results.length + Math.max(active, 0) + step) % results.length)
      return
    }
    if (event.key === 'Enter') {
      const chosen = active >= 0 ? results[active] : undefined
      if (chosen !== undefined) {
        event.preventDefault()
        choose(chosen)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      // 첫 Esc는 입력을 지우고, 빈 상태의 Esc는 포커스를 놓는다 / The first Esc clears, a second (empty) Esc leaves
      if (query !== '') setQuery('')
      else inputRef.current?.blur()
    }
  }

  return (
    <div className="search">
      <span className="search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        role="combobox"
        aria-label="종목 검색"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        placeholder="종목 검색 · 심볼 또는 종목명"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {!focused && (
        <kbd className="search-kbd" aria-hidden="true">
          ⌘K
        </kbd>
      )}
      {expanded && (
        /*
         * 옵션을 누르는 mousedown이 입력의 blur를 먼저 일으켜 목록이 사라지는 것을 막는다 — 기본 동작(포커스 이동)을
         * 취소하면 클릭이 끝까지 도달한다.
         * A mousedown on an option would blur the input and unmount the list before the click lands; cancelling the
         * default (focus move) lets the click complete.
         */
        <div className="search-pop" onMouseDown={(event) => event.preventDefault()}>
          <ul id={listId} role="listbox" aria-label="검색 결과" className="search-list">
            {results.map((quote, index) => (
              <li
                key={quote.symbol}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className="search-option"
                onClick={() => choose(quote)}
                onMouseMove={() => setActiveIndex(index)}
              >
                <span className="search-symbol mono">{quote.symbol}</span>
                <span className="search-name">{quote.name}</span>
                <span className="search-market badge">{quote.market.toUpperCase()}</span>
              </li>
            ))}
          </ul>
          {results.length === 0 && (
            <p className="search-empty" role="status">
              {isLoading ? '종목 목록을 불러오는 중…' : '일치하는 종목이 없습니다'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
