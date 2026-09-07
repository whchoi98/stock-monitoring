/**
 * 한글 매칭 유틸 — 종목 검색이 한글 종목명을 초성("ㅅㅅㅈㅈ" → 삼성전자), 음절, 그리고 IME 조합 중의 혼합("삼ㅅ")으로
 * 찾을 수 있게 한다.
 * Hangul matching helpers, so symbol search finds Korean names by initials ("ㅅㅅㅈㅈ" → 삼성전자), by syllables, and by
 * the mixed forms an IME produces mid-composition ("삼ㅅ").
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

/** 음절 하나의 초성, 음절이 아니면 그 문자 그대로 / One syllable's initial; a non-syllable is returned as is */
function initialOf(char: string): string {
  const code = char.codePointAt(0) ?? 0
  if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) {
    return CHOSEONG[Math.floor((code - SYLLABLE_BASE) / PER_INITIAL)]!
  }
  return char
}

/** 음절을 초성으로, 나머지는 그대로 / Syllables to their initial, everything else as is */
export function toChoseong(text: string): string {
  let out = ''
  for (const char of text) out += initialOf(char)
  return out
}

/**
 * 질의 한 글자가 이름 한 글자와 맞는가 — 같은 글자이거나, 질의가 초성 자모이고 이름 글자의 초성과 같으면 맞는다.
 * Does one query character match one name character: equal, or the query is an initial jamo equal to the name character's
 * initial.
 */
function charMatches(nameChar: string, queryChar: string): boolean {
  if (nameChar === queryChar) return true
  return CHOSEONG_SET.has(queryChar) && initialOf(nameChar) === queryChar
}

/**
 * 한글 이름에 질의가 어디서 맞는가 — 공백은 양쪽 모두 무시한다. 접두(`'prefix'`) > 포함(`'includes'`) > 없음(`null`).
 * 순수 초성("ㅅㅅㅈㅈ"), 음절("삼성"), 혼합("삼ㅅ" — IME가 조합 중에 내는 형태) 모두 같은 규칙으로 맞는다.
 * Where a query matches a Korean name, spaces ignored on both sides: prefix (`'prefix'`) > substring (`'includes'`) > none
 * (`null`). Pure initials ("ㅅㅅㅈㅈ"), syllables ("삼성") and the mixed forms an IME emits mid-composition ("삼ㅅ") all follow
 * the same rule.
 */
export function matchHangul(name: string, query: string): 'prefix' | 'includes' | null {
  const target = Array.from(name.replace(/\s+/g, ''))
  const needle = Array.from(query.replace(/\s+/g, ''))
  if (needle.length === 0 || needle.length > target.length) return null

  const matchesAt = (start: number): boolean => {
    for (let k = 0; k < needle.length; k += 1) {
      if (!charMatches(target[start + k]!, needle[k]!)) return false
    }
    return true
  }

  if (matchesAt(0)) return 'prefix'
  for (let start = 1; start + needle.length <= target.length; start += 1) {
    if (matchesAt(start)) return 'includes'
  }
  return null
}
