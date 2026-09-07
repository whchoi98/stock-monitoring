/** 초성 유틸 테스트 / Choseong helper tests */
import { describe, expect, it } from 'vitest'

import { isChoseongQuery, toChoseong } from './hangul.ts'

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

describe('isChoseongQuery', () => {
  it('초성만이면 true / true for initials only', () => {
    expect(isChoseongQuery('ㅅㅅ')).toBe(true)
    expect(isChoseongQuery('ㅅㅅ ㅈㅈ')).toBe(true)
  })

  it('음절·라틴·모음·빈 문자열은 false / false for syllables, Latin, vowels and empty', () => {
    expect(isChoseongQuery('삼성')).toBe(false)
    expect(isChoseongQuery('ㅅa')).toBe(false)
    expect(isChoseongQuery('ㅏ')).toBe(false)
    expect(isChoseongQuery('')).toBe(false)
    expect(isChoseongQuery('  ')).toBe(false)
  })
})
