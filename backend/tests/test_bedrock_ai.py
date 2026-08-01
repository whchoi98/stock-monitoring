"""
Bedrock AI 서비스 테스트 - boto3 client를 FakeClient로 대체 (실제 bedrock-runtime 호출 없음)
Bedrock AI service tests - boto3 client replaced by a FakeClient (no real bedrock-runtime calls).
"""
import json
import logging

import boto3
import pytest
from botocore.exceptions import ClientError

from app.core import config
from app.services import bedrock_ai
from app.services.bedrock_ai import (
    BedrockCallError,
    BedrockUnavailableError,
    analyze_article,
    analyze_stock,
    is_bedrock_available,
)

LOGGER_NAME = "app.services.bedrock_ai"


# ---------------------------------------------------------------------------
# 테스트 더블 / Test doubles
# ---------------------------------------------------------------------------

class FakeBody:
    """invoke_model 응답의 스트리밍 본문 대역 / Stand-in for the streaming invoke_model body."""

    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class FakeClient:
    """invoke_model 호출을 기록하고 고정 응답(또는 예외)을 반환 / Records calls, returns a fixed response or raises."""

    def __init__(self, payload=None, error=None):
        self.calls = []
        self.payload = {"content": [{"text": "분석결과"}]} if payload is None else payload
        self.error = error

    def invoke_model(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {"body": FakeBody(self.payload)}


class _FrozenCreds:
    access_key = "AKIAFAKE"
    secret_key = "FAKESECRET"
    token = None


class _Creds:
    def get_frozen_credentials(self):
        return _FrozenCreds()


def _client_error(code):
    """지정한 에러 코드의 botocore ClientError / A botocore ClientError with the given error code."""
    return ClientError({"Error": {"Code": code, "Message": code}}, "InvokeModel")


def _install_client(monkeypatch, client):
    """boto3.client를 FakeClient 팩토리로 교체하고 생성 인자를 기록 / Swap boto3.client for a recorder factory."""
    created = {"count": 0}

    def _factory(service_name, **kwargs):
        created["count"] += 1
        created["service"] = service_name
        created["kwargs"] = kwargs
        return client

    monkeypatch.setattr(boto3, "client", _factory)
    return created


def _bodies(client):
    """FakeClient가 받은 요청 본문(JSON) 목록 / Request bodies (parsed JSON) the FakeClient received."""
    return [json.loads(call["body"]) for call in client.calls]


def _error_payloads(caplog):
    """실패 로그가 단일 라인 JSON임을 확인하고 파싱 / Assert single-line JSON error logs and parse them."""
    payloads = []
    for record in caplog.records:
        if record.name != LOGGER_NAME or record.levelno < logging.WARNING:
            continue
        message = record.getMessage()
        assert "\n" not in message
        payloads.append(json.loads(message))
    return payloads


# ---------------------------------------------------------------------------
# 픽스처 / Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_availability_cache(monkeypatch):
    """모듈 가용성 캐시를 테스트마다 초기화 / Reset the module availability cache per test."""
    monkeypatch.setattr(bedrock_ai, "_bedrock_available", None)


@pytest.fixture
def creds(monkeypatch):
    """AWS 기본 자격 증명이 해석되는 상태 / AWS default credentials resolve (ECS Task Role stand-in)."""
    monkeypatch.setattr(boto3.Session, "get_credentials", lambda self: _Creds())


@pytest.fixture
def no_creds(monkeypatch):
    """AWS 기본 자격 증명이 없는 상태 / No AWS default credentials resolve."""
    monkeypatch.setattr(boto3.Session, "get_credentials", lambda self: None)


@pytest.fixture
def client(monkeypatch, creds):
    """정상 응답 FakeClient가 설치된 상태 / A FakeClient returning the fixed happy-path payload."""
    fake = FakeClient()
    fake.created = _install_client(monkeypatch, fake)
    return fake


STOCK_ARGS = dict(
    symbol="005930.KS",
    name="Samsung Electronics",
    price=71234.5,
    change_pct=-1.25,
    pe_ratio=13.5,
    week52_high=90000.0,
    week52_low=50000.0,
    sector="Semiconductor",
    market="KR",
    news_titles=["뉴스1", "뉴스2"],
)


# ---------------------------------------------------------------------------
# 정상 경로 / Happy path
# ---------------------------------------------------------------------------

def test_analyze_stock_returns_model_text(client):
    """모델 응답의 content[0].text를 그대로 반환 / Returns content[0].text from the model response."""
    assert analyze_stock(**STOCK_ARGS) == "분석결과"


def test_analyze_article_returns_model_text(client):
    """기사 분석도 동일하게 텍스트를 반환 / Article analysis returns the text as well."""
    assert analyze_article("제목", "본문", True) == "분석결과"


def test_analyze_stock_request_uses_config_model_and_1024_tokens(client):
    """종목 분석: modelId=config, max_tokens=1024, anthropic_version 고정 / Stock: config model, 1024 tokens."""
    analyze_stock(**STOCK_ARGS)

    call = client.calls[0]
    assert call["modelId"] == config.BEDROCK_MODEL_ID
    assert call["contentType"] == "application/json"
    assert call["accept"] == "application/json"

    body = _bodies(client)[0]
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["max_tokens"] == 1024
    assert len(body["messages"]) == 1
    assert body["messages"][0]["role"] == "user"


def test_analyze_article_request_uses_config_model_and_2048_tokens(client):
    """기사 분석: modelId=config, max_tokens=2048 / Article: config model, 2048 tokens."""
    analyze_article("제목", "본문", True)

    assert client.calls[0]["modelId"] == config.BEDROCK_MODEL_ID
    body = _bodies(client)[0]
    assert body["anthropic_version"] == "bedrock-2023-05-31"
    assert body["max_tokens"] == 2048


def test_stock_prompt_carries_facts_and_52week_position(client):
    """프롬프트에 종목 사실과 52주 위치(%)가 담긴다 / Prompt carries the facts and the 52-week position."""
    analyze_stock(**STOCK_ARGS)

    prompt = _bodies(client)[0]["messages"][0]["content"]
    assert "005930.KS (Samsung Electronics)" in prompt
    assert "시장: 한국" in prompt
    assert "섹터: Semiconductor" in prompt
    assert "현재가: 71,234.50 (-1.25%)" in prompt
    assert "PER: 13.50" in prompt
    # (71234.5 - 50000) / (90000 - 50000) * 100 = 53.09% -> 53%
    assert "52주 범위: 50,000.00 ~ 90,000.00 (현재 위치: 53%)" in prompt
    assert "- 뉴스1\n- 뉴스2" in prompt


def test_stock_prompt_handles_missing_optional_facts(client):
    """PER 없음/52주 범위 없음/뉴스 없음 → N/A·0%·(없음) / Missing optionals degrade to N/A, 0%, (없음)."""
    analyze_stock(symbol="AAPL", name="Apple", price=100.0, change_pct=0.0)

    prompt = _bodies(client)[0]["messages"][0]["content"]
    assert "시장: 미국" in prompt
    assert "섹터: N/A" in prompt
    assert "PER: N/A" in prompt
    assert "(현재 위치: 0%)" in prompt
    assert "최근 뉴스:\n(없음)" in prompt


def test_stock_prompt_uses_at_most_five_news_titles(client):
    """최근 뉴스는 최대 5개 / At most five recent news titles are included."""
    analyze_stock(**dict(STOCK_ARGS, news_titles=[f"N{i}" for i in range(8)]))

    prompt = _bodies(client)[0]["messages"][0]["content"]
    assert "- N4" in prompt
    assert "- N5" not in prompt


def test_article_prompt_differs_for_korean_and_english(client):
    """영문 기사는 한국어 번역 섹션을 요구 / English articles request a Korean translation section."""
    analyze_article("Title", "Content", False)
    english_prompt = _bodies(client)[0]["messages"][0]["content"]
    assert "## 한국어 번역" in english_prompt
    assert "Title: Title" in english_prompt

    client.calls.clear()
    analyze_article("제목", "본문", True)
    korean_prompt = _bodies(client)[0]["messages"][0]["content"]
    assert "## 한국어 번역" not in korean_prompt
    assert "제목: 제목" in korean_prompt


def test_article_prompt_truncates_content_at_6000_chars(client):
    """본문은 6000자까지만 프롬프트에 담는다 / The body is truncated to 6000 characters."""
    analyze_article("제목", "Z" * 7000, True)

    prompt = _bodies(client)[0]["messages"][0]["content"]
    assert prompt.count("Z") == 6000  # 프롬프트 본문에 없는 문자로 검증 / counted with a char absent from the prompt


# ---------------------------------------------------------------------------
# 클라이언트 생성 / Client creation (차이점 ①②: region, no API key branch)
# ---------------------------------------------------------------------------

def test_client_is_bedrock_runtime_in_configured_region(client):
    """bedrock-runtime + config.BEDROCK_REGION으로만 생성 / Created as bedrock-runtime in config region."""
    analyze_stock(**STOCK_ARGS)

    assert client.created["service"] == "bedrock-runtime"
    assert client.created["kwargs"] == {"region_name": config.BEDROCK_REGION}
    assert config.BEDROCK_REGION == "ap-northeast-2"


def test_bedrock_api_key_env_is_ignored(monkeypatch, client):
    """BEDROCK_API_KEY 분기 제거: 환경변수가 있어도 자격 증명을 넘기지 않는다 / No API-key branch."""
    monkeypatch.setenv("BEDROCK_API_KEY", "should-be-ignored")

    analyze_stock(**STOCK_ARGS)

    assert client.created["kwargs"] == {"region_name": config.BEDROCK_REGION}
    assert "aws_access_key_id" not in client.created["kwargs"]
    assert "aws_secret_access_key" not in client.created["kwargs"]


# ---------------------------------------------------------------------------
# 가용성 / Availability
# ---------------------------------------------------------------------------

def test_is_bedrock_available_true_when_default_credentials_resolve(creds):
    """기본 자격 증명이 해석되면 True / True when boto3 default credentials resolve."""
    assert is_bedrock_available() is True


def test_is_bedrock_available_false_without_credentials(no_creds):
    """자격 증명이 없으면 False / False when no credentials resolve."""
    assert is_bedrock_available() is False


def test_is_bedrock_available_false_and_logged_when_resolution_raises(monkeypatch, caplog):
    """자격 증명 해석 예외는 조용히 넘기지 않고 로그 남긴다 / Resolution errors are logged, not silent."""
    def _boom(self):
        raise RuntimeError("metadata down")

    monkeypatch.setattr(boto3.Session, "get_credentials", _boom)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert is_bedrock_available() is False

    payloads = _error_payloads(caplog)
    assert payloads and "metadata down" in payloads[0]["error"]


def test_get_client_raises_unavailable_without_credentials(monkeypatch, no_creds):
    """자격 증명 없음 → _get_client가 BedrockUnavailableError / No credentials -> BedrockUnavailableError."""
    created = _install_client(monkeypatch, FakeClient())

    with pytest.raises(BedrockUnavailableError):
        bedrock_ai._get_client()

    assert created["count"] == 0


def test_analyze_functions_raise_unavailable_without_credentials(monkeypatch, no_creds, caplog):
    """자격 증명 없음 → analyze_* 모두 BedrockUnavailableError raise / Both analyzers raise Unavailable."""
    created = _install_client(monkeypatch, FakeClient())

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(BedrockUnavailableError):
            analyze_stock(**STOCK_ARGS)
        with pytest.raises(BedrockUnavailableError):
            analyze_article("제목", "본문", True)

    assert created["count"] == 0
    assert len(_error_payloads(caplog)) >= 2


# ---------------------------------------------------------------------------
# 실패 경로 / Failure paths (차이점 ③: raise, 문자열 반환 금지)
# ---------------------------------------------------------------------------

def test_invoke_failure_raises_call_error_not_a_string(monkeypatch, creds, caplog):
    """invoke_model 예외 → BedrockCallError raise (문자열 반환 아님) / invoke failure raises BedrockCallError."""
    fake = FakeClient(error=RuntimeError("boom"))
    _install_client(monkeypatch, fake)

    with caplog.at_level(logging.ERROR, logger=LOGGER_NAME):
        with pytest.raises(BedrockCallError) as excinfo:
            analyze_stock(**STOCK_ARGS)

    assert "boom" in str(excinfo.value)
    payloads = _error_payloads(caplog)
    assert payloads and "boom" in payloads[0]["error"]


def test_article_invoke_failure_raises_call_error(monkeypatch, creds):
    """기사 분석도 실패 시 raise / Article analysis raises on failure too."""
    _install_client(monkeypatch, FakeClient(error=RuntimeError("boom")))

    with pytest.raises(BedrockCallError):
        analyze_article("제목", "본문", True)


def test_no_error_string_is_ever_returned(monkeypatch, creds):
    """TUI의 '(AI 분석을 불러올 수 없습니다...)' 문자열 반환은 제거됨 / The TUI error string is gone."""
    _install_client(monkeypatch, FakeClient(error=RuntimeError("boom")))

    for call in (lambda: analyze_stock(**STOCK_ARGS), lambda: analyze_article("t", "c", True)):
        try:
            result = call()
        except (BedrockCallError, BedrockUnavailableError):
            continue
        pytest.fail(f"예외 대신 문자열을 반환했다 / returned a string instead of raising: {result!r}")


@pytest.mark.parametrize("payload", [{}, {"content": []}, {"content": [{}]}])
def test_malformed_response_raises_call_error(monkeypatch, creds, payload):
    """응답 형식이 다르면 BedrockCallError / A malformed response raises BedrockCallError."""
    _install_client(monkeypatch, FakeClient(payload=payload))

    with pytest.raises(BedrockCallError):
        analyze_stock(**STOCK_ARGS)


def test_access_denied_raises_unavailable(monkeypatch, creds):
    """모델 접근 거부(AccessDeniedException) → BedrockUnavailableError / Access denied maps to Unavailable."""
    _install_client(monkeypatch, FakeClient(error=_client_error("AccessDeniedException")))

    with pytest.raises(BedrockUnavailableError):
        analyze_stock(**STOCK_ARGS)


def test_throttling_raises_call_error(monkeypatch, creds):
    """스로틀링 등 그 외 API 오류 → BedrockCallError / Other API errors map to BedrockCallError."""
    _install_client(monkeypatch, FakeClient(error=_client_error("ThrottlingException")))

    with pytest.raises(BedrockCallError):
        analyze_stock(**STOCK_ARGS)


# ---------------------------------------------------------------------------
# 잘못된 입력 / Bad input — 프롬프트 조립 실패도 타입 있는 예외로 나가야 한다
# Prompt-assembly failures must leave as typed errors too (assembly sits inside the try)
# ---------------------------------------------------------------------------

def test_none_price_raises_call_error_not_type_error(client, caplog):
    """price=None → 포맷 단계 TypeError를 BedrockCallError로 매핑 + 로그 / None price maps to BedrockCallError."""
    with caplog.at_level(logging.ERROR, logger=LOGGER_NAME):
        with pytest.raises(BedrockCallError):
            analyze_stock(**dict(STOCK_ARGS, price=None))

    assert client.calls == []  # 모델을 호출하지 않았다 / the model was never invoked
    payloads = _error_payloads(caplog)
    assert len(payloads) == 1
    assert payloads[0]["error_type"] == "TypeError"
    assert payloads[0]["event"] == "bedrock_stock_analysis_error"


def test_none_week52_high_raises_call_error(client):
    """week52_high=None → 비교 단계 TypeError를 BedrockCallError로 매핑 / None 52-week high maps too."""
    with pytest.raises(BedrockCallError):
        analyze_stock(**dict(STOCK_ARGS, week52_high=None))

    assert client.calls == []


def test_none_change_pct_raises_call_error(client):
    """change_pct=None도 동일 / A None change_pct behaves the same."""
    with pytest.raises(BedrockCallError):
        analyze_stock(**dict(STOCK_ARGS, change_pct=None))


def test_none_article_content_raises_call_error(client, caplog):
    """content=None → 슬라이싱 TypeError를 BedrockCallError로 매핑 + 로그 / None content maps to BedrockCallError."""
    with caplog.at_level(logging.ERROR, logger=LOGGER_NAME):
        with pytest.raises(BedrockCallError):
            analyze_article("t", None, True)

    assert client.calls == []
    payloads = _error_payloads(caplog)
    assert len(payloads) == 1
    assert payloads[0]["error_type"] == "TypeError"
    assert payloads[0]["event"] == "bedrock_article_analysis_error"


def test_no_raw_exception_type_escapes_the_module(client):
    """조립 실패가 TypeError로 새어 나가지 않는다 / A raw TypeError never escapes the module."""
    for call in (
        lambda: analyze_stock(**dict(STOCK_ARGS, price=None)),
        lambda: analyze_stock(**dict(STOCK_ARGS, week52_low=None)),
        lambda: analyze_article("t", None, False),
    ):
        with pytest.raises((BedrockCallError, BedrockUnavailableError)):
            call()


def test_bad_input_without_credentials_still_raises_unavailable(monkeypatch, no_creds):
    """자격 증명 없음이 우선: 잘못된 입력이어도 Unavailable로 재분류되지 않는다 / Unavailable is not reclassified."""
    _install_client(monkeypatch, FakeClient())

    # 조립 성공 → _get_client에서 Unavailable / assembly succeeds, then _get_client raises Unavailable
    with pytest.raises(BedrockUnavailableError):
        analyze_stock(**STOCK_ARGS)
