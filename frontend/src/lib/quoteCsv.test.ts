/** CSV 원본 값·인코딩·스프레드시트 안전성 / CSV source values, encoding and spreadsheet safety. */
import { describe, expect, it } from 'vitest'

import type { Quote } from '../api/types.ts'
import { quotesToCsv } from './quoteCsv.ts'

const QUOTE: Quote = {
  symbol: 'AAPL',
  name: 'Apple',
  name_ko: '애플',
  market: 'us',
  currency: 'USD',
  sector: 'Technology',
  price: 245.56789,
  change: -2.1234,
  change_pct: -0.86432,
  market_cap: 3700000000000,
  volume: 41234567,
}

describe('quotesToCsv', () => {
  it('exports exact source values, both currencies and the supplied order with UTF-8 BOM and CRLF', () => {
    const source = Object.freeze([
      Object.freeze({ ...QUOTE, symbol: '005930.KS', name: 'Samsung Electronics', name_ko: '삼성전자', market: 'kr' as const, currency: 'KRW' as const, price: 262500 }),
      Object.freeze(QUOTE),
    ])
    expect(quotesToCsv(source)).toBe(
      '\uFEFFsymbol,name,name_ko,market,sector,currency,price,change,change_pct,market_cap,volume\r\n' +
      '005930.KS,Samsung Electronics,삼성전자,kr,Technology,KRW,262500,-2.1234,-0.86432,3700000000000,41234567\r\n' +
      'AAPL,Apple,애플,us,Technology,USD,245.56789,-2.1234,-0.86432,3700000000000,41234567\r\n',
    )
  })

  it('escapes quotes, commas and line breaks and leaves unavailable cells empty', () => {
    const csv = quotesToCsv([{
      ...QUOTE,
      name: 'ACME, "Holdings"\nInternational',
      name_ko: null,
      sector: 'Tech\r\nFinance',
      market_cap: null,
      volume: 0,
    }])
    expect(csv).toContain(
      'AAPL,"ACME, ""Holdings""\nInternational",,us,"Tech\r\nFinance",USD,245.56789,-2.1234,-0.86432,,0\r\n',
    )
  })

  it.each([
    ['=SUM(1,2)', '"\'=SUM(1,2)"'],
    ['+Company', "'+Company"],
    ['-Company', "'-Company"],
    ['@Company', "'@Company"],
    ['  =1+1', "'  =1+1"],
    ['\t=1+1', '"\'\t=1+1"'],
    ['\r=1+1', '"\'\r=1+1"'],
    ['\n=1+1', '"\'\n=1+1"'],
    ['\uFEFF=1+1', "'\uFEFF=1+1"],
  ])('neutralizes formula-like text without changing numeric negatives: %j', (name, escaped) => {
    const csv = quotesToCsv([{ ...QUOTE, name }])
    expect(csv).toContain(`AAPL,${escaped},애플,us,Technology,USD,245.56789,-2.1234,-0.86432,3700000000000,41234567\r\n`)
  })

  it('protects every source text field, including Korean names, symbols and sectors', () => {
    const csv = quotesToCsv([{ ...QUOTE, symbol: '=1', name_ko: '+한글', sector: '@sector' }])
    expect(csv).toContain("'=1,Apple,'+한글,us,'@sector,USD,245.56789,-2.1234,-0.86432,3700000000000,41234567\r\n")
  })

  it('keeps ordinary text intact and does not serialize non-finite numbers as data', () => {
    const csv = quotesToCsv([{ ...QUOTE, name: 'A-B & Co.', market_cap: Number.NaN, volume: Number.POSITIVE_INFINITY }])
    expect(csv).toContain('AAPL,A-B & Co.,애플,us,Technology,USD,245.56789,-2.1234,-0.86432,,\r\n')
  })

  it('exports just a header for an empty result instead of inventing rows', () => {
    expect(quotesToCsv([])).toBe('\uFEFFsymbol,name,name_ko,market,sector,currency,price,change,change_pct,market_cap,volume\r\n')
  })
})
