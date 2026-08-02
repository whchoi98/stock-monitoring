/**
 * 카드 래퍼 — 대시보드/상세의 모든 위젯이 이 껍데기를 쓴다 (`.card`는 F1의 global.css 소유).
 * The card wrapper every dashboard and detail widget sits in (`.card` belongs to F1's global.css).
 */
import type { ReactNode } from 'react'

export interface CardProps {
  /** 카드 제목 / The card's title */
  title?: ReactNode
  /** 제목 우측 영역 — 탭·뱃지·버튼 / The area right of the title: tabs, badges, buttons */
  action?: ReactNode
  children?: ReactNode
}

export function Card({ title, action, children }: CardProps) {
  const hasHead = title !== undefined || action !== undefined
  return (
    <section className="card">
      {hasHead && (
        <header className="card-head">
          {title !== undefined && <h2 className="card-title">{title}</h2>}
          {action !== undefined && <div className="card-action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
