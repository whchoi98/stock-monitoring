/**
 * 위젯 단위 에러 카드 — "조용한 실패 없음": 한 위젯이 실패해도 화면은 살아 있고 재시도만 제공한다.
 * The per-widget error card. "No silent failures": one widget failing leaves the page alive and offers a retry.
 */
export interface ErrorCardProps {
  /** 재시도 — 보통 쿼리 키 무효화나 스트림의 `analyze` / The retry, usually a key invalidation or a stream's `analyze` */
  onRetry: () => void
  /** 사용자에게 보일 문구 / The wording shown to the user */
  message?: string
}

export function ErrorCard({ onRetry, message = '데이터를 불러오지 못했습니다' }: ErrorCardProps) {
  return (
    <div className="error-card" role="alert">
      <p className="error-message">{message}</p>
      <button type="button" className="retry-button" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  )
}
