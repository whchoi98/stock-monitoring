/**
 * 한글 초성 유틸 — 종목 검색의 초성 입력(예: "ㅅㅅㅈㅈ" → 삼성전자)을 지원한다.
 * Hangul initial-consonant helpers, so symbol search accepts choseong input (e.g. "ㅅㅅㅈㅈ" → 삼성전자).
 *
 * 완성형 음절(U+AC00–U+D7A3)은 588개(중성 21 × 종성 28)마다 초성이 바뀐다. 그 밖의 문자는 그대로 둔다.
 * A precomposed syllable (U+AC00–U+D7A3) changes its initial every 588 code points (21 medials × 28 finals); any
 * other character passes through unchanged.
 */

const SYLLABLE_BASE = 0xac00
const SYLLABLE_LAST = 0xd7a3
const PER_INITIAL = 21 * 28

/** 19개 초성 (호환 자모) / The 19 initial consonants (compatibility jamo) */
const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const

const CHOSEONG_SET: ReadonlySet<string> = new Set(CHOSEONG)

/** 음절을 초성으로, 나머지는 그대로 / Syllables to their initial, everything else as is */
export function toChoseong(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) {
      out += CHOSEONG[Math.floor((code - SYLLABLE_BASE) / PER_INITIAL)]
    } else {
      out += char
    }
  }
  return out
}

/** 초성만으로 이뤄진 질의인가 (공백 제외) / Whether a query is made of initial consonants only (spaces aside) */
export function isChoseongQuery(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact === '') return false
  for (const char of compact) if (!CHOSEONG_SET.has(char)) return false
  return true
}
