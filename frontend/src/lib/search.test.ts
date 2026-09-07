/**
 * 종목 검색 순위 테스트 / Symbol search ranking tests.
 */
import { describe, expect, it } from 'vitest'

import type { Quote } from '../api/types.ts'
import { searchSymbols } from './search.ts'

function quote(symbol: string, name: string, market: Quote['market'] = 'us', name_ko: string | null = null): Quote {
  return {
    symbol,
    name,
    name_ko,
    price: 1,
    change: 0,
    change_pct: 0,
    volume: 0,
    market,
    currency: market === 'kr' ? 'KRW' : 'USD',
    sector: '',
    market_cap: null,
  }
}

const UNIVERSE: Quote[] = [
  quote('AAPL', 'Apple', 'us', '애플'),
  quote('AMZN', 'Amazon', 'us', '아마존'),
  quote('AMD', 'AMD', 'us', 'AMD'),
  quote('MSFT', 'Microsoft', 'us', '마이크로소프트'),
  quote('META', 'Meta Platforms', 'us', '메타 플랫폼스'),
  quote('005930.KS', 'Samsung Electronics', 'kr', '삼성전자'),
  quote('006400.KS', 'Samsung SDI', 'kr', '삼성SDI'),
  quote('207940.KS', 'Samsung Biologics', 'kr', '삼성바이오로직스'),
  quote('035420.KS', 'NAVER', 'kr', '네이버'),
  quote('000660.KS', 'SK Hynix', 'kr', 'SK하이닉스'),
]

describe('searchSymbols', () => {
  it('빈 질의는 빈 결과 / an empty query yields nothing', () => {
    expect(searchSymbols(UNIVERSE, '')).toEqual([])
    expect(searchSymbols(UNIVERSE, '   ')).toEqual([])
  })

  it('심볼 정확 일치가 접두 일치보다 앞선다 / an exact symbol beats a prefix match', () => {
    expect(searchSymbols(UNIVERSE, 'amd').map((q) => q.symbol)).toEqual(['AMD'])
    // 'am'은 AMD·AMZN이 심볼 접두로 앞서고, 'Samsung …'(포함 일치)이 그 뒤를 따른다
    // 'am' puts AMD and AMZN first by symbol prefix; the 'Samsung …' substring matches trail them
    const symbols = searchSymbols(UNIVERSE, 'am').map((q) => q.symbol)
    expect(symbols.slice(0, 2)).toEqual(['AMD', 'AMZN'])
    expect(symbols.slice(2)).toEqual(['005930.KS', '006400.KS', '207940.KS'])
  })

  it('심볼 접두가 종목명 접두보다 앞선다 / a symbol prefix beats a name prefix', () => {
    // 'm' → META·MSFT(심볼 접두)가 먼저, 'Amazon'·'Samsung …'(포함)은 뒤 / 'm' → META and MSFT by symbol prefix, substring matches after
    expect(searchSymbols(UNIVERSE, 'm').slice(0, 2).map((q) => q.symbol)).toEqual(['META', 'MSFT'])
    // 'micro'는 종목명 접두로만 맞는다 / 'micro' matches by name prefix alone
    expect(searchSymbols(UNIVERSE, 'micro').map((q) => q.symbol)).toEqual(['MSFT'])
  })

  it('종목명 포함 일치는 마지막이다 / a name substring ranks last', () => {
    expect(searchSymbols(UNIVERSE, 'samsung').map((q) => q.symbol)).toEqual([
      '005930.KS',
      '006400.KS',
      '207940.KS',
    ])
    expect(searchSymbols(UNIVERSE, 'sdi').map((q) => q.symbol)).toEqual(['006400.KS'])
  })

  it('KR 코드는 접미사 없이도 맞는다 / a KR code matches without its suffix', () => {
    expect(searchSymbols(UNIVERSE, '005930').map((q) => q.symbol)).toEqual(['005930.KS'])
    expect(searchSymbols(UNIVERSE, '0059').map((q) => q.symbol)).toEqual(['005930.KS'])
  })

  it('대소문자를 가리지 않는다 / is case-insensitive', () => {
    expect(searchSymbols(UNIVERSE, 'AaPl').map((q) => q.symbol)).toEqual(['AAPL'])
  })

  it('상한을 지킨다 / respects the limit', () => {
    expect(searchSymbols(UNIVERSE, 'a', 2)).toHaveLength(2)
  })

  it('한글 종목명으로 찾는다 — 접두가 포함보다 앞 / matches Korean names, prefix before substring', () => {
    expect(searchSymbols(UNIVERSE, '삼성').map((q) => q.symbol)).toEqual(['005930.KS', '006400.KS', '207940.KS'])
    expect(searchSymbols(UNIVERSE, '네이버').map((q) => q.symbol)).toEqual(['035420.KS'])
    expect(searchSymbols(UNIVERSE, '전자').map((q) => q.symbol)).toEqual(['005930.KS'])
    expect(searchSymbols(UNIVERSE, '애플').map((q) => q.symbol)).toEqual(['AAPL'])
  })

  it('초성으로 찾는다 (공백 무시) / matches by Hangul initials, ignoring spaces', () => {
    expect(searchSymbols(UNIVERSE, 'ㅅㅅㅈㅈ').map((q) => q.symbol)).toEqual(['005930.KS'])
    expect(searchSymbols(UNIVERSE, 'ㅅㅅ ㅈㅈ').map((q) => q.symbol)).toEqual(['005930.KS'])
    // 'ㅅㅅ'는 삼성 셋 모두의 접두 / 'ㅅㅅ' prefixes all three Samsung names
    expect(searchSymbols(UNIVERSE, 'ㅅㅅ').map((q) => q.symbol)).toEqual(['005930.KS', '006400.KS', '207940.KS'])
    // 'ㅎㅇㄴㅅ'는 SK하이닉스의 초성열 안에 있다 (접두는 아니다) / 'ㅎㅇㄴㅅ' sits inside SK하이닉스's initials, not at the start
    expect(searchSymbols(UNIVERSE, 'ㅎㅇㄴㅅ').map((q) => q.symbol)).toEqual(['000660.KS'])
  })

  it('한글 종목명이 없는 종목은 영문으로만 맞는다 / a quote without a Korean name matches by Latin name only', () => {
    const noKo = [quote('KO', 'Coca-Cola')]
    expect(searchSymbols(noKo, '코카')).toEqual([])
    expect(searchSymbols(noKo, 'coca').map((q) => q.symbol)).toEqual(['KO'])
  })
})
