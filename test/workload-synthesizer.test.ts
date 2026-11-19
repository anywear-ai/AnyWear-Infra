import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, type Stack } from 'aws-cdk-lib';
import { DEPLOYMENT_GATE_THRESHOLDS, deploymentAlarmName, deploymentAlarmNames, WORKER_ALARM_THRESHOLDS } from '../lib/contracts.mjs';
import { PLATFORM_REGION, platformInputs, type Stage } from '../lib/platform-inputs';
import { BOOTSTRAP_QUALIFIER, RuntimeStack } from '../lib/runtime-stack';

// Synthesizing a cloud assembly is a little slower than building an in-memory
// template; keep the default Jest timeout out of the way of the identity proof.
jest.setTimeout(180_000);

const infraRoot = path.resolve(__dirname, '..');
const baselines = path.join(infraRoot, 'test', 'baselines');
const provenance = JSON.parse(readFileSync(path.join(baselines, 'provenance.json'), 'utf8')).runtime_identity;
const cdkContext = JSON.parse(readFileSync(path.join(infraRoot, 'cdk.json'), 'utf8')).context;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const assetsBucket = `cdk-${BOOTSTRAP_QUALIFIER}-assets-650880818323-ap-east-1`;

const VARIANTS = [
  { name: 'beta-active', stage: 'beta' as Stage, stackName: 'AnyWearRuntimeStack-beta' },
  { name: 'prod-active', stage: 'prod' as Stage, stackName: 'AnyWearRuntimeStack-prod' },
];

/**
 * Synthesize the real cloud assembly for one recorded legacy-phase variant.
 * The recorded baseline was synthesized from this source with the same
 * `cdk.json` context, so its template hash is the identity to preserve.
 */
function synthesize(variant: (typeof VARIANTS)[number]) {
  const outdir = mkdtempSync(path.join(tmpdir(), 'anywear-runtime-assembly-'));
  try {
    const app = new App({ outdir, context: cdkContext });
    new RuntimeStack(app, variant.stackName, {
      stage: variant.stage,
      env: { account: '650880818323', region: PLATFORM_REGION },
      platform: (scope: Stack) => platformInputs(scope, {
        stage: variant.stage,
        identityPhase: 'legacy',
      }),
    });
    app.synth();
    const manifestText = readFileSync(path.join(outdir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    const artifact = manifest.artifacts[variant.stackName];
    const assetsText = readFileSync(path.join(outdir, `${variant.stackName}.assets.json`), 'utf8');
    return {
      manifest,
      manifestText,
      artifact,
      assets: JSON.parse(assetsText),
      assetsText,
      template: JSON.parse(readFileSync(path.join(outdir, artifact.properties.templateFile), 'utf8')),
      templateSha256: sha256(readFileSync(path.join(outdir, artifact.properties.templateFile))),
    };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s maps a JSON metric value with a JSON filter pattern',
  (name, variant) => {
    const { template } = synthesize(variant);
    const filters = Object.entries(template.Resources).filter(([, resource]: [string, any]) =>
      resource.Type === 'AWS::Logs::MetricFilter');
    expect(filters.length).toBeGreaterThan(0);
    // CloudWatch Logs rejects a `$.field` metric value under a literal text
    // pattern ("requires metric values to be static numbers"). Every filter that
    // extracts a JSON field must therefore use a JSON filter pattern.
    for (const [, filter] of filters as Array<[string, any]>) {
      for (const transformation of filter.Properties.MetricTransformations ?? []) {
        if (!String(transformation.MetricValue).startsWith('$.')) continue;
        const pattern = String(filter.Properties.FilterPattern).trim();
        expect(pattern.startsWith('{')).toBe(true);
        expect(pattern.endsWith('}')).toBe(true);
      }
    }
    // The outbox age filter selects the pino `msg` field and keeps the JSON metric
    // value. Issue #220 removed its `defaultValue: 0`: a metric filter's default is
    // published whenever the pattern does not match, so a missing age no longer
    // reads as a healthy 0 among the real age datapoints.
    const outbox = filters.find(([, filter]: [string, any]) =>
      filter.Properties.MetricTransformations?.some((transformation: any) =>
        transformation.MetricName === 'OutboxOldestAgeMs'
        && String(transformation.MetricValue).startsWith('$.')));
    expect(outbox).toBeDefined();
    const outboxFilter = (outbox as [string, any])[1];
    expect(outboxFilter.Properties.FilterPattern).toContain('$.msg');
    expect(outboxFilter.Properties.FilterPattern).toContain('Durable task outbox metrics');
    expect(outboxFilter.Properties.MetricTransformations[0].MetricValue).toBe('$.outboxOldestAgeMs');
    expect(outboxFilter.Properties.MetricTransformations[0].DefaultValue).toBeUndefined();
  });

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s carries the recorded age-alarm calibration and the fail-closed outbox mapping',
  (name, variant) => {
    const { template } = synthesize(variant);
    const resources = Object.entries(template.Resources) as Array<[string, any]>;
    const alarms = resources.filter(([, resource]) => resource.Type === 'AWS::CloudWatch::Alarm');
    // Issue #321 adds two worker alarms to the same nine names #220 left: eleven
    // named alarms, no alarm added, removed or renamed for any other signal. The
    // autoscaling policies' own alarms are unnamed and outside this set.
    const expectedSuffixes = ['vto-dlq-not-empty', 'auto-tagging-dlq-not-empty', 'vto-oldest-message',
      'auto-tagging-oldest-message', 'api-high-cpu', 'alb-5xx', 'api-p95-latency',
      'ecs-running-not-desired', 'outbox-oldest-age',
      'object-deletion-abandoned', 'object-deletion-reaper-tick'];
    const named = alarms.filter(([, alarm]) => typeof alarm.Properties.AlarmName === 'string');
    expect(named).toHaveLength(11);
    const byName = new Map(named.map(([, alarm]) => [alarm.Properties.AlarmName, alarm]));
    expect([...byName.keys()].sort()).toEqual(expectedSuffixes.map((suffix) => `${variant.stage}-anywear-${suffix}`).sort());
    // Every alarm the bake's six signals name is one of them, so `describe-alarms`
    // still finds each read.
    for (const names of Object.values(deploymentAlarmNames(variant.stage))) {
      for (const alarmName of names) expect(byName.has(alarmName)).toBe(true);
    }

    // The two oldest-message alarms use the gate's recorded age limit, and keep
    // SQS's five-minute period and the two-period anti-flap calibration. The
    // threshold is equal to the gate's; the detection is deliberately later,
    // which the runbook records.
    const sqsThreshold = DEPLOYMENT_GATE_THRESHOLDS.sqs_oldest_message_age.max_seconds;
    expect(sqsThreshold).toBe(150);
    for (const suffix of ['vto-oldest-message', 'auto-tagging-oldest-message']) {
      const alarm = byName.get(`${variant.stage}-anywear-${suffix}`);
      expect(alarm).toBeDefined();
      expect(alarm.Properties.Threshold).toBe(sqsThreshold);
      expect(alarm.Properties.Period).toBe(300);
      expect(alarm.Properties.EvaluationPeriods).toBe(2);
      expect(alarm.Properties.TreatMissingData).toBe('notBreaching');
    }

    // The outbox alarm keeps its name, metric, statistic, period, evaluation
    // periods, comparison and missing-data treatment; only the threshold moved.
    const outboxThreshold = DEPLOYMENT_GATE_THRESHOLDS.outbox_oldest_age.max_age_milliseconds;
    expect(outboxThreshold).toBe(150000);
    const outboxAlarm = byName.get(`${variant.stage}-anywear-outbox-oldest-age`);
    expect(outboxAlarm).toBeDefined();
    expect(outboxAlarm.Properties.Threshold).toBe(outboxThreshold);
    expect(outboxAlarm.Properties.Period).toBe(60);
    expect(outboxAlarm.Properties.EvaluationPeriods).toBe(2);
    expect(outboxAlarm.Properties.ComparisonOperator).toBe('GreaterThanThreshold');
    expect(outboxAlarm.Properties.TreatMissingData).toBe('notBreaching');
    expect(outboxAlarm.Properties.Namespace).toBe('AnyWear/Worker');
    expect(outboxAlarm.Properties.MetricName).toBe('OutboxOldestAgeMs');
    expect(outboxAlarm.Properties.Statistic).toBe('Maximum');

    // Both outbox filters publish the one metric the alarm reads, and neither has a
    // `DefaultValue`: the age filter must not publish 0 for a missing age, and the
    // missing-age filter's static value is emitted only on a pattern match.
    const filters = resources.filter(([, resource]) => resource.Type === 'AWS::Logs::MetricFilter');
    const outboxFilters = filters.filter(([, filter]) => filter.Properties.MetricTransformations?.some(
      (transformation: any) => transformation.MetricName === 'OutboxOldestAgeMs'));
    expect(outboxFilters).toHaveLength(2);
    for (const [, filter] of outboxFilters) {
      expect(filter.Properties.MetricTransformations).toHaveLength(1);
      const [transformation] = filter.Properties.MetricTransformations;
      expect(transformation.MetricNamespace).toBe(outboxAlarm.Properties.Namespace);
      expect(transformation.MetricName).toBe(outboxAlarm.Properties.MetricName);
      expect(transformation.DefaultValue).toBeUndefined();
    }
    const ageFilter = (outboxFilters.find(([, filter]) =>
      filter.Properties.MetricTransformations[0].MetricValue === '$.outboxOldestAgeMs') as [string, any])[1];
    const missingAgeFilter = (outboxFilters.find(([, filter]) =>
      filter.Properties.MetricTransformations[0].MetricValue !== '$.outboxOldestAgeMs') as [string, any])[1];
    expect(ageFilter.Properties.FilterPattern).toBe('{ $.msg = "Durable task outbox metrics" }');
    // The exact rendered fail-closed pattern: a matched worker line with a
    // non-empty backlog and a null or absent age. An empty backlog with a null age
    // fails `$.outboxBacklog > 0`, so it matches neither filter and stays OK.
    expect(missingAgeFilter.Properties.FilterPattern).toBe(
      '{ ($.msg = "Durable task outbox metrics") && ($.outboxBacklog > 0) '
      + '&& (($.outboxOldestAgeMs IS NULL) || ($.outboxOldestAgeMs NOT EXISTS)) }');
    // The sentinel is derived from the same package constant as the alarm
    // threshold, so the two cannot drift: `GreaterThanThreshold` makes
    // threshold + 1 the first breaching value, and it is the only static value.
    expect(missingAgeFilter.Properties.MetricTransformations[0].MetricValue).toBe(`${outboxThreshold + 1}`);
    expect(missingAgeFilter.Properties.MetricTransformations[0].MetricValue).toBe('150001');

    // Issue #321: the object-deletion ledger's two worker alarms and their two
    // filters. Every calibration value is read from WORKER_ALARM_THRESHOLDS, so a
    // deployed alarm that ignores the contract fails here; the literal values are
    // asserted beside them so a contract edit is a visible test change.
    const abandonedThreshold = WORKER_ALARM_THRESHOLDS.object_deletion_abandoned;
    expect(abandonedThreshold.period_seconds).toBe(60);
    expect(abandonedThreshold.threshold).toBe(0);
    const abandonedAlarm = byName.get(`${variant.stage}-anywear-object-deletion-abandoned`);
    expect(abandonedAlarm).toBeDefined();
    expect(abandonedAlarm.Properties.Namespace).toBe('AnyWear/Worker');
    expect(abandonedAlarm.Properties.MetricName).toBe('ObjectDeletionAbandonedCount');
    expect(abandonedAlarm.Properties.Statistic).toBe('Maximum');
    expect(abandonedAlarm.Properties.Period).toBe(abandonedThreshold.period_seconds);
    expect(abandonedAlarm.Properties.Period).toBe(60);
    expect(abandonedAlarm.Properties.EvaluationPeriods).toBe(abandonedThreshold.evaluation_periods);
    expect(abandonedAlarm.Properties.EvaluationPeriods).toBe(2);
    expect(abandonedAlarm.Properties.Threshold).toBe(abandonedThreshold.threshold);
    expect(abandonedAlarm.Properties.Threshold).toBe(0);
    expect(abandonedAlarm.Properties.ComparisonOperator).toBe('GreaterThanThreshold');
    expect(abandonedAlarm.Properties.TreatMissingData).toBe('notBreaching');
    // The operations notification is Beta-only, exactly like the worker's other
    // alarms: a Production synthesis carries no alarm action.
    expect(abandonedAlarm.Properties.AlarmActions === undefined).toBe(variant.stage !== 'beta');
    const tickThreshold = WORKER_ALARM_THRESHOLDS.object_deletion_reaper_tick;
    expect(tickThreshold.period_seconds).toBe(300);
    expect(tickThreshold.threshold).toBe(1);
    const tickAlarm = byName.get(`${variant.stage}-anywear-object-deletion-reaper-tick`);
    expect(tickAlarm).toBeDefined();
    expect(tickAlarm.Properties.Namespace).toBe('AnyWear/Worker');
    expect(tickAlarm.Properties.MetricName).toBe('ObjectDeletionReaperTick');
    expect(tickAlarm.Properties.Statistic).toBe('Sum');
    expect(tickAlarm.Properties.Period).toBe(tickThreshold.period_seconds);
    expect(tickAlarm.Properties.Period).toBe(300);
    expect(tickAlarm.Properties.EvaluationPeriods).toBe(tickThreshold.evaluation_periods);
    expect(tickAlarm.Properties.EvaluationPeriods).toBe(2);
    expect(tickAlarm.Properties.Threshold).toBe(tickThreshold.threshold);
    expect(tickAlarm.Properties.Threshold).toBe(1);
    expect(tickAlarm.Properties.ComparisonOperator).toBe('LessThanThreshold');
    // The fail-closed half: a stopped reaper publishes nothing, which breaches.
    expect(tickAlarm.Properties.TreatMissingData).toBe('breaching');
    expect(tickAlarm.Properties.AlarmActions === undefined).toBe(variant.stage !== 'beta');

    const objectDeletionFilters = filters.filter(([, filter]) => filter.Properties.MetricTransformations?.some(
      (transformation: any) => ['ObjectDeletionAbandonedCount', 'ObjectDeletionReaperTick'].includes(transformation.MetricName)));
    expect(objectDeletionFilters).toHaveLength(2);
    const workerLogGroupName = `/anywear/${variant.stage}/worker`;
    for (const [, filter] of objectDeletionFilters) {
      // Both filters read the worker's own log group and publish exactly one
      // metric in the worker namespace from the exact standing-state message.
      expect(template.Resources[filter.Properties.LogGroupName.Ref].Properties.LogGroupName).toBe(workerLogGroupName);
      expect(filter.Properties.FilterPattern).toBe('{ $.msg = "Object deletion manifest standing state" }');
      expect(filter.Properties.MetricTransformations).toHaveLength(1);
      expect(filter.Properties.MetricTransformations[0].MetricNamespace).toBe('AnyWear/Worker');
      expect(filter.Properties.MetricTransformations[0].Unit).toBe('Count');
      // No filter publishes a default: a zero the system did not read must never
      // look like a healthy count (#220's rule, reused here).
      expect(filter.Properties.MetricTransformations[0].DefaultValue).toBeUndefined();
    }
    const filterByMetric = (metricName: string) => (objectDeletionFilters.find(([, filter]) =>
      filter.Properties.MetricTransformations[0].MetricName === metricName) as [string, any])[1];
    // The abandoned count is the integer the line carries; the tick is the static
    // 1 that makes a stopped reaper observable through missing data.
    expect(filterByMetric('ObjectDeletionAbandonedCount').Properties.MetricTransformations[0].MetricValue)
      .toBe('$.objectDeletionAbandoned');
    expect(filterByMetric('ObjectDeletionReaperTick').Properties.MetricTransformations[0].MetricValue).toBe('1');
  },
);

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s uses supported metric math for the ALB 5xx alarm',
  (name, variant) => {
    const { template } = synthesize(variant);
    const alarms = Object.entries(template.Resources).filter(([, resource]: [string, any]) =>
      resource.Type === 'AWS::CloudWatch::Alarm');
    expect(alarms.length).toBeGreaterThan(0);
    // CloudWatch metric math's MAX/MIN/AVG take time series; an array form may
    // contain several time series, but a scalar literal in that array mixes the
    // types and is rejected at CREATE. (The ECS alarm's MAX over two time series
    // is valid and must stay allowed.)
    for (const [, alarm] of alarms as Array<[string, any]>) {
      for (const metric of alarm.Properties.Metrics ?? []) {
        if (typeof metric.Expression !== 'string') continue;
        for (const match of metric.Expression.matchAll(/\b(?:MAX|MIN|AVG)\s*\(\s*\[([^\]]*)\]/g)) {
          expect(match[1]).not.toMatch(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/);
        }
      }
    }
    const alarmNames = alarms.map(([, alarm]: [string, any]) => alarm.Properties.AlarmName);
    // The other three bake alarms stay present; only the 5xx expression changed.
    for (const signal of ['alb_p95_latency', 'ecs_running_not_desired', 'outbox_oldest_age']) {
      expect(alarmNames).toContain(deploymentAlarmName(variant.stage, signal)[0]);
    }
    const alb5xx = (alarms as Array<[string, any]>).find(([, alarm]) =>
      alarm.Properties.AlarmName === deploymentAlarmName(variant.stage, 'alb_5xx_rate')[0]);
    expect(alb5xx).toBeDefined();
    const alb5xxAlarm = (alb5xx as [string, any])[1];
    const expressionMetric = alb5xxAlarm.Properties.Metrics.find((metric: any) =>
      typeof metric.Expression === 'string');
    expect(expressionMetric.Expression)
      .toBe('IF(requests > 0, 100 * (target5xx + elb5xx) / requests, 0)');
    const metricIds = alb5xxAlarm.Properties.Metrics.map((metric: any) => metric.Id);
    for (const id of ['target5xx', 'elb5xx', 'requests', 'expr_1']) expect(metricIds).toContain(id);
  });


test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s synthesizes the standard CDK bootstrap cloud assembly with the recorded template bytes',
  (name, variant) => {
    const { manifest, artifact, assets, manifestText, assetsText, templateSha256 } = synthesize(variant);
    expect(artifact.type).toBe('aws:cloudformation:stack');
    // Issue #195: the Runtime stack moved into Infra and deploys through the
    // standard CDK bootstrap path that `beta-infra-deploy-role` already assumes.
    // The assembly names the bootstrap deploy, file-publishing and cfn-exec
    // roles explicitly, and the template asset is still the recorded bytes.
    expect(artifact.properties.assumeRoleArn)
      .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-deploy-role-650880818323-ap-east-1`);
    expect(manifestText).toContain(`cdk-${BOOTSTRAP_QUALIFIER}-deploy-role`);
    // The parent design check (#195): the CloudFormation execution role the
    // deploy passes is the bootstrap cfn-exec role, never the retired
    // beta-service-deploy-cfn-role and never an explicit `--role-arn` override.
    expect(artifact.properties.cloudFormationExecutionRoleArn)
      .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-cfn-exec-role-650880818323-ap-east-1`);
    expect(artifact.properties.stackTemplateAssetObjectUrl)
      .toMatch(new RegExp(`^s3://${assetsBucket}/[a-f0-9]{64}\\.json$`));

    const files = Object.values(assets.files as Record<string, {
      displayName: string; destinations: Record<string, Record<string, unknown>>;
    }>);
    expect(files).toHaveLength(1);
    for (const file of files) {
      expect(file.displayName).toContain('Template');
      const destinations = Object.values(file.destinations);
      expect(destinations).toHaveLength(1);
      for (const destination of destinations) {
        expect(destination.bucketName).toBe(assetsBucket);
        expect(destination.assumeRoleArn)
          .toBe(`arn:\${AWS::Partition}:iam::650880818323:role/cdk-${BOOTSTRAP_QUALIFIER}-file-publishing-role-650880818323-ap-east-1`);
      }
    }
    expect(assetsText).toContain(`cdk-${BOOTSTRAP_QUALIFIER}-file-publishing-role`);

    // No context lookup is declared, so the CLI never needs the bootstrap
    // lookup role either.
    expect(manifest.missing ?? []).toEqual([]);

    // The template identity is unchanged: this is the recorded template hash
    // for the same variant, source and CDK context.
    expect(templateSha256).toBe(provenance.templates[`${variant.name}/${variant.stackName}.template.json`]);
  },
);
