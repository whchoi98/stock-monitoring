# Browser verification / 브라우저 검증

- `npm run test:e2e` builds the production app and launches the dedicated port 4317 server from `playwright.config.ts`. Never reuse an arbitrary running preview server. / 전용 서버를 사용한다.
- `fixtures.ts` intercepts only URL paths beginning with `/api/`. Do not match source-module paths such as `/src/api/`. / API 경로만 가로챈다.
- `fixtures/market.json` contains captured market data. Symbol/period variants and AI responses are controlled fixtures, not live financial evidence. / 파생 응답·AI는 검증용 모의 데이터다.
- Browser tests must not call Yahoo, Bedrock or other production APIs. Live deployment checks are recorded separately under `docs/deployments/`. / 운영 호출과 회귀 테스트를 분리한다.
- Keep coverage for URL scopes, filtering/export, local preferences, failures/offline recovery, IME, chart controls, article input and mobile full-column access. / 기존 검증 흐름을 유지한다.
- API responses and UI clocks are controlled so the tests remain repeatable. Wait for observable UI state and resize completion instead of arbitrary sleeps. / 관측 가능한 상태를 기다린다.
- `test-results/` and `playwright-report/` are ignored locally and retained by CI; they do not belong in the production image. / 검증 산출물을 배포 이미지에 포함하지 않는다.
