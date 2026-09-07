"""
설정 검증 테스트 / Configuration validation tests.
"""
from app.core import config


def test_kr_symbols_have_suffix():
    """한국 종목이 .KS 또는 .KQ 접미사를 가지고 있는지 검증 / Verify KR stocks have .KS or .KQ suffix."""
    assert all(s.endswith((".KS", ".KQ")) for s in config.KR_STOCKS), \
        "All KR stocks must end with .KS or .KQ"
    assert "005930.KS" in config.KR_STOCKS, \
        "Samsung Electronics (005930) should have .KS suffix"
    assert "247540.KQ" in config.KR_STOCKS, \
        "Ecopro BM (247540) should have .KQ suffix"
    assert len(config.KR_STOCKS) == 50, \
        f"Expected 50 KR stocks, got {len(config.KR_STOCKS)}"
    assert len(config.US_STOCKS) == 50, \
        f"Expected 50 US stocks, got {len(config.US_STOCKS)}"


def test_names_and_sectors_cover_universe():
    """모든 주식(US + KR)의 이름과 섹터가 설정되어 있는지 검증 / Verify all stocks have names and sectors."""
    all_stocks = config.US_STOCKS + config.KR_STOCKS

    for symbol in all_stocks:
        assert symbol in config.STOCK_NAMES, \
            f"Stock {symbol} missing in STOCK_NAMES"
        assert symbol in config.STOCK_SECTORS, \
            f"Stock {symbol} missing in STOCK_SECTORS"


def test_korean_names_cover_universe():
    """모든 종목에 한글 종목명이 있고 대표 종목의 표기가 맞는지 검증 / Every stock has a Korean name; spot-check the wording."""
    for symbol in config.US_STOCKS + config.KR_STOCKS:
        assert symbol in config.STOCK_NAMES_KO, f"Stock {symbol} missing in STOCK_NAMES_KO"
        assert config.STOCK_NAMES_KO[symbol].strip(), f"Stock {symbol} has a blank Korean name"
    assert config.STOCK_NAMES_KO["005930.KS"] == "삼성전자"
    assert config.STOCK_NAMES_KO["247540.KQ"] == "에코프로비엠"
    assert config.STOCK_NAMES_KO["AAPL"] == "애플"
    # 관용적 한글 표기가 없는 종목은 영문 표기를 그대로 둔다 / Names without a customary Korean form keep the Latin one
    assert config.STOCK_NAMES_KO["030200.KS"] == "KT"


def test_constants_present():
    """모든 필수 상수가 설정되어 있는지 검증 / Verify all required constants are present."""
    assert hasattr(config, "REFRESH_INTERVAL"), "REFRESH_INTERVAL not found"
    assert config.REFRESH_INTERVAL == 45, "REFRESH_INTERVAL should be 45"

    assert hasattr(config, "NEWS_REFRESH_INTERVAL"), "NEWS_REFRESH_INTERVAL not found"
    assert config.NEWS_REFRESH_INTERVAL == 120, "NEWS_REFRESH_INTERVAL should be 120"

    assert hasattr(config, "CLOSED_REFRESH_INTERVAL"), "CLOSED_REFRESH_INTERVAL not found"
    assert config.CLOSED_REFRESH_INTERVAL == 600, "CLOSED_REFRESH_INTERVAL should be 600"

    assert hasattr(config, "CHART_TTL"), "CHART_TTL not found"
    assert isinstance(config.CHART_TTL, dict), "CHART_TTL should be a dict"
    assert config.CHART_TTL["1w"] == 600, "1w TTL should be 600"
    assert config.CHART_TTL["1m"] == 3600, "1m TTL should be 3600"

    assert hasattr(config, "FUNDAMENTALS_TTL"), "FUNDAMENTALS_TTL not found"
    assert config.FUNDAMENTALS_TTL == 43200, "FUNDAMENTALS_TTL should be 43200"

    assert hasattr(config, "AI_TTL"), "AI_TTL not found"
    assert config.AI_TTL == 21600, "AI_TTL should be 21600"

    assert hasattr(config, "L2_TTL"), "L2_TTL not found"
    assert config.L2_TTL == 86400, "L2_TTL should be 86400"

    assert hasattr(config, "AI_RATE_PER_MIN"), "AI_RATE_PER_MIN not found"
    assert config.AI_RATE_PER_MIN == 3, "AI_RATE_PER_MIN should be 3"

    assert hasattr(config, "AI_GLOBAL_CONCURRENCY"), "AI_GLOBAL_CONCURRENCY not found"
    assert config.AI_GLOBAL_CONCURRENCY == 2, "AI_GLOBAL_CONCURRENCY should be 2"


def test_indices_defined():
    """지수 설정이 정의되어 있는지 검증 / Verify indices are defined."""
    assert len(config.US_INDICES) > 0, "US_INDICES should not be empty"
    assert "^GSPC" in config.US_INDICES, "^GSPC (S&P 500) should be in US_INDICES"

    assert len(config.KR_INDICES) > 0, "KR_INDICES should not be empty"
    assert "^KS11" in config.KR_INDICES, "^KS11 (KOSPI) should be in KR_INDICES"


def test_indicators_and_feeds_defined():
    """경제 지표와 뉴스 피드가 정의되어 있는지 검증 / Verify indicators and news feeds are defined."""
    assert len(config.INDICATORS) > 0, "INDICATORS should not be empty"
    assert len(config.SECTOR_INDICATOR_MAP) > 0, "SECTOR_INDICATOR_MAP should not be empty"
    assert len(config.NEWS_FEEDS) > 0, "NEWS_FEEDS should not be empty"


def test_kosdaq_symbols_correctly_tagged():
    """KOSDAQ 종목이 올바르게 .KQ로 태그되어 있는지 검증 / Verify KOSDAQ symbols are correctly tagged with .KQ."""
    kosdaq_codes = {"247540", "259960", "326030", "323410", "361610", "352820"}

    for symbol in config.KR_STOCKS:
        code = symbol.split(".")[0]
        suffix = symbol.split(".")[1]

        if code in kosdaq_codes:
            assert suffix == "KQ", f"KOSDAQ code {code} should have .KQ suffix, got .{suffix}"
        else:
            assert suffix == "KS", f"KOSPI code {code} should have .KS suffix, got .{suffix}"


def test_environment_variables():
    """환경 변수 기본값이 설정되어 있는지 검증 / Verify environment variables have defaults."""
    assert hasattr(config, "CACHE_TABLE"), "CACHE_TABLE not found"
    assert config.CACHE_TABLE == "stock-monitoring-cache", \
        f"CACHE_TABLE default should be 'stock-monitoring-cache', got '{config.CACHE_TABLE}'"

    # `global.` 접두사가 계약이다 — `ap-northeast-2`에 `us.` sonnet-4-6 프로필이 없어서 기본값을 그것으로
    # 되돌리면 AI 두 엔드포인트가 ValidationException으로 죽는다 (2026-08-02 정정).
    # The `global.` prefix is the contract: `ap-northeast-2` has no `us.` sonnet-4-6 profile, so reverting the
    # default would kill both AI endpoints with a ValidationException (corrected 2026-08-02).
    assert hasattr(config, "BEDROCK_MODEL_ID"), "BEDROCK_MODEL_ID not found"
    assert config.BEDROCK_MODEL_ID == "global.anthropic.claude-sonnet-4-6", \
        f"BEDROCK_MODEL_ID default incorrect, got '{config.BEDROCK_MODEL_ID}'"

    assert hasattr(config, "BEDROCK_REGION"), "BEDROCK_REGION not found"
    assert config.BEDROCK_REGION == "ap-northeast-2", \
        f"BEDROCK_REGION default should be 'ap-northeast-2', got '{config.BEDROCK_REGION}'"
