# React Router 7.18.3 및 품질 개선 운영 배포

2026-09-13 · 사용자 명시 승인에 따라 현재 계정의 기존 스택을 업데이트했다.

## 배포 대상

- 계정: `061525506239`
- 리전: `ap-northeast-2`
- 스택: `StockMonitoringStack`
- ECS 클러스터·서비스: `stock-monitoring`
- 운영 주소: `https://d2wa9w1vbqlndl.cloudfront.net`
- 태스크 정의: `stock-monitoring:12` → `stock-monitoring:13`
- 이미지 digest: `sha256:dae70ad29bed47aa7756d9e4311ea7c14d934c57d2c5cfe3003950b6749cfee7`

## 변경 및 검증

`react-router-dom`을 정확한 `7.18.3`으로 전환했다. 기존 품질 개선 코드와 함께 전체 검증을 다시 수행했으며 추가 라우팅 호환 수정은 필요하지 않았다.

| 항목 | 결과 |
| --- | --- |
| 프런트엔드 단위·통합 테스트 | 452 passed |
| 백엔드 테스트 | 437 passed |
| 프로덕션 빌드 대상 Chromium 시나리오 | 15 passed |
| strict TypeScript·빌드·린트 | 통과 |
| npm audit | 취약점 0건 |
| CDK synth | 통과 |
| 운영 템플릿 비교 | TaskDefinition의 ContainerDefinitions 이미지 변경만 확인 |
| 배포 컨텍스트 | 빌드 결과·브라우저 보고서·캡처·테스트 fixture·로컬 검증 산출물 제외 |

검토한 cloud assembly를 그대로 배포했다.

```bash
cd infra
.venv/bin/cdk deploy StockMonitoringStack --app cdk.out \
  --require-approval never \
  --outputs-file ../.artifacts/router7-deploy/cdk-outputs.json
```

CloudFormation은 `2026-09-13 03:46:44 UTC`에 `UPDATE_COMPLETE`로 완료됐다. 변경 세트 실행부터 완료까지 약 182초, 이미지 빌드·게시를 포함한 CDK 실행은 약 208초였다. 네트워크·DB·권한 정의는 변경하지 않았다.

## 운영 확인

- ECS: 배포 `COMPLETED`, desired/running `1`, pending `0`.
- 새 애플리케이션 태스크 및 컨테이너: `RUNNING` / `HEALTHY`.
- `/api/health`: `ok`; Yahoo·RSS·Bedrock 제공원 상태 `ok`.
- 미국·한국 시세: 각 50종목.
- 종목 상세: 현재가−등락금액과 전일 종가 일치.
- 실제 AI 요청: `phase`·`delta`·정상 `final` 수신, 분석 본문 존재 확인.
- 운영 엔트리 `/assets/index-BIaEP-xg.js`: 로컬에서 검증한 Router 7 빌드와 일치.
- 운영 브라우저: 시장 화면·종목 차트·기사 입력 정상, 페이지 예외 및 자산 실패 없음.
- 모바일: 차트 크기 변경 처리 후 가로 넘침 없음.
- PWA 매니페스트 및 SPA fallback 정상.
- ALB 직접 접근: 차단 확인.

초기 기동에서는 Yahoo 조회 제한시간에 도달해 미국 43종목·한국 46종목이 제공됐고 `degraded`로 표시됐다. 이후 정기 갱신으로 각 50종목과 제공원 `ok` 상태가 복구됨을 확인했다. 초기 부분 응답을 정상 전체 응답으로 간주하지 않았다.

## 증거 및 후속 사용

상태·검증 로그·운영 캡처는 git에서 제외한 `.artifacts/router7-deploy/`에 보관했다.

- `cdk-deploy.log`, `resource-diff.json`, `cdk-outputs.json`
- `final-status.json`, `final-quotes.json`, `npm-audit.json`
- `frontend-tests.log`, `backend-tests.log`, `e2e.log`, `build.log`, `lint.log`
- `smoke.log`, `live-browser.json`, `live-desktop.png`, `live-stock-mobile.png`
- `rollback-task.json`: 이전 이미지 및 태스크 정의 식별 정보

설치형 PWA 또는 이미 열어 둔 탭은 앱의 업데이트 알림에서 “새로 고침”을 적용해야 새 앱 셸을 사용한다. 업데이트는 기존 prompt 방식으로 유지했다.
