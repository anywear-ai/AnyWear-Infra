#!/usr/bin/env node
// Issue #162 added the bounded six-signal deployment bake gate; issue #219
// calibrated its window to 300 seconds.
//
// The `deploy-runtime` operation runs this after `cdk deploy` returned and the
// deployed stack identity was read back. It reads the six named signals live from
// the deployed state - never the deployed alarm states, which are read as evidence
// only - and fails closed on missing, delayed or insufficient data. A failing bake
// throws with the failing signals, so the deploy step exits non-zero and the run
// is failed: the verdict is the job conclusion and the step log. There is no gate
// block to publish (#207).
//
// The reads use the `aws` CLI, which is already the deploy job's interface. The
// signal evaluation is a separate pure function so every threshold, missing-data
// case and deadline can be tested without AWS, a network or a wall clock.

import { execFileSync } from 'node:child_process';
import {
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_THRESHOLDS,
  DEPLOYMENT_SQS_DEPTH_ATTRIBUTES,
  deploymentAlarmName,
  deploymentBakeName,
  deploymentQueueNames,
  runtimeStageFromStack,
} from '../../lib/contracts.mjs';

export const PROBE_PATH = '/readyz';
export const PROBE_TIMEOUT_MS = 5_000;
export const INGESTION_RETRY_MS = 15_000;
export const INGESTION_TIMEOUT_MS = 180_000;
export const DEADLINE_SLACK_MS = 120_000;
// The whole-window CloudWatch period: `TargetResponseTime` p95 and each work
// queue's `ApproximateAgeOfOldestMessage` Maximum cover exactly the bake, so the
// period and the window cannot drift apart. Each read must return exactly one
// datapoint; a second period would straddle the window boundary and aggregate
// pre-deployment data.
export const METRIC_PERIOD_SECONDS = 300;
export const MIN_ECS_SAMPLES = 10;
export const MIN_SQS_SAMPLES = 10;
export const MIN_OUTBOX_LINES = 4;
const ALARM_STATE = /^(OK|ALARM|INSUFFICIENT_DATA)$/;
const fail = (message) => {
  throw new Error(message);
};

// --------------------------------------------------------------------------
// AWS CLI interface

function defaultRunAws(args) {
  return execFileSync('aws', [...args, '--output', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function awsJson(runAws, args) {
  const output = runAws(args);
  if (typeof output !== 'string' || output.trim() === '') fail(`Empty AWS response for ${args.slice(0, 2).join(' ')}`);
  try {
    return JSON.parse(output);
  } catch (error) {
    return fail(`Unparseable AWS response for ${args.slice(0, 2).join(' ')}: ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// Time

/**
 * Align the bake to the next whole 300 seconds (the next 5-minute clock boundary)
 * so the 60s, 30s and 300s periods are exact.
 */
export function alignedStart(nowMs) {
  return Math.ceil(nowMs / (METRIC_PERIOD_SECONDS * 1000)) * METRIC_PERIOD_SECONDS * 1000;
}

const iso = (milliseconds) => new Date(milliseconds).toISOString();

// --------------------------------------------------------------------------
// Individual reads

async function probeReadyz(apiBaseUrl, fetchImpl) {
  const response = await fetchImpl(`${apiBaseUrl}${PROBE_PATH}`, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await response.arrayBuffer();
  return response.status;
}

async function findLoadBalancerDimension(runAws, stack) {
  const summaries = [];
  let nextToken;
  do {
    const args = ['cloudformation', 'list-stack-resources', '--stack-name', stack];
    if (nextToken !== undefined) args.push('--next-token', String(nextToken));
    const page = awsJson(runAws, args);
    summaries.push(...(page.StackResourceSummaries ?? []));
    nextToken = page.NextToken;
  } while (nextToken !== undefined);
  const loadBalancers = summaries.filter((summary) => summary.ResourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer');
  if (loadBalancers.length !== 1 || typeof loadBalancers[0].PhysicalResourceId !== 'string') {
    fail('The deployed stack does not expose exactly one application load balancer');
  }
  const match = /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d{12}:loadbalancer\/(app\/[^/]+\/[a-z0-9]+)$/
    .exec(loadBalancers[0].PhysicalResourceId);
  if (!match) fail('The deployed load balancer ARN has no app/<name>/<id> dimension');
  return match[1];
}

function parseStatistics(response, statistic) {
  return (response.Datapoints ?? []).map((datapoint) => {
    const value = statistic === 'p95'
      ? datapoint.ExtendedStatistics?.p95
      : datapoint[statistic];
    return typeof value === 'number' && Number.isFinite(value) ? value : fail('A CloudWatch datapoint has no numeric value');
  });
}

function readMetric(runAws, {
  namespace, metricName, dimensionName = 'LoadBalancer', dimension, startMs, endMs, period, statistic,
}) {
  const args = ['cloudwatch', 'get-metric-statistics', '--namespace', namespace,
    '--metric-name', metricName, '--dimensions', `Name=${dimensionName},Value=${dimension}`,
    '--start-time', iso(startMs), '--end-time', iso(endMs), '--period', String(period),
    ...(statistic === 'p95' ? ['--extended-statistics', 'p95'] : ['--statistics', statistic])];
  return parseStatistics(awsJson(runAws, args), statistic);
}

async function readAlbMetrics(runAws, dimension, startMs, endMs) {
  const at = (metricName) => readMetric(runAws, {
    namespace: 'AWS/ApplicationELB', metricName, dimension, startMs, endMs, period: 60, statistic: 'Sum',
  });
  const requests = at('RequestCount');
  return {
    target5xx: at('HTTPCode_Target_5XX_Count'),
    elb5xx: at('HTTPCode_ELB_5XX_Count'),
    requests,
    datapoints: requests.length,
  };
}

async function readP95(runAws, dimension, startMs, endMs) {
  return {
    seconds: readMetric(runAws, {
      namespace: 'AWS/ApplicationELB', metricName: 'TargetResponseTime', dimension,
      startMs, endMs, period: METRIC_PERIOD_SECONDS, statistic: 'p95',
    }),
  };
}

async function readEcs(runAws, cluster, stage, at) {
  const response = awsJson(runAws, ['ecs', 'describe-services', '--cluster', cluster, '--services',
    `${stage}-anywear-api`, `${stage}-anywear-worker`]);
  const failures = response.failures ?? [];
  if (failures.length > 0 || !Array.isArray(response.services) || response.services.length !== 2) {
    fail(`ECS DescribeServices returned ${failures.length} failures for ${stage}`);
  }
  const observation = (serviceName) => {
    const service = response.services.find((candidate) => candidate.serviceName === serviceName);
    if (!service || !Array.isArray(service.deployments) || service.deployments.length === 0) {
      fail(`ECS service ${serviceName} has no deployment observation`);
    }
    const deployment = service.deployments[0];
    const rolloutState = typeof deployment.rolloutState === 'string' && deployment.rolloutState !== ''
      ? deployment.rolloutState : fail(`ECS service ${serviceName} has no rollout state`);
    return {
      running_count: service.runningCount ?? fail(`ECS service ${serviceName} has no runningCount`),
      desired_count: service.desiredCount ?? fail(`ECS service ${serviceName} has no desiredCount`),
      deployment_count: service.deployments.length,
      rollout_state: rolloutState,
    };
  };
  return {
    at,
    api: observation(`${stage}-anywear-api`),
    worker: observation(`${stage}-anywear-worker`),
  };
}

const ATTRIBUTE_NAMES = DEPLOYMENT_SQS_DEPTH_ATTRIBUTES;

async function readSqs(runAws, queueUrls, at) {
  const read = (queueUrl) => awsJson(runAws, ['sqs', 'get-queue-attributes', '--queue-url', queueUrl,
    '--attribute-names', ...ATTRIBUTE_NAMES]).Attributes ?? {};
  const queues = {};
  for (const [purpose, queueUrl] of Object.entries(queueUrls)) queues[purpose] = read(queueUrl);
  return { at, queues };
}

// The oldest-message age is not a GetQueueAttributes result. Read the AWS/SQS
// ApproximateAgeOfOldestMessage Maximum over the bake window per work queue and
// record how many periods the read returned. A missing datapoint is handled by
// the idle rule in evaluateBake; two or more are rejected there, because extra
// periods would straddle the window boundary and aggregate pre-deployment time.
async function readQueueAges(runAws, stage, startMs, endMs) {
  const queues = deploymentQueueNames(stage);
  const read = (queueName) => {
    const values = readMetric(runAws, {
      namespace: 'AWS/SQS', metricName: 'ApproximateAgeOfOldestMessage', dimensionName: 'QueueName',
      dimension: queueName, startMs, endMs, period: METRIC_PERIOD_SECONDS, statistic: 'Maximum',
    });
    return {
      datapoints: values.length,
      seconds: values.length === 0 ? undefined : Math.max(...values),
    };
  };
  return { vto: read(queues.vto), auto_tagging: read(queues.auto_tagging) };
}

async function readOutbox(runAws, logGroup, startMs, endMs) {
  const lines = [];
  let nextToken;
  do {
    const args = ['logs', 'filter-log-events', '--log-group-name', logGroup,
      '--filter-pattern', '"Durable task outbox metrics"',
      '--start-time', String(startMs), '--end-time', String(endMs)];
    if (nextToken !== undefined) args.push('--next-token', nextToken);
    const page = awsJson(runAws, args);
    for (const event of page.events ?? []) {
      try {
        const parsed = JSON.parse(event.message);
        if (parsed?.msg !== 'Durable task outbox metrics') continue;
        lines.push({
          at: typeof event.timestamp === 'number' ? event.timestamp : startMs,
          age: typeof parsed.outboxOldestAgeMs === 'number' ? parsed.outboxOldestAgeMs : null,
          backlog: typeof parsed.outboxBacklog === 'number' ? parsed.outboxBacklog : 0,
        });
      } catch {
        // A non-JSON line cannot match the filter pattern's message; ignore it.
      }
    }
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  lines.sort((left, right) => left.at - right.at);
  return { lines };
}

async function readAlarms(runAws, names) {
  const response = awsJson(runAws, ['cloudwatch', 'describe-alarms', '--alarm-names', ...names]);
  const states = {};
  for (const alarm of response.MetricAlarms ?? []) {
    if (typeof alarm.AlarmName !== 'string' || !ALARM_STATE.test(alarm.StateValue)) continue;
    states[alarm.AlarmName] = alarm.StateValue;
  }
  return { states };
}

// --------------------------------------------------------------------------
// Pure signal evaluation

const thresholdOf = (name) => ({ ...DEPLOYMENT_GATE_THRESHOLDS[name] });

const comparisonOf = (name) => ({
  alb_5xx_rate: 'sum(target_5xx, elb_5xx) > max_5xx; request_count < min_requests is insufficient',
  alb_p95_latency: 'p95_milliseconds > max_milliseconds',
  ecs_running_not_desired: 'longest_gap_seconds >= max_gap_seconds; a non-single or non-COMPLETED deployment is breaching',
  sqs_oldest_message_age: 'max(vto_seconds, auto_tagging_seconds) > max_seconds',
  sqs_dlq_depth: 'vto_depth + auto_tagging_depth > max_depth',
  outbox_oldest_age: 'oldest_age_milliseconds > max_age_milliseconds; backlog > 0 with a null age is breaching',
}[name]);

function makeSignal(name, { state, value, reads, exceptions = [], alarms }) {
  return {
    name,
    state,
    value,
    threshold: thresholdOf(name),
    comparison: comparisonOf(name),
    alarms,
    reads,
    exceptions,
  };
}

function alarmEvidence(stage, name, states) {
  return deploymentAlarmName(stage, name).map((alarmName) => ({
    name: alarmName,
    state: states[alarmName] ?? 'INSUFFICIENT_DATA',
  }));
}

function missingAlarm(stage, name, states) {
  return deploymentAlarmName(stage, name).some((alarmName) => states[alarmName] === undefined);
}

function cloudWatchReads(name, dimension, datapoints) {
  if (name === 'alb_5xx_rate') {
    return [
      { source: 'cloudwatch', namespace: 'AWS/ApplicationELB', metric_name: 'HTTPCode_Target_5XX_Count',
        dimensions: { LoadBalancer: dimension }, statistic: 'Sum', period_seconds: 60, datapoints },
      { source: 'cloudwatch', namespace: 'AWS/ApplicationELB', metric_name: 'HTTPCode_ELB_5XX_Count',
        dimensions: { LoadBalancer: dimension }, statistic: 'Sum', period_seconds: 60, datapoints },
      { source: 'cloudwatch', namespace: 'AWS/ApplicationELB', metric_name: 'RequestCount',
        dimensions: { LoadBalancer: dimension }, statistic: 'Sum', period_seconds: 60, datapoints },
    ];
  }
  return [{ source: 'cloudwatch', namespace: 'AWS/ApplicationELB', metric_name: 'TargetResponseTime',
    dimensions: { LoadBalancer: dimension }, statistic: 'p95', period_seconds: METRIC_PERIOD_SECONDS, datapoints }];
}

/**
 * Evaluate one bake from raw observations.
 *
 * `observations` may carry `{ error }` for any surface that could not be read.
 * Every state other than `not-breaching` fails the gate; there is no averaging
 * and no majority vote. A failed gate keeps each signal's evidence so the run log
 * can show which signal failed and that the others were healthy.
 */
export function evaluateBake({
  stage, startedAtMs, windowSeconds = DEPLOYMENT_GATE_DURATION_SECONDS, probesSent,
  serviceSha, imageDigest, loadBalancerDimension, cluster, logGroup, queueNames, observations,
}) {
  const endsAtMs = startedAtMs + windowSeconds * 1000;
  const alarms = observations.alarms?.states ?? {};
  const alarmFailure = observations.alarms?.error;
  const base = (name) => ({ name, threshold: thresholdOf(name), comparison: comparisonOf(name),
    alarms: alarmEvidence(stage, name, alarms) });
  const failSignal = (name, reason, value = null, reads = [], exceptions = []) => makeSignal(name, {
    state: 'insufficient',
    value,
    reads,
    exceptions: [reason, ...exceptions],
    alarms: alarmEvidence(stage, name, alarms),
  });
  const alarmInsufficient = (name) => alarmFailure !== undefined || missingAlarm(stage, name, alarms);
  const buildSignal = (name, spec) => makeSignal(name, {
    ...spec,
    alarms: alarmEvidence(stage, name, alarms),
  });

  const signals = [];

  // 1. alb_5xx_rate
  {
    const alb = observations.alb;
    const reads = cloudWatchReads('alb_5xx_rate', loadBalancerDimension, alb?.datapoints ?? 0);
    if (!alb || alb.error) {
      signals.push(failSignal('alb_5xx_rate', alb?.error ?? 'ALB metrics were not read', null, reads));
    } else {
      // RequestCount is the denominator: it must cover the full five one-minute
      // periods for the rate to be meaningful. A 5xx series may legitimately be
      // shorter because CloudWatch does not emit a zero-valued 5xx datapoint;
      // the existing points are summed and an absent point counts as zero.
      const requestPeriods = alb.requests.length;
      const requestComplete = requestPeriods === 5;
      const target5xx = alb.target5xx.reduce((sum, value) => sum + value, 0);
      const elb5xx = alb.elb5xx.reduce((sum, value) => sum + value, 0);
      const requestCount = alb.requests.reduce((sum, value) => sum + value, 0);
      const value = { target_5xx: target5xx, elb_5xx: elb5xx, request_count: requestCount };
      const exceptions = [];
      if (observations.probes?.failed > 0) exceptions.push(`${observations.probes.failed} probe requests did not complete`);
      if (probesSent < DEPLOYMENT_GATE_REQUEST_FLOOR) {
        signals.push(failSignal('alb_5xx_rate',
          `only ${probesSent} probes were sent; the request floor is ${DEPLOYMENT_GATE_REQUEST_FLOOR}`,
          value, reads, exceptions));
      } else if (!requestComplete) {
        signals.push(failSignal('alb_5xx_rate',
          `RequestCount returned ${requestPeriods} of 5 one-minute datapoints`, value, reads, exceptions));
      } else if (target5xx + elb5xx > 0) {
        signals.push(buildSignal('alb_5xx_rate', { state: 'breaching', value, reads, exceptions }));
      } else if (requestCount < DEPLOYMENT_GATE_REQUEST_FLOOR) {
        signals.push(failSignal('alb_5xx_rate', `RequestCount ${requestCount} is below the ${DEPLOYMENT_GATE_REQUEST_FLOOR} request floor`,
          value, reads, exceptions));
      } else if (alarmInsufficient('alb_5xx_rate')) {
        signals.push(failSignal('alb_5xx_rate', alarmFailure ?? 'The deployed 5xx alarm was not observed', value, reads, exceptions));
      } else {
        signals.push(buildSignal('alb_5xx_rate', { state: 'not-breaching', value, reads, exceptions }));
      }
    }
  }

  // 2. alb_p95_latency
  {
    const p95 = observations.p95;
    const reads = cloudWatchReads('alb_p95_latency', loadBalancerDimension, p95?.seconds?.length ?? 0);
    if (!p95 || p95.error) {
      signals.push(failSignal('alb_p95_latency', p95?.error ?? 'TargetResponseTime was not read', null, reads));
    } else if (p95.seconds.length !== 1) {
      signals.push(failSignal('alb_p95_latency', `TargetResponseTime returned ${p95.seconds.length} of 1 period`,
        { p95_milliseconds: p95.seconds.length ? Math.max(...p95.seconds) * 1000 : 0 }, reads));
    } else {
      const value = { p95_milliseconds: p95.seconds[0] * 1000 };
      if (value.p95_milliseconds > DEPLOYMENT_GATE_THRESHOLDS.alb_p95_latency.max_milliseconds) {
        signals.push(buildSignal('alb_p95_latency', { state: 'breaching', value, reads }));
      } else if (alarmInsufficient('alb_p95_latency')) {
        signals.push(failSignal('alb_p95_latency', alarmFailure ?? 'The deployed p95 alarm was not observed', value, reads));
      } else {
        signals.push(buildSignal('alb_p95_latency', { state: 'not-breaching', value, reads }));
      }
    }
  }

  // 3. ecs_running_not_desired
  {
    const ecs = observations.ecs;
    const samples = ecs?.samples ?? [];
    const reads = [{ source: 'ecs', cluster, services: [`${stage}-anywear-api`, `${stage}-anywear-worker`],
      samples: samples.length }];
    if (!ecs || ecs.error) {
      signals.push(failSignal('ecs_running_not_desired', ecs?.error ?? 'ECS services were not read', null, reads));
    } else if (samples.length < MIN_ECS_SAMPLES) {
      signals.push(failSignal('ecs_running_not_desired', `only ${samples.length} ECS samples were taken; ${MIN_ECS_SAMPLES} are required`, null, reads));
    } else {
      let maxSampleGap = 0;
      for (let index = 1; index < samples.length; index += 1) {
        maxSampleGap = Math.max(maxSampleGap, samples[index].at - samples[index - 1].at);
      }
      let longestGap = 0;
      let mismatchSince = null;
      let badDeployment = false;
      for (const sample of samples) {
        if (sample.api.deployment_count !== 1 || sample.worker.deployment_count !== 1
          || sample.api.rollout_state !== 'COMPLETED' || sample.worker.rollout_state !== 'COMPLETED') {
          badDeployment = true;
        }
        const mismatch = sample.api.running_count !== sample.api.desired_count
          || sample.worker.running_count !== sample.worker.desired_count;
        if (mismatch) {
          if (mismatchSince === null) mismatchSince = sample.at;
          longestGap = Math.max(longestGap, sample.at - mismatchSince);
        } else {
          mismatchSince = null;
        }
      }
      const last = samples[samples.length - 1];
      const value = {
        longest_gap_seconds: longestGap / 1000,
        max_sample_gap_seconds: maxSampleGap / 1000,
        samples: samples.length,
        services: { api: last.api, worker: last.worker },
      };
      if (maxSampleGap > DEPLOYMENT_GATE_THRESHOLDS.ecs_running_not_desired.max_gap_seconds * 1000) {
        signals.push(failSignal('ecs_running_not_desired', `ECS sampling gap ${maxSampleGap / 1000}s exceeds 120s`, value, reads));
      } else if (badDeployment || longestGap >= DEPLOYMENT_GATE_THRESHOLDS.ecs_running_not_desired.max_gap_seconds * 1000) {
        signals.push(buildSignal('ecs_running_not_desired', { state: 'breaching', value, reads }));
      } else if (alarmInsufficient('ecs_running_not_desired')) {
        signals.push(failSignal('ecs_running_not_desired', alarmFailure ?? 'The deployed ECS alarm was not observed', value, reads));
      } else {
        signals.push(buildSignal('ecs_running_not_desired', { state: 'not-breaching', value, reads }));
      }
    }
  }

  // 4/5. SQS oldest-message age and DLQ depth
  {
    const sqs = observations.sqs;
    const samples = sqs?.samples ?? [];
    const ages = sqs?.ages ?? {};
    const ageDatapoints = (queue) => ages[queue]?.datapoints ?? 0;
    const ageReads = [
      { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
        dimensions: { QueueName: queueNames.vto }, statistic: 'Maximum', period_seconds: METRIC_PERIOD_SECONDS,
        datapoints: ageDatapoints('vto') },
      { source: 'cloudwatch', namespace: 'AWS/SQS', metric_name: 'ApproximateAgeOfOldestMessage',
        dimensions: { QueueName: queueNames.auto_tagging }, statistic: 'Maximum', period_seconds: METRIC_PERIOD_SECONDS,
        datapoints: ageDatapoints('auto_tagging') },
      { source: 'sqs', queue_name: queueNames.vto, attributes: [...DEPLOYMENT_SQS_DEPTH_ATTRIBUTES], samples: samples.length },
      { source: 'sqs', queue_name: queueNames.auto_tagging, attributes: [...DEPLOYMENT_SQS_DEPTH_ATTRIBUTES], samples: samples.length },
    ];
    const dlqReads = [
      { source: 'sqs', queue_name: queueNames.vto_dlq, attribute: 'ApproximateNumberOfMessages', samples: samples.length },
      { source: 'sqs', queue_name: queueNames.auto_tagging_dlq, attribute: 'ApproximateNumberOfMessages', samples: samples.length },
    ];
    if (!sqs || sqs.error) {
      signals.push(failSignal('sqs_oldest_message_age', sqs?.error ?? 'SQS attributes were not read', null, ageReads));
      signals.push(failSignal('sqs_dlq_depth', sqs?.error ?? 'SQS attributes were not read', null, dlqReads));
    } else if (samples.length < MIN_SQS_SAMPLES) {
      signals.push(failSignal('sqs_oldest_message_age', `only ${samples.length} SQS samples were taken; ${MIN_SQS_SAMPLES} are required`, null, ageReads));
      signals.push(failSignal('sqs_dlq_depth', `only ${samples.length} SQS samples were taken; ${MIN_SQS_SAMPLES} are required`, null, dlqReads));
    } else {
      const ageOf = (queue) => {
        let idle = true;
        for (const sample of samples) {
          const attributes = sample.queues[queue];
          const visible = Number(attributes.ApproximateNumberOfMessages ?? 0);
          const inFlight = Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
          const delayed = Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0);
          if (visible + inFlight + delayed !== 0) idle = false;
        }
        if (ages.error) return { error: `${queue} oldest-message age metric was not read: ${ages.error}` };
        const metric = ages[queue];
        // Exactly one 300-second period is the whole-window read. Two or more
        // periods would straddle the window boundary and include pre-deployment
        // time, so the signal is insufficient evidence even when the aggregate
        // would look healthy or breaching.
        if (metric !== undefined && metric.datapoints > 1) {
          return { error: `${queue} ApproximateAgeOfOldestMessage returned ${metric.datapoints} periods; exactly 1 whole-window period is required` };
        }
        if (metric !== undefined && metric.datapoints === 1) {
          const age = Number(metric.seconds);
          if (!Number.isFinite(age) || age < 0) return { error: `${queue} returned an invalid oldest-message age` };
          return { maximum: age, idle: idle && age === 0 };
        }
        if (idle) return { maximum: 0, idle: true };
        return { error: `${queue} has active messages but no ApproximateAgeOfOldestMessage datapoint` };
      };
      const vto = ageOf('vto');
      const autoTagging = ageOf('auto_tagging');
      const ageValue = {
        vto_seconds: vto.error ? 0 : vto.maximum,
        auto_tagging_seconds: autoTagging.error ? 0 : autoTagging.maximum,
      };
      const ageExceptions = [];
      for (const [queue, result] of [['vto', vto], ['auto_tagging', autoTagging]]) {
        if (result.idle) ageExceptions.push(`${queue} queue is idle (no visible, in-flight or delayed messages); its oldest age is recorded as 0`);
      }
      if (vto.error || autoTagging.error) {
        signals.push(failSignal('sqs_oldest_message_age', vto.error ?? autoTagging.error, ageValue, ageReads, ageExceptions));
      } else if (Math.max(ageValue.vto_seconds, ageValue.auto_tagging_seconds)
        > DEPLOYMENT_GATE_THRESHOLDS.sqs_oldest_message_age.max_seconds) {
        signals.push(buildSignal('sqs_oldest_message_age', { state: 'breaching', value: ageValue, reads: ageReads, exceptions: ageExceptions }));
      } else if (alarmInsufficient('sqs_oldest_message_age')) {
        signals.push(failSignal('sqs_oldest_message_age', alarmFailure ?? 'The deployed oldest-message alarms were not observed',
          ageValue, ageReads, ageExceptions));
      } else {
        signals.push(buildSignal('sqs_oldest_message_age', { state: 'not-breaching', value: ageValue, reads: ageReads, exceptions: ageExceptions }));
      }

      const depthOf = (queue) => {
        let maximum = 0;
        for (const sample of samples) {
          const attributes = sample.queues[queue];
          const raw = attributes.ApproximateNumberOfMessages;
          if (raw === undefined) return { error: `${queue} returned no ApproximateNumberOfMessages` };
          const depth = Number(raw);
          if (!Number.isSafeInteger(depth) || depth < 0) return { error: `${queue} returned an invalid message depth` };
          maximum = Math.max(maximum, depth);
        }
        return { maximum };
      };
      const vtoDepth = depthOf('vto_dlq');
      const autoTaggingDepth = depthOf('auto_tagging_dlq');
      const depthValue = {
        vto_depth: vtoDepth.error ? 0 : vtoDepth.maximum,
        auto_tagging_depth: autoTaggingDepth.error ? 0 : autoTaggingDepth.maximum,
      };
      if (vtoDepth.error || autoTaggingDepth.error) {
        signals.push(failSignal('sqs_dlq_depth', vtoDepth.error ?? autoTaggingDepth.error, depthValue, dlqReads));
      } else if (depthValue.vto_depth + depthValue.auto_tagging_depth > DEPLOYMENT_GATE_THRESHOLDS.sqs_dlq_depth.max_depth) {
        signals.push(buildSignal('sqs_dlq_depth', { state: 'breaching', value: depthValue, reads: dlqReads }));
      } else if (alarmInsufficient('sqs_dlq_depth')) {
        signals.push(failSignal('sqs_dlq_depth', alarmFailure ?? 'The deployed DLQ alarms were not observed', depthValue, dlqReads));
      } else {
        signals.push(buildSignal('sqs_dlq_depth', { state: 'not-breaching', value: depthValue, reads: dlqReads }));
      }
    }
  }

  // 6. outbox_oldest_age
  {
    const outbox = observations.outbox;
    const lines = outbox?.lines ?? [];
    const reads = [{ source: 'logs', log_group: logGroup,
      filter_pattern: '"Durable task outbox metrics"', samples: lines.length }];
    if (!outbox || outbox.error) {
      signals.push(failSignal('outbox_oldest_age', outbox?.error ?? 'worker outbox log lines were not read', null, reads));
    } else if (lines.length < MIN_OUTBOX_LINES) {
      signals.push(failSignal('outbox_oldest_age',
        `only ${lines.length} "Durable task outbox metrics" lines were observed; ${MIN_OUTBOX_LINES} are required`, null, reads));
    } else {
      const latest = lines[lines.length - 1];
      const value = { oldest_age_milliseconds: latest.age, backlog: latest.backlog, lines_observed: lines.length };
      const exceptions = [];
      if (latest.age === null && latest.backlog === 0) {
        exceptions.push('outbox backlog is 0; the oldest age is null by construction');
      }
      const ageBreach = latest.age !== null
        && latest.age > DEPLOYMENT_GATE_THRESHOLDS.outbox_oldest_age.max_age_milliseconds;
      const nullAgeWithBacklog = latest.age === null && latest.backlog > 0;
      if (ageBreach || nullAgeWithBacklog) {
        signals.push(buildSignal('outbox_oldest_age', { state: 'breaching', value, reads, exceptions }));
      } else if (alarmInsufficient('outbox_oldest_age')) {
        signals.push(failSignal('outbox_oldest_age', alarmFailure ?? 'The deployed outbox alarm was not observed', value, reads, exceptions));
      } else {
        signals.push(buildSignal('outbox_oldest_age', { state: 'not-breaching', value, reads, exceptions }));
      }
    }
  }

  const passed = signals.every((signal) => signal.state === 'not-breaching');
  return {
    name: deploymentBakeName(stage),
    result: passed ? 'passed' : 'failed',
    started_at: iso(startedAtMs),
    ended_at: iso(endsAtMs),
    duration_seconds: windowSeconds,
    service_sha: serviceSha,
    image_digest: imageDigest,
    probe: { interval_seconds: DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
      probes_sent: probesSent, request_floor: DEPLOYMENT_GATE_REQUEST_FLOOR },
    signals,
  };
}

// --------------------------------------------------------------------------
// Runner

export function failedGate(options, message = 'The bake could not be evaluated') {
  const startedAtMs = alignedStart(Date.now());
  return evaluateBake({
    stage: options.stage,
    startedAtMs,
    probesSent: 0,
    serviceSha: options.serviceSha,
    imageDigest: options.imageDigest,
    loadBalancerDimension: `app/${options.stage}-anywear-api/unknown`,
    cluster: options.cluster,
    logGroup: options.logGroup,
    queueNames: deploymentQueueNames(options.stage),
    observations: {
      alb: { error: message },
      p95: { error: message },
      ecs: { error: message },
      sqs: { error: message },
      outbox: { error: message },
      alarms: { error: message },
      probes: { sent: 0, failed: 0 },
    },
  });
}

/**
 * Run the live 300-second bake and return its gate block either way.
 *
 * The caller logs the verdict and its failing signals to the run log, then fails
 * the step on a failed block; nothing persists the block as evidence (#207).
 */
export async function runBakeGate(options) {
  const {
    stage, stack, apiBaseUrl, cluster, queueUrls, logGroup, serviceSha, imageDigest,
    now = () => Date.now(), sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    fetchImpl = globalThis.fetch, runAws = defaultRunAws,
  } = options;
  if (typeof fetchImpl !== 'function') fail('A fetch implementation is required');
  if (typeof now !== 'function' || typeof sleep !== 'function') fail('A clock is required');

  const startedAtMs = alignedStart(now());
  const windowMs = DEPLOYMENT_GATE_DURATION_SECONDS * 1000;
  const endsAtMs = startedAtMs + windowMs;
  const deadlineAtMs = endsAtMs + INGESTION_TIMEOUT_MS + DEADLINE_SLACK_MS;
  const dimension = await findLoadBalancerDimension(runAws, stack);
  const alarmNames = DEPLOYMENT_GATE_SIGNAL_NAMES.flatMap((name) => deploymentAlarmName(stage, name));

  let probesSent = 0;
  let probesFailed = 0;
  const ecsSamples = [];
  const sqsSamples = [];
  let ecsError;
  let sqsError;

  const ticks = Math.floor(windowMs / (DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS * 1000));
  for (let tick = 0; tick < Math.min(ticks, DEPLOYMENT_GATE_MAX_PROBES); tick += 1) {
    const target = startedAtMs + tick * DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS * 1000;
    if (target > now()) await sleep(target - now());
    if (now() >= endsAtMs || now() > deadlineAtMs) break;
    probesSent += 1;
    try {
      await probeReadyz(apiBaseUrl, fetchImpl);
    } catch {
      probesFailed += 1;
    }
    if (tick % 2 === 0) {
      const at = now();
      try {
        ecsSamples.push(await readEcs(runAws, cluster, stage, at));
      } catch (error) {
        ecsError ??= error.message;
      }
      try {
        sqsSamples.push(await readSqs(runAws, queueUrls, at));
      } catch (error) {
        sqsError ??= error.message;
      }
    }
  }
  if (now() > deadlineAtMs) {
    return failedGate(options, 'The bake deadline was exceeded before the window closed');
  }

  let alb;
  let p95;
  let outbox;
  let sqsAges;
  for (;;) {
    try {
      alb = await readAlbMetrics(runAws, dimension, startedAtMs, endsAtMs);
    } catch (error) {
      alb = { error: error.message, datapoints: 0, target5xx: [], elb5xx: [], requests: [] };
    }
    try {
      p95 = await readP95(runAws, dimension, startedAtMs, endsAtMs);
    } catch (error) {
      p95 = { error: error.message, seconds: [] };
    }
    try {
      outbox = await readOutbox(runAws, logGroup, startedAtMs, endsAtMs);
    } catch (error) {
      outbox = { error: error.message, lines: [] };
    }
    try {
      sqsAges = await readQueueAges(runAws, stage, startedAtMs, endsAtMs);
    } catch (error) {
      sqsAges = { error: error.message, vto: undefined, auto_tagging: undefined };
    }
    const albReady = !alb.error && alb.datapoints === 5;
    const p95Ready = !p95.error && p95.seconds.length === 1;
    const outboxReady = !outbox.error && outbox.lines.length >= MIN_OUTBOX_LINES;
    const agesReady = !sqsAges.error
      && Number.isFinite(sqsAges.vto?.seconds) && Number.isFinite(sqsAges.auto_tagging?.seconds);
    if (albReady && p95Ready && outboxReady && agesReady) break;
    if (now() >= endsAtMs + INGESTION_TIMEOUT_MS || now() > deadlineAtMs) break;
    await sleep(Math.min(INGESTION_RETRY_MS, endsAtMs + INGESTION_TIMEOUT_MS - now()));
  }

  let alarmObservation;
  try {
    alarmObservation = await readAlarms(runAws, alarmNames);
  } catch (error) {
    alarmObservation = { error: error.message, states: {} };
  }

  const gate = evaluateBake({
    stage, startedAtMs, probesSent, serviceSha, imageDigest,
    loadBalancerDimension: dimension,
    cluster, logGroup, queueNames: deploymentQueueNames(stage),
    observations: {
      alb, p95, outbox, alarms: alarmObservation,
      ecs: { samples: ecsSamples, ...(ecsError === undefined ? {} : { error: ecsError }) },
      sqs: { samples: sqsSamples, ages: sqsAges, ...(sqsError === undefined ? {} : { error: sqsError }) },
      probes: { sent: probesSent, failed: probesFailed },
    },
  });
  return gate;
}
