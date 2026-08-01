"""
Pydantic 데이터 모델 정의 - API 요청/응답 스키마
Pydantic data model definitions - API request/response schemas.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ============================================================================
# Quote Models (주식 시세)
# ============================================================================

class Quote(BaseModel):
    """개별 주식 시세 정보 / Individual stock quote information."""
    symbol: str
    name: str
    price: float
    change: float
    change_pct: float
    volume: int
    market: str
    currency: str
    sector: str
    market_cap: Optional[float] = None


class IndexQuote(BaseModel):
    """시장 지수 시세 정보 / Market index quote information."""
    symbol: str
    name: str
    value: float
    change: float
    change_pct: float


class Indicator(BaseModel):
    """경제 지표 정보 / Economic indicator information."""
    symbol: str
    name: str
    value: float
    change: float
    change_pct: float
    unit: str


# ============================================================================
# News Models (뉴스)
# ============================================================================

class NewsItem(BaseModel):
    """뉴스 아이템 정보 / News item information."""
    id: str
    title: str
    link: str
    source: str
    published: str
    language: str


# ============================================================================
# Chart Models (차트)
# ============================================================================

class Candle(BaseModel):
    """캔들 정보 (OHLCV) / Candle data (OHLCV)."""
    time: str
    open: float
    high: float
    low: float
    close: float
    volume: int


class CrossSignal(BaseModel):
    """이동평균 크로스 신호 / Moving average cross signal."""
    time: str
    kind: Literal["golden", "dead"]


class ChartResponse(BaseModel):
    """차트 응답 / Chart response."""
    symbol: str
    period: str
    candles: list[Candle]
    ma5: list[Optional[float]]
    ma20: list[Optional[float]]
    signals: list[CrossSignal]


# ============================================================================
# Stock Detail Models (종목 상세)
# ============================================================================

class StockDetailResponse(BaseModel):
    """종목 상세 정보 응답 / Stock detail information response."""
    symbol: str
    name: str
    market: str = "US"
    currency: str = "USD"
    price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    open_price: float = 0.0
    high: float = 0.0
    low: float = 0.0
    prev_close: float = 0.0
    volume: int = 0
    avg_volume: int = 0
    market_cap: float = 0.0
    pe_ratio: Optional[float] = None
    week52_high: float = 0.0
    week52_low: float = 0.0
    day_change: float = 0.0
    day_change_pct: float = 0.0
    eps: Optional[float] = None
    dividend_yield: Optional[float] = None
    beta: Optional[float] = None
    sector: str = ""
    pbr: Optional[float] = None
    # 기간수익률 (%) - 키: "1w"/"1m"/"3m"/"1y", 데이터 부족 시 None
    # Period returns (%) - keys "1w"/"1m"/"3m"/"1y"; None when history is too short
    returns: Optional[dict[str, Optional[float]]] = None
    last_updated: Optional[datetime] = None


# ============================================================================
# Order Book Models (호가 / 시장 깊이)
# ============================================================================

class OrderBookEntry(BaseModel):
    """호가 정보 / Order book entry."""
    price: float
    qty: int
    side: Literal["bid", "ask"]


# ============================================================================
# Investor Models (수급 정보)
# ============================================================================

class InvestorRow(BaseModel):
    """투자자별 수급 현황 / Investor supply/demand information."""
    date: str
    individual: int
    foreign: int
    institution: int


# ============================================================================
# Envelope Helper
# ============================================================================

def envelope(data: Any, market_open: bool, as_of: Optional[str] = None) -> dict:
    """
    API 응답을 표준 envelope 형식으로 래핑 / Wrap API response in standard envelope format.

    Args:
        data: 응답 데이터 / Response data
        market_open: 시장 개장 여부 / Whether market is open
        as_of: ISO8601 timestamp (기본값: 현재 UTC 시간) / ISO8601 timestamp (default: current UTC time)

    Returns:
        dict: Envelope 형식의 응답 / Response in envelope format
    """
    return {
        "asOf": as_of or datetime.now(timezone.utc).isoformat(),
        "marketOpen": market_open,
        "data": data,
    }
