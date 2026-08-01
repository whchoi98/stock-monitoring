"""
시뮬레이션 서비스 - 호가(오더북)/수급을 현재가·거래량에서 파생 (실데이터 아님)
Simulation service - derives the order book and investor supply/demand from price/volume (not real data).

실시간 호가·투자자별 순매수 데이터 소스가 없어 TUI(`stock-on-tui/services/stock_detail_data.py`의
`fetch_order_book` / `_fetch_us_investor_trends` / `_fetch_kr_investor_trends`)의 시뮬레이션 규칙을 포팅했다.
Ported from the TUI's simulation rules because no live order-book / investor-flow source exists.

TUI와의 차이 / Differences from the TUI:
1. 데이터를 직접 조회하지 않고 인자로 받는다 (yfinance 의존 제거, 순수 함수).
   Data arrives as arguments instead of being fetched (no yfinance dependency: pure functions).
2. 전역 `random.seed()` 대신 `random.Random(seed)`를 주입한다 (결정적 + 다른 코드에 영향 없음).
   An injected `random.Random(seed)` replaces global `random.seed()` (deterministic, no global side effect).
3. 수급 방향은 TUI의 종가-시가 대신 전일 종가 대비로 판단한다 (인자가 (date, close, volume)이므로 시가가 없다).
   Direction compares against the previous close instead of the TUI's close-minus-open (no open in the input).

라우트는 이 결과에 반드시 `"simulated": true`를 붙여야 한다.
Routes must tag these results with `"simulated": true`.
"""
from __future__ import annotations

import json
import logging
import random
from typing import Any, Iterable, Optional, Sequence, Tuple

from app.models import InvestorRow, OrderBookEntry

logger = logging.getLogger(__name__)

# 매도/매수 각 호가 단계 수 / Number of ask and bid levels each
ORDER_BOOK_LEVELS = 10
# 호가 기준가 = 현재가 ±0.1% / Order book base prices are the current price ±0.1%
BID_FACTOR = 0.999
ASK_FACTOR = 1.001
# 시뮬레이션 수량: 100 x uniform(0.3, 3.0) / Simulated quantity: 100 x uniform(0.3, 3.0)
QTY_BASE = 100
QTY_MIN_MULT = 0.3
QTY_MAX_MULT = 3.0
# 부동소수 오차만 제거하는 반올림 자리수 (0.1% 밴드를 삼키지 않을 만큼 깊게)
# Rounding depth that removes float noise only (deep enough to preserve the 0.1% band)
PRICE_DECIMALS = 6

# KR 호가 단위 / KR tick sizes
KR_TICK_THRESHOLD = 50000
KR_TICK_ABOVE = 500.0
KR_TICK_BELOW = 100.0
# US 호가 단위: (상한 가격, 틱) - 상한 미만이면 해당 틱 / US ticks: (upper bound, tick), first match wins
US_TICKS = ((10.0, 0.01), (50.0, 0.05))
US_TICK_DEFAULT = 0.10

# 수급 비율 (market -> 주체 -> (거래량 비중, 참여율)) — TUI 계수를 곱셈 순서까지 그대로 유지
# Investor ratios (market -> participant -> (volume share, participation)); TUI factors kept in order
INVESTOR_RATIOS = {
    # US: 기관 70%x0.1, 외국인 15%x0.8, 개인 10%x0.05 / inst 70%x0.1, foreign 15%x0.8, individual 10%x0.05
    "us": {"individual": (0.1, 0.05), "foreign": (0.15, 0.8), "institution": (0.7, 0.1)},
    # KR: 개인 60%x0.05, 외국인 30%x0.08, 기관 10%x0.15 / individual 60%x0.05, foreign 30%x0.08, inst 10%x0.15
    "kr": {"individual": (0.6, 0.05), "foreign": (0.3, 0.08), "institution": (0.1, 0.15)},
}

_MARKETS = ("us", "kr")


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _normalize_market(market: str) -> str:
    """
    market 인자를 "us"/"kr"로 정규화 / Normalize the market argument to "us"/"kr".

    TUI는 "US"/"KR", 백엔드 Quote는 "us"/"kr"를 쓰므로 대소문자를 모두 받는다.
    The TUI uses "US"/"KR" while backend quotes use "us"/"kr", so both cases are accepted.

    Raises:
        ValueError: 지원하지 않는 시장 / Unsupported market.
    """
    normalized = str(market).strip().lower()
    if normalized not in _MARKETS:
        raise ValueError(f"unsupported market: {market!r} (expected one of {list(_MARKETS)})")
    return normalized


def _tick_size(price: float, market: str) -> float:
    """
    시장·가격대별 호가 단위 / Tick size per market and price band.

    KR: 5만원 초과 500원, 이하 100원. US: 10달러 미만 0.01, 50달러 미만 0.05, 그 외 0.10.
    KR: 500 KRW above 50,000 else 100. US: 0.01 below $10, 0.05 below $50, otherwise 0.10.
    """
    if market == "kr":
        return KR_TICK_ABOVE if price > KR_TICK_THRESHOLD else KR_TICK_BELOW
    for upper, tick in US_TICKS:
        if price < upper:
            return tick
    return US_TICK_DEFAULT


def _qty(rng: random.Random) -> int:
    """시뮬레이션 호가 수량 1건 추첨 / Draw a single simulated order quantity."""
    return int(QTY_BASE * rng.uniform(QTY_MIN_MULT, QTY_MAX_MULT))


# ---------------------------------------------------------------------------
# 호가 시뮬레이션 / Order book simulation
# ---------------------------------------------------------------------------

def build_order_book(price: float, market: str, seed: int) -> list[OrderBookEntry]:
    """
    현재가 기반 호가 시뮬레이션 (실제 호가 아님) / Simulate an order book from the current price (not real depth).

    매도 10단계는 현재가+0.1%에서 틱 간격으로 위로, 매수 10단계는 현재가-0.1%에서 아래로 만든다.
    수량은 주입된 시드의 `random.Random`에서 뽑으므로 같은 시드는 항상 같은 호가를 만든다 (전역 random 미사용).
    Ten ask levels step up from price+0.1%, ten bid levels step down from price-0.1%.
    Quantities come from an injected seeded `random.Random`, so one seed always yields one book.

    반환 순서는 매도 10건 → 매수 10건 (TUI와 동일) / Ordering is 10 asks then 10 bids (same as the TUI).

    Args:
        price: 현재가 / Current price.
        market: "us" | "kr" (대소문자 무관) / "us" | "kr" (case-insensitive).
        seed: 수량 추첨 시드 / Seed for the quantity draws.

    Returns:
        OrderBookEntry 20건. 현재가가 0 이하면 빈 리스트 (경고 로그).
        20 OrderBookEntry items; an empty list (with a warning) when the price is not positive.
        틱이 커서 매수 단계가 0 이하로 내려가면 그 단계는 제외한다 (경고 로그).
        Bid levels that would fall to zero or below are dropped (with a warning).

    Raises:
        ValueError: 지원하지 않는 시장 / Unsupported market.
    """
    normalized = _normalize_market(market)
    if price <= 0:
        # 조용한 실패 금지: 호가를 만들 근거가 없다 / No silent failure: nothing to build a book from.
        _warn("order_book_price_invalid", price=price, market=normalized)
        return []

    tick = _tick_size(price, normalized)
    rng = random.Random(seed)

    entries: list[OrderBookEntry] = []
    ask_base = price * ASK_FACTOR
    for level in range(ORDER_BOOK_LEVELS):
        entries.append(
            OrderBookEntry(
                price=round(ask_base + tick * level, PRICE_DECIMALS),
                qty=_qty(rng),
                side="ask",
            )
        )

    bid_base = price * BID_FACTOR
    dropped = 0
    for level in range(ORDER_BOOK_LEVELS):
        bid_price = round(bid_base - tick * level, PRICE_DECIMALS)
        # 수량은 항상 추첨해 시드 소비 순서를 고정한다 / Always draw so seed consumption stays fixed.
        qty = _qty(rng)
        if bid_price <= 0:
            dropped += 1
            continue
        entries.append(OrderBookEntry(price=bid_price, qty=qty, side="bid"))

    if dropped:
        _warn(
            "order_book_bid_underflow",
            price=price,
            market=normalized,
            tick=tick,
            dropped_levels=dropped,
        )
    return entries


# ---------------------------------------------------------------------------
# 수급 시뮬레이션 / Investor trend simulation
# ---------------------------------------------------------------------------

def build_investor_trends(
    history: Sequence[Tuple[str, float, int]],
    market: str,
) -> list[InvestorRow]:
    """
    거래량·종가 방향에서 투자자별 순매수 시뮬레이션 / Simulate investor net buying from volume and close direction.

    상승(전일 종가 이상)이면 기관·외국인 순매수, 개인은 반대 방향(순매도)이고 하락이면 모두 부호가 뒤집힌다.
    주체별 수량은 `거래량 x 비중 x 참여율`이며 비중/참여율은 시장별 TUI 계수를 그대로 쓴다.
    On up days (close >= previous close) institutions and foreigners are net buyers while individuals
    are net sellers; every sign flips on down days. Each amount is `volume x share x participation`,
    using the TUI's per-market coefficients.

    랜덤 요소가 없어 같은 입력은 항상 같은 결과를 준다 / No randomness: identical input, identical output.

    Args:
        history: 오래된 순서의 (date, close, volume) 행 / (date, close, volume) rows, oldest first.
            date는 그대로 반환에 전달된다 (포맷은 호출부 책임).
            The date string passes through untouched (formatting is the caller's concern).
        market: "us" | "kr" (대소문자 무관) / "us" | "kr" (case-insensitive).

    Returns:
        입력과 같은 순서·길이의 InvestorRow 리스트 / InvestorRow list matching input order and length.
        첫 행은 비교할 전일 종가가 없어 상승으로 취급한다 / The first row has no previous close: treated as up.

    Raises:
        ValueError: 지원하지 않는 시장, 또는 행 형태가 (date, close, volume)이 아닐 때.
            Unsupported market, or a row that is not a (date, close, volume) triple.
    """
    normalized = _normalize_market(market)
    ratios = INVESTOR_RATIOS[normalized]

    rows: list[InvestorRow] = []
    prev_close: Optional[float] = None
    for row in history:
        date, close, volume = _unpack_history_row(row)
        # 첫 행은 기준이 없어 상승 취급, 보합(==)도 상승 / First row and flat closes count as up.
        direction = 1 if prev_close is None or close >= prev_close else -1
        prev_close = close

        amounts = {
            # 개인은 추세와 반대로 매매한다 / Individuals trade against the trend.
            name: int(volume * share * participation * (-direction if name == "individual" else direction))
            for name, (share, participation) in ratios.items()
        }
        rows.append(InvestorRow(date=date, **amounts))

    return rows


def _unpack_history_row(row: Iterable[Any]) -> Tuple[str, float, int]:
    """
    (date, close, volume) 행을 검증하며 분해 / Unpack and validate a (date, close, volume) row.

    Raises:
        ValueError: 항목 수가 3이 아니거나 close/volume이 숫자가 아닐 때 / Wrong arity or non-numeric values.
    """
    try:
        date, close, volume = row
        return str(date), float(close), int(volume)
    except (TypeError, ValueError) as exc:
        # 조용한 실패 금지: 잘못된 입력을 0으로 뭉개지 않는다 / No silent failure: bad input is not coerced to 0.
        _warn("investor_history_row_invalid", row=row, error=str(exc))
        raise ValueError(f"invalid history row: {row!r} (expected (date, close, volume))") from exc
