# ADR-002: PWA — 앱 셸만 담당하는 서비스 워커 / PWA with a service worker that owns the app shell only

- 날짜 / Date: 2026-09-07
- 상태 / Status: Accepted
- 선행 / Builds on: ADR-001 (터미널 디자인 언어), `docs/reference/frontend.md`

## 맥락 / Context

사용자가 대시보드를 "설치해서 쓰는 앱"처럼 쓰기를 원했다(`/goal` "PWA도 구현해줘"). 이 앱은 Yahoo Finance 시세를 45초마다
폴링하는 **실시간** 화면이고, 백엔드는 L1/L2 계층 캐시와 stale 규칙으로 "무엇을 얼마나 오래 보여줄지"를 이미 결정한다
(`docs/reference/data.md`). AI 분석은 SSE로 스트리밍되며 호출마다 비용이 든다.
The user wanted the dashboard to behave like an installed app (`/goal` "PWA도 구현해줘"). The app is a **live** screen that
polls Yahoo Finance quotes every 45 s, and the backend already decides what to show and for how long through its L1/L2
tiered cache and stale rules. AI analyses stream over SSE and cost money per call.

PWA의 세 요소 — 매니페스트(설치), 서비스 워커(오프라인·업데이트), 아이콘 — 중 서비스 워커가 데이터 경로에 끼어들면
위의 두 성질과 충돌한다.
Of the three PWA parts — manifest (install), service worker (offline and updates), icons — a worker that steps into the
data path collides with both properties above.

## 결정 / Decision

1. **`vite-plugin-pwa`(workbox `generateSW`)를 쓴다.** 손으로 만든 워커 대신 빌드가 프리캐시 목록(해시 포함)을 생성한다.
   / Use `vite-plugin-pwa` (workbox `generateSW`): the build emits the precache manifest with revisions instead of a
   hand-written worker.
2. **워커는 앱 셸만 담당한다.** 빌드 산출물(js/css/html/svg/png)을 프리캐시하고, SPA 경로는 `index.html`로 돌린다
   (`navigateFallback`, `/api/`는 `navigateFallbackDenylist`). 폰트(woff2, ~1.6MB)는 프리캐시하지 않고 처음 쓸 때
   `CacheFirst`로 담는다.
   / The worker owns the app shell only: build output is precached, SPA routes fall back to `index.html` (`/api/` is
   denylisted), and fonts (woff2, ~1.6 MB) are cached `CacheFirst` on first use rather than precached.
3. **`/api/*`에는 워커 라우트를 두지 않는다.** 시세·뉴스·AI는 항상 네트워크로 간다. 오프라인이면 TanStack Query
   (`networkMode: 'online'`)가 폴링을 멈추고 화면에 있던 마지막 데이터를 그대로 두며 상태 바가 "오프라인"을 표시한다
   (`lib/online.ts`); 캐시 없는 첫 진입(콜드)만 위젯별 실패 카드가 뜬다. 워커의 navigate fallback은 `/api`(슬래시 유무)와
   FastAPI 문서 라우트(`/docs`, `/redoc`, `/openapi.json`)를 제외한다.
   / No worker route for `/api/*`: quotes, news and AI always hit the network. Offline, TanStack Query
   (`networkMode: 'online'`) pauses the polls and keeps the last data on screen while the status bar shows "오프라인"
   (`lib/online.ts`); only a cold visit with nothing cached shows per-widget failure cards. The navigate fallback
   denylists `/api` (with or without a slash) and the FastAPI docs routes (`/docs`, `/redoc`, `/openapi.json`).
4. **업데이트는 `prompt` 방식이다.** 새 워커는 사용자가 토스트의 "새로 고침"을 누를 때만 활성화된다(`UpdateToast`,
   `SKIP_WAITING` 메시지). 자동 갱신(`autoUpdate`)은 채택하지 않는다.
   / Updates use `prompt` mode: a new worker activates only when the user presses "새로 고침" in the toast (`UpdateToast`,
   the `SKIP_WAITING` message). `autoUpdate` is rejected.
5. **매니페스트는 다크 테마를 따른다.** `theme_color`/`background_color` = `--bg`(`#0b0e14`), 아이콘은 브랜드 마크(앰버
   사각형 + 모노 "S")를 192/512/maskable/apple-touch로 생성한다(`public/icons/`).
   / The manifest follows the dark theme: `theme_color`/`background_color` = `--bg` (`#0b0e14`); icons are the brand
   mark (amber square, mono "S") at 192/512/maskable/apple-touch (`public/icons/`).

## 검토한 대안 / Options Considered

- **손으로 쓴 서비스 워커**: 의존성 0이지만 프리캐시 목록(해시 revision)을 빌드마다 직접 생성해야 하고 workbox의 만료·정리
  로직을 다시 만들어야 한다 → 기각. / A hand-written worker: no dependency, but the revisioned precache list and workbox's
  expiration/cleanup would have to be rebuilt by hand — rejected.
- **`autoUpdate` 등록**: 새 워커가 제어권을 잡을 때 페이지를 다시 읽는다 — AI 스트리밍·알림 폼 도중 화면이 갈릴 수 있다 → 기각,
  `prompt` 채택. / `autoUpdate`: reloads when the new worker takes control, possibly under an AI stream or an alert form —
  rejected in favour of `prompt`.
- **`/api/*` 런타임 캐시(NetworkFirst/StaleWhileRevalidate)**: 오프라인에서도 마지막 시세를 보여 주지만 백엔드 신선도 규칙 밖의
  두 번째 진실이 되고, 낡은 값을 '현재가'로 보이게 한다 → 기각(오프라인은 배지 + 위젯 실패 카드). / A runtime cache for
  `/api/*`: shows the last quotes offline but becomes a second source of truth outside the backend's freshness rules and
  presents stale values as current — rejected (offline = badge; cached screens pause, cold visits show failure cards).
- **폰트 프리캐시**: 첫 설치 비용 +1.6MB, `/assets/*`는 이미 CDN 장기 캐시 → 런타임 CacheFirst로 대체. / Precaching fonts:
  +1.6 MB on install while `/assets/*` is already long-cached by the CDN — replaced by runtime CacheFirst.

## 근거 / Rationale

- **API를 캐시하지 않는 이유**: 워커 캐시는 백엔드의 신선도 규칙(45초 갱신, stale-while-error, `degraded` 표시)과 별개의
  두 번째 진실이 된다. 오프라인에서 낡은 시세를 "현재가"처럼 보이게 하는 것은 조용한 실패이며, 이 프로젝트의 원칙
  (조용한 실패 금지, 시뮬레이션 데이터 명시)과 어긋난다. AI 응답을 워커가 캐시하면 백엔드의 비용 방어(레이트리밋 → 결과
  캐시 → 세마포어) 바깥에 또 하나의 캐시가 생긴다.
  / Why no API caching: a worker cache becomes a second source of truth beside the backend's freshness rules (45 s refresh,
  stale-while-error, `degraded`). Showing a stale quote as "current" offline is a silent failure, against this project's
  rules (no silent failures, simulated data labelled). Caching AI answers in the worker would add a cache outside the
  backend's cost defense (rate limit → result cache → semaphore).
- **`prompt`인 이유**: `autoUpdate`는 새 워커가 제어권을 잡을 때 페이지를 다시 읽는다. AI 분석을 스트리밍 중이거나 알림
  폼을 채우는 도중에 화면이 저절로 갈리면 안 된다. 사용자가 고르는 한 번의 클릭이 비용이다.
  / Why `prompt`: `autoUpdate` reloads the page when the new worker takes control; a screen mid-way through an AI stream or
  an alert form must not swap under the user. One click is the price.
- **폰트를 프리캐시하지 않는 이유**: 4.5MB 산출물 중 1.6MB가 woff2다. 설치 직후 첫 방문 비용을 줄이고, 이미 `/assets/*`는
  CloudFront가 불변 해시로 장기 캐시하므로 두 번째 방문부터는 어차피 빠르다.
  / Why fonts are not precached: 1.6 MB of the 4.5 MB output is woff2. It keeps the first visit after install light, and
  `/assets/*` is already long-cached by CloudFront under immutable hashes, so later visits are fast regardless.
- **배포 경로가 바뀌지 않는다**: `sw.js`·`manifest.webmanifest`·`workbox-*.js`는 `vite build`가 `backend/static`에 함께
  내놓고 FastAPI `StaticFiles`가 서빙한다. CloudFront 기본 동작이 `CACHING_DISABLED`라 워커 파일은 CDN에 캐시되지 않아
  새 배포가 곧바로 새 워커로 이어진다(`/assets/*`만 장기 캐시). 인프라 변경 0.
  / The deploy path is unchanged: `sw.js`, `manifest.webmanifest` and `workbox-*.js` land in `backend/static` with the
  build and FastAPI `StaticFiles` serves them; CloudFront's default behaviour is `CACHING_DISABLED`, so the worker files
  are never CDN-cached and a new deploy becomes a new worker at once (only `/assets/*` is long-cached). Zero infra change.

## 결과 / Consequences

- 긍정 / Positive: 홈 화면 설치, 오프라인에서도 셸이 열리고 이유("오프라인")가 보임, 새 버전이 사용자 제어로 적용됨, 데이터
  경로·비용 방어·인프라 무변경. 백엔드 SPA fallback은 `/assets/*`·파일형 경로에 진짜 404를 유지해(`main.py`) 롤링 배포 창에서
  옛 태스크가 낸 200 HTML이 워커 캐시(프리캐시·폰트 CacheFirst)나 CloudFront `/assets/*` 캐시에 굳지 않는다.
  / The backend SPA fallback keeps real 404s for `/assets/*` and file-like paths (`main.py`), so a 200 HTML answer from an
  old task during a rolling deploy can never harden into the worker caches (precache, font CacheFirst) or CloudFront's
  `/assets/*` cache.
- 부정 / Negative: 오프라인에서 새 데이터는 없다(의도) — 캐시된 화면은 마지막 값에 멈추고, 콜드 진입은 실패 카드다. 사용자가 "새로 고침"을 누르지 않으면 옛 번들이 계속 돈다
  (탭을 모두 닫고 다시 열면 새 워커가 활성화된다). 산출물에 워커 파일 2개(`sw.js`, `workbox-*.js`)·매니페스트·클라이언트
  `workbox-window` 청크(`/assets/`, 장기 캐시 대상)와 아이콘 4개가 추가된다; 프리캐시 항목은 15개(폰트·apple-touch 아이콘 제외 — 매니페스트 아이콘 3개는 플러그인이 넣는다)다.
  / Two worker files, the manifest, a `workbox-window` client chunk under `/assets/` and four icons join the build output;
  the precache holds 15 entries (fonts and the apple-touch icon excluded; the 3 manifest icons are added by the plugin).
- 테스트: `UpdateToast.test.tsx`(가상 모듈 mock), `StatusBar.test.tsx`(오프라인 배지). 워커 자체는 빌드 산출물 검사와
  로컬 headless Chromium(등록·프리캐시·오프라인 셸)으로 검증한다.

## 참조 / References

- `frontend/vite.config.ts` — `VitePWA({...})` 설정과 주석 / the plugin configuration and its comment
- `frontend/src/components/common/UpdateToast.tsx`, `frontend/src/lib/online.ts`, `frontend/index.html`, `frontend/public/icons/`
- `docs/reference/frontend.md` §3, `docs/reference/infrastructure.md` (CloudFront 행), `docs/reference/data.md` (백엔드 신선도 규칙)
