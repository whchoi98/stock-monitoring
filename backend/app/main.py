"""
FastAPI 앱 팩토리 (B10 최소 구현) / FastAPI application factory (minimal B10 implementation).

B10은 라우터 등록과 `app.state.ctx` 주입까지만 담당한다. B12가 이 파일을 확장한다:
  - lifespan에서 `DynamoCache`로 L2 구성 (접근 실패 시 L2 없이 기동 + warning)
  - `scheduler.run_loops` 기동/종료
  - React 빌드 산출물 정적 서빙 + SPA 404 fallback
  - 모듈 레벨 `app = create_app()` (uvicorn `app.main:app` 진입점)
B10 only wires the routers and injects `app.state.ctx`; B12 extends this file with the lifespan
(DynamoCache-backed L2, warning-and-continue when the table is unreachable), the scheduler loops,
static serving of the React build with an SPA 404 fallback, and the module-level `app` object.

B11은 여기서 `ai.router`를 추가로 등록하면 된다 / B11 only needs to register `ai.router` below.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI

from app.api import ai, health, market, stocks
from app.cache.memory import MemoryCache
from app.cache.tiered import TieredCache
from app.state import AppState


class NullL2:
    """
    L2 없이 기동할 때 쓰는 no-op 계층 / No-op tier used when the app starts without an L2.

    TieredCache의 L2 프로토콜(get/get_stale/put)을 만족하며 항상 미스를 반환한다.
    B12가 lifespan에서 `DynamoCache`로 교체한다 (로컬 개발/테스트에서는 그대로 쓴다).
    Satisfies the TieredCache L2 protocol (get/get_stale/put) and always misses.
    B12 swaps in `DynamoCache` from the lifespan; local development and tests keep this one.
    """

    async def get(self, key: str) -> None:
        return None

    async def get_stale(self, key: str) -> None:
        return None

    async def put(self, key: str, value: Any, ttl: int, as_of: str) -> None:
        return None


def default_state() -> AppState:
    """L1만 있는 기본 컨텍스트 (외부 의존성 없음) / Default context with L1 only (no external dependency)."""
    return AppState(cache=TieredCache(MemoryCache(), NullL2()))


def create_app(state: Optional[AppState] = None) -> FastAPI:
    """
    라우터가 등록된 FastAPI 앱 생성 / Create the FastAPI app with the routers registered.

    Args:
        state: 주입할 앱 컨텍스트. 생략하면 L1 전용 기본 컨텍스트를 만든다.
            The app context to inject; a L1-only default is built when omitted.

    Returns:
        FastAPI 인스턴스 (`app.state.ctx`에 AppState가 들어있다) / A FastAPI instance carrying AppState on `app.state.ctx`.
    """
    app = FastAPI(title="Stock Monitoring API", version="0.1.0")
    app.state.ctx = state if state is not None else default_state()

    app.include_router(health.router)
    app.include_router(market.router)
    app.include_router(stocks.router)
    app.include_router(ai.router)
    return app
