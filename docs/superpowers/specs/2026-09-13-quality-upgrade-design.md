# Stock monitoring quality upgrade / 품질 개선 설계

## Objective / 목적

현재 앱의 시장 탐색, 정보 가독성, 오류 복원력과 모바일 사용성을 실제로 개선한다.
Upgrade the existing market-monitoring workflow, readability, resilience and mobile usability.
The user's request authorizes implementation and local verification in the current workspace.

## Evidence / 현황

- The baseline frontend has 319 passing tests. Its dashboard has no page heading; market selection is inside the quote panel, below the overview on mobile.
- Quote sorting exists, but there is no in-table symbol/name search, sector or movement filter, view reset, or export.
- Quote, overview and detail widgets replace cached data with an error card after a failed background refresh.
- The watch scope observes US quotes with polling but gets KR quotes through a non-polling search observer. This needs a regression test against real QueryClient behavior.
- SymbolSearch consumes Enter during Hangul composition and does not distinguish a failed symbol lookup from no matches.
- Dense controls, small low-contrast text, and mobile ordering make the main monitoring workflow harder to use.

## Design / 방향

Keep ADR-001's Korean financial terminal identity. The single visual focal point is a readable market-breadth display grounded in the tracked quotes. Market choices and navigation lead the page; quotes get the widest work area; news and macro data remain secondary.

- Palette: ink `#0b0e14`, panel slate `#11151d`, raised slate `#171c26`, amber `#f2a93b`, rising red `#f5445a`, falling blue `#4391ff`. Improve muted text contrast through theme tokens. Light mode uses white and cool grey surfaces.
- Type: Pretendard for Korean headings/body, JetBrains Mono for symbols/prices. Use a clear page heading, quieter panel labels, tabular data and adequate line height.
- Layout: page heading and market controls, breadth/sector overview, quote workbench, secondary news/macro column. On mobile, market choice and quotes precede secondary data; wide tables scroll within their own panel.
- Interaction: clear focus, labelled controls, reduced-motion support, keyboard-safe Hangul search, native stock links, remembered browser preferences and meaningful empty states.

```text
Desktop
[ brand / navigation              global symbol search / theme ]
[                        index strip                           ]
[ market workspace title             US | KR | watch / refresh ]
[ market breadth                 | sectors         | news      ]
[ quote search / sector / move / export             | news      ]
[ sortable quotes, names, currencies, volume        | macro     ]
[ status / update state                              KST clock ]

Mobile
[ brand / nav / symbol search ][ index strip ]
[ title / market choice / refresh ]
[ market breadth ][ searchable quotes ]
[ sectors ][ macro ][ news ][ status ]
```

## Acceptance / 완료 기준

1. **Market navigation:** a real page heading, prominent US/KR/watch controls, URL-backed market selection that survives detail/back navigation, and a refresh action for active market data.
2. **Quote workflow:** combine symbol/English/Korean/initial search, sector and up/down/flat filters; show result counts and reset; sort without mutating cached data, place missing values last; export the displayed order with currency and CSV escaping; preserve star actions and stock navigation.
3. **Readability:** coherent dark/light hierarchy, Korean names where available, clickable leaders, honest breadth counts including flat stocks and explicit tracked-universe wording. No invented price series, recommendations or full-market breadth claims.
4. **Resilience:** retain available data after background errors with a visible retry notice; explicit initial loading/failure/empty/offline states; bounded GET duration with cancellation; watch quotes refresh for both markets and partial results remain usable.
5. **Accessibility/mobile:** keyboard search respects IME; errors are distinguishable from empty search; main-content skip link; labelled panel relationships; visible focus; no page-level horizontal overflow at 360/390/768/1440px; reduced motion and both themes checked.
6. **Verification:** full frontend tests, TypeScript, lint, production build, backend suite, and browser scenarios using deterministic fixtures derived from public API data. Include screenshots and an implementation/verification report.
7. **Documentation:** update affected frontend/UI/API/data references and README with delivered behavior and practical limitations.

## Invariants / 유지 조건

- Same React/FastAPI architecture; server state stays in TanStack Query; no manual data polling.
- Quotes refresh at `QUOTE_POLL_MS = 45_000`, news at `NEWS_POLL_MS = 120_000`.
- All theme colours come from `tokens.css`; up red, down blue, green for status only.
- User state stays in the browser through `localStore`. No user account, portfolio or trading subsystem.
- SSE AI cost/concurrency controls, backend single worker, SSRF guards and app-shell-only PWA caching remain intact.
- `img/` is existing user material. Do not modify it.
- This work upgrades and verifies source locally; it does not require a production deployment or changes to AWS resources.
