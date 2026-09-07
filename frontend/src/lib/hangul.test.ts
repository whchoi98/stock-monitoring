/** 한글 매칭 유틸 테스트 / Hangul matching helper tests */
import { describe, expect, it } from 'vitest'

import { matchHangul, toChoseong } from './hangul.ts'

describe('toChoseong', () => {
  it('음절을 초성으로 바꾼다 / maps syllables to their initials', () => {
    expect(toChoseong('삼성전자')).toBe('ㅅㅅㅈㅈ')
    expect(toChoseong('카카오뱅크')).toBe('ㅋㅋㅇㅂㅋ')
    expect(toChoseong('쌍용')).toBe('ㅆㅇ')
  })

  it('한글 아닌 문자는 그대로 둔다 / leaves non-Hangul characters alone', () => {
    expect(toChoseong('SK하이닉스')).toBe('SKㅎㅇㄴㅅ')
    expect(toChoseong('KT&G')).toBe('KT&G')
    expect(toChoseong('')).toBe('')
  })
})

describe('matchHangul', () => {
  it('순수 초성은 접두·포함으로 맞는다 / pure initials match as prefix or substring', () => {
    expect(matchHangul('삼성전자', 'ㅅㅅㅈㅈ')).toBe('prefix')
    expect(matchHangul('삼성전자', 'ㅅㅅ')).toBe('prefix')
    expect(matchHangul('SK하이닉스', 'ㅎㅇㄴㅅ')).toBe('includes')
    expect(matchHangul('삼성전자', 'ㅈㅈㅅ')).toBeNull()
  })

  it('음절과 혼합(IME 조합 중)도 맞는다 / syllables and mixed mid-composition forms match too', () => {
    expect(matchHangul('삼성전자', '삼성')).toBe('prefix')
    expect(matchHangul('삼성전자', '삼ㅅ')).toBe('prefix')
    expect(matchHangul('삼성전자', '성ㅈ')).toBe('includes')
    expect(matchHangul('SK하이닉스', 'SKㅎ')).toBe('prefix')
    expect(matchHangul('삼성전자', '삼ㅈ')).toBeNull()
  })

  it('공백은 양쪽에서 무시한다 / spaces are ignored on both sides', () => {
    expect(matchHangul('메타 플랫폼스', 'ㅁㅌㅍㄹㅍㅅ')).toBe('prefix')
    expect(matchHangul('메타 플랫폼스', 'ㅁㅌ ㅍㄹㅍㅅ')).toBe('prefix')
    expect(matchHangul('메타 플랫폼스', '메타플')).toBe('prefix')
    expect(matchHangul('일라이 릴리', 'ㅇㄹㅇㄹㄹ')).toBe('prefix')
    expect(matchHangul('일라이 릴리', '릴리')).toBe('includes')
  })

  it('빈 질의·이름보다 긴 질의는 맞지 않는다 / an empty query or one longer than the name never matches', () => {
    expect(matchHangul('삼성전자', '')).toBeNull()
    expect(matchHangul('삼성', '삼성전자')).toBeNull()
  })
})
