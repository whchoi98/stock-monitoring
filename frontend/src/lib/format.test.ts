import {
  formatPrice,
  formatChange,
  formatMarketCap,
  formatPublished,
  formatVolume,
  formatPct,
  arrow,
  changeClass,
} from "./format";
import { expect, test } from "vitest";

// ── 브리프에 명시된 계약 테스트 / Contract tests given by the brief ──
test("price by currency", () => {
  expect(formatPrice(259000, "KRW")).toBe("259,000");
  expect(formatPrice(1234.5, "USD")).toBe("1,234.50");
});
test("market cap units", () => {
  expect(formatMarketCap(3.1e12, "USD")).toBe("$3.10T");
  expect(formatMarketCap(4.5e14, "KRW")).toBe("450조");
  expect(formatMarketCap(null, "USD")).toBe("—");
});
test("volume/pct/arrow", () => {
  expect(formatVolume(2_500_000)).toBe("2.5M");
  expect(formatPct(1.234)).toBe("+1.23%");
  expect(arrow(0)).toBe("-");
});

// ── 추가 엣지 케이스 (TUI models/stock.py 규칙과 동일 결과) ──
// Added edge cases, matching the TUI's formatted_* rules.
test("formatPrice rounds and separates by currency", () => {
  expect(formatPrice(0, "KRW")).toBe("0");
  expect(formatPrice(0, "USD")).toBe("0.00");
  // KRW는 소수점 없음 / KRW carries no decimals
  expect(formatPrice(259_499.6, "KRW")).toBe("259,500");
  expect(formatPrice(-1234.5, "USD")).toBe("-1,234.50");
  expect(formatPrice(1_000_000, "USD")).toBe("1,000,000.00");
});

test("formatChange always carries a sign", () => {
  // TUI: sign = "+" if change >= 0 → 보합(0)도 "+0" / flat also renders "+0"
  expect(formatChange(1500, "KRW")).toBe("+1,500");
  expect(formatChange(0, "KRW")).toBe("+0");
  expect(formatChange(0, "USD")).toBe("+0.00");
  expect(formatChange(-2500, "KRW")).toBe("-2,500");
  expect(formatChange(2.5, "USD")).toBe("+2.50");
  expect(formatChange(-0.126, "USD")).toBe("-0.13");
});

test("formatPct signs and fixes to 2 decimals", () => {
  expect(formatPct(0)).toBe("+0.00%");
  expect(formatPct(-1.234)).toBe("-1.23%");
  expect(formatPct(12)).toBe("+12.00%");
});

test("formatMarketCap KRW ladder (억/조/경)", () => {
  expect(formatMarketCap(4.2e16, "KRW")).toBe("4경");
  expect(formatMarketCap(1e12, "KRW")).toBe("1조");
  expect(formatMarketCap(3.5e8, "KRW")).toBe("4억");
  // 1억 미만은 원 단위 그대로 / below 1억, raw won with separators
  expect(formatMarketCap(12_345_678, "KRW")).toBe("12,345,678");
  expect(formatMarketCap(0, "KRW")).toBe("—");
  expect(formatMarketCap(-5, "KRW")).toBe("—");
});

test("formatMarketCap USD ladder ($M/B/T)", () => {
  expect(formatMarketCap(2.5e9, "USD")).toBe("$2.5B");
  expect(formatMarketCap(7.4e6, "USD")).toBe("$7M");
  expect(formatMarketCap(999_999, "USD")).toBe("$999,999");
  expect(formatMarketCap(null, "KRW")).toBe("—");
  expect(formatMarketCap(0, "USD")).toBe("—");
});

test("formatVolume abbreviates K/M", () => {
  expect(formatVolume(1_500)).toBe("1.5K");
  expect(formatVolume(2_000_000)).toBe("2.0M");
  expect(formatVolume(999)).toBe("999");
  expect(formatVolume(0)).toBe("0");
  expect(formatVolume(12_345_678)).toBe("12.3M");
});

test("arrow follows the TUI ▲/▼/- rule", () => {
  expect(arrow(1)).toBe("▲");
  expect(arrow(-1)).toBe("▼");
  expect(arrow(0)).toBe("-");
  expect(arrow(-0.001)).toBe("▼");
});

test("changeClass treats exactly 0 as flat", () => {
  expect(changeClass(0.5)).toBe("up");
  expect(changeClass(0)).toBe("flat");
  expect(changeClass(-0.5)).toBe("down");
});

// 뉴스 발행 시각 — F4 NewsFeed와 F6 StockNews가 공유하는 표기.
// 절대 문자열을 못박지 않는다: 표기는 실행 환경의 시간대와 ICU 데이터에 따라 달라진다
// (Node는 "8. 2. AM 12:30", 풀 ICU 브라우저는 "8. 2. 오전 12:30"). 계약은 "월. 일. + 시계"이므로
// 같은 설정의 Intl 결과와 일치하는지, 그리고 파싱 실패가 null인지를 고정한다.
// No absolute string is pinned: the wording depends on the host's zone and ICU data (Node gives
// "8. 2. AM 12:30", a full-ICU browser "8. 2. 오전 12:30"). The contract is "month. day. + a clock", so what
// is pinned is agreement with an identically configured Intl formatter, plus the null branch.
test("formatPublished renders a short ko-KR month/day + clock", () => {
  const at = new Date("2026-08-02T00:30:00Z");

  expect(formatPublished(at.toISOString())).toContain("8. 2.");
  expect(formatPublished(at.toISOString())).toContain("09:30");
  // 월/일과 분 단위 시계가 실제로 들어 있다 / The month, the day and a minute-resolution clock are really there
  expect(formatPublished(at.toISOString())).toMatch(/\d+\. \d+\..*\d{1,2}:\d{2}/);
});

test("formatPublished returns null for an unparsable time", () => {
  expect(formatPublished("")).toBeNull();
  expect(formatPublished("어제")).toBeNull();
});
