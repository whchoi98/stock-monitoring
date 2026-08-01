"""
시장 요약 서비스 테스트 - 고정 Quote 목록으로 breadth/top3/섹터 검증 (네트워크 호출 없음)
Market summary service tests - breadth/top3/sectors over fixed Quote lists (no network calls).
"""
import json
import logging

import pytest

from app.models import Quote
from app.services.summary import build_sectors, build_summary

LOGGER_NAME = "app.services.summary"


def _quote(symbol, change_pct, volume, sector="Technology", market="us"):
    """고정 Quote 빌더 / Fixed Quote builder."""
    return Quote(
        symbol=symbol,
        name=f"Name {symbol}",
        price=100.0,
        change=change_pct,
        change_pct=change_pct,
        volume=volume,
        market=market,
        currency="USD" if market == "us" else "KRW",
        sector=sector,
    )


# 고정 6종목: 상승 3 / 보합 1 / 하락 2 / Fixed six: 3 up, 1 flat, 2 down
QA = _quote("AAA", 5.0, 100)
QB = _quote("BBB", 3.0, 500)
QC = _quote("CCC", 0.0, 300)
QD = _quote("DDD", -1.0, 900)
QE = _quote("EEE", -4.0, 200)
QF = _quote("FFF", 3.0, 700)      # BBB와 동률 / ties with BBB
US_QUOTES = [QA, QB, QC, QD, QE, QF]

KA = _quote("111.KS", 2.0, 50, market="kr")
KB = _quote("222.KS", -2.0, 80, market="kr")
KR_QUOTES = [KA, KB]


def _warning_payloads(caplog):
    """경고 로그가 단일 라인 JSON임을 확인하고 파싱 / Assert single-line JSON warnings and parse them."""
    payloads = []
    for record in caplog.records:
        if record.name != LOGGER_NAME or record.levelno < logging.WARNING:
            continue
        message = record.getMessage()
        assert "\n" not in message
        payloads.append(json.loads(message))
    return payloads


# ---------------------------------------------------------------------------
# build_summary
# ---------------------------------------------------------------------------

def test_summary_shape_has_both_markets_with_fixed_keys():
    """반환 구조는 시장별 breadth + top3 3종 / Shape is per-market breadth plus three top-3 lists."""
    result = build_summary(US_QUOTES, KR_QUOTES)

    assert set(result) == {"us", "kr"}
    for market in ("us", "kr"):
        assert set(result[market]) == {
            "advancing",
            "declining",
            "top_gainers",
            "top_losers",
            "volume_leaders",
        }


def test_summary_breadth_ignores_unchanged_quotes():
    """change_pct == 0은 상승도 하락도 아니다 / change_pct == 0 counts as neither."""
    us = build_summary(US_QUOTES, KR_QUOTES)["us"]

    assert us["advancing"] == 3
    assert us["declining"] == 2


def test_summary_top_lists_are_ordered_and_capped_at_three():
    """상승/하락/거래량 상위 3개, 동률은 입력 순서 / Top 3 each; ties keep input order."""
    us = build_summary(US_QUOTES, KR_QUOTES)["us"]

    assert [q["symbol"] for q in us["top_gainers"]] == ["AAA", "BBB", "FFF"]
    assert [q["symbol"] for q in us["top_losers"]] == ["EEE", "DDD", "CCC"]
    assert [q["symbol"] for q in us["volume_leaders"]] == ["DDD", "FFF", "BBB"]


def test_summary_entries_are_full_quote_dicts():
    """항목은 Quote.model_dump() 전체 필드 / Entries are complete Quote.model_dump() dicts."""
    us = build_summary(US_QUOTES, KR_QUOTES)["us"]

    assert us["top_gainers"][0] == QA.model_dump()
    assert json.dumps(build_summary(US_QUOTES, KR_QUOTES))  # JSON 직렬화 가능 / JSON serializable


def test_summary_returns_what_exists_when_fewer_than_three():
    """3개 미만이면 있는 만큼만 / Fewer than three stocks returns what exists."""
    kr = build_summary(US_QUOTES, KR_QUOTES)["kr"]

    assert [q["symbol"] for q in kr["top_gainers"]] == ["111.KS", "222.KS"]
    assert [q["symbol"] for q in kr["top_losers"]] == ["222.KS", "111.KS"]
    assert [q["symbol"] for q in kr["volume_leaders"]] == ["222.KS", "111.KS"]
    assert (kr["advancing"], kr["declining"]) == (1, 1)


def test_summary_handles_empty_markets():
    """빈 입력은 0/빈 리스트 / Empty input yields zeros and empty lists."""
    result = build_summary([], [])

    for market in ("us", "kr"):
        assert result[market] == {
            "advancing": 0,
            "declining": 0,
            "top_gainers": [],
            "top_losers": [],
            "volume_leaders": [],
        }


def test_summary_does_not_mutate_input_order():
    """입력 리스트 순서를 변경하지 않는다 / The input list order is left untouched."""
    quotes = list(US_QUOTES)
    build_summary(quotes, [])

    assert quotes == US_QUOTES


# ---------------------------------------------------------------------------
# build_sectors
# ---------------------------------------------------------------------------

def test_sectors_average_change_pct_sorted_by_absolute_value():
    """섹터 평균 등락률, |평균| 내림차순 / Sector average change_pct, sorted by |avg| desc."""
    quotes = [
        _quote("T1", 2.0, 10, sector="Technology"),
        _quote("T2", 4.0, 10, sector="Technology"),
        _quote("E1", -5.0, 10, sector="Energy"),
        _quote("F1", 1.0, 10, sector="Financial"),
        _quote("F2", -1.0, 10, sector="Financial"),
    ]

    assert build_sectors(quotes) == [
        {"sector": "Energy", "avg_change_pct": -5.0, "count": 1},
        {"sector": "Technology", "avg_change_pct": 3.0, "count": 2},
        {"sector": "Financial", "avg_change_pct": 0.0, "count": 2},
    ]


def test_sectors_are_capped_at_eight():
    """상위 8개만 반환 / Only the top eight sectors are returned."""
    quotes = [_quote(f"S{i}", float(i), 10, sector=f"Sector{i}") for i in range(1, 11)]

    rows = build_sectors(quotes)

    assert len(rows) == 8
    assert [r["sector"] for r in rows] == [f"Sector{i}" for i in range(10, 2, -1)]


def test_sectors_ties_keep_input_order():
    """|평균| 동률은 입력 순서 유지 / Ties on |avg| keep input order."""
    quotes = [
        _quote("A1", 2.0, 10, sector="Alpha"),
        _quote("B1", -2.0, 10, sector="Beta"),
    ]

    assert [r["sector"] for r in build_sectors(quotes)] == ["Alpha", "Beta"]


def test_sectors_fall_back_to_config_mapping_when_quote_sector_is_blank():
    """Quote.sector가 비면 config.STOCK_SECTORS로 보완 / Blank Quote.sector falls back to config."""
    rows = build_sectors([_quote("AAPL", 1.0, 10, sector="")])

    assert rows == [{"sector": "Technology", "avg_change_pct": 1.0, "count": 1}]


def test_sectors_skip_unknown_sector_with_warning(caplog):
    """섹터를 알 수 없으면 경고 후 제외 (조용한 실패 금지) / Unknown sectors are logged and skipped."""
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        rows = build_sectors(
            [_quote("ZZZZ", 1.0, 10, sector=""), _quote("T1", 2.0, 10, sector="Technology")]
        )

    assert rows == [{"sector": "Technology", "avg_change_pct": 2.0, "count": 1}]
    payloads = _warning_payloads(caplog)
    assert [p["event"] for p in payloads] == ["sector_unknown"]
    assert payloads[0]["symbol"] == "ZZZZ"


def test_sectors_average_is_rounded_to_two_decimals():
    """평균은 소수 2자리로 반올림 / The average is rounded to two decimals."""
    quotes = [
        _quote("A1", 1.0, 10, sector="Alpha"),
        _quote("A2", 1.0, 10, sector="Alpha"),
        _quote("A3", 2.0, 10, sector="Alpha"),
    ]

    assert build_sectors(quotes) == [{"sector": "Alpha", "avg_change_pct": 1.33, "count": 3}]


def test_sectors_handles_empty_input():
    """빈 입력은 빈 리스트 / Empty input yields an empty list."""
    assert build_sectors([]) == []
