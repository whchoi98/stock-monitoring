"""Market hours detection for KST and US stock markets with DST support."""
from datetime import datetime, time
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
NY = ZoneInfo("America/New_York")

def _open_between(now: datetime, tz, start: time, end: time) -> bool:
    local = now.astimezone(tz)
    return local.weekday() < 5 and start <= local.time() <= end

def is_kr_market_open(now: datetime) -> bool:
    return _open_between(now, KST, time(9, 0), time(15, 30))

def is_us_market_open(now: datetime) -> bool:
    return _open_between(now, NY, time(9, 30), time(16, 0))

def any_market_open(now: datetime) -> bool:
    return is_kr_market_open(now) or is_us_market_open(now)

def refresh_interval(now: datetime) -> int:
    return 45 if any_market_open(now) else 600
