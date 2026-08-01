# stock-monitoring 웹 서비스 설계 (Design Spec)

- 작성일: 2026-08-01
- 상태: 사용자 섹션별 승인 완료 (인프라/백엔드/프론트엔드/운영 4개 섹션)
- 기능 참조: `/home/ec2-user/my-project/stock-on-tui` (Textual 기반 Python TUI)
- UI 참조: Toss Invest (tossinvest.com) — 실측 스크린샷 및 디자인 토큰 확보

## 1. 개요

stock-on-tui의 기능 전체(대시보드, 종목 상세, 뉴스 AI 분석)를 Toss Invest 스타일의 웹 서비스로 포팅한다.
AWS에 CloudFront → Prefix SG → ALB → ECS Fargate 구조로 배포하며, 기존 `cc-on-bedrock-vpc`와
NAT Gateway를 재활용한다. 데이터는 Yahoo Finance(yfinance)를 단일 소스로 사용하고,
조회 결과를 DynamoDB에 저장해 재조회 시 재활용/빠른 응답을 보장한다.

## 2. 확정 결정 사항

| 항목 | 결정 | 비고 |
|---|---|---|
| 기능 범위 | 전체 포팅 (대시보드 + 종목 상세 + 뉴스 AI 분석) | Bedrock AI 포함 |
| 기술 스택 | React(Vite, TS) SPA + FastAPI 단일 컨테이너 | Python 데이터 로직 재사용 |
| 시세 갱신 | 클라이언트 폴링 (시세 45초 / 뉴스 120초) | 서버가 대표로 갱신, N명에게 서빙 |
| 접근 제어 | 공개 + AI 엔드포인트 rate limit | IP당 분당 3회 + 전역 동시 2건 + 결과 캐시 |
| 도메인 | 기본 CloudFront 도메인 (dxxxx.cloudfront.net) | ACM 인증서 불필요 |
| 데이터 계층 | 순수 Yahoo 단일화 (접근 1) | pykrx/Naver/페이지 스크래핑 제거 |
| 데이터 영속화 | DynamoDB 캐시 계층 (L2) | 사용자 명시 요구: 저장 후 재활용/빠른 응답 |
| VPC | 기존 `cc-on-bedrock-vpc` + 기존 NAT GW 재활용 | 신규 네트워크 리소스 생성 금지 |
| IaC | CDK Python 단일 스택 | 계정 CDK 부트스트랩 확인됨 |

## 3. 인프라 아키텍처

- 리전/계정: ap-northeast-2 / 061525506239
- VPC: `vpc-0dfa5610180dfa628` (10.100.0.0/16, CloudFormation 스택 CcOnBedrock-Network)

```
사용자 ──HTTPS──▶ CloudFront (기본 도메인, 기본 인증서)
                    │  /assets/* 장기 캐시 · /api/* 무캐시(origin Cache-Control)
                    │  압축 켬 · HTTPS redirect · X-Origin-Verify: <난수 시크릿> 헤더 주입
                    ▼  HTTP (origin protocol: HTTP_ONLY — ALB에 인증서 없음)
                 ALB (internet-facing)
                    │  Public Subnet ×2: subnet-08486a1e618b1991e (2a), subnet-0c161777c4031c320 (2b)
                    │  전용 SG: 인바운드 80 ← pl-22a6434b (CloudFront origin-facing prefix list)만
                    │  리스너 규칙: X-Origin-Verify 일치 → forward / 기본 액션 403 fixed-response
                    ▼
                 ECS Fargate (신규 클러스터 stock-monitoring)
                    │  Private Subnet ×2: subnet-07b1e65682847dce9 (2a), subnet-095297380cd45e1eb (2b)
                    │  서비스 1개 · 태스크 1개 · 0.5 vCPU / 1GB · 단일 컨테이너
                    │  아웃바운드: 기존 NAT GW ×2 (Yahoo/RSS), bedrock-runtime VPC 엔드포인트
                    └─ DynamoDB 테이블 stock-monitoring-cache (기존 Gateway 엔드포인트 경유)
```

### 3.1 보안

- **이중 오리진 방어**: Prefix SG("CloudFront 대역에서만") + 커스텀 헤더 검증("우리 배포에서만").
  같은 VPC의 vote2026 스택이 사용 중인 검증된 패턴. 헤더 검증은 ALB 리스너 규칙에서 수행해
  위조 트래픽이 컨테이너에 도달하기 전에 차단.
- 오리진 검증 시크릿은 Secrets Manager 저장, CloudFront 오리진 헤더와 ALB 리스너 규칙 양쪽에서 참조.
- CloudFront prefix list는 SG 규칙 슬롯 ~55개를 소비(기본 쿼터 60) → ALB 전용 SG로 분리 필수.
- Task Role 최소 권한: `bedrock:InvokeModel` + `stock-monitoring-cache` 테이블 한정
  `dynamodb:GetItem/PutItem/BatchGetItem/BatchWriteItem/Query`.

### 3.2 IaC

- CDK Python 단일 스택 `StockMonitoringStack`.
- VPC/서브넷/NATGW는 `Vpc.from_lookup(vpc_id="vpc-0dfa5610180dfa628")`으로 참조만 (생성 금지).
- 컨테이너 이미지는 `DockerImageAsset`으로 빌드·ECR 푸시.
- 공유 VPC이므로 리소스 이름 충돌 방지: `stock-monitoring` 프리픽스 일관 사용.

### 3.3 비용 (고정)

Fargate ~$18/월 + ALB ~$20/월 + DynamoDB on-demand <$1/월 + CloudFront/로그 소액
≈ **월 $40 내외** + Bedrock 호출량 과금. NATGW는 기존 공유(신규 시간당 요금 없음).

## 4. 데이터 계층 (Tiered Cache)

조회 흐름: `L1(인메모리) 히트 → 즉시 응답 / 미스 → L2(DynamoDB) → L1 적재 후 응답 / 미스 → Yahoo(yfinance) → L1+L2 기록 후 응답`

| 데이터 | 갱신 전략 | DynamoDB TTL | 효과 |
|---|---|---|---|
| 시세·지수·경제지표 | 백그라운드 45초 선제 갱신 → L1+L2 동시 기록 | 24시간 | 태스크 재시작 시 L2 웜스타트 |
| 차트 히스토리 (1W/1M/3M/1Y) | 최초 조회 시 fetch 후 저장 | 기간별 차등 (1W 10분 ~ 1Y 24시간) | 재조회 시 Yahoo 호출 없이 즉시 응답 |
| 펀더멘털 (PER/EPS/PBR 등) | 최초 조회 시 fetch 후 저장 | 12시간 | rate limit 회피 |
| 뉴스 (RSS) | 백그라운드 120초 갱신 | 24시간 | — |
| AI 분석 결과 | 생성 시 저장 | 6시간 | Bedrock 재호출 방지 (비용 방어) |

- 휴장 시간대(주말·야간)에는 갱신 주기를 10분으로 완화 → Yahoo 트래픽 최소화.
- DynamoDB: 파티션 키 `pk`(예: `quote#US`, `chart#005930.KS#1m`), 속성 `data`(JSON), `ttl`(epoch), `asOf`.
  on-demand 과금, TTL 자동 만료.

## 5. 백엔드 설계 (FastAPI)

### 5.1 모듈 구조

```
backend/app/
├── main.py                # FastAPI 생성, React 정적 서빙, lifespan에서 갱신 루프 기동
├── api/
│   ├── market.py          # 지수/경제지표/시세/시장요약/섹터/뉴스
│   ├── stocks.py          # 상세/차트/펀더멘털/호가/투자자동향/종목뉴스
│   ├── ai.py              # AI 분석 2종 (rate limit)
│   └── health.py          # ALB 헬스체크 + 소스별 상태
├── services/              # stock-on-tui services/ 이식 (yfinance 단일화)
│   ├── quotes.py          # us_stocks + kr_stocks 통합, KR은 .KS/.KQ 접미사
│   ├── indices.py         # ^GSPC ^IXIC ^DJI ^KS11 ^KQ11
│   ├── indicators.py      # 경제지표 11종 (WTI, Gold, USD/KRW, BTC 등)
│   ├── charts.py          # OHLCV + MA5/MA20 + 골든/데드크로스
│   ├── fundamentals.py    # yfinance Ticker.info (스크래핑 대체), 결측은 null
│   ├── news.py            # RSS 4종 + 종목별 RSS + 기사 본문 추출 (regex 3단계)
│   ├── bedrock.py         # Claude 종목/기사 분석 (TUI 이식, VPC 엔드포인트 경유)
│   └── simulation.py      # 호가창·투자자동향 시뮬레이션 (TUI 로직 유지)
├── cache/
│   ├── memory.py          # L1
│   ├── dynamo.py          # L2 (TTL 기록)
│   └── tiered.py          # L1→L2→Yahoo 오케스트레이션
└── core/
    ├── config.py          # US 50 + KR 50 유니버스(TUI config.py 이관), TTL, 모델 ID
    └── scheduler.py       # 45초/120초 백그라운드 루프, 장 시간 인지 (KST/DST)
```

### 5.2 API 계약

| 엔드포인트 | 응답 | 원천 |
|---|---|---|
| `GET /api/health` | 앱 생존 + 캐시 age + 소스별 상태 (yahoo/bedrock) | — |
| `GET /api/market/overview` | 지수 5종 + 지표 11종 + 시장요약(breadth/movers/거래량 Top3) + 섹터 등락 | L1 |
| `GET /api/market/quotes?market=us\|kr` | 50종목 테이블 | L1 |
| `GET /api/market/news` | 뉴스 피드 | L1 |
| `GET /api/stocks/{symbol}` | 상세 헤더 + 핵심지표 6종 + 52주 범위 + 기간수익률 | 계층 캐시 |
| `GET /api/stocks/{symbol}/chart?period=1w\|1m\|3m\|1y` | OHLCV + MA + 크로스 신호 | 계층 캐시 |
| `GET /api/stocks/{symbol}/news` | 종목 뉴스 최대 8건 | 계층 캐시 |
| `GET /api/stocks/{symbol}/orderbook` | 호가 10단계, `simulated: true` 명시 | 시뮬레이션 |
| `GET /api/stocks/{symbol}/investors` | 수급 10일, `simulated: true` 명시 | 시뮬레이션 |
| `POST /api/ai/stocks/{symbol}` | AI 종목 분석 (한국어) | Bedrock + 6h 캐시 |
| `POST /api/ai/articles` | 기사 요약/번역/인사이트 | Bedrock + 6h 캐시 |

- 모든 시세 응답에 `asOf`(데이터 시각) + `marketOpen`(장중 여부) 포함.
- `{symbol}` 형식은 yfinance 티커로 통일: US는 `AAPL`, KR은 `005930.KS`/`247540.KQ`.
  URL/캐시 키/프론트 라우트 전부 동일 형식 사용.
- AI rate limit: CloudFront `X-Forwarded-For` 첫 IP 기준 분당 3회 + 전역 동시 2건, 초과 시 429.
- 단일 uvicorn 워커 (L1 일관성, asyncio 동시성).

### 5.3 데이터 소스 변경 (TUI 대비)

| TUI 소스 | 웹 서비스 | 사유 |
|---|---|---|
| yfinance | 유지 (전 영역으로 확대) | 기본 방침 |
| pykrx (KR 시세/히스토리) | 제거 → yfinance `.KS`/`.KQ` | 단일화 |
| Naver Finance 스크래핑 (KR 시총/PER/EPS/PBR) | 제거 → yfinance `Ticker.info`, 결측 시 null → UI `—` | 스크래핑 취약성 제거 |
| Yahoo quote 페이지 스크래핑 (US 펀더멘털) | 제거 → yfinance + L2 캐시로 rate limit 대응 | 〃 |
| RSS 4종 + 종목 RSS | 유지 | — |
| Bedrock (Claude) | 유지, 모델 ID는 env 설정 (TUI와 동일 모델) | — |

## 6. 프론트엔드 / UI (React + Toss 스타일)

### 6.1 디자인 토큰 (Toss Invest 실측)

| 토큰 | 다크 (기본) | 라이트 (토글) |
|---|---|---|
| 배경 / 카드 | `#101013` / `#17171C` (radius 16px) | `#F4F5F8` / `#FBFCFD` |
| 상승 / 하락 | `#F5445A` / `#4391FF` | `#DE2B39` / `#2272EB` |
| 액센트 | `#3485FA` | `#3182F6` |
| 본문 / 강조 | `#C3C3C6` / `#FFFFFF` | `#4E5968` / `#191F28` |
| 폰트 | Pretendard → Noto Sans KR 폴백 (Toss Product Sans는 상용 비공개) | 〃 |

실측 스크린샷: 세션 스크래치패드 `toss-ui/` 3장 (다크/라이트/홈). 참고용이며 저장소에는 미포함.

### 6.2 페이지 구성

- **① 대시보드 `/`**: 지수 카드 5장 → 시장요약 + 섹터 등락 카드 → US 50/KR 50 탭 테이블
  (행 클릭 → 상세) → 우측 뉴스 사이드바 → 하단 고정 경제지표 티커 바 (Toss 문법).
- **② 종목 상세 `/stocks/{symbol}`**: Toss형 종목 헤더(현재가 크게 + "어제보다 +N원 (N%)" +
  1일/52주 미니 게이지) + 위젯 카드 그리드: 차트(캔들+MA5/20+크로스 마커+거래량, 기간 탭) ·
  호가(시뮬레이션 뱃지) · 개인·외국인·기관(시뮬레이션 뱃지) · 핵심지표 6종 · 기간수익률 ·
  종목 뉴스 · AI 분석 패널(버튼 클릭 생성, 마크다운 렌더).
- **③ 기사 AI 분석 `/articles?url=<기사URL>&title=<제목>`**: 뉴스 항목 클릭 시 쿼리 파라미터로
  진입(새로고침/링크 공유 가능). 진행 단계([1/2] 수집 → [2/2] 분석) 후 요약/번역/인사이트 렌더.

### 6.3 기술

- Vite + React + TypeScript, react-router.
- TanStack Query: 폴링(45초/120초) + 백그라운드 탭 자동 중단 + 재시도.
- 차트: lightweight-charts (캔들/MA/거래량 네이티브 지원).
- 숫자 포맷: KR 억/조, US K/M/B/T (TUI 로직 이관). 등락 화살표/색상 규칙 공통 유틸.
- 반응형: 데스크톱 그리드 → 모바일 1열 스택.

## 7. 에러 처리 — "조용한 실패 없음"

| 실패 지점 | 동작 |
|---|---|
| Yahoo 갱신 실패 | stale-while-error: 마지막 정상 데이터 서빙 + `asOf` 노출("N분 전 기준" 뱃지). 지수 백오프(5/10/15초). L2 데이터로 폴백 |
| Bedrock 실패/미권한 | graceful degradation: AI 패널에 안내 문구, 나머지 정상. 스로틀 시 재시도 안내 |
| RSS/본문 추출 실패 | 항목 단위 스킵, 부분 응답 |
| 프론트 API 에러 | 위젯 카드 단위 에러 + 재시도 버튼, ErrorBoundary로 전체 붕괴 방지 |
| 관측성 | 구조화 JSON 로그(CloudWatch) + `/api/health`에 소스별 상태. ALB 헬스체크는 앱 생존만 판정(외부 의존성 제외) |

## 8. 테스트

- **백엔드 (pytest)**: 서비스 단위(yfinance mock — 파싱/MA/크로스/포맷), 계층 캐시(L1/L2/fetch
  순서·TTL, moto로 DynamoDB mock), API 계약(TestClient — 스키마/`simulated`/429), 장시간 판정(KST/DST 경계).
- **프론트 (vitest)**: 숫자 포맷/등락색 등 순수 로직 위주.
- **배포 후 스모크**: `/api/health` 200 + 대시보드 데이터 로드 스크립트.

## 9. 배포 / 운영

- 멀티스테이지 Dockerfile: node(React 빌드) → python:3.12-slim(FastAPI + 정적 산출물).
- `cdk deploy` 일괄 (빌드→ECR→롤링 업데이트). 롤백은 이전 이미지.
- 로컬 개발: `uvicorn --reload` + `vite dev` (API 프록시).
- CloudWatch Logs 보존 2주. 알람 2개: ALB 5xx 급증, ECS 실행 태스크 0.

## 10. 범위 제외 (Out of Scope)

- CI/CD 파이프라인 (로컬 `cdk deploy`로 시작)
- 사용자 로그인/계정 (Cognito), 커스텀 도메인
- 실제 호가·수급 데이터 연동 (KRX Open API 승인 후 별도 작업 — 현재 키는 유효하나 API 미승인)
- 멀티 태스크 수평 확장 (필요 시 접근 3 방향으로 확장 여지 확보됨)
- Toss의 주문/커뮤니티/관심종목 등 계정 기반 기능

## 11. 참고

- stock-on-tui 상세 분석: 대시보드 4-Wave 로딩, 화면 3종, 데이터 소스 7종 — 탐색 워크플로 결과
  (세션 기록 `wf_2a296be9-9be`)
- KRX Open API 키: 등록 유효, 전 API "Unauthorized API Call" (2026-08-01 기준) — 승인 후 활용 가능
- 기존 VPC의 CloudFront→ALB 커스텀 헤더 패턴 선례: vote2026 배포 (E2CRZL8M8GL7AQ)
