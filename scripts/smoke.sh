#!/usr/bin/env bash
#
# stock-monitoring 배포 후 스모크 테스트 / Post-deploy smoke test for stock-monitoring.
#
# Usage: bash scripts/smoke.sh <CloudFrontURL> <AlbDNS>
#   e.g. bash scripts/smoke.sh https://d111111abcdef8.cloudfront.net stock-monitoring-alb-123.ap-northeast-2.elb.amazonaws.com
#
# 두 인자는 CDK 스택 Outputs의 CloudFrontURL / AlbDNS 다.
# Both arguments come from the CDK stack outputs: CloudFrontURL and AlbDNS.
#
# 검사 1~3은 CloudFront 경유 정상 동작을, 검사 4는 ALB 직접 접근이 막혔음을 확인한다.
# Checks 1-3 assert the service works through CloudFront; check 4 asserts direct ALB access is
# blocked. "Blocked" means either a 403 from the listener default action (the request reached the
# ALB but carried no X-Origin-Verify header) or a connection timeout (the CloudFront prefix-list
# security group dropped the packet). Both are a pass.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <CloudFrontURL> <AlbDNS>" >&2
  exit 2
fi

URL="${1%/}"   # https://dxxxx.cloudfront.net (trailing slash 제거 / drop trailing slash)
ALB_DNS="$2"   # stock-monitoring-alb-xxxx.ap-northeast-2.elb.amazonaws.com

echo "== stock-monitoring smoke test =="
echo "   CloudFront: $URL"
echo "   ALB:        $ALB_DNS"
echo

echo "1) health:"
curl -fsS --max-time 30 "$URL/api/health" | python3 -m json.tool

echo "2) overview:"
curl -fsS --max-time 60 "$URL/api/market/overview" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('   asOf:',d['asOf'],'marketOpen:',d['marketOpen'],'indices:',len(d['data']['indices']))"

echo "3) SPA fallback (/stocks/005930.KS):"
spa_code="$(curl -fsS --max-time 30 "$URL/stocks/005930.KS" -o /dev/null -w '%{http_code}')"
echo "   HTTP $spa_code"
[[ "$spa_code" == "200" ]] || { echo "   FAIL: expected 200" >&2; exit 1; }

echo "4) ALB direct access blocked:"
# curl 이 타임아웃/연결 실패로 죽어도 스크립트를 끝내지 않는다 (차단 성공이므로).
# A curl timeout or connection failure must not abort the script - it is the pass case.
alb_code="$(curl -s --max-time 10 "http://${ALB_DNS}/api/health" -o /dev/null -w '%{http_code}' || true)"
case "$alb_code" in
  403)     echo "   HTTP 403 - OK (listener default action rejected the unverified request)" ;;
  000|"")  echo "   no response within 10s - OK (blocked by the CloudFront prefix-list SG)" ;;
  *)       echo "   FAIL: ALB answered HTTP $alb_code - direct access is NOT blocked" >&2; exit 1 ;;
esac

echo
echo "== all smoke checks passed =="
