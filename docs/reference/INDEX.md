# Implementation References Index / 구현 레퍼런스 색인

Per-layer implementation reference docs for stock-monitoring. Each doc is bilingual (English / 한국어) and follows the same structure: Overview → Components → Key Decisions → Code Pointers → Cross-references.
stock-monitoring의 계층별 구현 레퍼런스 문서. 모든 문서는 영어/한국어 병기이며 동일한 구조(개요 → 구성요소 → 주요 결정 → 코드 포인터 → 상호 참조)를 따른다.

<!-- AUTO-MANAGED:references -->
| Layer | Doc | Scope / 범위 |
|---|---|---|
| Infrastructure | [infrastructure.md](infrastructure.md) | CloudFront → ALB → Fargate(ARM64) 런타임 토폴로지, Dockerfile, CloudWatch 알람, 스모크 테스트 |
| Data | [data.md](data.md) | L1(메모리) + L2(DynamoDB) 계층 캐시, single-flight 락, TTL 표, 가격 오버레이, 스케줄러 선제 갱신 |
| API | [api.md](api.md) | FastAPI 라우트 전체, envelope 규약, AI 라우트의 SSE 구조(phase/delta/final·하트비트·선점자/팔로워), 심볼 유니버스 검증, 고정 오류 문구, SPA 서빙 |
| IaC | [iac.md](iac.md) | CDK v2 단일 스택, VPC lookup pin, 오리진 시크릿, origin request policy, 최소 권한 IAM |
| Frontend | [frontend.md](frontend.md) | React 19 SPA 구조, TanStack Query 훅·폴링 상수, AI 스트리밍 훅과 SSE 프로토콜 소비(자유 질의 포함), 한글·초성 종목 검색, 브라우저 전용 사용자 상태(관심 종목·알림·패널 접힘 스토어), 차트 지표 계산, PWA 서비스 워커 범위(앱 셸만), ApiError 분기, 빌드/배포 경로 |
| UI | [ui.md](ui.md) | 터미널 디자인 언어(ADR-001): 패널 그리드·마켓 스트립·상태 바, 디자인 토큰(tokens.css), 다크/라이트 테마, 상승=빨강/하락=파랑 한국 관례, 앰버 액센트, Pretendard + JetBrains Mono |
| Security | [security.md](security.md) | 오리진 검증, AI 레이트리밋 키(CloudFront-Viewer-Address), SSRF 가드, 태그 regex 선형성 가드, defusedxml |
| Agent · LLM | [agent-llm.md](agent-llm.md) | Bedrock 모델 선택 근거(global. 프로파일), 3중 비용 방어, AI 캐시 키, 프롬프트 입력·상한 |
<!-- /AUTO-MANAGED:references -->

> 문서 추가/삭제 시 이 표와 루트 `CLAUDE.md`의 Implementation References 블록을 함께 재생성한다.
> When a doc is added or removed, regenerate this table together with the Implementation References block in the root `CLAUDE.md`.
