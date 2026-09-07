"""
Pydantic 데이터 모델 정의 - API 요청/응답 스키마
Pydantic data model definitions - API request/response schemas.
"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


# ============================================================================
# Quote Models (주식 시세)
# ============================================================================

class Quote(BaseModel):
    """개별 주식 시세 정보 / Individual stock quote information."""
    symbol: str
    name: str
    # 한글 종목명 (검색·표시용, `config.STOCK_NAMES_KO`) — 유니버스 밖 심볼은 None
    # Korean name for search and display (`config.STOCK_NAMES_KO`); None outside the universe
    name_ko: Optional[str] = None
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
    name_ko: Optional[str] = None
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
    # 배당수익률 (%) - yfinance `dividendYield`를 변환 없이 그대로 담는다. 퍼센트 스케일이다
    # (AAPL 0.35 = 0.35%), 원시 분수가 아니다. 프론트에서 100을 곱하면 100배로 부풀어 표시된다.
    # (정정 2026-08-02: 이전 주석/타입 문서는 "원시 분수 0.0044 = 0.44%"라며 ×100을 지시했다.
    #  라이브 응답으로 반증됨. `fundamentals._check_dividend_scale`가 스케일 변화를 감시한다.)
    # Dividend yield (%) - yfinance's `dividendYield`, carried through unconverted. It is percent-scale
    # (AAPL 0.35 = 0.35%), not a raw fraction; multiplying by 100 in the UI inflates it a hundredfold.
    # (Correction 2026-08-02: earlier notes called it a raw fraction (0.0044 = 0.44%) and demanded a x100;
    #  live data disproved that. `fundamentals._check_dividend_scale` watches for a scale change.)
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


# ---------------------------------------------------------------------------
# AI 자유 질의 / Free-form AI question
# ---------------------------------------------------------------------------

# 질문 길이 상한 — 프롬프트 비용과 주입 면적을 함께 묶는다 / The question cap, bounding prompt cost and injection surface alike
MAX_QUESTION_LEN = 200

_WHITESPACE_RUN = re.compile(r"\s+")


def normalize_question(text: str) -> str:
    """
    질문 정규화 — 제어문자 제거, 공백 접기, 앞뒤 공백 제거. 캐시 키와 프롬프트가 같은 문자열을 본다.
    Normalise a question: drop control characters, collapse whitespace, trim. The cache key and the prompt see one string.
    """
    printable = "".join(ch for ch in text if ch.isprintable() or ch.isspace())
    return _WHITESPACE_RUN.sub(" ", printable).strip()


class StockQuestionRequest(BaseModel):
    """종목 AI 분석의 선택 본문 — 사용자 질문 / The optional body of a stock analysis: the user's question."""
    question: str = Field(min_length=1, max_length=MAX_QUESTION_LEN)

    @field_validator("question")
    @classmethod
    def _normalized(cls, value: str) -> str:
        cleaned = normalize_question(value)
        if not cleaned:
            raise ValueError("question must not be blank")
        return cleaned
