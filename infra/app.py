#!/usr/bin/env python3
"""
CDK 엔트리포인트 / CDK entry point.

계정/리전을 명시한다: `Vpc.from_lookup`은 환경이 고정된 스택에서만 동작하고,
lookup 결과는 `cdk.context.json`에 pin되어 커밋된다.
The account/region are explicit: `Vpc.from_lookup` only works on an environment-bound
stack, and its result is pinned into the committed `cdk.context.json`.
"""
import aws_cdk as cdk

from stacks.stock_monitoring_stack import StockMonitoringStack

app = cdk.App()
StockMonitoringStack(
    app,
    "StockMonitoringStack",
    env=cdk.Environment(account="061525506239", region="ap-northeast-2"),
)
app.synth()
