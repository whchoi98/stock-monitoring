"""
stock-monitoring 인프라 스택 / The stock-monitoring infrastructure stack.

CloudFront(redirect-to-https) -> ALB(80, CloudFront prefix list만) -> Fargate(private subnet)
-> DynamoDB 캐시 + Bedrock. 네트워크 리소스(VPC/서브넷/NATGW/IGW)는 절대 생성하지 않고
기존 `cc-on-bedrock-vpc`를 참조만 한다.
CloudFront (redirect-to-https) -> ALB (port 80, CloudFront prefix list only) -> Fargate in the
private subnets -> DynamoDB cache + Bedrock. No network resource (VPC/subnet/NAT GW/IGW) is ever
created here; the pre-existing `cc-on-bedrock-vpc` is referenced only.
"""
from pathlib import Path

import aws_cdk as cdk
from aws_cdk import (
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cloudwatch as cloudwatch,
    aws_dynamodb as dynamodb,
    aws_ec2 as ec2,
    aws_ecr_assets as ecr_assets,
    aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_iam as iam,
    aws_logs as logs,
    aws_secretsmanager as secretsmanager,
)
from constructs import Construct

# ---------------------------------------------------------------------------
# 고정 식별자 / Fixed identifiers
#
# 공유 VPC이므로 모든 이름에 `stock-monitoring` 프리픽스를 붙인다 (충돌·오인 방지).
# The VPC is shared, so every name carries the `stock-monitoring` prefix.
# ---------------------------------------------------------------------------
PREFIX = "stock-monitoring"

VPC_ID = "vpc-0dfa5610180dfa628"
PUBLIC_SUBNET_IDS = ("subnet-08486a1e618b1991e", "subnet-0c161777c4031c320")
PRIVATE_SUBNET_IDS = ("subnet-07b1e65682847dce9", "subnet-095297380cd45e1eb")

# com.amazonaws.global.cloudfront.origin-facing - ALB SG 인바운드는 이 1규칙만 쓴다
# (prefix list 하나가 SG 규칙 슬롯을 ~55개 소비하므로 전용 SG가 필수다).
# One prefix-list rule eats ~55 SG rule slots, hence the dedicated SG with a single rule.
CLOUDFRONT_PREFIX_LIST_ID = "pl-22a6434b"

CONTAINER_PORT = 8000
BEDROCK_REGION = "ap-northeast-2"
ORIGIN_VERIFY_HEADER = "X-Origin-Verify"

# 이미지 빌드 컨텍스트는 리포지토리 루트다 (루트 Dockerfile이 frontend+backend를 함께 빌드).
# 프로세스 CWD가 아니라 이 파일 위치에서 계산한다: stacks/ -> infra/ -> repo root.
# The image build context is the repository root; derived from this file, not the process CWD.
PROJECT_ROOT = str(Path(__file__).resolve().parents[2])

# Dockerfile의 HEALTHCHECK와 동일한 명령. ECS 에이전트는 이미지에 박힌 HEALTHCHECK를
# 보지 않으므로 태스크 정의에서 다시 선언해야 효력이 있다 (죽은 태스크 교체를 앞당긴다).
# Same command as the Dockerfile HEALTHCHECK. The ECS agent ignores the image's own HEALTHCHECK,
# so it must be re-declared on the task definition to have any effect.
CONTAINER_HEALTHCHECK_CMD = (
    'python -c "import urllib.request;'
    f"urllib.request.urlopen('http://localhost:{CONTAINER_PORT}/api/health')\" || exit 1"
)


class StockMonitoringStack(cdk.Stack):
    """단일 스택: 캐시/시크릿/컨테이너/ALB/CloudFront/알람 / One stack for the whole service."""

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # -------------------------------------------------------------------
        # 1) VPC 참조 (생성 금지) / Reference the existing VPC - never create one
        # -------------------------------------------------------------------
        vpc = ec2.Vpc.from_lookup(self, "Vpc", vpc_id=VPC_ID)

        # 서브넷은 ID로 직접 지정한다. route table 정보가 없어 CDK가 경고를 내지만
        # 배치에는 문제 없다 (배치 대상만 필요하고 라우팅 판단은 하지 않는다).
        # Subnets are pinned by ID. CDK warns about the unknown route table, which is harmless:
        # we only need placement, never routing decisions.
        public_subnets = [
            ec2.Subnet.from_subnet_id(self, f"Pub{i}", subnet_id)
            for i, subnet_id in enumerate(PUBLIC_SUBNET_IDS, start=1)
        ]
        private_subnets = [
            ec2.Subnet.from_subnet_id(self, f"Priv{i}", subnet_id)
            for i, subnet_id in enumerate(PRIVATE_SUBNET_IDS, start=1)
        ]

        # -------------------------------------------------------------------
        # 2) DynamoDB 캐시 테이블 (L2) / DynamoDB cache table (L2)
        #
        # 순수 캐시이므로 RemovalPolicy.DESTROY다 - 스택을 지우면 같이 지워도 된다.
        # Pure cache: DESTROY is intentional, there is nothing to preserve.
        # -------------------------------------------------------------------
        table = dynamodb.Table(
            self,
            "CacheTable",
            table_name=f"{PREFIX}-cache",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            time_to_live_attribute="ttl",
            removal_policy=cdk.RemovalPolicy.DESTROY,
        )

        # -------------------------------------------------------------------
        # 3) 오리진 검증 시크릿 / Origin verification secret
        #
        # `unsafe_unwrap()`은 의도된 선택이다: 리스너 규칙 조건과 CloudFront 커스텀 헤더는
        # 시크릿 동적 참조(`{{resolve:...}}`)를 지원하지 않으므로 synth 시점 값이 필요하다.
        # 값은 CloudFormation 템플릿에 평문으로 들어간다. 로테이션은 스택 재배포로 한다.
        # `unsafe_unwrap()` is deliberate: neither listener-rule conditions nor CloudFront custom
        # headers support secret dynamic references, so a synth-time value is required. The value
        # lands in the template in clear text; rotation means redeploying the stack.
        # -------------------------------------------------------------------
        origin_secret = secretsmanager.Secret(
            self,
            "OriginVerifySecret",
            secret_name=f"{PREFIX}/origin-verify",
            generate_secret_string=secretsmanager.SecretStringGenerator(
                exclude_punctuation=True,
                password_length=32,
            ),
        )
        header_value = origin_secret.secret_value.unsafe_unwrap()

        # -------------------------------------------------------------------
        # 4) ECS 클러스터 + 이미지 / ECS cluster and image
        #
        # 빌드 호스트가 aarch64이고 amd64 크로스빌드용 QEMU가 없다. 그래서 이미지는
        # arm64로 빌드하고 태스크 정의도 ARM64로 선언한다 (Fargate Graviton, 더 저렴).
        # The build host is aarch64 with no QEMU for amd64 cross-builds, so the image is built for
        # arm64 and the task definition declares ARM64 (Fargate Graviton, and cheaper).
        # -------------------------------------------------------------------
        cluster = ecs.Cluster(self, "Cluster", cluster_name=PREFIX, vpc=vpc)
        image = ecr_assets.DockerImageAsset(
            self,
            "Image",
            directory=PROJECT_ROOT,
            platform=ecr_assets.Platform.LINUX_ARM64,
        )

        # -------------------------------------------------------------------
        # 5) 태스크 정의 (0.5 vCPU / 1GB) + 권한 + 로그 / Task definition, IAM, logs
        # -------------------------------------------------------------------
        task_def = ecs.FargateTaskDefinition(
            self,
            "TaskDef",
            family=PREFIX,
            cpu=512,
            memory_limit_mib=1024,
            runtime_platform=ecs.RuntimePlatform(
                cpu_architecture=ecs.CpuArchitecture.ARM64,
                operating_system_family=ecs.OperatingSystemFamily.LINUX,
            ),
        )
        task_def.add_container(
            "app",
            image=ecs.ContainerImage.from_docker_image_asset(image),
            port_mappings=[ecs.PortMapping(container_port=CONTAINER_PORT)],
            # BEDROCK_MODEL_ID는 넣지 않는다: 코드 기본값(global.anthropic.claude-sonnet-4-6)이
            # 검증된 운영 값이므로 env로 덮어쓰면 오히려 위험하다.
            # BEDROCK_MODEL_ID is intentionally absent: the code default is the verified value.
            environment={
                "CACHE_TABLE": table.table_name,
                "BEDROCK_REGION": BEDROCK_REGION,
            },
            health_check=ecs.HealthCheck(
                command=["CMD-SHELL", CONTAINER_HEALTHCHECK_CMD],
                interval=cdk.Duration.seconds(30),
                timeout=cdk.Duration.seconds(5),
                retries=3,
                start_period=cdk.Duration.seconds(30),
            ),
            logging=ecs.LogDrivers.aws_logs(
                stream_prefix=PREFIX,
                log_retention=logs.RetentionDays.TWO_WEEKS,
            ),
        )

        # 최소 권한: 백엔드 L2가 실제로 쓰는 것은 GetItem/PutItem뿐이고, 그 외는 배치/쿼리
        # 여유분이다. 테이블 ARN 한정 (GSI 없음).
        # Least privilege: the backend L2 only issues GetItem/PutItem; the rest is headroom.
        # Scoped to the table ARN (there is no index).
        task_def.task_role.add_to_principal_policy(
            iam.PolicyStatement(
                actions=[
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:BatchGetItem",
                    "dynamodb:BatchWriteItem",
                    "dynamodb:Query",
                ],
                resources=[table.table_arn],
            )
        )
        # `global.` 추론 프로파일은 교차 리전 모델 ARN으로 해석되므로 리소스를 특정할 수 없다.
        # The `global.` inference profile resolves to cross-region model ARNs, so `*` is required.
        task_def.task_role.add_to_principal_policy(
            iam.PolicyStatement(actions=["bedrock:InvokeModel"], resources=["*"])
        )

        # -------------------------------------------------------------------
        # 6) Fargate 서비스 - private 서브넷 명시 / Fargate service in private subnets only
        #
        # desired_count=1은 load-bearing이다: 컨테이너가 `--workers 1`로 돌고 L1 캐시와
        # AI 동시성 세마포어가 프로세스 단위이므로 스케일아웃은 의도적으로 하지 않는다.
        # desired_count=1 is load-bearing: the container runs `--workers 1` and both the L1 cache
        # and the AI concurrency semaphore are per-process. Scaling out is deliberately not done.
        # -------------------------------------------------------------------
        service = ecs.FargateService(
            self,
            "Service",
            service_name=PREFIX,
            cluster=cluster,
            task_definition=task_def,
            desired_count=1,
            vpc_subnets=ec2.SubnetSelection(subnets=private_subnets),
            min_healthy_percent=100,
            max_healthy_percent=200,
        )

        # -------------------------------------------------------------------
        # 7) ALB - public 서브넷 + 전용 SG(prefix list 1규칙) / ALB with its own SG
        # -------------------------------------------------------------------
        alb_sg = ec2.SecurityGroup(
            self,
            "AlbSg",
            vpc=vpc,
            security_group_name=f"{PREFIX}-alb-sg",
            allow_all_outbound=True,
            description=f"{PREFIX} ALB - CloudFront prefix list only",
        )
        alb_sg.add_ingress_rule(
            ec2.Peer.prefix_list(CLOUDFRONT_PREFIX_LIST_ID),
            ec2.Port.tcp(80),
            "CloudFront origin-facing prefix list",
        )
        alb = elbv2.ApplicationLoadBalancer(
            self,
            "Alb",
            load_balancer_name=f"{PREFIX}-alb",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_sg,
            vpc_subnets=ec2.SubnetSelection(subnets=public_subnets),
        )

        # -------------------------------------------------------------------
        # 8) 리스너: 기본 403, 헤더 일치 시에만 forward / Listener: default 403, forward on header
        #
        # ALB를 직접 때리는 트래픽은 헤더를 모르므로 403이다 (CloudFront 우회 차단).
        # Traffic hitting the ALB directly does not know the header, so it gets a 403.
        # -------------------------------------------------------------------
        # `open=False`가 load-bearing이다: 기본값(True)이면 CDK가 ALB SG에 0.0.0.0/0:80
        # 인바운드를 추가해버려서 "prefix list 단 1규칙" 제약이 깨진다.
        # `open=False` is load-bearing: the default (True) makes CDK add a 0.0.0.0/0:80 ingress rule
        # to the ALB SG, which would break the "single prefix-list rule" constraint.
        listener = alb.add_listener(
            "Http",
            port=80,
            open=False,
            default_action=elbv2.ListenerAction.fixed_response(
                403, content_type="text/plain", message_body="Forbidden"
            ),
        )
        tg = elbv2.ApplicationTargetGroup(
            self,
            "Tg",
            target_group_name=f"{PREFIX}-tg",
            vpc=vpc,
            port=CONTAINER_PORT,
            protocol=elbv2.ApplicationProtocol.HTTP,
            targets=[service],
            health_check=elbv2.HealthCheck(path="/api/health", healthy_http_codes="200"),
        )
        listener.add_action(
            "VerifiedForward",
            priority=1,
            conditions=[
                elbv2.ListenerCondition.http_header(ORIGIN_VERIFY_HEADER, [header_value])
            ],
            action=elbv2.ListenerAction.forward([tg]),
        )

        # -------------------------------------------------------------------
        # 9) CloudFront / CloudFront distribution
        #
        # ALB에 인증서가 없으므로 오리진은 HTTP_ONLY, 뷰어는 redirect-to-https다.
        # origin request policy가 필수다: CloudFront는 기본적으로 쿼리스트링과 대부분의
        # 헤더를 오리진에 전달하지 않는다. `?market=`, `?period=`와 POST의 Content-Type이
        # 사라지면 API가 깨진다. ALL_VIEWER_EXCEPT_HOST_HEADER는 Host를 ALB 도메인으로
        # 유지하면서 나머지를 그대로 넘긴다. 오리진 커스텀 헤더는 뷰어가 같은 이름을 보내도
        # CloudFront가 덮어쓰므로 검증 헤더는 위조되지 않는다.
        # The ALB has no certificate, so the origin is HTTP_ONLY and viewers are redirected to
        # https. An origin request policy is mandatory: by default CloudFront forwards neither
        # query strings nor most headers, which would break `?market=`, `?period=` and the POST
        # Content-Type. ALL_VIEWER_EXCEPT_HOST_HEADER forwards everything but keeps the ALB Host.
        # A viewer cannot forge the verification header: custom origin headers always overwrite it.
        # -------------------------------------------------------------------
        origin = origins.HttpOrigin(
            alb.load_balancer_dns_name,
            protocol_policy=cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            custom_headers={ORIGIN_VERIFY_HEADER: header_value},
        )
        dist = cloudfront.Distribution(
            self,
            "Dist",
            comment=f"{PREFIX} distribution",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origin,
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                origin_request_policy=cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                compress=True,
            ),
            # /assets/*는 vite가 낸 불변 해시 파일명이므로 장기 캐시한다 (쿼리스트링 불필요).
            # /assets/* are vite's immutable hashed filenames: long cache, no query strings needed.
            additional_behaviors={
                "/assets/*": cloudfront.BehaviorOptions(
                    origin=origin,
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                    compress=True,
                )
            },
        )

        # -------------------------------------------------------------------
        # 10) 알람 + Outputs / Alarms and outputs
        # -------------------------------------------------------------------
        # ELB 자체가 낸 5xx (오리진 5xx가 아니라 LB 레벨 실패). 카운트 지표는 0일 때
        # 아예 보고되지 않으므로 결측을 정상으로 취급한다.
        # ELB-generated 5xx (LB-level failures, not origin ones). Count metrics are not reported
        # when zero, so missing data is treated as OK.
        cloudwatch.Alarm(
            self,
            "Alb5xx",
            alarm_name=f"{PREFIX}-alb-5xx",
            alarm_description=f"{PREFIX}: ALB-generated 5xx spike",
            metric=alb.metrics.http_code_elb(
                elbv2.HttpCodeElb.ELB_5XX_COUNT, period=cdk.Duration.minutes(5)
            ),
            threshold=10,
            evaluation_periods=1,
            treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
        )
        # 태스크 수 알람: `RunningTaskCount`는 Container Insights 전용 지표(ECS/ContainerInsights
        # 네임스페이스)이므로 Insights 없이 쓰면 알람이 영구 INSUFFICIENT_DATA에 머문다.
        # `AWS/ECS`의 `LiveTaskCount`는 Insights 없이도 나오고 0도 보고하므로 이걸 쓴다.
        # 결측은 breaching으로 본다 (지표가 끊긴 것 = 태스크가 없는 것).
        # Task-count alarm: `RunningTaskCount` only exists in the ECS/ContainerInsights namespace,
        # so without Container Insights that alarm would sit in INSUFFICIENT_DATA forever.
        # `LiveTaskCount` in AWS/ECS is emitted without Insights and does report 0, so use it.
        # Missing data is breaching: no metric at all means no task.
        cloudwatch.Alarm(
            self,
            "TaskCount",
            alarm_name=f"{PREFIX}-task-count",
            alarm_description=f"{PREFIX}: fewer than 1 live task",
            metric=service.metric(
                "LiveTaskCount", statistic="Minimum", period=cdk.Duration.minutes(5)
            ),
            threshold=1,
            comparison_operator=cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            evaluation_periods=2,
            treat_missing_data=cloudwatch.TreatMissingData.BREACHING,
        )

        cdk.CfnOutput(self, "CloudFrontURL", value=f"https://{dist.distribution_domain_name}")
        cdk.CfnOutput(self, "AlbDNS", value=alb.load_balancer_dns_name)
        cdk.CfnOutput(self, "CacheTableName", value=table.table_name)
