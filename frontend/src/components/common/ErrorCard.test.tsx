/**
 * ErrorCard 테스트 — "조용한 실패 없음" 규칙의 위젯 단위 출구. 재시도 버튼이 실제로 콜백을 부르는지 본다.
 * ErrorCard tests; the per-widget exit of the "no silent failures" rule. The retry button must really fire.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ErrorCard } from './ErrorCard.tsx'

describe('ErrorCard', () => {
  it('기본 메시지를 렌더한다 / renders a default message', () => {
    render(<ErrorCard onRetry={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('데이터를 불러오지 못했습니다')
  })

  it('message를 주면 그것을 렌더한다 / renders the given message', () => {
    render(<ErrorCard onRetry={vi.fn()} message="잠시 후 다시 시도해주세요" />)
    expect(screen.getByRole('alert').textContent).toContain('잠시 후 다시 시도해주세요')
  })

  it('재시도 버튼이 onRetry를 부른다 / the retry button calls onRetry', () => {
    const onRetry = vi.fn()
    render(<ErrorCard onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
