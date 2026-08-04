# Runbook: Purge a Poisoned Quotes Cache

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#한국어"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="한국어"></a>

---

<a id="english"></a>

# English

## Overview

Recover from a stock table that renders blank while the rest of the dashboard looks healthy. The cause
is a *fresh empty* cache entry: an empty quote list was stored as a success, and because it is fresh
(24h TTL) neither the stale-while-error fallback nor a normal request can displace it. This runbook
purges the poisoned L2 (DynamoDB) items and verifies recovery.

## When to Use

- The US or KR stock table is blank in the UI while indices, indicators and news render fine.
- `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>` fails check 3 with `rows: 0`.
- `curl -fsS "<CloudFrontURL>/api/market/quotes?market=us"` returns HTTP 200 with `"data": []`.
- `/api/health` reports `sources.yahoo` as `degraded` and the `quotes:*` entry in `cacheAge` stops
  resetting every cycle — it either climbs toward 24 hours or **disappears entirely**. Both shapes mean
  the same thing: the scheduler is not completing cycles. `cacheAge` reads **L1 only** (health answers
  without touching DynamoDB) and L1 is per-task memory, so a task replaced during the outage starts
  with no `quotes:*` entry and a failing scheduler never writes one. A missing key is therefore not
  evidence of health, and the authoritative staleness signal is the `asOf` in the quotes response.

### Cause chain (2026-08-04 live incident)

1. Yahoo answered the parallel chunk burst (10 symbols × 5 workers) with all-empty frames. The
   trigger was **concurrency**, not batch size — with `threads=False` a "50-symbol batch" is already
   50 sequential HTTP requests.
2. `fetch_quotes` returned `[]`, which the caller could not distinguish from "the market has no
   symbols", so it counted as a success.
3. `deps.cached` / the scheduler's `cache.put` wrote `[]` into L1 and L2 with `L2_TTL` = 24h.
4. The stale-while-error fallback only fires on an **exception**. A fresh empty item is served as
   valid data for up to 24 hours, so the table stays blank even after Yahoo recovers.
5. Only an unconditional `cache.put` (a successful scheduler cycle) or a manual purge can replace the
   item — and while Yahoo kept throttling, the scheduler kept failing.

The fix (`backend/app/services/market_data.py`) now raises `QuotesUnavailableError` when a market is
all-empty or its coverage is below `QUOTE_MIN_COVERAGE`, so a new poisoned entry cannot be written.
This runbook still applies to items written **before** that fix and to any future path that manages to
cache an empty list.

## Prerequisites

- [ ] AWS credentials for `ap-northeast-2` with `dynamodb:GetItem` / `dynamodb:DeleteItem` on
      `stock-monitoring-cache`, and `ecs:UpdateService` on the `stock-monitoring` service.
- [ ] `CloudFrontURL` and `AlbDNS` from the CDK stack outputs
      (`cd infra && .venv/bin/cdk deploy` prints them; `aws cloudformation describe-stacks` also works).

## Procedure

### 1. Confirm the Symptom

```bash
curl -fsS --max-time 60 "<CloudFrontURL>/api/market/quotes?market=us" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('rows:',len(d['data']),'asOf:',d['asOf'])"
curl -fsS --max-time 30 "<CloudFrontURL>/api/health" | python3 -m json.tool
```

`rows: 0` with an `asOf` that is hours old confirms a poisoned entry. If `rows` is greater than zero,
stop — the blank table is a frontend problem, not this one.

### 2. Inspect the Poisoned Items

The cache table's key schema is a single partition key `pk` (string); the value lives in `data` as a
JSON string, with `ttl` (epoch seconds) and `asOf` alongside it — see `backend/app/cache/dynamo.py`.

```bash
aws dynamodb get-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache \
  --key '{"pk":{"S":"quotes:us"}}'
```

`"data": {"S": "[]"}` plus a `ttl` far in the future is the poisoned shape.

### 3. Purge the Poisoned Items

```bash
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"quotes:us"}}'
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"quotes:kr"}}'
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"overview"}}'
```

`overview` is included because its `summary` / `sectors` blocks are computed from the quote lists, so
it carries the same emptiness.

### 4. Clear L1 If the Task Still Serves Empty

L1 is in-memory inside the single Fargate task and holds the same empty value with a 24h TTL, so
purging DynamoDB alone does not fix the running task. The scheduler's `cache.put` overwrites L1
unconditionally, so one successful cycle (45s while a market is open, 600s when closed) is enough.
Only if the response is still empty after two cycles, replace the task:

```bash
aws ecs update-service --region ap-northeast-2 \
  --cluster stock-monitoring --service stock-monitoring --force-new-deployment
aws ecs wait services-stable --region ap-northeast-2 \
  --cluster stock-monitoring --services stock-monitoring
```

## Verification

- [ ] `curl -fsS "<CloudFrontURL>/api/market/quotes?market=us"` returns a non-empty `data` array.
- [ ] Same for `?market=kr`.
- [ ] `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>` passes all 5 checks (check 3 prints `rows: 50`).
- [ ] `/api/health` shows `sources.yahoo` = `ok` and the `quotes:*` ages reset every cycle.
- [ ] The UI stock table renders rows for both markets.

## Rollback

None needed and nothing to undo: the cache holds derived data only, and a deleted item is re-fetched
from Yahoo on the next request or scheduler cycle. There is no point of no return.

If Yahoo itself is down, the purge cannot help: with no cached value at all the quotes route answers
`503 {"detail": "data unavailable: quotes:us"}` instead of a blank table. That is the intended
behaviour — wait for upstream and let the scheduler repopulate the cache.

## Notes

- Last verified: 2026-08-04 (during the live incident of the same date).
- Timing: the purge itself is seconds; recovery is bounded by the scheduler cycle (45s open / 600s
  closed). A forced ECS deployment adds ~3-4 minutes.
- Related: `scripts/smoke.sh` check 3 (the detector), `backend/app/services/market_data.py`
  (`QUOTE_MIN_COVERAGE`, `QuotesUnavailableError`), `backend/app/core/scheduler.py` (`refresh_market`,
  per-market isolation), `backend/app/cache/dynamo.py` (item schema).
- Related alarms: none. `stock-monitoring-alb-5xx` does **not** fire for this incident, because a
  poisoned cache answers 200 with an empty array. Check 3 of the smoke test is the detector.

---

<a id="한국어"></a>

# 한국어

## 개요

대시보드의 나머지는 정상인데 종목 테이블만 빈 화면일 때 복구하는 절차. 원인은 *신선한 빈* 캐시
항목이다: 빈 시세 리스트가 성공으로 저장됐고, 신선하기 때문에(TTL 24시간) stale-while-error 폴백도
일반 요청도 이를 밀어낼 수 없다. 이 런북은 오염된 L2(DynamoDB) 항목을 지우고 복구를 검증한다.

## 사용 시점

- UI에서 US 또는 KR 종목 테이블만 비어 있고 지수·지표·뉴스는 정상 렌더링될 때.
- `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>`의 검사 3이 `rows: 0`으로 실패할 때.
- `curl -fsS "<CloudFrontURL>/api/market/quotes?market=us"`가 HTTP 200 + `"data": []`를 반환할 때.
- `/api/health`의 `sources.yahoo`가 `degraded`이고 `cacheAge`의 `quotes:*`가 매 사이클 리셋되지 않을 때
  — 24시간을 향해 계속 늘어나거나 **아예 사라진다**. 두 모양의 뜻은 같다: 스케줄러가 사이클을 완주하지
  못하고 있다. `cacheAge`는 **L1만** 읽고(헬스는 DynamoDB를 건드리지 않는다) L1은 태스크별 인메모리라,
  장애 중에 태스크가 교체되면 `quotes:*` 항목이 없는 상태로 시작하고 실패하는 스케줄러는 그것을 채우지
  못한다. 따라서 키가 없다는 것은 정상의 증거가 아니며, 신선도의 최종 근거는 시세 응답의 `asOf`다.

### 원인 연쇄 (2026-08-04 라이브 장애)

1. Yahoo가 병렬 청크 버스트(10심볼 × 5워커)를 심볼 전부 빈 프레임으로 응답했다. 방아쇠는 배치
   크기가 아니라 **동시성**이었다 — `threads=False`에서 "50심볼 배치"는 이미 순차 HTTP 요청 50건이다.
2. `fetch_quotes`가 `[]`를 반환했고, 호출부는 이것을 "심볼이 없는 시장"과 구분할 수 없어 성공으로
   처리했다.
3. `deps.cached` / 스케줄러의 `cache.put`이 `[]`를 `L2_TTL`(24시간)로 L1·L2에 썼다.
4. stale-while-error 폴백은 **예외**에만 발동한다. 신선한 빈 항목은 최대 24시간 동안 정상 데이터로
   서빙되므로 Yahoo가 회복된 뒤에도 테이블은 계속 비어 있다.
5. 이 항목을 교체할 수 있는 건 무조건 실행되는 `cache.put`(성공한 스케줄러 사이클) 또는 수동 삭제뿐
   이지만, Yahoo가 계속 스로틀하는 동안 스케줄러도 계속 실패했다.

수정 후(`backend/app/services/market_data.py`)에는 시장 전체가 비거나 커버리지가
`QUOTE_MIN_COVERAGE` 미달이면 `QuotesUnavailableError`를 던지므로 새로 오염된 항목이 쓰이지 않는다.
이 런북은 그 수정 **이전**에 쓰인 항목, 그리고 앞으로 빈 리스트를 캐시하게 되는 경로에 여전히
적용된다.

## 사전 요구 사항

- [ ] `stock-monitoring-cache`에 `dynamodb:GetItem` / `dynamodb:DeleteItem`, `stock-monitoring`
      서비스에 `ecs:UpdateService` 권한이 있는 `ap-northeast-2` AWS 자격 증명.
- [ ] CDK 스택 Outputs의 `CloudFrontURL`, `AlbDNS`
      (`cd infra && .venv/bin/cdk deploy`가 출력하며 `aws cloudformation describe-stacks`로도 확인 가능).

## 절차

### 1. 증상 확인

```bash
curl -fsS --max-time 60 "<CloudFrontURL>/api/market/quotes?market=us" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('rows:',len(d['data']),'asOf:',d['asOf'])"
curl -fsS --max-time 30 "<CloudFrontURL>/api/health" | python3 -m json.tool
```

`rows: 0`이고 `asOf`가 몇 시간 전이면 오염된 항목이다. `rows`가 0이 아니면 여기서 중단한다 — 빈
테이블은 이 런북이 아니라 프론트엔드 문제다.

### 2. 오염된 항목 확인

캐시 테이블의 키 스키마는 파티션 키 `pk`(문자열) 하나이고, 값은 `data`에 JSON 문자열로,
`ttl`(epoch 초)과 `asOf`가 함께 저장된다 — `backend/app/cache/dynamo.py` 참조.

```bash
aws dynamodb get-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache \
  --key '{"pk":{"S":"quotes:us"}}'
```

`"data": {"S": "[]"}` + 한참 뒤의 `ttl`이 오염된 형태다.

### 3. 오염된 항목 삭제

```bash
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"quotes:us"}}'
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"quotes:kr"}}'
aws dynamodb delete-item --region ap-northeast-2 \
  --table-name stock-monitoring-cache --key '{"pk":{"S":"overview"}}'
```

`overview`도 지우는 이유는 `summary` / `sectors` 블록이 시세 리스트에서 계산되므로 같은 공백을
그대로 담고 있기 때문이다.

### 4. 태스크가 계속 빈 값을 서빙하면 L1도 비운다

L1은 단일 Fargate 태스크의 인메모리 캐시이고 같은 빈 값을 24시간 TTL로 갖고 있어서, DynamoDB만
지워도 실행 중인 태스크는 낫지 않는다. 스케줄러의 `cache.put`이 L1을 무조건 덮어쓰므로 성공한
사이클 1회(장중 45초, 휴장 600초)면 충분하다. 두 사이클이 지나도 여전히 비어 있을 때만 태스크를
교체한다:

```bash
aws ecs update-service --region ap-northeast-2 \
  --cluster stock-monitoring --service stock-monitoring --force-new-deployment
aws ecs wait services-stable --region ap-northeast-2 \
  --cluster stock-monitoring --services stock-monitoring
```

## 검증

- [ ] `curl -fsS "<CloudFrontURL>/api/market/quotes?market=us"`가 비어 있지 않은 `data` 배열 반환.
- [ ] `?market=kr`도 동일.
- [ ] `bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>` 5개 검사 전부 통과 (검사 3이 `rows: 50` 출력).
- [ ] `/api/health`의 `sources.yahoo`가 `ok`이고 `quotes:*` age가 매 사이클 리셋됨.
- [ ] UI 종목 테이블이 두 시장 모두 행을 렌더링.

## 롤백

필요 없고 되돌릴 것도 없다: 캐시는 파생 데이터만 담고, 삭제된 항목은 다음 요청이나 스케줄러
사이클에서 Yahoo로부터 다시 채워진다. 되돌릴 수 없는 지점은 없다.

Yahoo 자체가 죽어 있으면 삭제로는 해결되지 않는다. 캐시에 값이 아예 없으면 시세 라우트는 빈
테이블이 아니라 `503 {"detail": "data unavailable: quotes:us"}`를 반환한다 — 이것이 의도된 동작이며,
업스트림 회복을 기다리면 스케줄러가 캐시를 다시 채운다.

## 참고

- 최종 검증일: 2026-08-04 (같은 날 라이브 장애 대응 중).
- 소요 시간: 삭제 자체는 수 초, 복구는 스케줄러 사이클(장중 45초 / 휴장 600초)에 의해 결정된다.
  ECS 강제 재배포를 하면 ~3-4분 추가.
- 관련: `scripts/smoke.sh` 검사 3(탐지기), `backend/app/services/market_data.py`
  (`QUOTE_MIN_COVERAGE`, `QuotesUnavailableError`), `backend/app/core/scheduler.py`(`refresh_market`,
  시장별 격리), `backend/app/cache/dynamo.py`(항목 스키마).
- 관련 알람: 없음. 오염된 캐시는 200 + 빈 배열로 응답하므로 `stock-monitoring-alb-5xx`는 **발동하지
  않는다**. 스모크 테스트의 검사 3이 탐지기다.
