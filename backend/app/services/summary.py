"""
시장 요약 서비스 - 시세 목록에서 breadth(상승/하락)·상위 종목·섹터 평균을 집계
Market summary service - aggregates breadth (advancing/declining), leaders and sector averages from quotes.

네트워크·캐시 접근이 없는 순수 함수다. 입력은 B5(`market_data.fetch_quotes`)가 만든 Quote 리스트다.
Pure functions with no network or cache access; the input is the Quote list produced by `market_data.fetch_quotes`.

반환값은 그대로 JSON 직렬화되므로 Quote는 dict(`model_dump()`)로 펼친다.
Results are serialized straight to JSON, so quotes are flattened into dicts via `model_dump()`.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Callable, Sequence

from app.core import config
from app.models import Quote

logger = logging.getLogger(__name__)

# 시장별 상위 종목 개수 / Number of leaders per market list
TOP_N = 3
# 섹터 카드 최대 개수 / Maximum number of sector cards
SECTOR_TOP_N = 8
# 섹터 평균 등락률 반올림 자리수 / Rounding depth for the sector average change
SECTOR_DECIMALS = 2


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _top(
    quotes: Sequence[Quote],
    key: Callable[[Quote], float],
    reverse: bool,
) -> list[dict]:
    """
    key 기준 상위 TOP_N개를 dict로 반환 / Return the top TOP_N quotes by key, as dicts.

    `sorted`는 안정 정렬이므로 동률은 입력 순서를 유지한다 (reverse=True에서도 동률 순서는 뒤집히지 않는다).
    `sorted` is stable, so ties keep their input order (reverse=True does not flip tied entries).
    """
    ranked = sorted(quotes, key=key, reverse=reverse)[:TOP_N]
    return [quote.model_dump() for quote in ranked]


def _market_summary(quotes: Sequence[Quote]) -> dict:
    """
    한 시장의 breadth + 상위 3종 리스트 / One market's breadth plus the three leader lists.

    change_pct == 0은 상승도 하락도 아니다 (보합) / change_pct == 0 counts as neither advancing nor declining.
    """
    return {
        "advancing": sum(1 for quote in quotes if quote.change_pct > 0),
        "declining": sum(1 for quote in quotes if quote.change_pct < 0),
        "top_gainers": _top(quotes, key=lambda q: q.change_pct, reverse=True),
        "top_losers": _top(quotes, key=lambda q: q.change_pct, reverse=False),
        "volume_leaders": _top(quotes, key=lambda q: q.volume, reverse=True),
    }


# ---------------------------------------------------------------------------
# 시장 요약 / Market summary
# ---------------------------------------------------------------------------

def build_summary(us: Sequence[Quote], kr: Sequence[Quote]) -> dict:
    """
    미국·한국 시장 요약 집계 / Aggregate the US and KR market summaries.

    Args:
        us: 미국 시세 목록 / US quote list.
        kr: 한국 시세 목록 / KR quote list.

    Returns:
        `{"us": {...}, "kr": {...}}` — 각 시장은 `advancing`, `declining`,
        `top_gainers`, `top_losers`, `volume_leaders`(각 최대 3건, Quote dict)를 갖는다.
        Each market carries `advancing`, `declining`, `top_gainers`, `top_losers`
        and `volume_leaders` (at most three quote dicts each).
        종목이 3개 미만이면 있는 만큼만 담고, 입력 리스트는 변경하지 않는다.
        Shorter markets return what exists; the input lists are never mutated.
    """
    return {"us": _market_summary(us), "kr": _market_summary(kr)}


# ---------------------------------------------------------------------------
# 섹터 집계 / Sector aggregation
# ---------------------------------------------------------------------------

def build_sectors(quotes: Sequence[Quote]) -> list[dict]:
    """
    섹터별 평균 등락률 집계 / Aggregate the average change per sector.

    호출부는 한 시장의 시세만 넘긴다 (미국·한국을 섞으면 통화·섹터 체계가 섞인다).
    Callers pass a single market's quotes (mixing markets would mix currencies and sector taxonomies).

    Args:
        quotes: 한 시장의 시세 목록 / One market's quote list.

    Returns:
        `[{"sector": str, "avg_change_pct": float, "count": int}]` — |평균| 내림차순 상위 8개.
        Up to eight rows sorted by |average| descending; ties keep first-appearance order.
        섹터를 알 수 없는 종목(Quote.sector가 비고 config.STOCK_SECTORS에도 없음)은 경고 후 제외한다.
        Quotes with no resolvable sector are logged and skipped.
    """
    grouped: dict[str, list[float]] = {}
    for quote in quotes:
        # Quote.sector가 비면 config 매핑으로 보완 / Fall back to the config mapping when the quote has none.
        sector = quote.sector or config.STOCK_SECTORS.get(quote.symbol, "")
        if not sector:
            # 조용한 실패 금지: 섹터 귀속 불가를 로그로 남긴다 / No silent failure: log unattributable quotes.
            _warn("sector_unknown", symbol=quote.symbol, market=quote.market)
            continue
        grouped.setdefault(sector, []).append(quote.change_pct)

    rows = [
        {
            "sector": sector,
            "avg_change_pct": round(sum(changes) / len(changes), SECTOR_DECIMALS),
            "count": len(changes),
        }
        for sector, changes in grouped.items()
    ]
    # 반환값과 같은 반올림된 평균으로 정렬한다 (보이지 않는 정밀도로 순서가 뒤바뀌지 않도록)
    # Sort on the same rounded average that is returned, so invisible precision cannot reorder rows.
    rows.sort(key=lambda row: abs(row["avg_change_pct"]), reverse=True)
    return rows[:SECTOR_TOP_N]
