/**
 * 2026-09-13 공개 API 스냅샷을 바탕으로 화면을 검증한다. 파생 종목·기간 응답과 AI는 검증용 모의 응답이다.
 * Based on public API snapshots captured 2026-09-13, with synthetic symbol/period variants and AI output.
 * No upstream service is contacted.
 */
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { ChartData, Envelope, InvestorsData, NewsItem, OrderBookData, Overview, Quote, StockDetail } from '../src/api/types.ts'

interface Snapshots {
  overview: Envelope<Overview>
  us: Envelope<Quote[]>
  kr: Envelope<Quote[]>
  stock: Envelope<StockDetail>
  chart: Envelope<ChartData>
  news: Envelope<NewsItem[]>
  stockNews: Envelope<NewsItem[]>
  orderbook: Envelope<OrderBookData>
  investors: Envelope<InvestorsData>
}

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/market.json', import.meta.url), 'utf8')) as Snapshots
export interface ApiState {
  failedMarkets: Set<string>
  aiRequests: number
  waitForMarket?: (market: string) => Promise<void>
}

export async function mockApi(page: Page): Promise<ApiState> {
  const state: ApiState = { failedMarkets: new Set(), aiRequests: 0 }
  await page.clock.setFixedTime(new Date('2026-09-13T01:56:00Z'))
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const url = new URL(request.url())
    const parts = url.pathname.split('/')
    const symbol = decodeURIComponent(parts[3] ?? '')
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname.startsWith('/api/ai/') && request.method() === 'POST') {
      state.aiRequests++
      const raw = request.postData()
      const input = raw === null ? {} : JSON.parse(raw) as Record<string, string>
      const analysis = '## 테스트 분석 결과\n\n이 내용은 브라우저 동작 검증용 응답입니다.\n\n| 구분 | 상태 |\n| --- | --- |\n| 스트리밍 | 정상 |'
      const data = url.pathname.includes('/stocks/')
        ? { symbol: parts[4], analysis, ...(input.question ? { question: input.question } : {}) }
        : { ...input, analysis }
      const frames = [
        ['phase', { phase: 'analyzing' }],
        ['delta', { text: analysis }],
        ['final', { asOf: fixtures.overview.asOf, marketOpen: false, data }],
      ].map(([event, body]) => `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`).join('')
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames })
      return
    }

    if (url.pathname === '/api/market/quotes') {
      const market = url.searchParams.get('market') === 'kr' ? 'kr' : 'us'
      await state.waitForMarket?.(market)
      if (state.failedMarkets.has(market)) return json({ detail: 'quotes_unavailable' }, 503)
      return json(fixtures[market])
    }
    if (url.pathname === '/api/market/overview') return json(fixtures.overview)
    if (url.pathname === '/api/market/news') return json(fixtures.news)
    if (url.pathname.startsWith('/api/stocks/')) {
      const suffix = parts[4]
      if (suffix === 'chart') return json({ ...fixtures.chart, data: { ...fixtures.chart.data, symbol, period: url.searchParams.get('period') } })
      if (suffix === 'news') return json(fixtures.stockNews)
      if (suffix === 'orderbook') return json(fixtures.orderbook)
      if (suffix === 'investors') return json(fixtures.investors)
      const quote = [...fixtures.us.data, ...fixtures.kr.data].find(row => row.symbol === symbol)
      if (quote === undefined) return json({ detail: 'not_found' }, 404)
      return json({
        ...fixtures.stock,
        data: {
          ...fixtures.stock.data, ...quote,
          day_change: quote.change, day_change_pct: quote.change_pct,
          prev_close: quote.price - quote.change,
        },
      })
    }
    return json({ detail: 'unexpected_test_route' }, 404)
  })
  return state
}
