# Quality Upgrade Implementation Plan

> **For agentic workers:** use the dispatching-parallel-agents workflow for the disjoint tasks below; the parent integrates and verifies the combined result.

**Goal:** Improve the current application's market workflow, visual clarity, reliability and accessibility with verified working code.

**Architecture:** Keep existing routes, query/cache architecture and terminal components. Extend quote exploration through pure functions and browser preferences; expose recoverable query errors in the UI without discarding cached data.

**Tech Stack:** React 19, strict TypeScript, TanStack Query 5, Vite, Vitest/Testing Library, FastAPI, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-13-quality-upgrade-design.md`

## Global Constraints

- Server state stays in TanStack Query; no manual data polling.
- Quotes refresh at `QUOTE_POLL_MS = 45_000`, news at `NEWS_POLL_MS = 120_000`.
- All theme colours come from `tokens.css`; up red, down blue, green for status only.
- User state stays in the browser through `localStore`.
- Preserve single-worker cache invariants, SSE cost controls, SSRF guards, app-shell-only PWA and existing `img/`.
- Work in the current user workspace without deploying production changes.

## Task 1: Quote workbench

**Owner/files:** quote worker: `components/market/StockTable.tsx`, its tests, new `lib/quoteFilter.ts`, `lib/quoteCsv.ts`, `lib/quotePreferences.ts` and colocated tests. Parent owns CSS.

**Consumes:** `useScopedQuotes(scope)` with `quotes/asOf/isLoading/error/retryKeys`; existing `searchSymbols`, `useWatchlist`, `createLocalStore`.
**Produces:** unchanged `StockTable({ scope, onScopeChange? })` interface and semantic `quote-*` CSS classes; filtered rows and escaped CSV output.

- [x] Add failing behavioral cases: combined Korean/sector/move filtering, zero matches/reset, null-last sort in both directions, export order/currency/escaping, star versus navigation, cached data plus error.
- [x] Implement pure filtering/sorting/export functions and real controls; keep default source order.
- [x] Run targeted Vitest; return class names and evidence to parent for visual integration.

## Task 2: Query reliability

**Owner/files:** query worker: `api/client.ts`, `api/queries.ts`, `lib/scopedQuotes.ts` and colocated tests only.

**Consumes:** existing backend Envelope/Quote API and TanStack AbortSignal.
**Produces:** backward-compatible hooks with optional `isFetching`/additional metadata; a bounded cancellable GET and reliable watch polling.

- [x] Reproduce KR-watch non-refresh, partial-market failure behavior and indefinite GET handling using real QueryClient/fetch boundaries.
- [x] Implement shared per-market quote observers, accurate watch freshness and partial-data retention without losing explicit errors.
- [x] Preserve callers of `useQuotes(market)` and `useSymbolUniverse(enabled)` and existing mock fixture compatibility.
- [x] Run targeted query/client/scoped tests; communicate changed metadata to parent.

## Task 3: Dashboard and presentation

**Owner/files:** parent: `pages/Dashboard.tsx`, `App.tsx`, market panels except StockTable, common controls, stock widgets, `styles/`, related tests.

**Consumes:** tasks 1/2, existing overview and quotes. A reusable `DataNotice({ error, onRetry })` renders only for background failures.
**Produces:** page hierarchy, market controls, improved breadth, responsive table/layout styles, reliable error presentation and accessible navigation.

- [x] Test URL market restoration, IME Enter handling, explicit search failures and retained widget data.
- [x] Add page heading, accessible market controls, refresh, skip link and panel relationships.
- [x] Implement breadth from actual quotes, including flat rows; make leaders link to stocks.
- [x] Add DataNotice and use initial-error versus background-error branches in relevant widgets.
- [x] Refine theme tokens, typography, workspace grids, table/filter styles, mobile control targets and reduced motion.
- [x] Inspect actual dark/light desktop and mobile renders, including error/empty states.

## Task 4: Backend reliability audit and fixes

**Owner/files:** backend worker: `backend/**`, affected `docs/reference/api.md` / `data.md`.

- [x] Run existing backend tests; identify at most 2–3 concrete high-confidence correctness/resilience defects.
- [x] Reproduce with failing regression tests before fixing; preserve response/cache invariants.
- [x] Run backend suite; return exact evidence and compatibility implications.

## Task 5: Integration and completion audit

**Owner/files:** parent: browser smoke harness/artifacts, README, frontend/UI references, verification report.

- [x] Review every delegated diff and integrate only changes aligned with the spec.
- [x] Run `npm test`, `npm run lint`, `npm run build` in frontend; run `.venv/bin/pytest -q` in backend.
- [x] Run browser scenarios for US/KR/watch, filters/reset/export, sorting/stars, stock/chart/AI route navigation, news, keyboard/IME, retry/offline, collapse, dark/light, and viewport overflow.
- [x] Save desktop/mobile screenshots and evidence under an appropriate ignored artifact directory; document repeatable commands.
- [x] Sync docs, review `git diff --check` and status, and audit all seven acceptance requirements before completion.


## Completion evidence / 완료 근거

- Backend 437, frontend 452 and Chromium 15 tests passed; strict type checking, production build and lint passed.
- Browser coverage includes both themes at 360/390/768/1440px, mobile full-column access, stock/article flows, recovery, IME and persistent preferences.
- An independent reviewer rechecked the three identified defects after fixes; all affected component cases passed.
- The existing all-screen alert contract was additionally checked with a real QueryClient; both-market polling now works without quote widgets and stops when no alerts remain.
- Details and known limits: [quality upgrade record](../../quality-upgrade-2026-09-13.md).
- Local screenshots and raw logs: `.artifacts/quality-upgrade/`.
- The user subsequently approved Router 7.18.3 and deployment. The migration passed all 904 tests with zero npm audit findings and was deployed to the existing StockMonitoringStack (task revision 13), followed by live verification.
