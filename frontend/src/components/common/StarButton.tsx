/**
 * 관심 종목 ★ 토글 — 시세 표 행·워치리스트 레일·종목 헤더가 같은 버튼을 쓴다.
 * The watchlist ★ toggle shared by quote rows, the watchlist rail and the quote header.
 *
 * 클릭·키 입력이 부모(행 이동)로 올라가지 않게 막는다 — 별을 누르는 것은 종목을 여는 것이 아니다.
 * Click and key events stop at the button: pressing the star is not opening the symbol.
 */
import type { KeyboardEvent, MouseEvent } from 'react'

import { useWatchlist } from '../../lib/watchlistStore.ts'

export interface StarButtonProps {
  symbol: string
}

export function StarButton({ symbol }: StarButtonProps) {
  const { has, toggle } = useWatchlist()
  const on = has(symbol)

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    toggle(symbol)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // 행의 Enter/Space 이동 핸들러에 닿지 않게 한다 (버튼 자체의 click은 그대로 난다) / Keep Enter/Space from the row's navigation handler; the button's own click still fires
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }

  return (
    <button
      type="button"
      className={on ? 'star star-on' : 'star'}
      aria-pressed={on}
      aria-label={`${symbol} 관심 ${on ? '해제' : '추가'}`}
      title={on ? '관심 종목에서 제거' : '관심 종목에 추가'}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {on ? '★' : '☆'}
    </button>
  )
}
