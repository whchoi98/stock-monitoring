import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { mockApi, type ApiState } from './fixtures.ts'

const states = new WeakMap<Page, ApiState>()
const errors = new WeakMap<Page, string[]>()
const quotes = (page: Page) => page.getByRole('region', { name: '시세 모니터', exact: true })
const rows = (page: Page) => quotes(page).locator('tbody tr')

test.beforeEach(async ({ page }) => {
  const caught: string[] = []
  errors.set(page, caught)
  page.on('pageerror', error => caught.push(error.message))
  states.set(page, await mockApi(page))
})

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'uncaught browser errors').toEqual([])
})

test('Korean filtering, export, reset and persistent density', async ({ page }) => {
  await page.goto('/?market=kr')
  await expect(rows(page)).toHaveCount(50)
  await expect(page.getByRole('button', { name: '한국', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await quotes(page).getByRole('searchbox', { name: '종목 검색' }).fill('ㅅㅅㅈㅈ')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('삼성전자')

  const downloadPromise = page.waitForEvent('download')
  await quotes(page).getByRole('button', { name: 'CSV 내보내기' }).click()
  const download = await downloadPromise
  const csv = await readFile((await download.path())!, 'utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  expect(csv).toContain('005930.KS')
  expect(csv).toContain('KRW')
  expect(csv.trim().split('\r\n')).toHaveLength(2)

  await quotes(page).getByRole('button', { name: '시세 보기 초기화' }).click()
  await expect(rows(page)).toHaveCount(50)
  await quotes(page).getByRole('combobox', { name: '섹터', exact: true }).selectOption('Semiconductor')
  await quotes(page).getByRole('group', { name: '등락 필터' }).getByRole('button', { name: '하락' }).click()
  expect(await rows(page).count()).toBeGreaterThan(0)
  await expect(rows(page).first()).toHaveClass('down')
  await quotes(page).getByRole('button', { name: '시세 보기 초기화' }).click()
  await quotes(page).getByRole('button', { name: '촘촘하게' }).click()
  await page.reload()
  await expect(quotes(page).locator('table')).toHaveClass(/quote-table--compact/)
  await expect(page.getByRole('button', { name: '한국', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('watchlist holds both markets and survives detail/back navigation', async ({ page }) => {
  await page.goto('/')
  await quotes(page).getByRole('button', { name: 'AAPL 관심 추가' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: '한국', exact: true }).click()
  await quotes(page).getByRole('button', { name: '005930.KS 관심 추가' }).click()
  await page.getByRole('button', { name: '관심', exact: true }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(quotes(page)).toContainText('USD')
  await expect(quotes(page)).toContainText('KRW')
  await quotes(page).getByRole('link', { name: '삼성전자', exact: true }).click()
  await expect(page).toHaveURL(/\/stocks\/005930\.KS$/)
  await page.goBack()
  await expect(page.getByRole('button', { name: '관심', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(rows(page)).toHaveCount(2)
  await page.reload()
  await expect(rows(page)).toHaveCount(2)
})

test('failed refresh retains rows; retry and offline state recover', async ({ page }) => {
  await page.goto('/')
  await expect(rows(page)).toHaveCount(50)
  states.get(page)!.failedMarkets.add('us')
  await page.getByRole('button', { name: '시장 데이터 새로고침' }).click()
  const notice = quotes(page).getByRole('status', { name: '데이터 갱신 안내' })
  await expect(notice).toBeVisible()
  await expect(rows(page)).toHaveCount(50)
  states.get(page)!.failedMarkets.clear()
  await notice.getByRole('button', { name: '다시 시도' }).click()
  await expect(notice).toBeHidden()

  await page.context().setOffline(true)
  await expect(page.getByText('오프라인', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '시장 데이터 새로고침' })).toBeDisabled()
  await expect(rows(page)).toHaveCount(50)
  await page.context().setOffline(false)
  await expect(page.getByText('오프라인', { exact: true })).toBeHidden()
})

test('a cold market failure still permits switching to another market', async ({ page }) => {
  states.get(page)!.failedMarkets.add('us')
  await page.goto('/')
  await expect(quotes(page).getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: '한국', exact: true }).click()
  await expect(rows(page)).toHaveCount(50)
  await expect(quotes(page).getByRole('alert')).toBeHidden()
})

test('skip link, command search and IME confirmation work from a non-Korean timezone', async ({ page }) => {
  await page.goto('/?market=kr')
  await expect(rows(page)).toHaveCount(50)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '본문으로 건너뛰기' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
  await page.keyboard.press('/')
  const search = page.getByRole('combobox', { name: '종목 검색' })
  await expect(search).toBeFocused()
  await search.fill('ㅅㅅㅈㅈ')
  await expect(page.getByRole('listbox', { name: '검색 결과' }).getByRole('option')).toContainText('삼성전자')
  await search.evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  })
  await expect(page).toHaveURL(/\?market=kr#main-content$/)
  await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/stocks\/005930\.KS$/)
  // Fixture overview is 01:53 UTC: the strip must agree with the KST clock even in New York.
  await expect(page.locator('.strip-asof')).toContainText('10:53')
})

test('chart periods, data view and AI streaming remain functional', async ({ page }) => {
  await page.goto('/stocks/AAPL')
  await expect(page.locator('.price-chart canvas').first()).toBeVisible()
  await page.getByRole('button', { name: '1Y', exact: true }).click()
  await expect(page.getByRole('button', { name: '1Y', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'RSI', exact: true }).click()
  await expect(page.locator('.chart-pane').filter({ hasText: 'RSI 14' }).locator('canvas').first()).toBeVisible()
  await page.getByRole('button', { name: '표', exact: true }).click()
  await expect(page.locator('.candle-table tbody tr').first()).toBeVisible()
  await page.getByRole('button', { name: '캔들', exact: true }).click()
  await expect(page.locator('.price-chart canvas').first()).toBeVisible()
  expect(states.get(page)!.aiRequests).toBe(0)
  await page.getByRole('textbox', { name: 'AI 질문' }).fill('현재 거래량을 설명해 주세요')
  await page.getByRole('button', { name: 'AI 분석', exact: true }).click()
  await expect(page.getByRole('heading', { name: '테스트 분석 결과' })).toBeVisible()
  expect(states.get(page)!.aiRequests).toBe(1)
  await expect(page.locator('.ai-question')).toContainText('현재 거래량을 설명해 주세요')
})

test('article menu is actionable and sends one request only on submit', async ({ page }) => {
  await page.goto('/articles')
  await expect(page.getByRole('heading', { level: 1, name: '기사 분석' })).toBeVisible()
  expect(states.get(page)!.aiRequests).toBe(0)
  await page.getByRole('textbox', { name: '기사 주소' }).fill('https://example.com/markets/test')
  await page.getByRole('textbox', { name: '기사 제목 (선택)' }).fill('브라우저 검증 기사')
  await page.getByRole('combobox', { name: '기사 언어' }).selectOption('en')
  await page.getByRole('button', { name: '기사 분석 시작' }).click()
  await expect(page.getByRole('heading', { name: '테스트 분석 결과' })).toBeVisible()
  expect(states.get(page)!.aiRequests).toBe(1)
  await page.getByRole('link', { name: '← 다른 기사 분석하기' }).click()
  await expect(page.getByRole('textbox', { name: '기사 주소' })).toBeVisible()
  expect(states.get(page)!.aiRequests).toBe(1)
})

test('pending Korean search distinguishes loading from no matches', async ({ page }) => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  states.get(page)!.waitForMarket = market => market === 'kr' ? ready : Promise.resolve()
  await page.goto('/')
  await expect(rows(page)).toHaveCount(50)
  const search = page.getByRole('combobox', { name: '종목 검색' })
  await search.fill('삼성전자')
  try {
    await expect(page.locator('.search-pop').getByRole('status')).toContainText('불러오는 중')
    await expect(page.locator('.search-pop').getByText('일치하는 종목이 없습니다')).toHaveCount(0)
  } finally {
    release()
  }
  await expect(page.getByRole('listbox', { name: '검색 결과' }).getByRole('option')).toContainText('삼성전자')
})

test('a failed saved watch entry offers recovery without claiming it is empty', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('stock-monitoring:watchlist', '["005930.KS"]'))
  states.get(page)!.failedMarkets.add('kr')
  await page.goto('/stocks/AAPL')
  const rail = page.getByRole('complementary', { name: '워치리스트', exact: true })
  await rail.getByRole('button', { name: '관심', exact: true }).click()
  await expect(rail.getByRole('alert')).toBeVisible()
  await expect(rail.getByText('☆를 눌러 관심 종목을 추가하세요')).toHaveCount(0)
  await expect(rail.getByRole('status', { name: '데이터 갱신 안내' })).toHaveCount(0)
  states.get(page)!.failedMarkets.clear()
  await rail.getByRole('button', { name: '다시 시도' }).click()
  await expect(rail.locator('.wl-name')).toHaveText('삼성전자')
})

test('stock and article workflows fit a phone in both themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 844 })
  await page.goto('/stocks/AAPL')
  await expect(page.locator('.price-chart canvas').first()).toBeVisible()
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', { name: '라이트 모드로 전환' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
    await page.screenshot({ path: testInfo.outputPath(`stock-mobile-${theme}.png`), fullPage: true })
  }
  await page.goto('/articles')
  await expect(page.getByRole('textbox', { name: '기사 주소' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.screenshot({ path: testInfo.outputPath('article-mobile-light.png'), fullPage: true })
})

test('panel preferences, news filters and themes survive reload', async ({ page }) => {
  await page.goto('/')
  const news = page.getByRole('region', { name: '시장 뉴스', exact: true })
  await news.getByRole('button', { name: '한국어', exact: true }).click()
  await expect(news.locator('.news-item')).toHaveCount(3)
  await news.getByRole('searchbox', { name: '뉴스 검색' }).fill('impossible-match-2026')
  await expect(news.getByText('조건에 맞는 뉴스가 없습니다')).toBeVisible()
  await news.getByRole('button', { name: '뉴스 필터 초기화' }).click()
  await expect(news.locator('.news-item')).toHaveCount(6)
  await news.getByRole('button', { name: '패널 접기' }).click()
  await page.getByRole('button', { name: '라이트 모드로 전환' }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(news.getByRole('searchbox', { name: '뉴스 검색' })).toBeHidden()
  await page.getByRole('button', { name: '레이아웃 초기화' }).click()
  await expect(news.getByRole('searchbox', { name: '뉴스 검색' })).toBeVisible()
})

for (const width of [360, 390, 768, 1440]) {
  test(`workspace fits ${width}px in both themes with contained panels`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/?market=kr')
    await expect(rows(page)).toHaveCount(50)
    if (width < 600) {
      await expect(quotes(page).getByRole('button', { name: '전체 열 보기' })).toBeVisible()
      await expect(rows(page).first().locator('.cell-symbol')).toBeHidden()
      await quotes(page).getByRole('button', { name: '전체 열 보기' }).click()
      await expect(rows(page).first().locator('.cell-symbol')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await quotes(page).getByRole('button', { name: '핵심 열 보기' }).click()
    }
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: '라이트 모드로 전환' }).click()
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      const newsBounds = await page.getByRole('region', { name: '시장 뉴스', exact: true }).boundingBox()
      expect(newsBounds?.width).toBeGreaterThan(Math.min(width - 32, 280))
      const list = page.locator('.area-news .news-list')
      const listBox = await list.boundingBox()
      expect(listBox!.height).toBeLessThan(newsBounds!.height)
      await expect(page.locator('.strip-track')).toHaveCSS('animation-name', 'none')
      await page.screenshot({ path: testInfo.outputPath(`workspace-${width}-${theme}.png`), fullPage: true })
    }
  })
}
