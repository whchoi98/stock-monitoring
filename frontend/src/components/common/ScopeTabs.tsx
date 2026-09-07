/**
 * 스코프 토글 (미국 / 한국 / ★관심) — 시세 표와 워치리스트 레일이 같은 컨트롤을 쓴다.
 * The scope toggle (US / KR / ★watch), shared by the quote monitor and the watchlist rail.
 *
 * 탭 대신 `role="group"` + `aria-pressed` 토글 버튼을 쓴다 — tablist/tab 롤은 tabpanel 배선까지 요구하는데 이 컨트롤은
 * 한 패널이 아니라 여러 위젯의 데이터를 함께 바꾸므로 그 모델과 맞지 않는다.
 * Toggle buttons in a labelled group rather than tablist/tab roles: those imply a tabpanel relationship, and this
 * control switches the data of several widgets at once, which that model does not fit.
 */
import { type QuoteScope, SCOPE_LABEL } from '../../lib/markets.ts'

const SCOPES: QuoteScope[] = ['us', 'kr', 'watch']

export interface ScopeTabsProps {
  value: QuoteScope
  onChange: (scope: QuoteScope) => void
}

export function ScopeTabs({ value, onChange }: ScopeTabsProps) {
  return (
    <div className="tabs" role="group" aria-label="시장 선택">
      {SCOPES.map((scope) => (
        <button
          key={scope}
          type="button"
          className={scope === value ? 'tab tab-active' : 'tab'}
          aria-pressed={scope === value}
          onClick={() => onChange(scope)}
        >
          {/* 별은 장식 — 접근 가능한 이름은 "관심"이다 / The star is decoration; the accessible name is "관심" */}
          {scope === 'watch' && <span aria-hidden="true">★</span>}
          {SCOPE_LABEL[scope]}
        </button>
      ))}
    </div>
  )
}
