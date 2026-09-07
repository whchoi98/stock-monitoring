/**
 * 시장 라벨 — 컴포넌트 파일 밖에 둔다 (oxlint `react/only-export-components` — 컴포넌트 파일이 상수를 함께 export하면
 * HMR이 깨진다).
 * Market labels, kept outside component files (oxlint `react/only-export-components`: a component file that also
 * exports a constant breaks fast refresh).
 */
import type { Market } from '../api/types.ts'

export const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }
