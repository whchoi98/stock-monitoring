"""
L2 DynamoDB 캐시 테스트 - moto 기반, 실제 AWS 호출 없음
L2 DynamoDB cache tests - moto-based, no real AWS calls.
"""
import json
import logging

import boto3
import pytest
from moto import mock_aws

from app.cache.dynamo import DynamoCache

REGION = "ap-northeast-2"


@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    """moto가 요구하는 더미 자격증명과 리전 고정 / Pin dummy credentials + region for moto."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("AWS_REGION", REGION)


@pytest.fixture
def table(aws_env):
    with mock_aws():
        boto3.client("dynamodb", region_name=REGION).create_table(
            TableName="t",
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield "t"


async def test_roundtrip_and_expiry(table):
    c = DynamoCache(table)
    await c.put("q", {"x": [1, 2]}, ttl=60, as_of="A")
    assert (await c.get("q")) == ({"x": [1, 2]}, "A")
    await c.put("old", "v", ttl=-10, as_of="B")  # 이미 만료 / already expired
    assert await c.get("old") is None
    assert (await c.get_stale("old")) == ("v", "B")


async def test_nested_structures_survive_json_roundtrip(table):
    """JSON 문자열 저장이므로 중첩 구조/타입이 그대로 보존된다 / JSON storage preserves nested types."""
    c = DynamoCache(table)
    payload = {
        "asOf": "2026-08-01T00:00:00+00:00",
        "marketOpen": True,
        "data": [
            {"symbol": "005930.KS", "price": 71234.5, "change": -0.42, "name": None},
            {"symbol": "AAPL", "price": 213.07, "history": [[1, 2.5], [3, 4.0]]},
        ],
    }
    await c.put("nested", payload, ttl=60, as_of="A")
    value, as_of = await c.get("nested")
    assert value == payload
    assert as_of == "A"


async def test_missing_table_does_not_raise_and_logs(aws_env, caplog):
    """테이블 없음/오설정: get/get_stale은 None, put은 무시 — 단, 경고 로그는 남긴다.
    Missing/misconfigured table: get/get_stale return None, put swallows - but always warns."""
    with mock_aws():
        c = DynamoCache("does-not-exist")
        with caplog.at_level(logging.WARNING, logger="app.cache.dynamo"):
            assert await c.get("q") is None
            assert await c.get_stale("q") is None
            await c.put("q", {"a": 1}, ttl=60, as_of="A")  # must not raise

    assert len(caplog.records) == 3
    for record in caplog.records:
        message = record.getMessage()
        assert "\n" not in message  # 단일 라인 JSON / single-line JSON
        payload = json.loads(message)
        assert payload["table"] == "does-not-exist"
        assert payload["key"] == "q"
        assert payload["error"]
