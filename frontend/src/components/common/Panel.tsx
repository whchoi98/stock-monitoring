/**
 * 패널 — 터미널 워크스페이스의 모든 위젯이 이 껍데기를 쓴다 (`.panel*`은 global.css 소유).
 * The panel every widget in the terminal workspace sits in (`.panel*` belongs to global.css).
 *
 * 머리는 eyebrow(대문자 소형 라벨, 예: "PRICE ACTION") + 제목(한국어) + 우측 액션(탭·뱃지·버튼)이다.
 * 셋 중 하나라도 있으면 머리를 그린다. 표·목록처럼 가장자리까지 써야 하는 본문은 `flush`로 패딩을 없앤다.
 * The head is an eyebrow (small uppercase label such as "PRICE ACTION"), a Korean title and right-side actions
 * (tabs, badges, buttons); it renders when any of the three is present. Tables and lists that must run to the edge
 * pass `flush` to drop the body padding.
 *
 * `id`가 있으면 접을 수 있다 — 접힘 상태는 브라우저(localStorage, `lib/panelStore.ts`)에 남고, 상태 바의 "레이아웃 초기화"가
 * 전부 펼친다. 접힌 패널은 본문을 **언마운트**하므로 그 위젯의 폴링도 멈춘다.
 * With an `id` the panel is collapsible: the state lives in the browser (localStorage, `lib/panelStore.ts`) and the
 * status bar's "레이아웃 초기화" expands everything. A collapsed panel **unmounts** its body, so that widget's polling stops.
 */
import type { ReactNode } from 'react'

import { togglePanel, usePanelCollapsed } from '../../lib/panelStore.ts'

export interface PanelProps {
  /** 접기 상태의 키 — 있으면 접기 버튼이 생긴다 / The collapse-state key; present means collapsible */
  id?: string
  /** 대문자 소형 라벨 / The small uppercase label */
  eyebrow?: ReactNode
  /** 패널 제목 / The panel's title */
  title?: ReactNode
  /** 제목 우측 영역 — 탭·뱃지·버튼 / The area right of the title: tabs, badges, buttons */
  action?: ReactNode
  /** 패널 요소에 덧붙일 클래스 / Extra classes for the panel element */
  className?: string
  /** 본문 패딩 제거 (표·목록) / Drop the body padding (tables, lists) */
  flush?: boolean
  children?: ReactNode
}

export function Panel({ id, eyebrow, title, action, className, flush = false, children }: PanelProps) {
  const collapsed = usePanelCollapsed(id)
  const hasHead = id !== undefined || eyebrow !== undefined || title !== undefined || action !== undefined
  return (
    <section
      className={className === undefined ? 'panel' : `panel ${className}`}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {hasHead && (
        <header className="panel-head">
          {id !== undefined && (
            <button
              type="button"
              className="panel-toggle"
              aria-expanded={!collapsed}
              aria-label={collapsed ? '패널 펼치기' : '패널 접기'}
              onClick={() => togglePanel(id)}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          )}
          {eyebrow !== undefined && <span className="panel-eyebrow">{eyebrow}</span>}
          {title !== undefined && <h2 className="panel-title">{title}</h2>}
          {action !== undefined && <div className="panel-action">{action}</div>}
        </header>
      )}
      {!collapsed && <div className={flush ? 'panel-body panel-body-flush' : 'panel-body'}>{children}</div>}
    </section>
  )
}
