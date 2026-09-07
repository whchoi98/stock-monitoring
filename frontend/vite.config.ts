// vitest/config의 defineConfig를 사용해야 test 옵션이 타입 체크를 통과함
// Use defineConfig from vitest/config so the `test` option is typed.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    /*
     * PWA (ADR-002) — 매니페스트 + 서비스 워커. 워커는 **앱 셸만** 담당한다:
     *  - 빌드 산출물(js/css/html/svg/png)을 프리캐시하고 SPA 라우트를 index.html로 돌린다(`/api/`는 제외).
     *  - 폰트(woff2, ~1.6MB)는 프리캐시하지 않고 처음 쓸 때 CacheFirst로 담는다.
     *  - `/api/*`는 어떤 라우트에도 걸리지 않아 항상 네트워크로 간다 — 시세·뉴스·AI를 워커가 캐시하면 백엔드의
     *    계층 캐시·stale 규칙과 어긋난 낡은 데이터를 보이게 된다. 오프라인이면 TanStack Query(`networkMode: 'online'`)가
     *    폴링을 멈추고 마지막 데이터를 그대로 두며 상태 바가 "오프라인"을 알린다; 캐시 없는 첫 진입만 실패 카드다.
     *  - `registerType: 'prompt'`: 새 워커는 사용자가 "새로 고침"을 누를 때만 교체된다(`UpdateToast`) —
     *    AI 스트리밍 중인 화면이 저절로 다시 읽히지 않게.
     * PWA (ADR-002): manifest plus service worker. The worker owns the **app shell only**:
     *  - precaches the build output (js/css/html/svg/png) and routes SPA paths to index.html (`/api/` excluded);
     *  - fonts (woff2, ~1.6MB) are not precached but cached CacheFirst on first use;
     *  - `/api/*` matches no route and always goes to the network — a worker cache would show data that disagrees
     *    with the backend's tiered cache and stale rules. Offline, TanStack Query (`networkMode: 'online'`) pauses the
     *    polls and keeps the last data on screen while the status bar says "오프라인"; only a cold visit shows failure cards;
     *  - `registerType: 'prompt'`: a new worker takes over only when the user presses refresh (`UpdateToast`), so a
     *    screen mid-way through an AI stream never reloads by itself.
     */
    VitePWA({
      registerType: 'prompt',
      // `includeAssets`는 두지 않는다 — 아래 globPatterns가 svg/png를 이미 프리캐시한다(중복 항목 방지) / No `includeAssets`: the glob below already precaches svg/png (avoids duplicate entries)
      manifest: {
        id: '/',
        name: 'Stock Monitoring Terminal',
        short_name: 'StockMon',
        description: 'Yahoo Finance 기반 실시간 주식 모니터링 터미널 — 시세·차트·재무·뉴스·AI 분석',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        // 다크 테마 `--bg` — 스플래시·상태 표시줄 색 / The dark theme's `--bg`, for the splash and the status bar
        background_color: '#0b0e14',
        theme_color: '#0b0e14',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // 매니페스트 아이콘 3개는 플러그인이 따로 프리캐시 목록에 넣는다 — glob과 겹치지 않게 아이콘 png는 glob에서 뺀다
        // (apple-touch 아이콘은 iOS가 설치 시점에 네트워크로 가져가므로 프리캐시 대상이 아니다).
        // The plugin adds the 3 manifest icons to the precache itself, so icon pngs leave the glob to avoid duplicates
        // (the apple-touch icon is fetched by iOS at install time and needs no precache).
        globIgnores: ['**/icons/*.png'],
        navigateFallback: '/index.html',
        // `/api`(슬래시 없음 포함)와 FastAPI 문서 라우트는 셸이 아니다 / `/api` (with or without a slash) and the FastAPI docs routes are not the shell
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/(docs|redoc|openapi\.json)$/],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.woff2$/,
            handler: 'CacheFirst',
            options: { cacheName: 'fonts', expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // 개발 서버의 /api 호출을 FastAPI 백엔드로 프록시
    // Proxy /api calls to the FastAPI backend during development.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  test: {
    environment: 'jsdom',
    // @testing-library/react의 자동 cleanup은 전역 afterEach가 있을 때만 등록된다.
    // globals가 false면 컴포넌트 테스트끼리 DOM이 누적되어 조용히 서로를 오염시킨다.
    // @testing-library/react only registers its auto-cleanup when a global afterEach exists; with
    // globals disabled the DOM accumulates across component tests and they silently pollute each other.
    globals: true,
  },
})
