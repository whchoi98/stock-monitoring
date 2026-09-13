/** 입력 형식만 확인한다. 네트워크 주소의 SSRF 검증은 서버가 수행한다.
 * Validate input shape only; the server owns network/SSRF enforcement.
 */
export function isArticleUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' && url.password === ''
  } catch {
    return false
  }
}
