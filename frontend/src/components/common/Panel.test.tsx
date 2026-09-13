/** Panel 테스트 — 머리 구성과 접기(영속) / Panel tests: head composition and collapsing (persisted). */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { panelStore, PANELS_KEY } from '../../lib/panelStore.ts'
import { Panel } from './Panel.tsx'

beforeEach(() => {
  localStorage.clear()
  panelStore.reload()
})

describe('Panel', () => {
  it('eyebrow·제목·액션·본문을 렌더하고 id가 없으면 접기 버튼이 없다 / renders head parts and body; no toggle without an id', () => {
    render(
      <Panel eyebrow="PRICE ACTION" title="가격 차트" action={<span>액션</span>}>
        본문
      </Panel>,
    )
    expect(screen.getByText('PRICE ACTION')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '가격 차트' })).toBeTruthy()
    expect(screen.getByText('액션')).toBeTruthy()
    expect(screen.getByText('본문')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('머리가 없으면 본문만 / body only without any head part', () => {
    const { container } = render(<Panel>본문</Panel>)
    expect(container.querySelector('.panel-head')).toBeNull()
    expect(container.querySelector('.panel-body')?.textContent).toBe('본문')
  })

  it('id가 있으면 접기 버튼이 본문을 언마운트하고 상태가 저장된다 / with an id the toggle unmounts the body and persists', () => {
    const { container, rerender } = render(
      <Panel id="orderbook" eyebrow="ORDER BOOK">
        본문
      </Panel>,
    )
    const toggle = screen.getByRole('button', { name: '패널 접기' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(screen.queryByText('본문')).toBeNull()
    expect(container.querySelector('.panel')?.getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByRole('button', { name: '패널 펼치기' }).getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}')).toEqual({ orderbook: true })

    // 다른 id는 영향받지 않는다 / Another id is unaffected
    rerender(
      <Panel id="news" eyebrow="NEWS">
        뉴스 본문
      </Panel>,
    )
    expect(screen.getByText('뉴스 본문')).toBeTruthy()
  })

  it('패널 제목과 접기 버튼이 해당 본문을 가리킨다 / labels its region and identifies the controlled body', () => {
    render(<Panel id="quotes" title="시세"><span>시세 본문</span></Panel>)
    const region = screen.getByRole('region', { name: '시세' })
    const toggle = screen.getByRole('button', { name: '패널 접기' })
    const controlled = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(controlled?.textContent).toContain('시세 본문')
    expect(region.contains(controlled)).toBe(true)
  })
})
