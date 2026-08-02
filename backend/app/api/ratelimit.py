"""
슬라이딩 윈도우 레이트리미터 - IP별 요청 시각 deque 하나로 "분당 N회"를 판정한다.
Sliding-window rate limiter: one deque of request timestamps per IP decides "N requests per minute".

프로세스 로컬 상태다. Fargate 태스크가 여러 개면 한도는 태스크마다 따로 적용된다
(AI 비용 방어는 이 한도 + 결과 캐시 + 전역 동시 실행 제한을 합쳐서 이루어진다).
The state is process-local: with several Fargate tasks the limit applies per task. AI cost is defended
by this limit *plus* the result cache and the global concurrency cap, not by this class alone.

단조 시계(`time.monotonic`)를 쓰므로 시스템 시간 변경에 영향을 받지 않는다.
It uses a monotonic clock, so a system clock change cannot widen or narrow the window.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Callable, Deque, Dict


class SlidingWindowLimiter:
    """
    IP당 `limit`회/`window_sec`초 제한 / At most `limit` requests per `window_sec` seconds per IP.

    Attributes:
        limit: 윈도우 안에서 허용하는 요청 수 / Allowed requests inside one window.
        window_sec: 윈도우 길이(초) / Window length in seconds.
    """

    def __init__(self, limit: int, window_sec: int, *, now: Callable[[], float] = time.monotonic) -> None:
        """
        Args:
            limit: 윈도우당 허용 요청 수 / Allowed requests per window.
            window_sec: 윈도우 길이(초) / Window length in seconds.
            now: 단조 시계 (테스트에서 주입) / Monotonic clock, injectable for tests.
        """
        self.limit = limit
        self.window_sec = window_sec
        self._now = now
        # IP -> 윈도우 안의 요청 시각들 (오래된 것이 앞) / IP -> request timestamps inside the window (oldest first)
        self._hits: Dict[str, Deque[float]] = {}
        self._last_sweep = now()

    def allow(self, ip: str) -> bool:
        """
        요청을 허용할지 판정하고, 허용하면 기록한다 / Decide whether to allow a request, recording it when allowed.

        Args:
            ip: 클라이언트 IP (`ai.client_ip`: CloudFront-Viewer-Address 우선, XFF 첫 항목 폴백)
                / Client IP (`ai.client_ip`: CloudFront-Viewer-Address first, first XFF entry as fallback).

        Returns:
            True면 허용(카운트됨), False면 한도 초과 / True when allowed (and counted), False when over the limit.
        """
        now = self._now()
        cutoff = now - self.window_sec
        self._sweep(now, cutoff)

        hits = self._hits.get(ip)
        if hits is None:
            hits = deque()
            self._hits[ip] = hits
        while hits and hits[0] <= cutoff:
            hits.popleft()

        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True

    def _sweep(self, now: float, cutoff: float) -> None:
        """
        윈도우당 최대 한 번 유휴 IP 항목을 제거한다 / Drop idle IP entries at most once per window.

        `allow`는 요청된 IP의 deque만 정리하므로, 한 번 등장한 IP는 그대로 남는다. CloudFront 뒤에서는
        키가 위조 불가한 뷰어 주소지만 로컬/직접 호출에서는 여전히 XFF 폴백이라 맵이 계속 커질 수 있어
        주기적으로 훑어 비운다 (윈도우당 O(IP 수)).
        `allow` only prunes the requested IP's deque, so every IP ever seen would linger. Behind CloudFront
        the key is the unforgeable viewer address, but the XFF fallback still applies off CloudFront and can
        grow the map, hence this periodic pass (O(#IPs) once per window).
        """
        if now - self._last_sweep < self.window_sec:
            return
        self._last_sweep = now
        idle = [ip for ip, hits in self._hits.items() if not hits or hits[-1] <= cutoff]
        for ip in idle:
            del self._hits[ip]
