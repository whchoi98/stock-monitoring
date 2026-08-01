"""
시뮬레이션 서비스 테스트 - 시드 주입으로 결정적 검증 (네트워크 호출 없음)
Simulation service tests - deterministic via injected seed (no network calls).
"""
import json
import logging

import pytest

from app.services.simulation import build_investor_trends, build_order_book

LOGGER_NAME = "app.services.simulation"

KR_PRICE = 70000.0


def _sides(book):
    """side별 (가격, 수량) 분리 / Split entries per side into (price, qty)."""
    asks = [(e.price, e.qty) for e in book if e.side == "ask"]
    bids = [(e.price, e.qty) for e in book if e.side == "bid"]
    return asks, bids


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
# 호가 시뮬레이션 / Order book simulation
# ---------------------------------------------------------------------------

def test_order_book_is_deterministic_for_the_same_seed():
    """같은 시드는 완전히 동일한 호가를 만든다 / The same seed reproduces an identical book."""
    first = build_order_book(KR_PRICE, "kr", seed=42)
    second = build_order_book(KR_PRICE, "kr", seed=42)

    assert first == second
    assert [e.model_dump() for e in first] == [e.model_dump() for e in second]


def test_order_book_seed_changes_quantities():
    """다른 시드는 다른 수량을 만든다 (전역 random 미사용 확인) / A different seed yields different quantities."""
    a = [e.qty for e in build_order_book(KR_PRICE, "kr", seed=42)]
    b = [e.qty for e in build_order_book(KR_PRICE, "kr", seed=7)]

    assert a != b


def test_order_book_is_unaffected_by_global_random_state():
    """전역 random.seed는 결과에 영향이 없다 / Global random.seed must not influence the result."""
    import random

    random.seed(1)
    first = build_order_book(KR_PRICE, "kr", seed=42)
    random.seed(999)
    [random.random() for _ in range(5)]
    second = build_order_book(KR_PRICE, "kr", seed=42)

    assert first == second


def test_order_book_has_ten_asks_above_and_ten_bids_below_price():
    """ask 10 + bid 10, 모든 ask > 현재가 > 모든 bid / 10 asks + 10 bids straddling the price."""
    book = build_order_book(KR_PRICE, "kr", seed=42)
    asks, bids = _sides(book)

    assert len(book) == 20
    assert len(asks) == 10
    assert len(bids) == 10
    assert all(price > KR_PRICE for price, _ in asks)
    assert all(KR_PRICE > price > 0 for price, _ in bids)


def test_order_book_quantities_are_within_simulated_band():
    """수량은 100 x uniform(0.3, 3.0) 범위 / Quantities stay inside 100 x uniform(0.3, 3.0)."""
    book = build_order_book(KR_PRICE, "kr", seed=42)

    assert all(30 <= e.qty <= 300 for e in book)


def test_order_book_draws_asks_before_bids():
    """수량 추첨 순서(ask 10개 → bid 10개)를 고정 / Pin the draw order: 10 asks, then 10 bids."""
    book = build_order_book(KR_PRICE, "kr", seed=42)

    # random.Random(42) 첫 3개 추첨 / first three draws of random.Random(42)
    assert [e.qty for e in book][:3] == [202, 36, 104]
    assert [e.side for e in book] == ["ask"] * 10 + ["bid"] * 10


def test_order_book_kr_tick_is_500_above_50000():
    """KR 5만원 초과는 틱 500원 / KR tick is 500 KRW above 50,000."""
    asks, bids = _sides(build_order_book(70000.0, "kr", seed=1))

    assert [price for price, _ in asks][:3] == [70070.0, 70570.0, 71070.0]
    assert [price for price, _ in bids][:3] == [69930.0, 69430.0, 68930.0]


def test_order_book_kr_tick_is_100_at_or_below_50000():
    """KR 5만원 이하는 틱 100원 / KR tick is 100 KRW at or below 50,000."""
    asks, bids = _sides(build_order_book(30000.0, "kr", seed=1))

    assert [price for price, _ in asks][:3] == [30030.0, 30130.0, 30230.0]
    assert [price for price, _ in bids][:3] == [29970.0, 29870.0, 29770.0]


@pytest.mark.parametrize(
    "price, expected_asks",
    [
        (5.0, [5.005, 5.015, 5.025]),        # < 10 -> 0.01
        (30.0, [30.03, 30.08, 30.13]),       # < 50 -> 0.05
        (150.0, [150.15, 150.25, 150.35]),   # >= 50 -> 0.10
    ],
)
def test_order_book_us_tick_bands(price, expected_asks):
    """US 틱은 가격대별 0.01/0.05/0.10 / US ticks are 0.01/0.05/0.10 by price band."""
    asks, _ = _sides(build_order_book(price, "us", seed=1))

    assert [p for p, _ in asks][:3] == expected_asks


def test_order_book_market_is_case_insensitive():
    """market 대소문자 무관 (TUI는 "KR", 백엔드는 "kr") / market is case-insensitive."""
    assert build_order_book(KR_PRICE, "KR", seed=42) == build_order_book(KR_PRICE, "kr", seed=42)


def test_order_book_returns_empty_for_non_positive_price(caplog):
    """현재가가 0 이하면 빈 호가 + 경고 / Non-positive price yields an empty book plus a warning."""
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert build_order_book(0.0, "kr", seed=42) == []
        assert build_order_book(-1.0, "us", seed=42) == []

    events = [p["event"] for p in _warning_payloads(caplog)]
    assert events == ["order_book_price_invalid", "order_book_price_invalid"]


def test_order_book_rejects_unknown_market():
    """지원하지 않는 market은 ValueError / Unsupported market raises ValueError."""
    with pytest.raises(ValueError, match="unsupported market"):
        build_order_book(KR_PRICE, "jp", seed=42)


def test_order_book_drops_non_positive_bid_levels(caplog):
    """틱이 가격보다 커서 bid가 0 이하가 되면 해당 단계는 버리고 경고 / Non-positive bid levels are dropped loudly."""
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        book = build_order_book(600.0, "kr", seed=1)  # tick 100 -> 10th bid would be negative

    asks, bids = _sides(book)
    assert len(asks) == 10
    assert 0 < len(bids) < 10
    assert all(price > 0 for price, _ in bids)
    assert [p["event"] for p in _warning_payloads(caplog)] == ["order_book_bid_underflow"]


# ---------------------------------------------------------------------------
# 수급 시뮬레이션 / Investor trend simulation
# ---------------------------------------------------------------------------

US_HISTORY = [
    ("08/01", 100.0, 1_000_000),   # 첫 행 -> 상승 취급 / first row -> treated as up
    ("08/02", 101.0, 500_000),     # 상승 / up
    ("08/03", 99.0, 400_000),      # 하락 / down
]

KR_HISTORY = [
    ("08/01", 1000.0, 1_000_000),
    ("08/02", 990.0, 2_000_000),
]


def test_investor_trends_us_ratios():
    """US 비율: 기관 70%x0.1, 외인 15%x0.8, 개인 10%x0.05(역방향) / US ratio port."""
    rows = build_investor_trends(US_HISTORY, "us")

    assert [r.date for r in rows] == ["08/01", "08/02", "08/03"]
    assert (rows[0].individual, rows[0].foreign, rows[0].institution) == (-5000, 120000, 70000)
    assert (rows[1].individual, rows[1].foreign, rows[1].institution) == (-2500, 60000, 35000)
    assert (rows[2].individual, rows[2].foreign, rows[2].institution) == (2000, -48000, -28000)


def test_investor_trends_kr_ratios_with_individuals_against_the_trend():
    """KR 비율: 개인 60%x0.05(역방향), 외인 30%x0.08, 기관 10%x0.15 / KR ratio port."""
    rows = build_investor_trends(KR_HISTORY, "kr")

    assert (rows[0].individual, rows[0].foreign, rows[0].institution) == (-30000, 24000, 15000)
    assert (rows[1].individual, rows[1].foreign, rows[1].institution) == (60000, -48000, -30000)


@pytest.mark.parametrize("market", ["us", "kr"])
def test_investor_trends_components_are_signed_volume_fractions(market):
    """각 주체 수량 = ±거래량 x 비율, 개인은 항상 반대 부호 / Each component is a signed fraction of volume."""
    shares = {
        "us": {"individual": (0.1, 0.05), "foreign": (0.15, 0.8), "institution": (0.7, 0.1)},
        "kr": {"individual": (0.6, 0.05), "foreign": (0.3, 0.08), "institution": (0.1, 0.15)},
    }[market]
    history = [("08/01", 100.0, 1_000_000), ("08/02", 90.0, 800_000)]

    rows = build_investor_trends(history, market)

    for row, (volume, direction) in zip(rows, [(1_000_000, 1), (800_000, -1)]):
        for name, (share, participation) in shares.items():
            sign = -direction if name == "individual" else direction
            assert getattr(row, name) == int(volume * share * participation * sign)
        # 상승일에는 기관/외인 순매수, 개인 순매도 / Up days: institutions & foreigners buy, individuals sell
        assert (row.institution > 0) is (direction > 0)
        assert (row.foreign > 0) is (direction > 0)
        assert (row.individual < 0) is (direction > 0)


def test_investor_trends_direction_uses_previous_close():
    """방향은 전일 종가 대비로 결정 (동일가는 상승 취급) / Direction compares to the previous close (flat counts as up)."""
    rows = build_investor_trends(
        [("08/01", 100.0, 1000), ("08/02", 100.0, 1000), ("08/03", 90.0, 1000)],
        "kr",
    )

    assert rows[0].institution > 0
    assert rows[1].institution > 0   # 보합 -> 상승 / flat -> up
    assert rows[2].institution < 0


def test_investor_trends_empty_history_returns_empty():
    """빈 히스토리는 빈 리스트 / Empty history yields an empty list."""
    assert build_investor_trends([], "us") == []


def test_investor_trends_zero_volume_rows_are_zero():
    """거래량 0이면 모든 주체 0 / Zero volume produces all-zero rows."""
    rows = build_investor_trends([("08/01", 100.0, 0)], "kr")

    assert (rows[0].individual, rows[0].foreign, rows[0].institution) == (0, 0, 0)


def test_investor_trends_is_deterministic():
    """수급은 랜덤 요소가 없다 / Investor trends carry no randomness."""
    assert build_investor_trends(US_HISTORY, "us") == build_investor_trends(US_HISTORY, "us")


def test_investor_trends_market_is_case_insensitive():
    """market 대소문자 무관 / market is case-insensitive."""
    assert build_investor_trends(KR_HISTORY, "KR") == build_investor_trends(KR_HISTORY, "kr")


def test_investor_trends_rejects_unknown_market():
    """지원하지 않는 market은 ValueError / Unsupported market raises ValueError."""
    with pytest.raises(ValueError, match="unsupported market"):
        build_investor_trends(US_HISTORY, "jp")


def test_order_book_does_not_disturb_global_random_state():
    """호가 생성이 전역 random 상태를 소비/재시드하지 않는다 / Building a book neither reseeds nor consumes global random."""
    import random

    random.seed(123)
    expected = [random.random() for _ in range(3)]

    random.seed(123)
    build_order_book(KR_PRICE, "kr", seed=42)

    assert [random.random() for _ in range(3)] == expected
