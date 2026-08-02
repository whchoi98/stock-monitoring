"""
애플리케이션 상태 - 계층 캐시 + 소스별 상태를 담아 `app.state.ctx`로 공유한다.
Application state - the tiered cache plus per-source status, shared via `app.state.ctx`.

라우트는 `deps.get_state(request)`로, 스케줄러(B12)는 직접 인스턴스를 받아 쓴다.
Routes reach it through `deps.get_state(request)`; the scheduler (B12) receives the instance directly.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 헬스 응답에 항상 노출되는 소스 키 / Source keys always present in the health response
SOURCE_KEYS = ("yahoo", "rss", "bedrock")

# 소스 상태 값 / Source status values
STATUS_UNKNOWN = "unknown"   # 아직 한 번도 조회하지 않음 / never queried yet
STATUS_OK = "ok"             # 최근 조회 성공 / last query succeeded
STATUS_DEGRADED = "degraded"  # 최근 조회 실패 (캐시로 버티는 중) / last query failed (serving from cache)


def default_source_status() -> dict:
    """모든 소스를 unknown으로 초기화 / Initialize every source to unknown."""
    return {key: STATUS_UNKNOWN for key in SOURCE_KEYS}


@dataclass
class AppState:
    """
    요청·스케줄러가 공유하는 앱 컨텍스트 / App context shared by requests and the scheduler.

    Attributes:
        cache: 계층 캐시 (L1 메모리 -> L2 영속) / Tiered cache (L1 memory -> L2 persistent).
        source_status: 소스 키 -> 상태 문자열 / Source key -> status string.
    """

    cache: Any
    source_status: dict = field(default_factory=default_source_status)

    def mark_source(self, name: str, status: str) -> None:
        """
        소스 상태 갱신 - 실패를 조용히 넘기지 않기 위한 단일 진입점.
        Update a source's status: the single entry point that keeps failures visible.

        Args:
            name: 소스 키 (예: "yahoo") / Source key (e.g. "yahoo").
            status: STATUS_OK | STATUS_DEGRADED | STATUS_UNKNOWN.
        """
        self.source_status[name] = status
