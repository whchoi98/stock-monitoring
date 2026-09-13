/**
 * 화면 행의 CSV — 원본 숫자·통화·이름을 보존하고 한글 인코딩과 스프레드시트 수식 해석을 방어한다.
 * CSV for displayed rows: preserve original numbers, currencies and names with a UTF-8 BOM and safe text cells.
 */
import type { Quote } from '../api/types.ts'

const COLUMNS = [
  'symbol', 'name', 'name_ko', 'market', 'sector', 'currency',
  'price', 'change', 'change_pct', 'market_cap', 'volume',
] as const

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return ''
  // 음수 숫자는 수식 방어 대상이 아니다 / Numeric negatives remain numbers, never apostrophe-prefixed text.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''

  let text = value
  if (/^[=+@-]/u.test(text.trimStart()) || /^[\t\r\n]/u.test(text)) text = `'${text}`
  return /[",\t\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function quotesToCsv(quotes: readonly Quote[]): string {
  const rows = quotes.map((quote) => COLUMNS.map((key) => csvCell(quote[key])).join(','))
  return `\uFEFF${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`
}

export function downloadQuoteCsv(quotes: readonly Quote[], filename: string): void {
  const blob = new Blob([quotesToCsv(quotes)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const revoke = URL.revokeObjectURL.bind(URL)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    // 다운로드가 시작된 뒤 임시 URL을 해제한다 / Release the temporary URL after the download has started.
    setTimeout(() => revoke(url), 0)
  }
}
