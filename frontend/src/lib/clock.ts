/**
 * 시각 표기 유틸 — 마켓 스트립의 기준 시각 칩, 상태 바의 KST 시계, 뉴스 와이어의 시각 열이 공유한다.
 * Clock formatting shared by the market strip's as-of chip, the status bar's KST clock and the news wire's time column.
 *
 * `hour12: false`는 h24 사이클로 해석되어 00:xx가 24:xx로 렌더된다 — 그래서 `hourCycle: 'h23'`을 쓴다
 * (정정 2026-08-03, TickerBar 리뷰에서 실증).
 * `hour12: false` resolves to the h24 cycle and renders 00:xx as 24:xx, hence `hourCycle: 'h23'` (corrected
 * 2026-08-03, proven in the TickerBar review).
 */

/** 브라우저 로컬 HH:MM / Browser-local HH:MM */
const LOCAL_HHMM = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 서울 시각 HH:MM:SS — 상태 바 시계는 시장 시각(KST)을 고정으로 보인다 / Seoul HH:MM:SS; the status bar clock always shows market time */
const KST_HHMMSS = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * ISO → 브라우저 로컬 `HH:MM`. 파싱 불가면 null — 칩/열을 그리지 않는 신호다.
 * ISO to the browser-local `HH:MM`; null when unparseable, meaning "draw nothing".
 */
export function formatClock(iso: string): string | null {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : LOCAL_HHMM.format(at)
}

/** 에포크 ms → 서울 `HH:MM:SS` / Epoch ms to Seoul `HH:MM:SS` */
export function formatKstClock(epochMs: number): string {
  return KST_HHMMSS.format(epochMs)
}
