# 주식 모니터링 품질 개선 / Quality upgrade

2026-09-13 · 기존 워크트리 분석, 구현, 로컬 검증 기록

## 개선 결과 / Delivered changes

| 영역 | 확인한 문제 | 반영한 개선 |
| --- | --- | --- |
| 시장 탐색 | 모바일 시장 선택이 늦고 시세 탐색이 정렬에 제한됨 | 상단 시장 선택, URL 복원, 한글·초성·영문 검색, 섹터·등락 필터, 초기화, 밀도 저장, CSV |
| 가독성 | 뉴스가 패널 높이를 넘어 흐르고 정보 위계가 약함 | 제목·간격·양 테마 대비 정리, 내부 뉴스 스크롤, 시세 중심 배치, SVG 아이콘 |
| 시장 집계 | 보합을 빼고 전체 종목 수처럼 표시 | 표와 같은 시세로 상승·보합·하락 집계, 추적 종목 기준 명시, 종목 상세로 연결되는 순위 |
| 시세 복구 | 갱신 오류가 받아 둔 데이터를 가림 | 기존 데이터와 재시도 안내를 함께 표시, 초기 실패·대기·빈 결과 구분, GET 취소와 요청별 30초 제한 |
| 관심·검색 | 한국 시세 갱신 누락, 대기를 검색 실패로 표시, 조회 실패를 빈 목록으로 표시 | 양 시장 폴링, 일부 결과 유지, 대기·실패 구분, 한글 조합 Enter 처리 |
| 가격 알림 | 기사 화면 등 시세 위젯 없는 화면에서 갱신이 멈춤 | 대기 알림이 있을 때 양 시장 공유 키 폴링, 모든 화면에서 판정, 기록 후 1회 알림, 대기 종료 시 폴링 중지 |
| 기사 분석 | 정상 메뉴 진입에도 잘못된 접근 안내 | URL·선택 제목·언어 입력, 제출 후 기존 SSE 분석 실행, 잘못된 주소 수정 |
| 시각·가격 | 기준 시각과 시계의 시간대 불일치, 새 가격과 오래된 전일 종가 혼재 | 스트립·뉴스·상태 바 KST 통일, 재무 기준 시각 분리, 전일 종가를 최신 가격·등락과 일치시킴 |
| 서버 복원력 | 시장별 장 상태 혼재, 지연 필드 조회의 부분 실패가 전체 실패로 확대 | 시장 범위별 장 상태, 필드별 복구·degraded 전달, 무한대 비율을 캐시 전에 결측 처리 |
| 모바일·키보드 | 전체 열·정렬 접근 소실, 차트 지표가 화면 폭 초과 | 핵심/전체 열 전환과 내부 가로 스크롤, 지표 줄바꿈, 본문 바로가기, 패널 ARIA 연결, 입력 크기 개선 |

The upgrade preserves React/FastAPI, quote/news cadence, browser-only user state, SSE cost controls, simulation labels and app-shell-only PWA caching. The existing production stack was subsequently updated with the new application image after explicit approval; network and storage resource definitions were unchanged.

## 검증 / Verification

| 확인 항목 | 명령 / 증거 | 결과 |
| --- | --- | --- |
| 서버 전체 회귀 | `cd backend && .venv/bin/pytest -q` | 437 passed |
| 프런트엔드 전체 회귀 | `cd frontend && npm test` | 452 passed · 54 files |
| 타입·프로덕션 빌드 | `npm run build` 및 브라우저 테스트 사전 빌드 | 통과 · strict TypeScript |
| 린트 | `npm run lint` | 통과 |
| 실제 브라우저 | `npm run test:e2e` | 15 passed |
| 공백 검사 | `git diff --check` | 통과 |
| 의존성 점검 | `npm audit --json` | 취약점 0건 · Router 7.18.3 |

총 **904개 테스트**를 통과했다. 최초 기준은 서버 408개·프런트엔드 319개였다.

브라우저 검증은 프로덕션 빌드와 Chromium을 사용한다. 360/390/768/1440px의 양 테마, 모바일 전체 열, 종목·기사 화면, 필터·CSV·관심 저장과 뒤로 가기, 최초 실패·갱신 실패·오프라인 복구, 검색·IME·키보드, 차트 기간·지표·표 전환, AI 요청·SSE 결과, 접힘 상태 복원을 확인했다. 뉴욕 시간대 브라우저에서도 스트립·뉴스·상태 바 시각이 KST로 유지된다.

테스트는 공개 API의 시장 스냅샷, 탐색 검증용 종목·기간 변형, 테스트용 AI 응답을 사용한다. Yahoo/AWS 호출이나 실제 AI 비용은 발생하지 않는다. 스냅샷은 프로덕션 번들에 포함되지 않는다. 가격 알림은 실제 QueryClient·스토어·컴포넌트와 제어된 시계로 45초 이후의 양 시장 갱신, 1회 발동, 폴링 중지, 백그라운드 권한 요청 없음을 검증했다.

독립 리뷰의 모바일 열 접근, 한국 검색 대기, 관심 목록 실패 표시는 각각 재현한 뒤 수정했다. 서버 무한대 값 수정은 캐시·엄격한 JSON 직렬화 일관성 개선이며, 해당 값으로 인한 실제 HTTP 500은 재현되지 않았다.

## 결과물 / Artifacts

- 브라우저 보고서: `frontend/playwright-report/index.html`
- 화면·실패 추적: `frontend/test-results/`
- 선택한 캡처와 로그: `.artifacts/quality-upgrade/` (로컬 산출물, git 제외)
- 설계: [quality-upgrade-design.md](superpowers/specs/2026-09-13-quality-upgrade-design.md)
- 결정 근거: [ADR-003](decisions/ADR-003-market-workbench-and-recoverable-reads.md)

```bash
cd frontend
npx playwright install --with-deps chromium
npm run test:e2e
```

전용 4317 포트를 사용하며 다른 서버를 재사용하지 않는다. CI에도 브라우저 검증과 결과물 보존을 추가했다. 원격 CI 실행은 수행하지 않았으며, 사용자 승인 후 기존 운영 스택 배포와 공개 주소 점검을 완료했다.

## 보안 업데이트와 운영 배포 / Security update and deployment

사용자가 React Router 7.18.3 전환과 현재 계정의 기존 스택 배포를 명시적으로 승인했다. 정확한 버전 7.18.3을 적용해 전체 테스트·빌드·보안 검증을 다시 통과했고, `StockMonitoringStack`을 업데이트했다. 최종 npm audit는 취약점 0건이다. 이전 자동 승인 차단은 사용자 승인으로 해소되었다.

운영 태스크는 `stock-monitoring:13`, 태스크 1개가 RUNNING/HEALTHY이고 배포 상태는 COMPLETED다. CloudFormation은 UPDATE_COMPLETE다. 미국·한국 시세 각 50종목, 실제 AI SSE의 정상 final, 새 정적 번들과 운영 화면의 일치, 모바일 화면과 ALB 직접 접근 차단을 확인했다. 상세 기록은 [운영 배포 기록](deployments/2026-09-13-router7-quality-upgrade.md)에 있다.

## 적용 범위 / Limits

소스 개선과 기존 운영 스택의 애플리케이션 이미지 배포를 완료했다. 네트워크·DB 정의는 변경하지 않았다. Yahoo의 시세 지연 가능성과 기존 정규장 계산의 휴일·조기 폐장 미반영은 유지된다. `asOf`는 수집/캐시 기준 시각이며 거래소 체결 시각을 보장하지 않는다. 통화가 섞인 금액 정렬은 현지 통화 숫자 기준이고 환산 가치 비교가 아니다. 백엔드 테스트에는 기존 Starlette/httpx deprecation 경고 1건이 남아 있다.
