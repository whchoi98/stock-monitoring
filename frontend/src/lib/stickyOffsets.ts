/**
 * 고정 블록 실측 높이 → CSS 변수. 상단 sticky 블록(`.term-top`: 커맨드 바 + 마켓 스트립)과 하단 상태 바(`.statusbar`)의 실제
 * 높이를 `--sticky-top-h` / `--sticky-bottom-h`로 내보낸다. 토스트 스택(`.toasts`, `.toasts-left`)이 이 값에 붙는다.
 * Measured sticky-block heights as CSS variables: the top sticky block (`.term-top`: command bar + market strip) and the
 * bottom status bar (`.statusbar`) are exported as `--sticky-top-h` / `--sticky-bottom-h`; the toast stacks (`.toasts`,
 * `.toasts-left`) anchor to them.
 *
 * 왜 토큰으로 충분하지 않은가: `--term-top-h`(85px)·`--term-status-h`(28px)는 데스크톱 실측값이다. 좁은 화면에서는 커맨드 바·
 * 스트립·상태 바가 줄바꿈해 125~184px / 38~59px가 되고, 토큰에 붙인 토스트는 그 블록을 덮었다(2026-09-07 PWA 리뷰, 390px 실측).
 * 변수가 없으면(관찰 전, ResizeObserver 부재) CSS는 토큰으로 폴백한다.
 * Why the tokens are not enough: `--term-top-h` (85px) and `--term-status-h` (28px) are desktop measurements; on narrow
 * screens the bar, strip and status bar wrap to 125–184px / 38–59px and toasts anchored to the tokens covered them (PWA
 * review, 2026-09-07, measured at 390px). Without the variables (before observation, no ResizeObserver) CSS falls back to
 * the tokens.
 */

export const STICKY_TOP_VAR = '--sticky-top-h'
export const STICKY_BOTTOM_VAR = '--sticky-bottom-h'

const TARGETS: ReadonlyArray<readonly [selector: string, variable: string]> = [
  ['.term-top', STICKY_TOP_VAR],
  ['.statusbar', STICKY_BOTTOM_VAR],
]

/**
 * 두 블록을 관찰하기 시작하고, 해제 함수를 돌려준다 (해제 시 변수도 지운다 → 토큰 폴백).
 * Start observing both blocks and return a stop function (which also clears the variables → token fallback).
 */
export function observeStickyOffsets(root: Document): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}

  const style = root.documentElement.style
  const found = TARGETS.flatMap(([selector, variable]) => {
    const element = root.querySelector(selector)
    return element === null ? [] : [{ element, variable }]
  })
  if (found.length === 0) return () => {}

  const measure = (element: Element, variable: string) => {
    style.setProperty(variable, `${Math.round(element.getBoundingClientRect().height)}px`)
  }
  const observer = new ResizeObserver(() => {
    for (const { element, variable } of found) measure(element, variable)
  })
  for (const { element, variable } of found) {
    measure(element, variable)
    observer.observe(element)
  }
  return () => {
    observer.disconnect()
    for (const { variable } of found) style.removeProperty(variable)
  }
}
