import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  deploymentAlarmName,
  deploymentQueueNames,
} from '../../lib/contracts.mjs';
import { evaluateBake, failedGate } from '../../scripts/lib/bake-gate.mjs';
import { ecsServiceObservation } from '../../scripts/lib/ecs-rollout.mjs';
import {
  BAKE_FAILURE_DESIGN_LIMIT_BYTES,
  BAKE_FAILURE_LIMIT_BYTES,
  BAKE_FAILURE_REASON_LIMIT_BYTES,
  BAKE_FAILURE_TARGET_LIMIT_BYTES,
  bakeFailureLines,
  bakeFailureSummary,
} from '../../scripts/lib/bake-failure.mjs';
import { gateBlock } from '../contracts/gate-fixture.mjs';

// Issue #336: the failed bake's step-log record, proven against gates the real
// evaluator produces. Every AWS surface is an injected observation and the
// projection is pure, so the grammar, the target derivation, the two clips and
// the 2048-byte ceiling are tested without AWS, a network or a wall clock.
// `npm run check` runs this file through `test:contracts`.
const STAGE = 'beta';
const SERVICE_SHA = 'b'.repeat(40);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const START = Date.UTC(2026, 9, 18, 0, 5, 0);
const DIMENSION = `app/${STAGE}-anywear-api/0123456789abcdef`;
const CLUSTER = `${STAGE}-anywear`;
const LOG_GROUP = `/anywear/${STAGE}/worker`;
const QUEUES = deploymentQueueNames(STAGE);
const ALARM_NAMES = DEPLOYMENT_GATE_SIGNAL_NAMES.flatMap((name) => deploymentAlarmName(STAGE, name));
const OPENED_AT = new Date(START - 300_000).toISOString();
const DEPLOYMENT_IDS = Object.freeze({ api: 'ecs-svc/0691474722825612207', worker: 'ecs-svc/1164516558847022624' });
// The eight fields `makeSignal` puts on every signal; the record adds none and
// changes none.
const SIGNAL_FIELDS = Object.freeze(['name', 'state', 'value', 'threshold', 'comparison', 'alarms', 'reads', 'exceptions']);

const idleQueue = () => ({
  ApproximateNumberOfMessages: '0',
  ApproximateNumberOfMessagesNotVisible: '0',
  ApproximateNumberOfMessagesDelayed: '0',
});

const healthyService = (purpose) => ecsServiceObservation({
  serviceName: `${STAGE}-anywear-${purpose}`, status: 'ACTIVE',
  taskDefinition: `arn:aws:ecs:ap-east-1:650880818323:task-definition/${STAGE}-anywear-${purpose}:7`,
  runningCount: 1, desiredCount: 1,
  deployments: [{ id: DEPLOYMENT_IDS[purpose], status: 'PRIMARY', rolloutState: 'COMPLETED',
    createdAt: OPENED_AT, updatedAt: OPENED_AT, runningCount: 1, desiredCount: 1 }],
});

function observations() {
  return {
    alb: { target5xx: Array(5).fill(0), elb5xx: Array(5).fill(0), requests: Array(5).fill(4), datapoints: 5 },
    p95: { seconds: [0.12] },
    ecs: {
      samples: Array.from({ length: 10 }, (_, index) => ({
        at: START + index * 30_000, api: healthyService('api'), worker: healthyService('worker'),
      })),
      baselineDeploymentIds: { ...DEPLOYMENT_IDS },
    },
    sqs: {
      ages: { vto: { datapoints: 1, seconds: 0 }, auto_tagging: { datapoints: 1, seconds: 0 } },
      samples: Array.from({ length: 10 }, (_, index) => ({
        at: START + index * 30_000,
        queues: {
          vto: idleQueue(), auto_tagging: idleQueue(),
          vto_dlq: { ApproximateNumberOfMessages: '0' },
          auto_tagging_dlq: { ApproximateNumberOfMessages: '0' },
        },
      })),
    },
    outbox: {
      lines: Array.from({ length: 5 }, (_, index) => ({ at: START + index * 60_000, age: null, backlog: 0 })),
    },
    alarms: { states: Object.fromEntries(ALARM_NAMES.map((name) => [name, 'OK'])) },
    probes: { sent: 20, failed: 0 },
  };
}

const evaluate = (override = observations(), extra = {}) => evaluateBake({
  stage: STAGE, startedAtMs: START, probesSent: 20,
  serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
  loadBalancerDimension: DIMENSION, cluster: CLUSTER, logGroup: LOG_GROUP,
  queueNames: QUEUES, observations: override, ...extra,
});

// All six signals breaching at once, with one distinct number per signal.
function breachingObservations() {
  const all = observations();
  all.alb.target5xx[0] = 1;
  all.p95.seconds = [5.001];
  for (let index = 0; index < 5; index += 1) all.ecs.samples[index].api.running_count = 0; // 120 s
  all.sqs.ages.auto_tagging = { datapoints: 1, seconds: 316 };
  all.sqs.samples[4].queues.vto_dlq = { ApproximateNumberOfMessages: '1' };
  all.outbox.lines[4] = { ...all.outbox.lines[4], age: 150_001 };
  return all;
}

const lineOf = (gate, name) => bakeFailureLines(gate).find((line) => line.startsWith(`${name} `));
const recordBytes = (gate) => bakeFailureLines(gate)
  .reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  + Buffer.byteLength(bakeFailureSummary(gate), 'utf8');

test("the incident's breach record names the queue, its 316 seconds and the 150-second threshold", () => {
  // The incident's shape: the VTO queue idle at 0 and beta-anywear-auto-tagging at
  // 316 s. The idle note exists on the gate block, but the record carries the
  // number, the bar and both deployed queue names instead — so no healthy queue's
  // note can be read as the cause.
  const incident = observations();
  incident.sqs.ages.auto_tagging = { datapoints: 1, seconds: 316 };
  const gate = evaluate(incident);
  const signal = gate.signals.find((candidate) => candidate.name === 'sqs_oldest_message_age');
  assert.equal(gate.result, 'failed');
  assert.equal(signal.state, 'breaching');
  assert.match(signal.exceptions.join('; '), new RegExp(`^${QUEUES.vto} queue is idle`));
  const [line] = bakeFailureLines(gate);
  assert.equal(line, 'sqs_oldest_message_age state=breaching value=vto_seconds=0,auto_tagging_seconds=316 '
    + 'threshold=max_seconds=150 target=vto=beta-anywear-vto,auto_tagging=beta-anywear-auto-tagging');
  assert.equal(line.includes('idle'), false, 'no idle-queue text on the record line');
  assert.equal(bakeFailureSummary(gate),
    'The 300-second bake failed (1 of 6 signals): sqs_oldest_message_age');
  // The design's measured incident record: 244 bytes, inside the 1024-byte
  // one-signal reference and far inside the 2048-byte ceiling.
  assert.equal(recordBytes(gate), 244);
  assert.ok(recordBytes(gate) <= BAKE_FAILURE_DESIGN_LIMIT_BYTES);
});

test('each of the six signals carries its anchored value, threshold and target', () => {
  const gate = evaluate(breachingObservations());
  assert.equal(gate.result, 'failed');
  assert.deepEqual(bakeFailureLines(gate), [
    'alb_5xx_rate state=breaching value=target_5xx=1,elb_5xx=0,request_count=20 '
      + 'threshold=max_5xx=0,min_requests=15 target=app/beta-anywear-api/0123456789abcdef',
    'alb_p95_latency state=breaching value=p95_milliseconds=5001 '
      + 'threshold=max_milliseconds=5000 target=app/beta-anywear-api/0123456789abcdef',
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=120,max_sample_gap_seconds=30,samples=10 '
      + 'threshold=max_gap_seconds=120 target=beta-anywear(beta-anywear-api,beta-anywear-worker)',
    'sqs_oldest_message_age state=breaching value=vto_seconds=0,auto_tagging_seconds=316 '
      + 'threshold=max_seconds=150 target=vto=beta-anywear-vto,auto_tagging=beta-anywear-auto-tagging',
    'sqs_dlq_depth state=breaching value=vto_depth=1,auto_tagging_depth=0 '
      + 'threshold=max_depth=0 target=vto_dlq=beta-anywear-vto-dlq,auto_tagging_dlq=beta-anywear-auto-tagging-dlq',
    'outbox_oldest_age state=breaching value=oldest_age_milliseconds=150001,backlog=0,lines_observed=5 '
      + 'threshold=max_age_milliseconds=150000 target=/anywear/beta/worker,"Durable task outbox metrics"',
  ]);
  assert.equal(bakeFailureSummary(gate),
    'The 300-second bake failed (6 of 6 signals): alb_5xx_rate, alb_p95_latency, '
      + 'ecs_running_not_desired, sqs_oldest_message_age, sqs_dlq_depth, outbox_oldest_age');
});

test('an insufficient signal prints value=null and its read error', () => {
  // The four count-floor paths, each with its exact message, plus one surface read
  // error: a missing number reads differently from a measured breach.
  const ecs = observations();
  ecs.ecs.samples = ecs.ecs.samples.slice(0, 9);
  assert.equal(bakeFailureLines(evaluate(ecs)).length, 1);
  assert.equal(lineOf(evaluate(ecs), 'ecs_running_not_desired'),
    'ecs_running_not_desired state=insufficient value=null threshold=max_gap_seconds=120 '
      + 'target=beta-anywear(beta-anywear-api,beta-anywear-worker) '
      + 'reason=only 9 ECS samples were taken; 10 are required');

  const sqs = observations();
  sqs.sqs.samples = sqs.sqs.samples.slice(0, 9);
  const sqsGate = evaluate(sqs);
  assert.deepEqual(bakeFailureLines(sqsGate).map((line) => line.split(' ')[0]),
    ['sqs_oldest_message_age', 'sqs_dlq_depth']);
  assert.equal(lineOf(sqsGate, 'sqs_oldest_message_age'),
    'sqs_oldest_message_age state=insufficient value=null threshold=max_seconds=150 '
      + 'target=vto=beta-anywear-vto,auto_tagging=beta-anywear-auto-tagging '
      + 'reason=only 9 SQS samples were taken; 10 are required');
  assert.equal(lineOf(sqsGate, 'sqs_dlq_depth'),
    'sqs_dlq_depth state=insufficient value=null threshold=max_depth=0 '
      + 'target=vto_dlq=beta-anywear-vto-dlq,auto_tagging_dlq=beta-anywear-auto-tagging-dlq '
      + 'reason=only 9 SQS samples were taken; 10 are required');

  const outbox = observations();
  outbox.outbox.lines = outbox.outbox.lines.slice(0, 3);
  const outboxGate = evaluate(outbox);
  const outboxSignal = outboxGate.signals.find((signal) => signal.name === 'outbox_oldest_age');
  assert.equal(outboxSignal.exceptions[0],
    'only 3 "Durable task outbox metrics" lines were observed; 4 are required');
  // This count-floor message is the one longer than the 60-byte reason budget, so
  // the record carries its clipped head with the marker; the gate keeps the full
  // message and the decision is unchanged.
  assert.equal(lineOf(outboxGate, 'outbox_oldest_age'),
    'outbox_oldest_age state=insufficient value=null threshold=max_age_milliseconds=150000 '
      + 'target=/anywear/beta/worker,"Durable task outbox metrics" '
      + 'reason=only 3 "Durable task outbox metrics" lines were observed;...');

  const unread = observations();
  unread.alb = { error: 'AccessDenied' };
  assert.equal(lineOf(evaluate(unread), 'alb_5xx_rate'),
    'alb_5xx_rate state=insufficient value=null threshold=max_5xx=0,min_requests=15 '
      + 'target=app/beta-anywear-api/0123456789abcdef reason=AccessDenied');
});

test('a judged-value insufficiency keeps its number beside its reason', () => {
  // The gate judged a number but the evidence was short: the value stays, and the
  // reason names the condition that fell short.
  const requestPeriods = observations();
  requestPeriods.alb.datapoints = 4;
  requestPeriods.alb.requests = [4, 4, 4, 4];
  assert.equal(lineOf(evaluate(requestPeriods), 'alb_5xx_rate'),
    'alb_5xx_rate state=insufficient value=target_5xx=0,elb_5xx=0,request_count=16 '
      + 'threshold=max_5xx=0,min_requests=15 target=app/beta-anywear-api/0123456789abcdef '
      + 'reason=RequestCount returned 4 of 5 one-minute datapoints');

  const p95Periods = observations();
  p95Periods.p95.seconds = [0.12, 0.2];
  assert.equal(lineOf(evaluate(p95Periods), 'alb_p95_latency'),
    'alb_p95_latency state=insufficient value=p95_milliseconds=200 threshold=max_milliseconds=5000 '
      + 'target=app/beta-anywear-api/0123456789abcdef reason=TargetResponseTime returned 2 of 1 period');
});

test('a two-queue signal whose read failed prints null on that side', () => {
  // The unread side is `null`, not a zero-fill that reads as a measured age; the
  // other side keeps its number and the reason names the deployed queue.
  const age = observations();
  age.sqs.ages.vto = { datapoints: 1 };
  age.sqs.ages.auto_tagging = { datapoints: 1, seconds: 45 };
  assert.equal(lineOf(evaluate(age), 'sqs_oldest_message_age'),
    'sqs_oldest_message_age state=insufficient value=vto_seconds=null,auto_tagging_seconds=45 '
      + 'threshold=max_seconds=150 target=vto=beta-anywear-vto,auto_tagging=beta-anywear-auto-tagging '
      + `reason=${QUEUES.vto} returned an invalid oldest-message age`);

  const depth = observations();
  delete depth.sqs.samples[0].queues.vto_dlq.ApproximateNumberOfMessages;
  depth.sqs.samples[2].queues.auto_tagging_dlq = { ApproximateNumberOfMessages: '3' };
  assert.equal(lineOf(evaluate(depth), 'sqs_dlq_depth'),
    'sqs_dlq_depth state=insufficient value=vto_depth=null,auto_tagging_depth=3 '
      + 'threshold=max_depth=0 '
      + 'target=vto_dlq=beta-anywear-vto-dlq,auto_tagging_dlq=beta-anywear-auto-tagging-dlq '
      + `reason=${QUEUES.vto_dlq} returned no ApproximateNumberOfMessages`);
});

test('the ECS deployment half prints its first condition and the exact narrowed target', () => {
  // Hand-built rows prove the two independent rules: the first non-null condition
  // in array order, and the unique services in first-appearance order.
  const base = gateBlock().signals.find((signal) => signal.name === 'ecs_running_not_desired');
  const handBuilt = {
    ...base,
    state: 'breaching',
    value: {
      longest_gap_seconds: 0, max_sample_gap_seconds: 30, samples: 10,
      unexpected_deployments: [
        { service: 'beta-anywear-worker', condition: null },
        { service: 'beta-anywear-worker', condition: 'rollout-stalled' },
        { service: 'beta-anywear-api', condition: 'deployment-shape' },
      ],
    },
  };
  assert.equal(bakeFailureLines({ signals: [handBuilt] })[0],
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=0,max_sample_gap_seconds=30,samples=10,'
      + 'deployment_breach=rollout-stalled threshold=max_gap_seconds=120 '
      + 'target=beta-anywear(beta-anywear-worker,beta-anywear-api)');

  // A read with no cluster prints `unknown`, never an invented name.
  assert.equal(bakeFailureLines({ signals: [{ ...base, state: 'breaching', reads: [{
    source: 'ecs', services: ['beta-anywear-api', 'beta-anywear-worker'], samples: 10,
  }] }] })[0],
  'ecs_running_not_desired state=breaching value=longest_gap_seconds=0,max_sample_gap_seconds=30,samples=10 '
    + 'threshold=max_gap_seconds=120 target=unknown');

  // One failing service: the target narrows to that service.
  const one = observations();
  one.ecs.samples[5].api.deployments.push({ id: 'ecs-svc/concurrent', status: 'ACTIVE',
    rollout_state: 'COMPLETED', created_at: OPENED_AT, updated_at: OPENED_AT, running_count: 1, desired_count: 1 });
  one.ecs.samples[5].api.deployment_count = 2;
  const oneGate = evaluate(one);
  assert.equal(oneGate.signals.find((signal) => signal.name === 'ecs_running_not_desired').state, 'breaching');
  assert.equal(lineOf(oneGate, 'ecs_running_not_desired'),
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=0,max_sample_gap_seconds=30,samples=10,'
      + 'deployment_breach=deployment-shape threshold=max_gap_seconds=120 '
      + 'target=beta-anywear(beta-anywear-api)');

  // Both services represented: both names, in first-appearance order.
  const both = observations();
  both.ecs.samples[5].api.deployments.push({ id: 'ecs-svc/concurrent', status: 'ACTIVE',
    rollout_state: 'COMPLETED', created_at: OPENED_AT, updated_at: OPENED_AT, running_count: 1, desired_count: 1 });
  both.ecs.samples[5].api.deployment_count = 2;
  both.ecs.samples[5].worker.deployments[0].rollout_state = 'IN_PROGRESS';
  both.ecs.samples[5].worker.rollout_state = 'IN_PROGRESS';
  assert.equal(lineOf(evaluate(both), 'ecs_running_not_desired'),
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=0,max_sample_gap_seconds=30,samples=10,'
      + 'deployment_breach=deployment-shape threshold=max_gap_seconds=120 '
      + 'target=beta-anywear(beta-anywear-api,beta-anywear-worker)');

  // A count-half-only breach has no rows, so it carries no condition key and names
  // both services the gate read.
  const countOnly = observations();
  for (let index = 0; index < 5; index += 1) countOnly.ecs.samples[index].api.running_count = 0;
  assert.equal(lineOf(evaluate(countOnly), 'ecs_running_not_desired'),
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=120,max_sample_gap_seconds=30,samples=10 '
      + 'threshold=max_gap_seconds=120 target=beta-anywear(beta-anywear-api,beta-anywear-worker)');

  // Both halves fail: the condition and the count gap both print.
  const together = observations();
  for (let index = 0; index < 5; index += 1) together.ecs.samples[index].api.running_count = 0;
  together.ecs.samples[5].api.deployments.push({ id: 'ecs-svc/concurrent', status: 'ACTIVE',
    rollout_state: 'COMPLETED', created_at: OPENED_AT, updated_at: OPENED_AT, running_count: 1, desired_count: 1 });
  together.ecs.samples[5].api.deployment_count = 2;
  assert.equal(lineOf(evaluate(together), 'ecs_running_not_desired'),
    'ecs_running_not_desired state=breaching value=longest_gap_seconds=120,max_sample_gap_seconds=30,samples=10,'
      + 'deployment_breach=deployment-shape threshold=max_gap_seconds=120 '
      + 'target=beta-anywear(beta-anywear-api)');
});

test('no record line carries comparison, reads or alarms', () => {
  const passing = evaluate(observations());
  assert.equal(passing.result, 'passed');
  for (const signal of passing.signals) assert.deepEqual(Object.keys(signal), [...SIGNAL_FIELDS]);
  assert.deepEqual(bakeFailureLines(passing), [], 'a passing bake writes no record line');

  const failing = evaluate(breachingObservations());
  for (const signal of failing.signals) assert.deepEqual(Object.keys(signal), [...SIGNAL_FIELDS]);
  const before = JSON.stringify(failing);
  const lines = bakeFailureLines(failing);
  const summary = bakeFailureSummary(failing);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(line.includes('comparison'), false, line);
    assert.equal(line.includes('reads'), false, line);
    assert.equal(line.includes('alarms'), false, line);
    assert.match(line, /^[a-z0-9_]+ state=(breaching|insufficient) value=\S+ threshold=\S+ target=.+$/);
  }
  assert.equal(JSON.stringify(failing), before, 'the projection does not mutate the gate block');
  assert.match(summary, /^The 300-second bake failed \(6 of 6 signals\): /);
});

test('six failed signals stay within the 2048-byte ceiling and every value survives', () => {
  assert.equal(BAKE_FAILURE_LIMIT_BYTES, 2048);
  assert.equal(BAKE_FAILURE_DESIGN_LIMIT_BYTES, 1024);
  assert.equal(BAKE_FAILURE_TARGET_LIMIT_BYTES, 96);
  assert.equal(BAKE_FAILURE_REASON_LIMIT_BYTES, 60);
  const breaching = evaluate(breachingObservations());
  const lines = bakeFailureLines(breaching);
  assert.equal(lines.length, 6, 'no signal is dropped');
  assert.deepEqual(lines.map((line) => line.split(' ')[0]), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
  assert.ok(recordBytes(breaching) <= BAKE_FAILURE_LIMIT_BYTES,
    `six-breaching record is ${recordBytes(breaching)} bytes`);
  const slot = (name, key) => lineOf(breaching, name).split(' ').find((entry) => entry.startsWith(`${key}=`));
  assert.equal(slot('alb_5xx_rate', 'value'), 'value=target_5xx=1,elb_5xx=0,request_count=20');
  assert.equal(slot('alb_p95_latency', 'value'), 'value=p95_milliseconds=5001');
  assert.equal(slot('ecs_running_not_desired', 'value'),
    'value=longest_gap_seconds=120,max_sample_gap_seconds=30,samples=10');
  assert.equal(slot('sqs_oldest_message_age', 'value'), 'value=vto_seconds=0,auto_tagging_seconds=316');
  assert.equal(slot('sqs_dlq_depth', 'value'), 'value=vto_depth=1,auto_tagging_depth=0');
  assert.equal(slot('outbox_oldest_age', 'value'),
    'value=oldest_age_milliseconds=150001,backlog=0,lines_observed=5');
  for (const signal of breaching.signals) {
    const threshold = Object.entries(signal.threshold).map(([key, value]) => `${key}=${value}`).join(',');
    assert.equal(slot(signal.name, 'threshold'), `threshold=${threshold}`, signal.name);
  }

  // The stress case: six insufficient signals whose AWS errors are 4000 bytes.
  const huge = failedGate({ stage: STAGE, cluster: CLUSTER, logGroup: LOG_GROUP,
    serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST }, 'x'.repeat(4000));
  const hugeLines = bakeFailureLines(huge);
  assert.equal(hugeLines.length, 6);
  assert.ok(recordBytes(huge) <= BAKE_FAILURE_LIMIT_BYTES,
    `six-insufficient record with 4000-byte errors is ${recordBytes(huge)} bytes`);
  for (const line of hugeLines) {
    assert.equal(Buffer.byteLength(line.slice(line.indexOf('reason=') + 'reason='.length), 'utf8'), 60,
      'each reason is clipped to its 60-byte budget');
  }
});

test('a control character in a reason or target is escaped and the signal stays one line', () => {
  const base = gateBlock().signals.find((signal) => signal.name === 'outbox_oldest_age');
  const signal = {
    ...base,
    state: 'insufficient',
    exceptions: ['line1\nline2\r\t\u0000\u2028\u2029\\'],
    reads: [{ source: 'logs', log_group: '/anywear/beta/worker\nbreak',
      filter_pattern: '"Durable task outbox metrics"', samples: 5 }],
  };
  const lines = bakeFailureLines({ signals: [signal] });
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.split('\n').length, 1, 'one physical line per signal');
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/.test(line), false);
  assert.equal(line,
    'outbox_oldest_age state=insufficient value=oldest_age_milliseconds=null,backlog=0,lines_observed=5 '
      + 'threshold=max_age_milliseconds=150000 '
      + 'target=/anywear/beta/worker\\nbreak,"Durable task outbox metrics" '
      + 'reason=line1\\nline2\\r\\t\\u0000\\u2028\\u2029\\\\');
  assert.equal(bakeFailureSummary({ signals: [signal] }).includes('\n'), false);
});

test('a target over 96 bytes is clipped with a marker and the judged value is untouched', () => {
  const base = gateBlock().signals.find((signal) => signal.name === 'alb_5xx_rate');
  const dimension = `app/${STAGE}-anywear-api/${'a'.repeat(120)}`;
  const clipped = `${dimension.slice(0, 93)}...`;
  assert.equal(Buffer.byteLength(clipped, 'utf8'), BAKE_FAILURE_TARGET_LIMIT_BYTES);
  const [line] = bakeFailureLines({
    signals: [{ ...base, state: 'breaching', reads: [{ ...base.reads[0], dimensions: { LoadBalancer: dimension } }] }],
  });
  assert.equal(line,
    'alb_5xx_rate state=breaching value=target_5xx=0,elb_5xx=0,request_count=20 '
      + `threshold=max_5xx=0,min_requests=15 target=${clipped}`);
  assert.equal(line.includes(`value=target_5xx=0,elb_5xx=0,request_count=20 threshold=max_5xx=0,min_requests=15`),
    true, 'the judged value and threshold are byte-identical to the gate block');

  // A target slot with no read at all prints `unknown`, not an invented name.
  assert.equal(bakeFailureLines({ signals: [{ ...base, state: 'breaching', reads: [] }] })[0],
    'alb_5xx_rate state=breaching value=target_5xx=0,elb_5xx=0,request_count=20 '
      + 'threshold=max_5xx=0,min_requests=15 target=unknown');
});

test('a reason over 60 bytes is clipped and one signal stays one line', () => {
  const base = gateBlock().signals.find((signal) => signal.name === 'alb_p95_latency');
  // 56 ASCII bytes plus a two-byte character: the head must stop before the `é`
  // rather than split it, so it is 56 bytes and the clip is 59 bytes with `...`.
  const reason = `${'x'.repeat(56)}é${'y'.repeat(20)}`;
  const clipped = `${'x'.repeat(56)}...`;
  assert.equal(Buffer.byteLength(clipped, 'utf8'), 59);
  const [line] = bakeFailureLines({
    signals: [{ ...base, state: 'insufficient', value: { p95_milliseconds: 120 }, exceptions: [reason] }],
  });
  assert.equal(line.split('\n').length, 1);
  assert.equal(line,
    `alb_p95_latency state=insufficient value=p95_milliseconds=120 threshold=max_milliseconds=5000 `
      + `target=app/${STAGE}-anywear-api/0123456789abcdef reason=${clipped}`);
  assert.equal(line.includes('é'), false, 'the marker replaces the cut multi-byte character');
});
