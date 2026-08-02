"""
헬스 라우트 - ALB 생존 판정 전용. 항상 200이며 외부 의존성을 호출하지 않는다.
Health route - liveness only. Always 200, and it never calls an external dependency.

소스별 상태(yahoo/rss/bedrock)와 선제 갱신 캐시의 age를 함께 보고해 조용한 실패를 드러낸다.
It reports per-source status (yahoo/rss/bedrock) and the age of the pre-warmed cache entries,
so a silent failure is visible from outside.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Request

from app.api import deps
from app.state import AppState

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["health"])


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _age_seconds(as_of: str, now: datetime) -> int:
    """asOf ISO8601 문자열의 경과 초 / Elapsed seconds for an asOf ISO8601 string."""
    stamp = datetime.fromisoformat(as_of)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return max(0, int((now - stamp).total_seconds()))


def cache_age(state: Optional[AppState]) -> dict:
    """
    선제 갱신 키의 캐시 age(초) / Age in seconds of the pre-warmed cache keys.

    L1만 조회한다: 헬스는 외부 호출(L2/DynamoDB) 없이 답해야 한다. 아직 채워지지 않은 키는 빠진다.
    L1 only: health must answer without any external call (L2/DynamoDB). Keys not yet warm are absent.
    """
    ages: dict = {}
    if state is None:
        return ages

    now = datetime.now(timezone.utc)
    for key in deps.PREWARMED_KEYS:
        try:
            entry = state.cache.l1.get(key)
            if entry is None:
                continue
            _value, as_of = entry
            ages[key] = _age_seconds(as_of, now)
        except Exception as exc:
            # age 계산 실패가 헬스체크를 깨뜨리면 안 된다 / A bad timestamp must not break liveness
            _warn("health_cache_age_failed", key=key, error=str(exc))
    return ages


@router.get("/health")
async def get_health(request: Request) -> dict:
    """
    앱 생존 + 소스 상태 + 캐시 age / Liveness plus source status and cache age.

    항상 200을 반환한다 (ALB 헬스체크는 외부 의존성 상태로 인스턴스를 죽이지 않는다).
    Always answers 200: the ALB health check must not kill an instance over an external dependency.
    """
    state = getattr(request.app.state, "ctx", None)
    if state is None:
        # 컨텍스트 미초기화는 구성 오류다: 200은 유지하되 로그로 드러낸다
        # A missing context is a configuration bug: keep the 200 but make it visible in the logs
        _warn("app_state_missing", path=request.url.path)

    return {
        "status": "ok",
        "sources": dict(state.source_status) if state is not None else {},
        "cacheAge": cache_age(state),
    }
