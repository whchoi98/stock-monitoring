"""
FastAPI 앱 팩토리 - 라우터 등록, lifespan(L2 + 스케줄러), SPA 정적 서빙.
FastAPI application factory - router registration, lifespan (L2 + scheduler), SPA static serving.

기동 순서(lifespan): ① `DynamoCache`로 L2 교체 (테이블 접근 실패 시 L2 없이 계속 - 로컬 개발 배려)
→ ② `scheduler.run_loops` 백그라운드 태스크 기동. 종료 시 stop 이벤트로 루프를 깨워 정리한다.
Startup order (lifespan): (1) swap L2 for `DynamoCache` (continue without L2 when the table is
unreachable - local development), (2) start `scheduler.run_loops` as a background task. Shutdown wakes
the loops through the stop event.

uvicorn 진입점은 모듈 레벨 `app`이다 (`uvicorn app.main:app`). 워커는 1개만 띄운다:
L1 캐시와 AI 전역 세마포어가 프로세스 단위라 워커가 늘면 캐시가 갈라지고 동시 실행 상한이 깨진다.
The uvicorn entry point is the module-level `app` (`uvicorn app.main:app`). Run exactly one worker:
the L1 cache and the AI global semaphore are per-process, so extra workers would split the cache and
multiply the concurrency cap.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import ai, health, market, stocks
from app.cache.dynamo import DynamoCache
from app.cache.memory import MemoryCache
from app.cache.tiered import TieredCache
from app.core import config, scheduler
from app.state import AppState

logger = logging.getLogger(__name__)

# frontend 빌드 산출물 위치 (`vite build --outDir ../backend/static`) / Location of the frontend build
BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_STATIC_DIR = BACKEND_DIR / "static"

# L2 도달 확인용 프로브 키 (존재하지 않아도 된다 - 응답만 오면 성공) / Probe key for the L2 reachability check
L2_PROBE_KEY = "__l2_probe__"

# 종료 시 스케줄러 태스크를 기다리는 상한(초) / Grace period for the scheduler task on shutdown
SHUTDOWN_TIMEOUT_SEC = 5

# SPA fallback 대상 메서드 / Methods eligible for the SPA fallback
SPA_METHODS = frozenset({"GET", "HEAD"})

# 자산 경로는 SPA fallback 대상이 아니다 (없으면 진짜 404) — 워커·CDN 캐시가 HTML을 자산으로 담는 일을 막는다.
# Asset paths are never SPA-fallback targets (a missing one is a real 404), so no worker or CDN cache can store HTML as an asset.
ASSET_PREFIXES = ("/assets/", "/icons/")
# 루트 파일의 확장자 — 루트 SPA 라우트(`/`, `/articles`, `/stocks/...`)에는 확장자가 없다 / Root-file suffixes; root SPA routes carry none
ROOT_FILE_SUFFIXES = (".js", ".css", ".map", ".webmanifest", ".svg", ".png", ".ico", ".txt", ".json", ".xml")


def _is_static_asset_path(path: str) -> bool:
    """자산 디렉터리 또는 확장자 있는 루트 파일 경로인지 / Whether a path is an asset directory or a root file with a suffix."""
    return path.startswith(ASSET_PREFIXES) or ("/" not in path[1:] and path.endswith(ROOT_FILE_SUFFIXES))
# API 404는 절대 index.html로 바꾸지 않는다 / An API 404 is never rewritten to index.html
API_PREFIX = "/api"


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _info(event: str, **fields: Any) -> None:
    """기동 상태를 단일 라인 JSON으로 기록 / Log a startup fact as single-line JSON."""
    payload = {"event": event}
    payload.update(fields)
    logger.info(json.dumps(payload, default=str, ensure_ascii=False))


class NullL2:
    """
    L2 없이 기동할 때 쓰는 no-op 계층 / No-op tier used when the app starts without an L2.

    TieredCache의 L2 프로토콜(get/get_stale/put)을 만족하며 항상 미스를 반환한다.
    lifespan이 `DynamoCache`로 교체한다 (교체 실패 시 이 계층이 그대로 남는다).
    Satisfies the TieredCache L2 protocol (get/get_stale/put) and always misses. The lifespan swaps in
    `DynamoCache`; when that fails this tier simply stays.
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


# ---------------------------------------------------------------------------
# L2 (DynamoDB)
# ---------------------------------------------------------------------------

def _build_l2(table_name: str) -> DynamoCache:
    """
    L2 캐시를 만들고 테이블 도달 여부를 확인 - **블로킹**이므로 스레드에서만 호출한다.
    Build the L2 cache and confirm the table is reachable - **blocking**, so call it in a thread only.

    boto3 리소스 생성/자격증명 해석과 첫 왕복을 여기서 끝낸다: 이후 요청 경로의 이벤트 루프가
    그 비용을 내지 않는다(`DynamoCache._get_table`은 핸들을 캐시한다). 확인은 `describe_table`이
    아니라 `get_item`으로 한다 - 런타임과 같은 IAM 권한만 요구하므로 권한 차이로 오탐하지 않는다.
    Building the boto3 resource, resolving credentials and the first round trip all happen here, so no
    request-path event loop ever pays for them (`DynamoCache._get_table` caches the handle). The check
    uses `get_item`, not `describe_table`: it needs only the IAM permission the runtime already has.

    Raises:
        Exception: 테이블에 접근할 수 없을 때 (호출자가 경고 후 계속 진행) / When the table is unreachable.
    """
    cache = DynamoCache(table_name)
    cache._get_table().get_item(Key={"pk": L2_PROBE_KEY})
    return cache


async def _attach_l2(state: AppState) -> None:
    """
    L2를 `DynamoCache`로 교체 / Swap the state's L2 for a `DynamoCache`.

    실패해도 기동을 막지 않는다: 경고를 남기고 기존 L2(NullL2)를 유지한다 - 로컬 개발 배려.
    A failure never blocks startup: it warns and keeps the existing L2 (NullL2), for local development.
    """
    table_name = config.CACHE_TABLE
    try:
        l2 = await asyncio.to_thread(_build_l2, table_name)
    except Exception as exc:
        _warn("l2_unavailable", table=table_name, error=str(exc))
        return
    state.cache.l2 = l2
    _info("l2_attached", table=table_name)


# ---------------------------------------------------------------------------
# lifespan
# ---------------------------------------------------------------------------

async def _stop_scheduler(task: asyncio.Task, stop: asyncio.Event) -> None:
    """stop을 세팅하고 스케줄러 태스크를 정리 / Set stop and reap the scheduler task."""
    stop.set()
    try:
        await asyncio.wait_for(task, timeout=SHUTDOWN_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        # wait_for가 이미 태스크를 취소했다 / wait_for has already cancelled the task
        _warn("scheduler_stop_timeout", timeout=SHUTDOWN_TIMEOUT_SEC)
    except Exception as exc:
        _warn("scheduler_task_failed", error=str(exc))


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    L2 연결 + 스케줄러 루프의 수명을 앱에 묶는다 / Tie the L2 connection and the scheduler loops to the app.

    stop 이벤트는 **실행 중인 이벤트 루프 안에서** 만든다 (py3.9은 생성 시점의 루프에 바인딩된다).
    The stop event is created *inside the running loop*: on py3.9 it binds to the loop that created it.
    """
    state: Optional[AppState] = getattr(app.state, "ctx", None)
    if state is None:
        # 구성 오류지만 기동은 막지 않는다 (헬스는 계속 200) / A configuration bug, but startup goes on
        _warn("app_state_missing", phase="startup")
        yield
        return

    await _attach_l2(state)
    stop = asyncio.Event()
    task = asyncio.create_task(scheduler.run_loops(state, stop))
    _info("scheduler_started")
    try:
        yield
    finally:
        await _stop_scheduler(task, stop)


# ---------------------------------------------------------------------------
# 정적 서빙 / Static serving
# ---------------------------------------------------------------------------

def static_dir() -> Path:
    """정적 파일 디렉터리 (env `STATIC_DIR` 우선) / The static file directory (env `STATIC_DIR` wins)."""
    override = os.environ.get("STATIC_DIR")
    return Path(override) if override else DEFAULT_STATIC_DIR


def _mount_static(app: FastAPI) -> None:
    """
    frontend 빌드 산출물을 서빙하고 SPA 라우트를 index.html로 되돌린다.
    Serve the frontend build and send SPA routes back to index.html.

    빌드 산출물이 없으면 조용히 건너뛴다 (백엔드만 띄우는 로컬 개발) - 사실은 로그로 남긴다.
    Skipped when the build is absent (backend-only local development), and the skip is logged.

    라우터 등록 **뒤에** 호출해야 한다: `/`에 마운트하면 모든 경로와 매칭되므로 가장 마지막
    라우트여야 `/api/*`가 먼저 잡힌다.
    Must run *after* the routers: a mount at `/` matches every path, so it has to be the last route
    for `/api/*` to win.
    """
    directory = static_dir()
    index = directory / "index.html"
    if not index.is_file():
        _info("static_serving_disabled", directory=str(directory))
        return

    async def spa_fallback(request: Request, exc: StarletteHTTPException) -> Response:
        """
        비-API·비-자산 GET의 404만 index.html로 대체 / Only a non-API, non-asset GET 404 becomes index.html.

        자산·루트 파일 경로(`/assets/*`, `/icons/*`, `sw.js` 같은 루트 파일)는 진짜 404를 유지한다: PWA 워커의 프리캐시·폰트
        CacheFirst와 CloudFront `/assets/*` 캐시는 200이면 그대로 담으므로, 롤링 배포 창에서 옛 태스크가 새 해시의 청크에
        200 HTML을 돌려주면 그 HTML이 자산 URL 아래 굳는다. SPA 라우트(`/stocks/005930.KS`처럼 점이 든 것 포함)는 그대로 셸이다.
        Asset and root-file paths (`/assets/*`, `/icons/*`, root files such as `sw.js`) keep a real 404: the PWA worker's
        precache/font CacheFirst and CloudFront's `/assets/*` cache store any 200, so an old task answering a new-hash chunk
        with 200 HTML during a rolling deploy would harden that HTML under the asset URL. SPA routes (dots included, as in
        `/stocks/005930.KS`) still get the shell.
        """
        path = request.url.path
        if (
            exc.status_code == 404
            and request.method in SPA_METHODS
            and not path.startswith(API_PREFIX)
            and not _is_static_asset_path(path)
        ):
            return FileResponse(index)
        return await http_exception_handler(request, exc)

    app.add_exception_handler(StarletteHTTPException, spa_fallback)
    app.mount("/", StaticFiles(directory=str(directory), html=True), name="static")


# ---------------------------------------------------------------------------
# 앱 팩토리 / App factory
# ---------------------------------------------------------------------------

def create_app(state: Optional[AppState] = None, *, background: bool = False) -> FastAPI:
    """
    라우터·정적 서빙이 붙은 FastAPI 앱 생성 / Create the FastAPI app with routers and static serving.

    Args:
        state: 주입할 앱 컨텍스트. 생략하면 L1 전용 기본 컨텍스트를 만든다.
            The app context to inject; a L1-only default is built when omitted.
        background: L2 연결 + 스케줄러 루프(lifespan)를 붙일지 여부. 서비스 진입점(모듈 레벨 `app`)만
            True를 쓴다 - 기본값 False라 테스트가 실수로 네트워크/AWS를 때리지 않는다.
            Whether to attach the lifespan (L2 connection + scheduler loops). Only the service entry
            point (the module-level `app`) passes True; the False default keeps tests off the network.

    Returns:
        FastAPI 인스턴스 (`app.state.ctx`에 AppState가 들어있다) / A FastAPI instance carrying AppState on `app.state.ctx`.
    """
    app = FastAPI(
        title="Stock Monitoring API",
        version="0.1.0",
        lifespan=_lifespan if background else None,
    )
    app.state.ctx = state if state is not None else default_state()

    app.include_router(health.router)
    app.include_router(market.router)
    app.include_router(stocks.router)
    app.include_router(ai.router)

    # 항상 마지막 / Always last
    _mount_static(app)
    return app


# uvicorn 진입점 (`uvicorn app.main:app`, 워커 1개) / uvicorn entry point (`uvicorn app.main:app`, one worker)
app = create_app(background=True)
