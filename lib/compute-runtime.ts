import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DEPLOYMENT_GATE_THRESHOLDS, deploymentAlarmName, deploymentAlarmNames, WORKER_ALARM_THRESHOLDS } from './contracts.mjs';
import type { PlatformDatabase } from './platform-inputs';

export interface ComputeRuntimeProps {
  stage: 'beta' | 'prod';
  vpc: ec2.IVpc;
  database: PlatformDatabase;
  wardrobeBucket: s3.IBucket;
  repository: ecr.IRepository;
  /** The recorded stage-base ECR URI the `ServiceRepositoryUri` output reports. */
  repositoryUri: string;
  vtoQueue: sqs.IQueue;
  vtoDeadLetterQueue: sqs.IQueue;
  autoTaggingQueue: sqs.IQueue;
  autoTaggingDeadLetterQueue: sqs.IQueue;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  qWeatherApiKeySecret: secretsmanager.ISecret;
  cluster: ecs.ICluster;
  apiSecurityGroup: ec2.ISecurityGroup;
  workerSecurityGroup: ec2.ISecurityGroup;
  loadBalancerSecurityGroup: ec2.ISecurityGroup;
  operationsTopic?: sns.ITopic;
  betaApiS2Condition?: cdk.CfnCondition;
}

export class ComputeRuntime extends Construct {
  readonly cluster: ecs.ICluster;
  readonly imageDigest: cdk.CfnParameter;
  readonly serviceCommit: cdk.CfnParameter;
  readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
  readonly apiService: ecs.FargateService;
  readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeRuntimeProps) {
    super(scope, id);

    // The two identity `allowedPattern`s below are one contract with
    // AnyWear-Service/src/config/env.ts: they must stay character-identical to
    // SERVICE_COMMIT_SHA_PATTERN and IMAGE_DIGEST_PATTERN, so a value this
    // template accepts never fails the Service's startup gate. Change both sides
    // together.
    const imageDigest = new cdk.CfnParameter(cdk.Stack.of(this), 'ServiceImageDigest', {
      type: 'String',
      description: 'Immutable ECR image digest qualified for this deployment',
      allowedPattern: '^sha256:[a-f0-9]{64}$',
      constraintDescription: 'Must be a sha256 OCI image digest',
    });
    const serviceCommit = new cdk.CfnParameter(cdk.Stack.of(this), 'ServiceCommitSha', {
      type: 'String',
      description: 'Exact AnyWear-Service commit represented by the image',
      allowedPattern: '^[a-f0-9]{40}$',
    });
    this.imageDigest = imageDigest;
    this.serviceCommit = serviceCommit;
    const providerSecretArn = new cdk.CfnParameter(cdk.Stack.of(this), 'VlmConfigArn', {
      type: 'String',
      description: 'Secrets Manager ARN containing DOUBAO_VLM_API_KEY',
    });
    const cloudFrontPrefixListId = new cdk.CfnParameter(cdk.Stack.of(this), 'CloudFrontPrefixListId', {
      type: 'String',
      description: 'Regional ID for com.amazonaws.global.cloudfront.origin-facing',
      allowedPattern: '^pl-[a-z0-9]+$',
    });
    const originHeaderSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudFrontOriginHeaderSecret',
      `/anywear/${props.stage}/cloudfront_origin_header`,
    );
    const originHeaderValue = originHeaderSecret.secretValue.unsafeUnwrap();
    const qWeatherApiHost = ssm.StringParameter.valueForStringParameter(
      this,
      `/anywear/${props.stage}/qweather_api_host`,
    );
    this.cluster = props.cluster;
    // The API CloudFront distribution moved to Infra Base in #166; the Runtime
    // stack owns the ALB, which still accepts only CloudFront origin traffic.
    new ec2.CfnSecurityGroupIngress(this, 'CloudFrontOriginIngress', {
      groupId: props.loadBalancerSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      sourcePrefixListId: cloudFrontPrefixListId.valueAsString,
      description: 'CloudFront origin-facing network only',
    });

    this.loadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${props.stage}-anywear-api`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.loadBalancerSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      targetGroupName: `${props.stage}-anywear-api`,
      vpc: props.vpc,
      port: 3000,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      targetType: elasticloadbalancingv2.TargetType.IP,
      healthCheck: {
        path: '/readyz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elasticloadbalancingv2.ListenerAction.fixedResponse(403, {
        contentType: 'application/json',
        messageBody: '{"error":"forbidden_origin"}',
      }),
    });
    listener.addAction('CloudFrontVerifiedOrigin', {
      priority: 1,
      conditions: [elasticloadbalancingv2.ListenerCondition.httpHeader(
        'X-AnyWear-Origin-Verify',
        [originHeaderValue],
      )],
      action: elasticloadbalancingv2.ListenerAction.forward([targetGroup]),
    });

    const image = ecs.ContainerImage.fromRegistry(
      `${props.repository.repositoryUri}@${imageDigest.valueAsString}`,
    );
    const retention = props.stage === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
    const apiLogGroup = this.createLogGroup('ApiLogGroup', `/anywear/${props.stage}/api`, retention, props.stage);
    const workerLogGroup = this.createLogGroup('WorkerLogGroup', `/anywear/${props.stage}/worker`, retention, props.stage);

    const apiTaskRole = this.createTaskRole('ApiTaskRole', `${props.stage}-anywear-api-task`);
    const apiExecutionRole = this.createTaskRole('ApiExecutionRole', `${props.stage}-anywear-api-execution`);
    const workerTaskRole = this.createTaskRole('WorkerTaskRole', `${props.stage}-anywear-worker-task`);
    const workerExecutionRole = this.createTaskRole('WorkerExecutionRole', `${props.stage}-anywear-worker-execution`);
    const cleanupMachineAuthSecret = props.stage === 'beta'
      ? secretsmanager.Secret.fromSecretNameV2(
        this,
        'CleanupMachineAuthSecret',
        '/anywear/beta/cleanup_machine_auth',
      )
      : undefined;

    for (const role of [apiExecutionRole, workerExecutionRole]) {
      props.repository.grantPull(role);
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    }
    props.database.secret?.grantRead(apiTaskRole);
    props.database.secret?.grantRead(workerTaskRole);
    cleanupMachineAuthSecret?.grantRead(apiTaskRole);
    props.wardrobeBucket.grantReadWrite(apiTaskRole);
    props.wardrobeBucket.grantReadWrite(workerTaskRole);
    props.vtoQueue.grantSendMessages(workerTaskRole);
    props.vtoQueue.grantConsumeMessages(workerTaskRole);
    props.autoTaggingQueue.grantSendMessages(workerTaskRole);
    props.autoTaggingQueue.grantConsumeMessages(workerTaskRole);
    // ECS task scale-in protection: the container agent signs these two calls
    // with the task role's credentials on the task's behalf. The task ARN has no
    // service segment, so the cluster's task ARNs are the narrowest stable
    // scope; the role is attached only to the worker task definition, and no
    // other role carries these actions.
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:GetTaskProtection', 'ecs:UpdateTaskProtection'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'ecs',
        resource: 'task',
        resourceName: `${props.cluster.clusterName}/*`,
      })],
    }));

    const commonEnvironment: Record<string, string> = {
      STAGE: props.stage,
      NODE_ENV: 'production',
      AWS_REGION: cdk.Stack.of(this).region,
      DB_SECRET_ARN: props.database.secret?.secretArn ?? '',
      DB_HOST: props.database.clusterEndpoint.hostname,
      DB_PORT: props.database.clusterEndpoint.port.toString(),
      DB_NAME: 'anywear',
      S3_BUCKET_NAME: props.wardrobeBucket.bucketName,
      TASK_TRANSPORT: 'sqs',
      SQS_VTO_QUEUE_URL: props.vtoQueue.queueUrl,
      SQS_AUTO_TAGGING_QUEUE_URL: props.autoTaggingQueue.queueUrl,
      SERVICE_COMMIT_SHA: serviceCommit.valueAsString,
      IMAGE_DIGEST: imageDigest.valueAsString,
    };

    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `${props.stage}-anywear-api`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: apiTaskRole,
      executionRole: apiExecutionRole,
    });
    if (props.stage === 'beta' && props.betaApiS2Condition) {
      // One retained profile selects the complete candidate pair; S1 is default.
      const task = apiTaskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
      task.cpu = cdk.Token.asString(cdk.Fn.conditionIf(props.betaApiS2Condition.logicalId, '256', '512'));
      task.memory = cdk.Token.asString(cdk.Fn.conditionIf(props.betaApiS2Condition.logicalId, '512', '1024'));
    }
    apiTaskDefinition.addContainer('ApiContainer', {
      image,
      command: ['node', 'dist/api.js'],
      environment: {
        ...commonEnvironment,
        PORT: '3000',
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        QWEATHER_API_HOST: qWeatherApiHost,
      },
      secrets: {
        QWEATHER_API_KEY: ecs.Secret.fromSecretsManager(props.qWeatherApiKeySecret),
        ...(cleanupMachineAuthSecret ? {
          CLEANUP_MACHINE_AUTH_SECRET: ecs.Secret.fromSecretsManager(cleanupMachineAuthSecret),
        } : {}),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogGroup, streamPrefix: 'api' }),
      portMappings: [{ containerPort: 3000, name: 'http', appProtocol: ecs.AppProtocol.http }],
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3000/readyz\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefinition', {
      family: `${props.stage}-anywear-worker`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: workerTaskRole,
      executionRole: workerExecutionRole,
    });
    workerTaskDefinition.addContainer('WorkerContainer', {
      image,
      command: ['node', 'dist/worker.js'],
      environment: { ...commonEnvironment, VLM_DEFAULT_PROVIDER: 'doubao' },
      secrets: {
        DOUBAO_VLM_API_KEY: ecs.Secret.fromSecretsManager(
          cdk.aws_secretsmanager.Secret.fromSecretCompleteArn(this, 'ProviderSecret', providerSecretArn.valueAsString),
          'DOUBAO_VLM_API_KEY',
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogGroup, streamPrefix: 'worker' }),
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      serviceName: `${props.stage}-anywear-api`,
      cluster: this.cluster,
      taskDefinition: apiTaskDefinition,
      // Beta's single-user baseline keeps one API task; Production retains HA.
      desiredCount: props.stage === 'beta' ? 1 : 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.apiSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      enableExecuteCommand: false,
    });
    this.apiService.attachToApplicationTargetGroup(targetGroup);

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      serviceName: `${props.stage}-anywear-worker`,
      cluster: this.cluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.workerSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableExecuteCommand: false,
    });

    const apiScaling = this.apiService.autoScaleTaskCount({
      minCapacity: props.stage === 'beta' ? 1 : 2,
      maxCapacity: props.stage === 'prod' ? 10 : 4,
    });
    apiScaling.scaleOnCpuUtilization('ApiCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: props.stage === 'prod' ? 20 : 4,
    });
    // Scale out on work nobody has claimed yet. Visible-only is deliberately the
    // earlier observation: a burst grows the fleet before a task claims the message.
    // Claimed (NotVisible) messages do not count here — the claim belongs to a
    // running task, so adding capacity for it would add idle tasks.
    workerScaling.scaleOnMetric('QueueDepthScaling', {
      metric: new cloudwatch.MathExpression({
        expression: 'vto + tagging',
        usingMetrics: {
          vto: props.vtoQueue.metricApproximateNumberOfMessagesVisible(),
          tagging: props.autoTaggingQueue.metricApproximateNumberOfMessagesVisible(),
        },
        period: cdk.Duration.minutes(1),
      }),
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [
        { lower: 1, change: +1 },
        { lower: 10, change: +2 },
      ],
      cooldown: cdk.Duration.minutes(1),
    });

    // Scale in only when nothing is owed: messages still waiting plus messages
    // already claimed, on both queues. A claimed message stays NotVisible until its
    // receipt is settled (deleted or left for redelivery), so this alarm cannot read
    // zero while a task is working. Two consecutive 60-second periods absorb SQS
    // depth's eventual consistency; the 60-second cooldown bounds the drain.
    workerScaling.scaleOnMetric('QueueDrainScaling', {
      metric: new cloudwatch.MathExpression({
        expression: 'vto_visible + vto_inflight + tagging_visible + tagging_inflight',
        usingMetrics: {
          vto_visible: props.vtoQueue.metricApproximateNumberOfMessagesVisible(),
          vto_inflight: props.vtoQueue.metricApproximateNumberOfMessagesNotVisible(),
          tagging_visible: props.autoTaggingQueue.metricApproximateNumberOfMessagesVisible(),
          tagging_inflight: props.autoTaggingQueue.metricApproximateNumberOfMessagesNotVisible(),
        },
        period: cdk.Duration.minutes(1),
      }),
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 1, change: 0 },
      ],
      cooldown: cdk.Duration.minutes(1),
      evaluationPeriods: 2,
    });

    this.createAlarms(props, workerLogGroup);

    new cdk.CfnOutput(cdk.Stack.of(this), 'ServiceRepositoryUri', { value: props.repositoryUri });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiServiceName', { value: this.apiService.serviceName });
    new cdk.CfnOutput(cdk.Stack.of(this), 'WorkerServiceName', { value: this.workerService.serviceName });
    new cdk.CfnOutput(cdk.Stack.of(this), 'ApiLoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Origin only; direct access is restricted to CloudFront',
    });
  }

  private createTaskRole(id: string, roleName: string): iam.Role {
    return new iam.Role(this, id, {
      roleName,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
  }

  private createLogGroup(
    id: string,
    logGroupName: string,
    retention: logs.RetentionDays,
    stage: string,
  ): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName,
      retention,
      removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }

  private createAlarms(props: ComputeRuntimeProps, workerLogGroup: logs.LogGroup): void {
    const loadBalancer = this.loadBalancer;
    const apiService = this.apiService;
    const workerService = this.workerService;
    // The pinned package is the single source of the deployed alarm names, so the
    // alarms created here and the bake gate's reads can never name different
    // alarms. `<stage>` appears only in these names; every threshold below is
    // stage-free, with no deployment switch.
    const alarmNames = deploymentAlarmNames(props.stage);
    const alarmProps = {
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    } as const;
    const addAction = (alarm: cloudwatch.Alarm) => {
      if (props.operationsTopic && props.stage === 'beta') {
        alarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.operationsTopic));
      }
    };
    const vtoDlqAlarm = new cloudwatch.Alarm(this, 'VtoDlqAlarm', {
      ...alarmProps,
      alarmName: alarmNames.sqs_dlq_depth[0],
      metric: props.vtoDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    addAction(vtoDlqAlarm);
    const autoTaggingDlqAlarm = new cloudwatch.Alarm(this, 'AutoTaggingDlqAlarm', {
      ...alarmProps,
      alarmName: alarmNames.sqs_dlq_depth[1],
      metric: props.autoTaggingDeadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    addAction(autoTaggingDlqAlarm);
    // Issue #220: both oldest-message alarms carry the deployment gate's own
    // recorded age limit, read from the one pinned package constant, so a bake
    // that refuses a stalled queue at 150 seconds can never leave a deployed alarm
    // configured for the retired 600-second calibration (300 s). The period stays
    // at Amazon SQS's five-minute publication interval and `evaluationPeriods: 2`
    // is the pre-existing anti-flap calibration; that makes the alarm's *detection*
    // deliberately later than the gate's, while the age limit is shared.
    const sqsOldestMessageAgeSeconds = DEPLOYMENT_GATE_THRESHOLDS.sqs_oldest_message_age.max_seconds;
    for (const [id, queue, alarmName] of [
      ['VtoAgeAlarm', props.vtoQueue, alarmNames.sqs_oldest_message_age[0]],
      ['AutoTaggingAgeAlarm', props.autoTaggingQueue, alarmNames.sqs_oldest_message_age[1]],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, id, {
        ...alarmProps,
        alarmName,
        metric: queue.metricApproximateAgeOfOldestMessage(),
        threshold: sqsOldestMessageAgeSeconds,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
      });
      addAction(alarm);
    }
    const apiCpuAlarm = new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      ...alarmProps,
      alarmName: `${props.stage}-anywear-api-high-cpu`,
      metric: apiService.metricCpuUtilization(),
      threshold: 85,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
    });
    addAction(apiCpuAlarm);

    // Issue #162 added the bake alarms and issue #219 set the deployment bake to
    // 300 seconds. Each one is a deployed, named entity the bake reads; the bake's
    // own pass/fail never reads alarm state.
    const alb5xxRate = new cloudwatch.MathExpression({
      // AWS's recommended 5% 5xx alarm, over 60-second sums. MAX takes one time
      // series, so the zero-request guard is an IF over a scalar comparison; it
      // yields 0 for an idle period instead of a missing datapoint.
      expression: 'IF(requests > 0, 100 * (target5xx + elb5xx) / requests, 0)',
      usingMetrics: {
        target5xx: loadBalancer.metrics.httpCodeTarget(elasticloadbalancingv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(1),
        }),
        elb5xx: loadBalancer.metrics.httpCodeElb(elasticloadbalancingv2.HttpCodeElb.ELB_5XX_COUNT, {
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(1),
        }),
        requests: loadBalancer.metrics.requestCount({
          statistic: cloudwatch.Stats.SUM,
          period: cdk.Duration.minutes(1),
        }),
      },
      period: cdk.Duration.minutes(1),
    });
    const alb5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      ...alarmProps,
      alarmName: alarmNames.alb_5xx_rate[0],
      metric: alb5xxRate,
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
    });
    addAction(alb5xxAlarm);
    // TargetResponseTime is published in seconds, so 5 is the gate's 5000 ms.
    const apiP95LatencyAlarm = new cloudwatch.Alarm(this, 'ApiP95LatencyAlarm', {
      ...alarmProps,
      alarmName: alarmNames.alb_p95_latency[0],
      metric: loadBalancer.metrics.targetResponseTime({
        statistic: cloudwatch.Stats.p(95),
        period: cdk.Duration.minutes(1),
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
    });
    addAction(apiP95LatencyAlarm);
    // Container Insights is enabled on the shared cluster; these are the two ECS
    // services this release slice deploys.
    const containerInsights = (metricName: string, serviceName: string) => new cloudwatch.Metric({
      namespace: 'AWS/ECS/ContainerInsights',
      metricName,
      dimensionsMap: { ClusterName: props.cluster.clusterName, ServiceName: serviceName },
      statistic: cloudwatch.Stats.AVERAGE,
      period: cdk.Duration.minutes(1),
    });
    const runningNotDesired = new cloudwatch.MathExpression({
      expression: 'MAX([api_desired - api_running, worker_desired - worker_running])',
      usingMetrics: {
        api_desired: containerInsights('DesiredTaskCount', apiService.serviceName),
        api_running: containerInsights('RunningTaskCount', apiService.serviceName),
        worker_desired: containerInsights('DesiredTaskCount', workerService.serviceName),
        worker_running: containerInsights('RunningTaskCount', workerService.serviceName),
      },
      period: cdk.Duration.minutes(1),
    });
    // 120 seconds of a positive gap is the gate's continuous tolerance.
    const ecsRunningNotDesiredAlarm = new cloudwatch.Alarm(this, 'EcsRunningNotDesiredAlarm', {
      ...alarmProps,
      alarmName: alarmNames.ecs_running_not_desired[0],
      metric: runningNotDesired,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });
    addAction(ecsRunningNotDesiredAlarm);
    // The worker logs this JSON line every 60 seconds with `outboxOldestAgeMs`
    // and `outboxBacklog`; the filter turns it into the metric the alarm reads.
    // The `$.outboxOldestAgeMs` metric value requires a JSON filter pattern; a
    // literal pattern is only valid with a static metric value.
    //
    // Issue #220 removed the `defaultValue: 0`. AWS publishes a filter's default
    // when the pattern does not match an event or a period, not only when a matched
    // line's field is missing, so the 0 default is what made a non-empty backlog
    // with no age look healthy. This filter now publishes nothing it cannot extract.
    const workerOutboxMetrics = new logs.MetricFilter(this, 'WorkerOutboxMetricFilter', {
      logGroup: workerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'Durable task outbox metrics'),
      metricNamespace: 'AnyWear/Worker',
      metricName: 'OutboxOldestAgeMs',
      metricValue: '$.outboxOldestAgeMs',
      unit: cloudwatch.Unit.MILLISECONDS,
    });
    // Issue #220 fail-closed half: a matched worker line with a non-empty backlog
    // and a null or absent age publishes the static sentinel, one millisecond above
    // the alarm threshold and derived from the same package constant, so the two
    // cannot drift. A static metric value is emitted only on a pattern match, so a
    // healthy line, an idle worker and an empty backlog with a null age publish
    // nothing and stay OK under `TreatMissingData: notBreaching`; only a non-empty
    // backlog with no age can produce 150001 ms. The bake names the same case
    // ("backlog > 0 with a null age is breaching"), which the deployed alarm could
    // not report while a missing age read as 0.
    const outboxOldestAgeMilliseconds = DEPLOYMENT_GATE_THRESHOLDS.outbox_oldest_age.max_age_milliseconds;
    new logs.MetricFilter(this, 'WorkerOutboxMissingAgeFilter', {
      logGroup: workerLogGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.msg', '=', 'Durable task outbox metrics'),
        logs.FilterPattern.numberValue('$.outboxBacklog', '>', 0),
        logs.FilterPattern.any(
          logs.FilterPattern.isNull('$.outboxOldestAgeMs'),
          logs.FilterPattern.notExists('$.outboxOldestAgeMs'),
        ),
      ),
      metricNamespace: 'AnyWear/Worker',
      metricName: 'OutboxOldestAgeMs',
      metricValue: `${outboxOldestAgeMilliseconds + 1}`,
      unit: cloudwatch.Unit.MILLISECONDS,
    });
    const outboxOldestAgeAlarm = new cloudwatch.Alarm(this, 'OutboxOldestAgeAlarm', {
      ...alarmProps,
      alarmName: alarmNames.outbox_oldest_age[0],
      metric: workerOutboxMetrics.metric({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: cdk.Duration.minutes(1),
      }),
      // Issue #220: the gate's own recorded outbox age limit, in milliseconds
      // (150000 ms), so a real age breaches at the same point the bake refuses it.
      threshold: outboxOldestAgeMilliseconds,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });
    addAction(outboxOldestAgeAlarm);

    // Issue #321: the object-deletion ledger's standing state. The worker reaper
    // emits one `Object deletion manifest standing state` line per tick carrying
    // `objectDeletionAbandoned`; two alarms read it, both wired through the same
    // `addAction` the worker's other alarms use. Every number below comes from
    // `WORKER_ALARM_THRESHOLDS`, so the deployed alarm and the reviewed contract
    // cannot drift. The pair is deliberately not a bake signal: the 300-second bake
    // cannot observe an hours-long failure, so neither name is added to
    // `DEPLOYMENT_GATE_SIGNAL_NAMES` and the bake never reads them.
    const workerStatistic = (statistic: 'Maximum' | 'Sum') => (statistic === 'Maximum'
      ? cloudwatch.Stats.MAXIMUM : cloudwatch.Stats.SUM);
    const workerComparison = (comparison: 'greater_than_threshold' | 'less_than_threshold') => (
      comparison === 'greater_than_threshold'
        ? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
        : cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD);
    const workerMissingData = (treatMissingData: 'breaching' | 'notBreaching') => (
      treatMissingData === 'breaching'
        ? cloudwatch.TreatMissingData.BREACHING : cloudwatch.TreatMissingData.NOT_BREACHING);
    // The abandoned-count filter extracts the integer the line always carries, so
    // it sets no `defaultValue`: AWS publishes a filter default whenever the
    // pattern does not match, and #220 removed exactly that from the outbox filter
    // because a zero default makes a quiet system look healthy. The ADR also
    // deleted the count-null sentinel — the line always carries an integer count,
    // so a filter keyed on null could never distinguish "nothing abandoned" from
    // "no signal".
    const abandonedThreshold = WORKER_ALARM_THRESHOLDS.object_deletion_abandoned;
    const abandonedFilter = new logs.MetricFilter(this, 'WorkerObjectDeletionAbandonedMetricFilter', {
      logGroup: workerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'Object deletion manifest standing state'),
      metricNamespace: 'AnyWear/Worker',
      metricName: abandonedThreshold.metric,
      metricValue: '$.objectDeletionAbandoned',
      unit: cloudwatch.Unit.COUNT,
    });
    // The tick filter publishes the static value 1 on every matched line. A
    // per-tick signal cannot report its own absence, so the alarm's
    // `treatMissingData: BREACHING` over two 300-second periods is what turns a
    // stopped reaper into a breach instead of silence read as health. A static
    // metric value is emitted only on a pattern match, exactly like the outbox
    // missing-age filter, so nothing is published for an idle or stopped worker.
    const tickThreshold = WORKER_ALARM_THRESHOLDS.object_deletion_reaper_tick;
    const tickFilter = new logs.MetricFilter(this, 'WorkerObjectDeletionReaperTickMetricFilter', {
      logGroup: workerLogGroup,
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'Object deletion manifest standing state'),
      metricNamespace: 'AnyWear/Worker',
      metricName: tickThreshold.metric,
      metricValue: '1',
      unit: cloudwatch.Unit.COUNT,
    });
    const objectDeletionAbandonedAlarm = new cloudwatch.Alarm(this, 'ObjectDeletionAbandonedAlarm', {
      alarmName: deploymentAlarmName(props.stage, 'object_deletion_abandoned')[0],
      metric: abandonedFilter.metric({
        statistic: workerStatistic(abandonedThreshold.statistic),
        period: cdk.Duration.seconds(abandonedThreshold.period_seconds),
      }),
      threshold: abandonedThreshold.threshold,
      comparisonOperator: workerComparison(abandonedThreshold.comparison),
      evaluationPeriods: abandonedThreshold.evaluation_periods,
      treatMissingData: workerMissingData(abandonedThreshold.treat_missing_data),
    });
    addAction(objectDeletionAbandonedAlarm);
    const objectDeletionReaperTickAlarm = new cloudwatch.Alarm(this, 'ObjectDeletionReaperTickAlarm', {
      alarmName: deploymentAlarmName(props.stage, 'object_deletion_reaper_tick')[0],
      metric: tickFilter.metric({
        statistic: workerStatistic(tickThreshold.statistic),
        period: cdk.Duration.seconds(tickThreshold.period_seconds),
      }),
      threshold: tickThreshold.threshold,
      comparisonOperator: workerComparison(tickThreshold.comparison),
      evaluationPeriods: tickThreshold.evaluation_periods,
      treatMissingData: workerMissingData(tickThreshold.treat_missing_data),
    });
    addAction(objectDeletionReaperTickAlarm);
  }
}
