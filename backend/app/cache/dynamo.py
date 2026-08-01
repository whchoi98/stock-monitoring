"""
L2 DynamoDB 캐시 - 동기 boto3 호출을 asyncio.to_thread로 감싼 영속 캐시 계층
L2 DynamoDB cache - persistent cache tier wrapping synchronous boto3 calls in asyncio.to_thread.

항목 스키마 / Item schema: pk(S, key), data(S, JSON), ttl(N, epoch), asOf(S)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Optional, Tuple

import boto3

logger = logging.getLogger(__name__)

# 기본 리전 (env AWS_REGION 미설정 시) / Default region when env AWS_REGION is unset
DEFAULT_REGION = "ap-northeast-2"


class DynamoCache:
    """
    DynamoDB-backed L2 cache implementing the duck-typed L2 protocol used by TieredCache.

    Values are stored as a JSON string in the ``data`` attribute so nested structures and
    numeric types round-trip unchanged (DynamoDB's native number type would surface as
    ``Decimal``). ``ttl`` is an epoch second value: DynamoDB's own TTL sweep is delayed by
    up to 48 hours, so ``get`` re-checks expiry in the application. ``get_stale`` ignores
    ttl entirely to serve as the upstream-failure fallback.

    Every DynamoDB failure is swallowed and logged as single-line JSON: an L2 outage must
    degrade to a cache miss, never break a request.
    """

    def __init__(self, table_name: str):
        """
        Args:
            table_name: DynamoDB table name (see config.CACHE_TABLE)
        """
        self.table_name = table_name
        self._table = None

    def _get_table(self):
        """Return the boto3 Table handle, creating it on first use (no network call)."""
        if self._table is None:
            region = os.environ.get("AWS_REGION") or DEFAULT_REGION
            resource = boto3.resource("dynamodb", region_name=region)
            self._table = resource.Table(self.table_name)
        return self._table

    def _warn(self, event: str, key: str, error: Exception) -> None:
        """Log an L2 failure as single-line JSON (structlog style). Never raises."""
        logger.warning(
            json.dumps(
                {
                    "event": event,
                    "table": self.table_name,
                    "key": key,
                    "error": str(error),
                },
                ensure_ascii=False,
            )
        )

    async def _read(self, key: str, ignore_ttl: bool) -> Optional[Tuple[Any, str]]:
        """
        Read one item, optionally enforcing the app-level TTL check.

        Args:
            key: Cache key (pk)
            ignore_ttl: True to return expired items as well (stale read)

        Returns:
            Tuple of (value, asOf) on hit, None on miss / expiry / any failure
        """
        event = "l2_get_stale_failed" if ignore_ttl else "l2_get_failed"
        try:
            table = self._get_table()
            response = await asyncio.to_thread(table.get_item, Key={"pk": key})
            item = response.get("Item")
            if item is None:
                return None

            if not ignore_ttl:
                expires_at = item.get("ttl")
                if expires_at is not None and int(expires_at) < int(time.time()):
                    return None

            return (json.loads(item["data"]), str(item.get("asOf", "")))
        except Exception as error:  # boto3/botocore errors + malformed items
            self._warn(event, key, error)
            return None

    async def get(self, key: str) -> Optional[Tuple[Any, str]]:
        """
        Get a fresh (non-expired) value.

        Args:
            key: Cache key

        Returns:
            Tuple of (value, asOf) if present and ttl >= now, None otherwise
        """
        return await self._read(key, ignore_ttl=False)

    async def get_stale(self, key: str) -> Optional[Tuple[Any, str]]:
        """
        Get a value ignoring ttl - fallback path when the upstream fetch fails.

        Args:
            key: Cache key

        Returns:
            Tuple of (value, asOf) if the item exists at all, None otherwise
        """
        return await self._read(key, ignore_ttl=True)

    async def put(self, key: str, value: Any, ttl: int, as_of: str) -> None:
        """
        Write-through best effort: store the value, swallowing DynamoDB failures.

        Args:
            key: Cache key
            value: JSON-serializable value
            ttl: Time to live in seconds (added to current epoch)
            as_of: ISO8601 timestamp string
        """
        try:
            table = self._get_table()
            item = {
                "pk": key,
                "data": json.dumps(value, ensure_ascii=False),
                "ttl": int(time.time()) + int(ttl),
                "asOf": as_of,
            }
            await asyncio.to_thread(table.put_item, Item=item)
        except Exception as error:
            self._warn("l2_put_failed", key, error)
