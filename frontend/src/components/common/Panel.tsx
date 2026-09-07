/**
 * 패널 — 터미널 워크스페이스의 모든 위젯이 이 껍데기를 쓴다 (`.panel*`은 global.css 소유).
 * The panel every widget in the terminal workspace sits in (`.panel*` belongs to global.css).
 *
 * 머리는 eyebrow(대문자 소형 라벨, 예: "PRICE ACTION") + 제목(한국어) + 우측 액션(탭·뱃지·버튼)이다.
 * 셋 중 하나라도 있으면 머리를 그린다. 표·목록처럼 가장자리까지 써야 하는 본문은 `flush`로 패딩을 없앤다.
 * The head is an eyebrow (small uppercase label such as "PRICE ACTION"), a Korean title and right-side actions
 * (tabs, badges, buttons); it renders when any of the three is present. Tables and lists that must run to the edge
 * pass `flush` to drop the body padding.
 */
import type { ReactNode } from 'react'

export interface PanelProps {
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

export function Panel({ eyebrow, title, action, className, flush = false, children }: PanelProps) {
  const hasHead = eyebrow !== undefined || title !== undefined || action !== undefined
  return (
    <section className={className === undefined ? 'panel' : `panel ${className}`}>
      {hasHead && (
        <header className="panel-head">
          {eyebrow !== undefined && <span className="panel-eyebrow">{eyebrow}</span>}
          {title !== undefined && <h2 className="panel-title">{title}</h2>}
          {action !== undefined && <div className="panel-action">{action}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body panel-body-flush' : 'panel-body'}>{children}</div>
    </section>
  )
}
