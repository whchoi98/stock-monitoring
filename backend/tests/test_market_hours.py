from datetime import datetime
from zoneinfo import ZoneInfo
from app.core.market_hours import is_kr_market_open, is_us_market_open, refresh_interval

KST = ZoneInfo("Asia/Seoul")

def test_kr_open_weekday_10am():
    assert is_kr_market_open(datetime(2026, 8, 3, 10, 0, tzinfo=KST))  # 월요일

def test_kr_closed_weekend_and_evening():
    assert not is_kr_market_open(datetime(2026, 8, 1, 10, 0, tzinfo=KST))  # 토요일
    assert not is_kr_market_open(datetime(2026, 8, 3, 15, 31, tzinfo=KST))

def test_us_open_handles_dst():
    # 2026-08-03 10:00 ET(EDT) = 23:00 KST → 미국 장중
    assert is_us_market_open(datetime(2026, 8, 3, 23, 0, tzinfo=KST))
    # 겨울(EST): 2026-01-05 10:00 ET = 2026-01-06 00:00 KST
    assert is_us_market_open(datetime(2026, 1, 6, 0, 0, tzinfo=KST))

def test_refresh_interval():
    assert refresh_interval(datetime(2026, 8, 3, 10, 0, tzinfo=KST)) == 45
    assert refresh_interval(datetime(2026, 8, 2, 3, 0, tzinfo=KST)) == 600  # Sunday 03:00 KST = Saturday 14:00 EDT, both markets closed
