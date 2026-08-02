/**
 * 로딩 스피너 — 위젯 단위 로딩 표시. 애니메이션은 global.css의 `.spinner`가 담당한다.
 * The loading spinner for per-widget loading states; global.css's `.spinner` owns the animation.
 */
export function Spinner() {
  return <div className="spinner" role="status" aria-label="불러오는 중" />
}
