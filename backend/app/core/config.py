"""
애플리케이션 설정 파일 - 주식 심볼, 지수, 경제 지표, 뉴스 피드 등 전역 설정 정의
Application configuration - defines stock symbols, indices, economic indicators, news feeds, and global settings.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

# 주식 데이터 갱신 주기 (초) / Stock data refresh interval (seconds)
REFRESH_INTERVAL = 45  # seconds
# 뉴스 데이터 갱신 주기 (초) / News data refresh interval (seconds)
NEWS_REFRESH_INTERVAL = 120  # seconds
# 장 마감 후 갱신 주기 (초) / Refresh interval after market close (seconds)
CLOSED_REFRESH_INTERVAL = 600  # seconds

# 미국 시장 주요 지수 (심볼: 이름) / US market major indices (symbol: name)
US_INDICES = {
    "^GSPC": "S&P 500",
    "^IXIC": "NASDAQ",
    "^DJI": "DOW",
}

# 한국 시장 주요 지수 (yfinance 심볼) / KR market major indices (yfinance symbols)
KR_INDICES = {
    "^KS11": "KOSPI",
    "^KQ11": "KOSDAQ",
}

# 미국 주요 종목 50개 티커 목록 / US major 50 stock ticker list
US_STOCKS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA",
    "META", "TSLA", "BRK-B", "JPM", "V",
    "JNJ", "UNH", "WMT", "MA", "PG",
    "HD", "XOM", "CVX", "LLY", "ABBV",
    "PFE", "KO", "PEP", "MRK", "COST",
    "AVGO", "AMD", "ORCL", "CRM", "NFLX",
    # 추가 20개 종목 / 20 additional stocks
    "ADBE", "CSCO", "ACN", "TXN", "INTC",
    "QCOM", "INTU", "AMAT", "BKNG", "ISRG",
    "MDLZ", "ADP", "REGN", "VRTX", "GILD",
    "PANW", "LRCX", "MU", "KLAC", "SNPS",
]

# 미국 종목 티커-회사명 매핑 / US stock ticker-to-company-name mapping
US_STOCK_NAMES = {
    "AAPL": "Apple", "MSFT": "Microsoft", "GOOGL": "Alphabet",
    "AMZN": "Amazon", "NVDA": "Nvidia", "META": "Meta Platforms",
    "TSLA": "Tesla", "BRK-B": "Berkshire Hathaway", "JPM": "JPMorgan Chase",
    "V": "Visa", "JNJ": "Johnson & Johnson", "UNH": "UnitedHealth",
    "WMT": "Walmart", "MA": "Mastercard", "PG": "Procter & Gamble",
    "HD": "Home Depot", "XOM": "Exxon Mobil", "CVX": "Chevron",
    "LLY": "Eli Lilly", "ABBV": "AbbVie", "PFE": "Pfizer",
    "KO": "Coca-Cola", "PEP": "PepsiCo", "MRK": "Merck",
    "COST": "Costco", "AVGO": "Broadcom", "AMD": "AMD",
    "ORCL": "Oracle", "CRM": "Salesforce", "NFLX": "Netflix",
    "ADBE": "Adobe", "CSCO": "Cisco", "ACN": "Accenture",
    "TXN": "Texas Instruments", "INTC": "Intel", "QCOM": "Qualcomm",
    "INTU": "Intuit", "AMAT": "Applied Materials", "BKNG": "Booking Holdings",
    "ISRG": "Intuitive Surgical", "MDLZ": "Mondelez", "ADP": "ADP",
    "REGN": "Regeneron", "VRTX": "Vertex Pharma", "GILD": "Gilead Sciences",
    "PANW": "Palo Alto Networks", "LRCX": "Lam Research", "MU": "Micron",
    "KLAC": "KLA Corp", "SNPS": "Synopsys",
}

# 미국 종목 티커-섹터 매핑 / US stock ticker-to-sector mapping
US_STOCK_SECTORS = {
    "AAPL": "Technology", "MSFT": "Technology", "GOOGL": "Technology",
    "AMZN": "Consumer", "NVDA": "Technology", "META": "Technology",
    "TSLA": "Consumer", "BRK-B": "Financial", "JPM": "Financial",
    "V": "Financial", "JNJ": "Healthcare", "UNH": "Healthcare",
    "WMT": "Consumer", "MA": "Financial", "PG": "Consumer",
    "HD": "Consumer", "XOM": "Energy", "CVX": "Energy",
    "LLY": "Healthcare", "ABBV": "Healthcare", "PFE": "Healthcare",
    "KO": "Consumer", "PEP": "Consumer", "MRK": "Healthcare",
    "COST": "Consumer", "AVGO": "Technology", "AMD": "Technology",
    "ORCL": "Technology", "CRM": "Technology", "NFLX": "Communication",
    "ADBE": "Technology", "CSCO": "Technology", "ACN": "Technology",
    "TXN": "Technology", "INTC": "Technology", "QCOM": "Technology",
    "INTU": "Technology", "AMAT": "Technology", "BKNG": "Consumer",
    "ISRG": "Healthcare", "MDLZ": "Consumer", "ADP": "Technology",
    "REGN": "Healthcare", "VRTX": "Healthcare", "GILD": "Healthcare",
    "PANW": "Technology", "LRCX": "Technology", "MU": "Technology",
    "KLAC": "Technology", "SNPS": "Technology",
}

# 한국 주요 종목 50개 종목코드 목록 / KR major 50 stock code list
# 6-digit codes from TUI, transformed with .KS/.KQ suffix
_KR_STOCKS_RAW = [
    "005930", "000660", "373220", "005380", "000270",
    "207940", "006400", "035420", "035720", "005490",
    "068270", "028260", "105560", "055550", "012330",
    "066570", "003670", "051910", "096770", "034730",
    "000810", "003550", "032830", "009150", "086790",
    "010130", "033780", "011200", "247540", "377300",
    # 추가 20개 종목 / 20 additional stocks
    "030200", "017670", "018260", "036570", "316140",
    "003490", "034020", "011170", "024110", "010950",
    "006800", "004020", "000720", "002790", "138040",
    "259960", "326030", "323410", "361610", "352820",
]

# KOSDAQ codes that need .KQ suffix (rest get .KS)
_KOSDAQ_CODES = {"247540", "259960", "326030", "323410", "361610", "352820"}

# Transform KR stock codes with suffix
KR_STOCKS = [
    f"{code}.KQ" if code in _KOSDAQ_CODES else f"{code}.KS"
    for code in _KR_STOCKS_RAW
]

# 한국 종목 코드-회사명 매핑 / KR stock code-to-company-name mapping
_KR_STOCK_NAMES_RAW = {
    "005930": "Samsung Electronics", "000660": "SK Hynix",
    "373220": "LG Energy Solution", "005380": "Hyundai Motor",
    "000270": "Kia", "207940": "Samsung Biologics",
    "006400": "Samsung SDI", "035420": "NAVER",
    "035720": "Kakao", "005490": "POSCO Holdings",
    "068270": "Celltrion", "028260": "Samsung C&T",
    "105560": "KB Financial", "055550": "Shinhan Financial",
    "012330": "Hyundai Mobis", "066570": "LG Electronics",
    "003670": "POSCO Future M", "051910": "LG Chem",
    "096770": "SK Innovation", "034730": "SK",
    "000810": "Samsung Fire", "003550": "LG",
    "032830": "Samsung Life", "009150": "Samsung Electro",
    "086790": "Hana Financial", "010130": "Korea Zinc",
    "033780": "KT&G", "011200": "HMM",
    "247540": "Ecopro BM", "377300": "Kakao Pay",
    "030200": "KT", "017670": "SK Telecom",
    "018260": "Samsung SDS", "036570": "NCsoft",
    "316140": "Woori Financial", "003490": "Korea Shipbuilding",
    "034020": "Doosan Enerbility", "011170": "Lotte Chemical",
    "024110": "Industrial Bank of Korea", "010950": "S-Oil",
    "006800": "Mirae Asset Securities", "004020": "Hyundai Steel",
    "000720": "Hyundai E&C", "002790": "Amore Pacific",
    "138040": "Meritz Financial", "259960": "Krafton",
    "326030": "SK Biopharm", "323410": "Kakao Bank",
    "361610": "SK IE Technology", "352820": "Hive",
}

# Transform KR stock names dict with suffix
KR_STOCK_NAMES = {
    (f"{code}.KQ" if code in _KOSDAQ_CODES else f"{code}.KS"): name
    for code, name in _KR_STOCK_NAMES_RAW.items()
}

# 한국 종목 코드-섹터 매핑 / KR stock code-to-sector mapping
_KR_STOCK_SECTORS_RAW = {
    "005930": "Semiconductor", "000660": "Semiconductor",
    "373220": "Battery", "005380": "Auto",
    "000270": "Auto", "207940": "Bio",
    "006400": "Battery", "035420": "Internet",
    "035720": "Internet", "005490": "Steel",
    "068270": "Bio", "028260": "Holding",
    "105560": "Financial", "055550": "Financial",
    "012330": "Auto Parts", "066570": "Electronics",
    "003670": "Materials", "051910": "Chemical",
    "096770": "Energy", "034730": "Holding",
    "000810": "Insurance", "003550": "Holding",
    "032830": "Insurance", "009150": "Components",
    "086790": "Financial", "010130": "Non-Ferrous",
    "033780": "Tobacco", "011200": "Shipping",
    "247540": "Battery", "377300": "Fintech",
    "030200": "Telecom", "017670": "Telecom",
    "018260": "IT Services", "036570": "Gaming",
    "316140": "Financial", "003490": "Shipbuilding",
    "034020": "Industrial", "011170": "Chemical",
    "024110": "Financial", "010950": "Energy",
    "006800": "Securities", "004020": "Steel",
    "000720": "Construction", "002790": "Cosmetics",
    "138040": "Financial", "259960": "Gaming",
    "326030": "Bio", "323410": "Fintech",
    "361610": "Battery", "352820": "Entertainment",
}

# Transform KR stock sectors dict with suffix
KR_STOCK_SECTORS = {
    (f"{code}.KQ" if code in _KOSDAQ_CODES else f"{code}.KS"): sector
    for code, sector in _KR_STOCK_SECTORS_RAW.items()
}

# Combined stock names (US + KR)
STOCK_NAMES = {**US_STOCK_NAMES, **KR_STOCK_NAMES}

# Combined stock sectors (US + KR)
STOCK_SECTORS = {**US_STOCK_SECTORS, **KR_STOCK_SECTORS}

# 경제 지표 (yfinance 심볼): 심볼 -> (이름, 단위) / Economic indicators (yfinance symbols): symbol -> (name, unit)
INDICATORS = {
    "CL=F": ("WTI Oil", "$"),
    "GC=F": ("Gold", "$"),
    "SI=F": ("Silver", "$"),
    "HG=F": ("Copper", "$"),
    "EURUSD=X": ("EUR/USD", ""),
    "KRW=X": ("USD/KRW", "W"),
    "JPY=X": ("USD/JPY", ""),
    "CNY=X": ("USD/CNY", ""),
    "^TNX": ("US 10Y", "%"),
    "BTC-USD": ("Bitcoin", "$"),
    "ETH-USD": ("Ethereum", "$"),
}

# 섹터별 관련 경제 지표 매핑: 종목 섹터를 관련 경제 지표 심볼에 연결
# Sector-to-related-economic-indicators mapping: maps stock sectors to relevant indicator symbols
SECTOR_INDICATOR_MAP = {
    "Technology": ["^IXIC", "BTC-USD"],
    "Semiconductor": ["^IXIC", "BTC-USD"],
    "Internet": ["^IXIC", "BTC-USD"],
    "IT Services": ["^IXIC", "BTC-USD"],
    "Communication": ["^IXIC", "BTC-USD"],
    "Gaming": ["^IXIC", "BTC-USD"],
    "Energy": ["CL=F", "HG=F"],
    "Chemical": ["CL=F", "HG=F"],
    "Materials": ["CL=F", "HG=F"],
    "Financial": ["^TNX", "EURUSD=X"],
    "Insurance": ["^TNX", "EURUSD=X"],
    "Securities": ["^TNX", "EURUSD=X"],
    "Fintech": ["^TNX", "BTC-USD"],
    "Consumer": ["GC=F", "EURUSD=X"],
    "Cosmetics": ["GC=F", "JPY=X"],
    "Entertainment": ["GC=F", "EURUSD=X"],
    "Auto": ["KRW=X", "CL=F"],
    "Auto Parts": ["KRW=X", "CL=F"],
    "Healthcare": ["GC=F", "^TNX"],
    "Bio": ["GC=F", "^TNX"],
    "Battery": ["HG=F", "SI=F"],
    "Steel": ["HG=F", "CNY=X"],
    "Non-Ferrous": ["HG=F", "GC=F"],
    "Shipbuilding": ["CL=F", "KRW=X"],
    "Shipping": ["CL=F", "KRW=X"],
    "Construction": ["HG=F", "^TNX"],
    "Industrial": ["CL=F", "HG=F"],
    "Telecom": ["^TNX", "KRW=X"],
    "Tobacco": ["GC=F", "KRW=X"],
    "Holding": ["^TNX", "KRW=X"],
    "Electronics": ["^IXIC", "KRW=X"],
    "Components": ["^IXIC", "KRW=X"],
}

# 뉴스 RSS 피드 URL (미국/한국 금융 뉴스) / News RSS feed URLs (US/KR financial news)
NEWS_FEEDS = {
    "yahoo": "https://finance.yahoo.com/news/rssindex",
    "yahoo_markets": "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",
    "hankyung": "https://www.hankyung.com/feed/economy",
    "mk": "https://www.mk.co.kr/rss/30100041/",
}

# 캐시 TTL (초) / Cache TTL (seconds)
CHART_TTL = {
    "1w": 600,      # 1주: 10분 / 1 week: 10 minutes
    "1m": 3600,     # 1개월: 1시간 / 1 month: 1 hour
    "3m": 21600,    # 3개월: 6시간 / 3 months: 6 hours
    "1y": 86400,    # 1년: 24시간 / 1 year: 24 hours
}

FUNDAMENTALS_TTL = 43200     # 12시간 / 12 hours
AI_TTL = 21600               # 6시간 / 6 hours
L2_TTL = 86400               # 24시간 / 24 hours

# 환경변수 설정 (기본값 포함) / Environment variable settings (with defaults)
CACHE_TABLE = os.environ.get("CACHE_TABLE", "stock-monitoring-cache")
# 모델 ID는 **크로스리전 추론 프로필**이다 — 접두사가 곧 라우팅 범위이고, 프로필은 리전마다 존재 여부가
# 다르다. `ap-northeast-2`에는 `us.` 접두사의 sonnet-4-6이 없어(2026-08-02 실측: list-inference-profiles에
# 미존재) 호출이 `ValidationException: The provided model identifier is invalid`로 죽는다. 이 리전에서
# 유효한 sonnet-4-6은 `global.` 프로필뿐이라 그것을 기본값으로 쓴다 (같은 날 converse 실호출로 확인).
# The model id is a **cross-region inference profile**: the prefix is the routing scope, and a profile's
# existence differs per region. `ap-northeast-2` has no `us.`-prefixed sonnet-4-6 (verified 2026-08-02 against
# list-inference-profiles), so such a call dies with `ValidationException: The provided model identifier is
# invalid`. The only sonnet-4-6 profile valid in this region is the `global.` one, confirmed the same day with
# a live converse call, so that is the default.
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-6")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "ap-northeast-2")

# AI rate limiting 설정 / AI rate limiting settings
AI_RATE_PER_MIN = 3           # IP당 분당 요청 수 / Requests per minute per IP
AI_GLOBAL_CONCURRENCY = 2     # 전역 동시 요청 수 / Global concurrent requests
# 기사 본문 fetch 전용 동시 실행 상한 — Bedrock 세마포어와 분리한다 (2026-08-03 보안 리뷰):
# 같은 세마포어를 쓰면 느린 fetch(최대 FETCH_TOTAL_DEADLINE=20s 점유) 2건이 Bedrock 예산을
# 잠식해 IP 2개로 AI 기능 전체가 대기열에 갇힌다. 분리하면 fetch 폭주는 fetch만 늦춘다.
# Concurrency cap dedicated to article-body fetches, separate from the Bedrock semaphore
# (security review 2026-08-03): sharing one semaphore lets two slow fetches (holding up to
# FETCH_TOTAL_DEADLINE=20s each) starve the Bedrock budget — two IPs would queue-lock all AI
# features. Separated, a fetch flood slows only fetches.
AI_FETCH_CONCURRENCY = 2
