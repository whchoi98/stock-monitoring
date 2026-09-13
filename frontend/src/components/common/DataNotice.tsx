/** 백그라운드 갱신 실패는 기존 데이터 옆에 표시한다.
 * A refresh failure is visible alongside the last successful data.
 */
export function DataNotice({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  if (error === null) return null
  return (
    <div className="data-notice" role="status" aria-label="데이터 갱신 안내">
      <span className="data-notice-mark" aria-hidden="true">!</span>
      <span><strong>갱신 지연</strong> 마지막으로 받은 데이터를 표시하고 있습니다.</span>
      <button type="button" className="btn" onClick={onRetry}>다시 시도</button>
    </div>
  )
}
