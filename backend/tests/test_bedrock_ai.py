"""
Bedrock AI 서비스 테스트 - boto3 client를 FakeClient로 대체 (실제 bedrock-runtime 호출 없음)
Bedrock AI service tests - boto3 client replaced by a FakeClient (no real bedrock-runtime calls).
"""
import asyncio
import json
import logging
import threading
import time

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


class _FakeStreamClient:
    """converse_stream 이벤트 시퀀스를 재생하는 페이크 / A fake replaying a converse_stream event sequence."""

    def __init__(self, events=None, error=None):
        self.events = [] if events is None else events
        self.error = error
        self.calls = []

    def converse_stream(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {"stream": iter(self.events)}


def _delta(text):
    """텍스트 델타 이벤트 / A text delta event."""
    return {"contentBlockDelta": {"delta": {"text": text}}}


def _stop(reason):
    """메시지 종료 이벤트 / A message stop event."""
    return {"messageStop": {"stopReason": reason}}


class _GatedStream:
    """close() 호출을 기록하는 이벤트 스트림 대역 / An event-stream stand-in recording close() calls."""

    def __init__(self, events):
        self._events = events
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._events)

    def close(self):
        self.closed = True
        self._events.close()


class _GatedStreamClient:
    """
    게이트가 열릴 때까지 다음 이벤트를 내주지 않는 페이크 / A fake withholding each next event until its gate opens.

    조기 종료 검증에는 **블로킹** 스트림이 필요하다: 유한 `iter(events)`는 즉시 소진되므로 펌프가 취소를
    무시하고 끝까지 읽어도 스레드가 곧 사라져 테스트가 어떤 구현에서도 통과한다(= 무의미한 테스트).
    A blocking stream is required to observe early close: a finite `iter(events)` drains instantly, so
    a pump that ignores cancellation still ends promptly and the test would pass against anything.
    """

    # 구현이 취소를 무시해도 스레드가 영원히 남지 않도록 상한을 둔다 / bounded so a broken impl still exits
    GATE_TIMEOUT = 5.0

    def __init__(self, error=None):
        self.calls = []
        self.error = error                  # 게이트가 열린 뒤 던질 예외 / raised once the gate opens
        self.gate = threading.Event()       # 두 번째 이벤트를 여는 게이트 / opens the second event
        self.tail_gate = threading.Event()  # 그 이후 이벤트를 여는 게이트 / opens everything after that
        self.produced = []                  # 스트림이 실제로 내보낸 것 / what the stream actually emitted
        self.stream = None                  # 마지막으로 넘긴 스트림 / the stream handed to the pump

    def converse_stream(self, **kwargs):
        self.calls.append(kwargs)
        self.stream = _GatedStream(self._events())
        return {"stream": self.stream}

    def _events(self):
        self.produced.append("a")
        yield _delta("a")
        self.gate.wait(self.GATE_TIMEOUT)
        if self.error is not None:
            raise self.error
        self.produced.append("b")
        yield _delta("b")
        # 취소를 존중하지 않는 펌프는 여기서 막힌다 / a pump ignoring cancellation blocks here
        self.tail_gate.wait(self.GATE_TIMEOUT)
        self.produced.append("c")
        yield _delta("c")
        yield _stop("end_turn")

    def release_all(self):
        """테스트 실패 시에도 스레드를 남기지 않기 위한 정리 / Cleanup so a failure never leaks the thread."""
        self.gate.set()
        self.tail_gate.set()


def _prompt_of(stream_client):
    """페이크가 받은 converse_stream 프롬프트 / The prompt the fake received via converse_stream."""
    return stream_client.calls[0]["messages"][0]["content"][0]["text"]


def _pump_threads():
    """살아 있는 스트림 펌프 스레드 / Stream pump threads still alive."""
    return [t for t in threading.enumerate() if t.name == "bedrock-stream" and t.is_alive()]


async def _await_pump_exit(timeout=1.5):
    """펌프 스레드가 끝나기를 기다리고 남은 스레드를 반환 / Wait for pump exit, returning what is left."""
    deadline = time.monotonic() + timeout
    while _pump_threads() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    return _pump_threads()


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


@pytest.fixture
def stream_client(monkeypatch, creds):
    """converse_stream 페이크를 설치하는 팩토리 / Factory installing a converse_stream fake."""
    def _install(events=None, error=None):
        fake = _FakeStreamClient(events=events, error=error)
        fake.created = _install_client(monkeypatch, fake)
        return fake

    return _install


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


# ---------------------------------------------------------------------------
# 스트리밍 / Streaming (converse_stream + 스레드 브리지 / thread-to-queue bridge)
# ---------------------------------------------------------------------------

async def test_stream_invoke_yields_deltas_in_order(stream_client):
    """contentBlockDelta가 순서대로 yield된다 / Deltas come out in order."""
    fake = stream_client([_delta("안"), _delta("녕"), _stop("end_turn")])

    out = [chunk async for chunk in bedrock_ai.stream_invoke("p", 100)]

    assert out == ["안", "녕"]
    call = fake.calls[0]
    assert call["modelId"] == config.BEDROCK_MODEL_ID
    assert call["inferenceConfig"] == {"maxTokens": 100}
    assert call["messages"] == [{"role": "user", "content": [{"text": "p"}]}]


async def test_stream_invoke_uses_bedrock_runtime_in_configured_region(stream_client):
    """스트리밍도 같은 _get_client 경로를 쓴다 / Streaming goes through the same _get_client path."""
    fake = stream_client([_stop("end_turn")])

    assert [c async for c in bedrock_ai.stream_invoke("p", 10)] == []

    assert fake.created["service"] == "bedrock-runtime"
    assert fake.created["kwargs"] == {"region_name": config.BEDROCK_REGION}


async def test_stream_invoke_skips_empty_and_non_text_events(stream_client):
    """빈 델타·다른 이벤트는 yield하지 않는다 / Empty deltas and other events are not yielded."""
    fake = stream_client([
        {"messageStart": {"role": "assistant"}},
        _delta(""),
        _delta("x"),
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"metadata": {"usage": {"outputTokens": 1}}},
        _stop("end_turn"),
    ])

    assert [c async for c in bedrock_ai.stream_invoke("p", 10)] == ["x"]
    assert len(fake.calls) == 1


async def test_stream_invoke_warns_on_max_tokens_stop(stream_client, caplog):
    """stopReason max_tokens는 절단 시그널로 경고된다 / A max_tokens stop is warned as a truncation signal."""
    stream_client([_delta("x"), _stop("max_tokens")])

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert [c async for c in bedrock_ai.stream_invoke("p", 5)] == ["x"]

    payloads = _error_payloads(caplog)
    assert [p["event"] for p in payloads] == ["ai_stream_truncated"]
    assert payloads[0]["stop_reason"] == "max_tokens"
    assert payloads[0]["max_tokens"] == 5


async def test_stream_invoke_does_not_warn_on_normal_stop(stream_client, caplog):
    """정상 종료(end_turn)는 경고하지 않는다 / A normal end_turn stop logs nothing."""
    stream_client([_delta("x"), _stop("end_turn")])

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert [c async for c in bedrock_ai.stream_invoke("p", 5)] == ["x"]

    assert _error_payloads(caplog) == []


async def test_stream_invoke_maps_client_errors(stream_client, caplog):
    """스트림 도중 ClientError는 기존 타입 예외로 매핑된다 / A mid-stream ClientError maps to the typed error."""
    stream_client(error=ClientError({"Error": {"Code": "AccessDeniedException"}}, "ConverseStream"))

    with caplog.at_level(logging.ERROR, logger=LOGGER_NAME):
        with pytest.raises(BedrockUnavailableError):
            _ = [c async for c in bedrock_ai.stream_invoke("p", 5)]

    payloads = _error_payloads(caplog)
    assert payloads and payloads[0]["event"] == "ai_stream_failed"


async def test_stream_invoke_maps_other_errors_to_call_error(stream_client):
    """그 외 실패는 BedrockCallError / Any other failure maps to BedrockCallError."""
    stream_client(error=RuntimeError("boom"))

    with pytest.raises(BedrockCallError) as excinfo:
        _ = [c async for c in bedrock_ai.stream_invoke("p", 5)]

    assert "boom" in str(excinfo.value)


async def test_stream_invoke_error_after_partial_deltas_raises_out_of_generator(monkeypatch, creds):
    """델타 일부 뒤 실패해도 예외는 제너레이터 밖으로 나온다 / A late failure still leaves the generator."""
    class _BrokenStream(_FakeStreamClient):
        def converse_stream(self, **kwargs):
            self.calls.append(kwargs)

            def _events():
                yield _delta("a")
                raise RuntimeError("mid-stream")

            return {"stream": _events()}

    _install_client(monkeypatch, _BrokenStream())

    seen = []
    with pytest.raises(BedrockCallError):
        async for chunk in bedrock_ai.stream_invoke("p", 5):
            seen.append(chunk)

    assert seen == ["a"]


async def test_stream_invoke_raises_unavailable_without_credentials(monkeypatch, no_creds):
    """자격 증명 없음 → 제너레이터에서 BedrockUnavailableError / No credentials raise Unavailable."""
    created = _install_client(monkeypatch, _FakeStreamClient([_stop("end_turn")]))

    with pytest.raises(BedrockUnavailableError):
        _ = [c async for c in bedrock_ai.stream_invoke("p", 5)]

    assert created["count"] == 0


async def test_stream_invoke_pump_stops_reading_after_early_close(monkeypatch, creds, caplog):
    """
    조기 close 후 펌프는 스트림을 끝까지 읽지 않고 멈춘다 / After an early close the pump stops instead of draining.

    페이크가 블로킹이라 "끝까지 읽는" 구현은 tail_gate에서 막혀 스레드가 남는다(= 이 테스트가 잡는 회귀).
    The fake blocks, so a drain-to-end pump parks on tail_gate and the thread lingers — the regression
    this test exists to catch. 고아 스레드는 세마포어 해제 이후까지 살아남으면 안 된다 / an orphaned pump
    must not outlive the caller's semaphore release.
    """
    fake = _GatedStreamClient()
    _install_client(monkeypatch, fake)

    try:
        with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
            agen = bedrock_ai.stream_invoke("p", 10)
            assert await agen.__anext__() == "a"

            await agen.aclose()          # 소비자 이탈 → 취소 플래그 / consumer leaves, cancel flag set
            fake.gate.set()              # 다음 이벤트 하나를 흘려보낸다 / release exactly one more event

            assert await _await_pump_exit() == []
            # 취소 후 읽은 이벤트는 "b" 하나뿐 — "c"·messageStop까지 가지 않았다
            # Only "b" was read after cancellation: it never reached "c" or the messageStop.
            assert fake.produced == ["a", "b"]
            # 버린 스트림은 닫아 소켓을 돌려준다 / the abandoned stream is closed, releasing its socket
            assert fake.stream.closed is True
            # 조용한 취소: 버린 항목도 없고 경고도 없다 / a clean cancel logs nothing
            assert _error_payloads(caplog) == []
    finally:
        fake.release_all()
        await _await_pump_exit()


async def test_stream_invoke_logs_error_arriving_after_consumer_left(monkeypatch, creds, caplog):
    """소비자가 떠난 뒤의 실패도 로그로는 남는다 / A failure after the consumer left is still logged."""
    fake = _GatedStreamClient(error=RuntimeError("late boom"))
    _install_client(monkeypatch, fake)

    try:
        with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
            agen = bedrock_ai.stream_invoke("p", 10)
            assert await agen.__anext__() == "a"

            await agen.aclose()
            fake.gate.set()              # 게이트 뒤에서 스트림이 터진다 / the stream blows up past the gate

            assert await _await_pump_exit() == []
            payloads = _error_payloads(caplog)
            assert [p["event"] for p in payloads] == ["ai_stream_dropped"]
            assert payloads[0]["reason"] == "consumer_gone"
            assert payloads[0]["kind"] == "error"
            assert payloads[0]["error_type"] == "RuntimeError"
            assert "late boom" in payloads[0]["error"]
    finally:
        fake.release_all()
        await _await_pump_exit()


async def test_stream_invoke_logs_item_dropped_when_queue_put_fails(monkeypatch, creds, caplog):
    """큐 전달 실패(닫힌 루프)도 조용히 사라지지 않는다 / A failed queue put is logged, not silent."""
    fake = _FakeStreamClient([_delta("안"), _delta("녕"), _stop("end_turn")])
    _install_client(monkeypatch, fake)

    # 첫 전달만 닫힌 루프처럼 실패시킨다 (나머지는 그대로) / only the first put fails, as a closed loop would
    loop = asyncio.get_running_loop()
    real_call_soon = loop.call_soon_threadsafe
    remaining = {"failures": 1}

    def _flaky(callback, *args):
        if remaining["failures"]:
            remaining["failures"] -= 1
            raise RuntimeError("Event loop is closed")
        return real_call_soon(callback, *args)

    monkeypatch.setattr(loop, "call_soon_threadsafe", _flaky)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert [c async for c in bedrock_ai.stream_invoke("p", 5)] == ["녕"]
        assert await _await_pump_exit() == []

    payloads = _error_payloads(caplog)
    assert [p["event"] for p in payloads] == ["ai_stream_dropped"]
    assert payloads[0]["reason"] == "loop_closed"
    assert payloads[0]["kind"] == "delta"
    assert "Event loop is closed" in payloads[0]["detail"]
    # 델타 본문(모델 출력)은 로그에 남기지 않는다 / the delta text itself is never logged
    assert all("안" not in record.getMessage() for record in caplog.records)


# ---------------------------------------------------------------------------
# 스트리밍 variant / Streaming variants — 프롬프트는 블로킹 버전과 동일해야 한다
# The prompts must stay identical to the blocking versions
# ---------------------------------------------------------------------------

async def test_analyze_stock_stream_matches_blocking_prompt_and_token_cap(monkeypatch, creds):
    """종목 스트리밍: 프롬프트 동일 + maxTokens 1024 / Stock stream: same prompt, 1024 maxTokens."""
    blocking = FakeClient()
    _install_client(monkeypatch, blocking)
    analyze_stock(**STOCK_ARGS)
    expected = _bodies(blocking)[0]["messages"][0]["content"]

    fake = _FakeStreamClient([_delta("s"), _stop("end_turn")])
    _install_client(monkeypatch, fake)

    assert [c async for c in bedrock_ai.analyze_stock_stream(**STOCK_ARGS)] == ["s"]
    assert _prompt_of(fake) == expected
    assert fake.calls[0]["inferenceConfig"] == {"maxTokens": bedrock_ai.STOCK_MAX_TOKENS}
    assert bedrock_ai.STOCK_MAX_TOKENS == 1024


@pytest.mark.parametrize("is_korean", [True, False])
async def test_analyze_article_stream_matches_blocking_prompt_and_token_cap(monkeypatch, creds, is_korean):
    """기사 스트리밍: 프롬프트 동일 + maxTokens 2048 / Article stream: same prompt, 2048 maxTokens."""
    blocking = FakeClient()
    _install_client(monkeypatch, blocking)
    analyze_article("제목", "본문", is_korean)
    expected = _bodies(blocking)[0]["messages"][0]["content"]

    fake = _FakeStreamClient([_delta("a"), _stop("end_turn")])
    _install_client(monkeypatch, fake)

    assert [c async for c in bedrock_ai.analyze_article_stream("제목", "본문", is_korean)] == ["a"]
    assert _prompt_of(fake) == expected
    assert fake.calls[0]["inferenceConfig"] == {"maxTokens": bedrock_ai.ARTICLE_MAX_TOKENS}
    assert bedrock_ai.ARTICLE_MAX_TOKENS == 2048


async def test_stock_stream_bad_input_raises_call_error_without_calling_model(stream_client, caplog):
    """price=None → 조립 실패도 BedrockCallError + 모델 미호출 / Assembly failure maps typed, no invoke."""
    fake = stream_client([_stop("end_turn")])

    with caplog.at_level(logging.ERROR, logger=LOGGER_NAME):
        with pytest.raises(BedrockCallError):
            _ = [c async for c in bedrock_ai.analyze_stock_stream(**dict(STOCK_ARGS, price=None))]

    assert fake.calls == []
    payloads = _error_payloads(caplog)
    assert len(payloads) == 1
    assert payloads[0]["error_type"] == "TypeError"


async def test_article_stream_bad_input_raises_call_error_without_calling_model(stream_client):
    """content=None도 동일 / A None article content behaves the same."""
    fake = stream_client([_stop("end_turn")])

    with pytest.raises(BedrockCallError):
        _ = [c async for c in bedrock_ai.analyze_article_stream("t", None, True)]

    assert fake.calls == []
