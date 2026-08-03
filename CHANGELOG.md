# Changelog

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-02

First production release.

### Added
- Add market dashboard with indices, market summary, sector performance, stock table, news feed, and rolling ticker
- Add stock detail page with candlestick chart (moving averages, cross signals, volume), fundamentals, and simulated orderbook/investor widgets
- Add AI stock analysis powered by Amazon Bedrock, with per-IP rate limiting and result caching
- Add RSS news feed and article AI analysis page with article body extraction
- Add tiered cache (in-memory L1, DynamoDB L2 with TTL) with stale fallback and per-key single-flight locking
- Add AWS CDK stack provisioning CloudFront, ALB, ECS Fargate, and the DynamoDB cache table, reusing the existing VPC
- Add post-deploy smoke test script verifying CloudFront routes and confirming direct ALB access is blocked

### Fixed
- Fix dividend yield interpretation to percent scale instead of a raw fraction
- Fix Bedrock invocation in ap-northeast-2 by using the `global.` inference profile model-ID prefix

### Security
- Key the AI rate limit on the CloudFront-Viewer-Address header instead of the forgeable X-Forwarded-For
- Guard article fetching against SSRF and cap streamed response bodies at 256KB
- Bound backtracking in article-extraction regexes to prevent quadratic-time denial of service

[Unreleased]: https://github.com/whchoi98/stock-monitoring/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/stock-monitoring/releases/tag/v0.1.0

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

## [0.1.0] - 2026-08-02

첫 프로덕션 릴리스입니다.

### Added
- 지수, 시장 요약, 섹터 등락, 종목 테이블, 뉴스 피드, 롤링 티커를 포함한 시장 대시보드 추가
- 캔들스틱 차트(이동평균, 크로스 시그널, 거래량), 재무지표, 모의 호가/투자자 위젯을 갖춘 종목 상세 페이지 추가
- IP별 레이트리밋과 결과 캐시를 포함한 Amazon Bedrock 기반 AI 종목 분석 추가
- RSS 뉴스 피드 및 기사 본문 추출 기반 기사 AI 분석 페이지 추가
- 계층형 캐시(인메모리 L1, TTL 적용 DynamoDB L2) 추가 — stale fallback 및 키별 single-flight 락 포함
- 기존 VPC를 재활용하여 CloudFront, ALB, ECS Fargate, DynamoDB 캐시 테이블을 프로비저닝하는 AWS CDK 스택 추가
- CloudFront 경유 라우트 검증 및 ALB 직접 접근 차단을 확인하는 배포 후 스모크 테스트 스크립트 추가

### Fixed
- dividend yield 값을 raw fraction이 아닌 percent 스케일로 해석하도록 수정
- ap-northeast-2에서 `global.` inference profile 모델 ID 프리픽스를 사용하도록 Bedrock 호출 수정

### Security
- AI 레이트리밋 키를 위조 가능한 X-Forwarded-For 대신 CloudFront-Viewer-Address 헤더로 변경
- 기사 본문 수집에 SSRF 가드 적용 및 스트리밍 응답 본문 256KB 캡 설정
- 기사 추출 regex의 백트래킹 상한 설정으로 quadratic-time 서비스 거부 공격 차단

[Unreleased]: https://github.com/whchoi98/stock-monitoring/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/whchoi98/stock-monitoring/releases/tag/v0.1.0
