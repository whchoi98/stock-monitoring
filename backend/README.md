# stock-monitoring backend

FastAPI 백엔드 (Python 3.9). 시세/뉴스/AI 분석 API + frontend 빌드 산출물 정적 서빙.
FastAPI backend (Python 3.9): market/news/AI endpoints plus static serving of the frontend build.

## 로컬 실행 / Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # 1. 의존성 / dependencies
.venv/bin/python -m pytest -q                                            # 2. 테스트 / tests
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000                # 3. 기동 / serve (워커 1개 / one worker)
curl -s localhost:8000/api/health | python3 -m json.tool                 # 4. 헬스 / health
curl -s "localhost:8000/api/market/overview" | head -c 400               # 5. 시세 / market data
```

**워커는 1개만 (uvicorn 기본값) / Exactly one worker (uvicorn's default):** L1 메모리 캐시와 AI 전역
동시 실행 세마포어가 프로세스 단위라, 워커를 늘리면 캐시가 갈라지고 Bedrock 동시 호출 상한이 워커 수만큼
곱해진다. 확장은 워커가 아니라 컨테이너(태스크) 수로 한다.
The L1 cache and the AI global concurrency semaphore are per-process, so extra workers would split the
cache and multiply the Bedrock concurrency cap; scale with containers, not workers.

## 환경변수 / Environment

| 변수 / Variable | 기본값 / Default | 설명 / Notes |
| --- | --- | --- |
| `CACHE_TABLE` | `stock-monitoring-cache` | L2 DynamoDB 테이블. 접근 불가면 경고만 남기고 L1만으로 기동한다 / unreachable table only warns; the app starts with L1 only |
| `AWS_REGION` | `ap-northeast-2` | DynamoDB 리전 / DynamoDB region |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | AI 분석 모델 / AI analysis model |
| `BEDROCK_REGION` | `ap-northeast-2` | Bedrock 리전 / Bedrock region |
| `STATIC_DIR` | `backend/static` | frontend 빌드 산출물. 없으면 정적 서빙을 건너뛴다 / skipped when absent |

기동 직후 백그라운드 스케줄러가 `quotes:us` / `quotes:kr` / `overview`(장중 45초, 휴장 600초)와
`news:feed`(120초 / 600초)를 갱신한다. 첫 사이클 전의 요청은 요청 시점에 직접 조회하므로 느릴 수 있다.
A background scheduler refreshes `quotes:us` / `quotes:kr` / `overview` (45s open, 600s closed) and
`news:feed` (120s / 600s); requests before the first cycle fetch inline and may be slow.

frontend 정적 서빙은 `make build`(리포지토리 루트)로 `backend/static/`을 만든 뒤 활성화된다.
Static serving turns on once `make build` (repository root) has produced `backend/static/`.
