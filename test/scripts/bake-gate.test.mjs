import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_SQS_DEPTH_ATTRIBUTES,
  deploymentAlarmName,
  deploymentQueueNames,
} from '../../lib/contracts.mjs';
import {
  MIN_OUTBOX_LINES,
  alignedStart,
  evaluateBake,
  failedGate,
  runBakeGate,
} from '../../scripts/lib/bake-gate.mjs';

// The 300-second six-signal bake's contract tests (#162), moved from
// `AnyWear-Service/infra/test/bake-gate.test.mjs` when #195 moved the Runtime stack
// and its deploy operation into Infra. They keep the original design: every AWS
// surface is an injected `runAws` fake and the evaluation is pure, so thresholds,
// insufficient-data versus failed states, the six signals and the URL form of the
// queue reads are proven without AWS, a network or a wall clock. `npm run check`
// runs this file through `test:contracts`.
const STAGE = 'beta';
const SERVICE_SHA = 'b'.repeat(40);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const START = alignedStart(Date.UTC(2026, 9, 18, 0, 0, 30)); // 2026-10-18T00:05:00.000Z
const DIMENSION = `app/${STAGE}-anywear-api/0123456789abcdef`;
const CLUSTER = `${STAGE}-anywear`;
const LOG_GROUP = `/anywear/${STAGE}/worker`;
const QUEUES = deploymentQueueNames(STAGE);
// The four stage-contract queue URLs the deploy reads and the bake consumes. The
// values are shape fixtures, not account/region literals hardcoded by the gate.
const QUEUE_URLS = Object.freeze({
  vto: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
  auto_tagging: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
  vto_dlq: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto-dlq',
  auto_tagging_dlq: 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging-dlq',
});
const ALARM_NAMES = DEPLOYMENT_GATE_SIGNAL_NAMES.flatMap((name) => deploymentAlarmName(STAGE, name));
const ECS_START = Date.UTC(2026, 9, 18, 0, 5, 0);

const healthyService = () => ({ running_count: 1, desired_count: 1, deployment_count: 1, rollout_state: 'COMPLETED' });
// The live GetQueueAttributes surface: only these three names are valid depth
// attributes. The oldest-message age is a separate AWS/SQS CloudWatch metric.
const idleQueue = () => ({
  ApproximateNumberOfMessages: '0',
  ApproximateNumberOfMessagesNotVisible: '0',
  ApproximateNumberOfMessagesDelayed: '0',
});

function baseObservations() {
  return {
    alb: {
      target5xx: Array(5).fill(0),
      elb5xx: Array(5).fill(0),
      // Five one-minute periods of four probes each: the 20-probe 300-second window.
      requests: Array(5).fill(4),
      datapoints: 5,
    },
    p95: { seconds: [0.12] },
    ecs: {
      samples: Array.from({ length: 10 }, (_, index) => ({
        at: ECS_START + index * 30_000,
        api: healthyService(),
        worker: healthyService(),
      })),
    },
    sqs: {
      // One 300-second period per work queue: the whole-window read the gate
      // requires. Tests override `datapoints` to prove the exactly-one guard.
      ages: { vto: { datapoints: 1, seconds: 0 }, auto_tagging: { datapoints: 1, seconds: 0 } },
      samples: Array.from({ length: 10 }, (_, index) => ({
        at: ECS_START + index * 30_000,
        queues: {
          vto: idleQueue(),
          auto_tagging: idleQueue(),
          vto_dlq: { ApproximateNumberOfMessages: '0' },
          auto_tagging_dlq: { ApproximateNumberOfMessages: '0' },
        },
      })),
    },
    outbox: {
      lines: Array.from({ length: 5 }, (_, index) => ({ at: ECS_START + index * 60_000, age: null, backlog: 0 })),
    },
    alarms: { states: Object.fromEntries(ALARM_NAMES.map((name) => [name, 'OK'])) },
    probes: { sent: 20, failed: 0 },
  };
}

const evaluate = (observations, extra = {}) => evaluateBake({
  stage: STAGE,
  startedAtMs: START,
  probesSent: 20,
  serviceSha: SERVICE_SHA,
  imageDigest: IMAGE_DIGEST,
  loadBalancerDimension: DIMENSION,
  cluster: CLUSTER,
  logGroup: LOG_GROUP,
  queueNames: QUEUES,
  observations,
  ...extra,
});

const signalOf = (gate, name) => gate.signals.find((signal) => signal.name === name);

function assertFailedWith(gate, name, state) {
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, name).state, state);
  for (const other of gate.signals.filter((signal) => signal.name !== name)) {
    assert.equal(other.state, 'not-breaching', `unexpected ${other.name} state`);
  }
}

test('the bake window starts on the next 5-minute clock boundary so the 60s, 30s and 300s periods are exact', () => {
  assert.equal(alignedStart(Date.UTC(2026, 9, 18, 0, 0, 30)), Date.UTC(2026, 9, 18, 0, 5, 0));
  assert.equal(alignedStart(Date.UTC(2026, 9, 18, 0, 0, 0)), Date.UTC(2026, 9, 18, 0, 0, 0));
  assert.equal(alignedStart(Date.UTC(2026, 9, 18, 0, 5, 0)), Date.UTC(2026, 9, 18, 0, 5, 0));
  assert.equal(alignedStart(Date.UTC(2026, 9, 18, 0, 5, 1)), Date.UTC(2026, 9, 18, 0, 10, 0));
});

test('a healthy 300-second bake passes, records the six fixed signals and their calibration', () => {
  const gate = evaluate(baseObservations());
  assert.equal(gate.result, 'passed');
  assert.equal(gate.name, 'beta-anywear-deployment-bake');
  assert.equal(gate.duration_seconds, 300);
  assert.equal(Date.parse(gate.ended_at) - Date.parse(gate.started_at), 300_000);
  assert.equal(gate.probe.interval_seconds, 15);
  assert.equal(gate.probe.probes_sent, 20);
  assert.equal(gate.probe.request_floor, 15);
  assert.equal(signalOf(gate, 'sqs_oldest_message_age').threshold.max_seconds, 150);
  assert.equal(signalOf(gate, 'outbox_oldest_age').threshold.max_age_milliseconds, 150_000);
  assert.deepEqual(gate.signals.map((signal) => signal.name), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
  for (const signal of gate.signals) assert.equal(signal.state, 'not-breaching', `${signal.name} must be healthy`);
  assert.equal(signalOf(gate, 'alb_5xx_rate').value.request_count, 20);
  assert.equal(signalOf(gate, 'alb_p95_latency').value.p95_milliseconds, 120);
  assert.equal(signalOf(gate, 'ecs_running_not_desired').value.samples, 10);
  assert.equal(signalOf(gate, 'sqs_oldest_message_age').value.vto_seconds, 0);
  assert.match(signalOf(gate, 'sqs_oldest_message_age').exceptions.join('; '), /vto queue is idle/);
  assert.match(signalOf(gate, 'outbox_oldest_age').exceptions.join('; '), /oldest age is null by construction/);
  assert.equal(signalOf(gate, 'outbox_oldest_age').value.lines_observed, 5);
  assert.deepEqual(signalOf(gate, 'sqs_dlq_depth').alarms.map((alarm) => alarm.name),
    [`${STAGE}-anywear-vto-dlq-not-empty`, `${STAGE}-anywear-auto-tagging-dlq-not-empty`]);
  assert.equal(signalOf(gate, 'alb_p95_latency').reads[0].statistic, 'p95');
  assert.equal(signalOf(gate, 'alb_5xx_rate').reads[0].dimensions.LoadBalancer, DIMENSION);
});

test('one DLQ message fails only sqs_dlq_depth', () => {
  const observations = baseObservations();
  observations.sqs.samples[7].queues.vto_dlq.ApproximateNumberOfMessages = '1';
  assertFailedWith(evaluate(observations), 'sqs_dlq_depth', 'breaching');
});

test('a single ALB 5xx record fails alb_5xx_rate', () => {
  const observations = baseObservations();
  observations.alb.target5xx[3] = 1;
  assertFailedWith(evaluate(observations), 'alb_5xx_rate', 'breaching');
  const elb = baseObservations();
  elb.alb.elb5xx[0] = 1;
  assertFailedWith(evaluate(elb), 'alb_5xx_rate', 'breaching');
});

test('an absent zero-valued 5xx datapoint is summed as zero, not missing evidence', () => {
  const observations = baseObservations();
  observations.alb.target5xx = observations.alb.target5xx.slice(0, 4);
  observations.alb.elb5xx = observations.alb.elb5xx.slice(0, 4);
  const gate = evaluate(observations);
  assert.equal(gate.result, 'passed');
  assert.equal(signalOf(gate, 'alb_5xx_rate').state, 'not-breaching');
  assert.equal(signalOf(gate, 'alb_5xx_rate').value.target_5xx, 0);
  assert.equal(signalOf(gate, 'alb_5xx_rate').value.elb_5xx, 0);
  assert.equal(signalOf(gate, 'alb_5xx_rate').value.request_count, 20);
});

test('a four-period RequestCount read is insufficient and names the short series', () => {
  const observations = baseObservations();
  observations.alb.datapoints = 4;
  observations.alb.requests = Array(4).fill(4);
  const gate = evaluate(observations);
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'alb_5xx_rate').state, 'insufficient');
  assert.match(signalOf(gate, 'alb_5xx_rate').exceptions[0], /RequestCount returned 4 of 5/);
});

test('a 14-request denominator is insufficient evidence, not health', () => {
  const observations = baseObservations();
  observations.alb.requests = [3, 3, 3, 3, 2];
  assertFailedWith(evaluate(observations), 'alb_5xx_rate', 'insufficient');
});

test('14 probes sent is insufficient whatever the metric reads say', () => {
  const observations = baseObservations();
  const gate = evaluate(observations, { probesSent: 14 });
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'alb_5xx_rate').state, 'insufficient');
  assert.match(signalOf(gate, 'alb_5xx_rate').exceptions[0], /the request floor is 15/);
});

test('a p95 above 5000 ms fails alb_p95_latency', () => {
  const observations = baseObservations();
  observations.p95.seconds = [5.001];
  assertFailedWith(evaluate(observations), 'alb_p95_latency', 'breaching');
  const atLimit = baseObservations();
  atLimit.p95.seconds = [5];
  assert.equal(evaluate(atLimit).result, 'passed');
});

test('a missing TargetResponseTime period is insufficient', () => {
  const p95 = baseObservations();
  p95.p95.seconds = [];
  assertFailedWith(evaluate(p95), 'alb_p95_latency', 'insufficient');
});

test('an ECS rollout with two deployments or a non-COMPLETED rollout fails', () => {
  const two = baseObservations();
  two.ecs.samples[5].api.deployment_count = 2;
  assertFailedWith(evaluate(two), 'ecs_running_not_desired', 'breaching');
  const inProgress = baseObservations();
  inProgress.ecs.samples[0].worker.rollout_state = 'IN_PROGRESS';
  assertFailedWith(evaluate(inProgress), 'ecs_running_not_desired', 'breaching');
  const failed = baseObservations();
  failed.ecs.samples[3].api.rollout_state = 'FAILED';
  assertFailedWith(evaluate(failed), 'ecs_running_not_desired', 'breaching');
});

test('a running/desired mismatch is tolerated below 120s and fails at 120s', () => {
  const jitter = baseObservations();
  for (let index = 0; index < 3; index += 1) jitter.ecs.samples[index].api.running_count = 0; // 60s
  assert.equal(evaluate(jitter).result, 'passed');
  const mismatch = baseObservations();
  for (let index = 0; index < 5; index += 1) mismatch.ecs.samples[index].worker.running_count = 0; // 120s
  assertFailedWith(evaluate(mismatch), 'ecs_running_not_desired', 'breaching');
});

test('nine ECS samples and nine SQS samples are insufficient', () => {
  const ecs = baseObservations();
  ecs.ecs.samples = ecs.ecs.samples.slice(0, 9);
  assertFailedWith(evaluate(ecs), 'ecs_running_not_desired', 'insufficient');
  const sqs = baseObservations();
  sqs.sqs.samples = sqs.sqs.samples.slice(0, 9);
  const gate = evaluate(sqs);
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'sqs_oldest_message_age').state, 'insufficient');
  assert.equal(signalOf(gate, 'sqs_dlq_depth').state, 'insufficient');
  assert.match(signalOf(gate, 'sqs_dlq_depth').exceptions[0], /only 9 SQS samples were taken; 10 are required/);
});

test('a late ECS sampling gap beyond 120s is insufficient', () => {
  const late = baseObservations();
  late.ecs.samples[5].at += 150_000;
  assertFailedWith(evaluate(late), 'ecs_running_not_desired', 'insufficient');
});

test('a fresh SQS message crossing 150 seconds fails only sqs_oldest_message_age', () => {
  const observations = baseObservations();
  observations.sqs.ages.vto.seconds = 151;
  observations.sqs.samples[4].queues.vto = {
    ...observations.sqs.samples[4].queues.vto,
    ApproximateNumberOfMessages: '1',
  };
  assertFailedWith(evaluate(observations), 'sqs_oldest_message_age', 'breaching');
  const atLimit = baseObservations();
  atLimit.sqs.ages.vto.seconds = 150;
  atLimit.sqs.samples[4].queues.vto = {
    ...atLimit.sqs.samples[4].queues.vto,
    ApproximateNumberOfMessages: '1',
  };
  assert.equal(evaluate(atLimit).result, 'passed');
});

test('an active queue with no age datapoint is insufficient', () => {
  const observations = baseObservations();
  observations.sqs.samples[2].queues.auto_tagging = {
    ...observations.sqs.samples[2].queues.auto_tagging,
    ApproximateNumberOfMessages: '1',
  };
  delete observations.sqs.ages.auto_tagging;
  assertFailedWith(evaluate(observations), 'sqs_oldest_message_age', 'insufficient');
});

test('an idle queue with no age datapoint is recorded as age 0', () => {
  const zeroRead = baseObservations();
  zeroRead.sqs.ages.auto_tagging = { datapoints: 0 };
  const absentRead = baseObservations();
  delete absentRead.sqs.ages.auto_tagging;
  // A zero-datapoint read is what the runner records for an idle queue; an
  // absent key is the same evidence. Both keep the idle rule, never insufficiency.
  for (const observations of [zeroRead, absentRead]) {
    const gate = evaluate(observations);
    const signal = signalOf(gate, 'sqs_oldest_message_age');
    assert.equal(gate.result, 'passed');
    assert.equal(signal.state, 'not-breaching');
    assert.equal(signal.value.auto_tagging_seconds, 0);
    assert.match(signal.exceptions.join('; '), /auto_tagging queue is idle/);
    const read = signal.reads.find((candidate) => candidate.metric_name === 'ApproximateAgeOfOldestMessage'
      && candidate.dimensions.QueueName === QUEUES.auto_tagging);
    assert.equal(read.datapoints, 0);
  }
});

test('one whole-window age period for both work queues is the healthy read', () => {
  const gate = evaluate(baseObservations());
  const signal = signalOf(gate, 'sqs_oldest_message_age');
  assert.equal(gate.result, 'passed');
  assert.equal(signal.state, 'not-breaching');
  const ageReads = signal.reads.filter((read) => read.metric_name === 'ApproximateAgeOfOldestMessage');
  assert.deepEqual(ageReads.map((read) => read.dimensions.QueueName), [QUEUES.vto, QUEUES.auto_tagging]);
  assert.deepEqual(ageReads.map((read) => read.datapoints), [1, 1]);
});

test('two age periods for one queue are insufficient, record the count and do not poison sqs_dlq_depth', () => {
  for (const [queue, other] of [['vto', 'auto_tagging'], ['auto_tagging', 'vto']]) {
    const observations = baseObservations();
    // The aggregate would look breaching. A two-period read is not the window's
    // evidence at all, so the signal must be insufficient rather than breaching.
    observations.sqs.ages[queue] = { datapoints: 2, seconds: 300 };
    const gate = evaluate(observations);
    assertFailedWith(gate, 'sqs_oldest_message_age', 'insufficient');
    const signal = signalOf(gate, 'sqs_oldest_message_age');
    assert.match(signal.exceptions[0], new RegExp(`${queue} ApproximateAgeOfOldestMessage returned 2 periods`));
    const ageReads = signal.reads.filter((read) => read.metric_name === 'ApproximateAgeOfOldestMessage');
    assert.equal(ageReads.find((read) => read.dimensions.QueueName === QUEUES[queue]).datapoints, 2);
    assert.equal(ageReads.find((read) => read.dimensions.QueueName === QUEUES[other]).datapoints, 1);
    assert.equal(signalOf(gate, 'sqs_dlq_depth').state, 'not-breaching');
  }
});

test('the live runner rejects a two-period age read instead of aggregating it', async () => {
  const observations = baseObservations();
  observations.sqs.ages.vto = { datapoints: 2, seconds: 300 };
  const clock = virtualClock();
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: fixtureRunAws({ observations }),
  });
  assert.equal(gate.result, 'failed');
  const signal = signalOf(gate, 'sqs_oldest_message_age');
  assert.equal(signal.state, 'insufficient');
  assert.match(signal.exceptions[0], /vto ApproximateAgeOfOldestMessage returned 2 periods/);
  const read = signal.reads.find((candidate) => candidate.metric_name === 'ApproximateAgeOfOldestMessage'
    && candidate.dimensions.QueueName === QUEUES.vto);
  assert.equal(read.datapoints, 2);
  assert.equal(signalOf(gate, 'sqs_dlq_depth').state, 'not-breaching');
});

test('the live runner records a zero-datapoint idle queue as age 0 with the idle exception', async () => {
  const clock = virtualClock();
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: fixtureRunAws({
      onMetric: (metric) => {
        if (metric === 'ApproximateAgeOfOldestMessage') return JSON.stringify({ Datapoints: [] });
        if (metric === 'TargetResponseTime') return JSON.stringify({ Datapoints: [{ ExtendedStatistics: { p95: 0.12 } }] });
        const values = metric === 'HTTPCode_Target_5XX_Count' || metric === 'HTTPCode_ELB_5XX_Count'
          ? Array(5).fill(0) : Array(5).fill(4);
        return JSON.stringify({ Datapoints: values.map((value) => ({ Sum: value })) });
      },
    }),
  });
  assert.equal(gate.result, 'passed');
  const signal = signalOf(gate, 'sqs_oldest_message_age');
  assert.equal(signal.state, 'not-breaching');
  assert.deepEqual(signal.value, { vto_seconds: 0, auto_tagging_seconds: 0 });
  assert.match(signal.exceptions.join('; '), /vto queue is idle/);
  assert.match(signal.exceptions.join('; '), /auto_tagging queue is idle/);
  for (const read of signal.reads.filter((candidate) => candidate.metric_name === 'ApproximateAgeOfOldestMessage')) {
    assert.equal(read.datapoints, 0);
  }
});

test('the SQS read requests only valid depth attribute names', async () => {
  const queuedAttributeLists = [];
  const clock = virtualClock();
  await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    output: 'bake-gate.json', now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    runAws: (args) => {
      if (args[0] === 'sqs') {
        const start = args.indexOf('--attribute-names') + 1;
        queuedAttributeLists.push(args.slice(start));
      }
      return fixtureRunAws()(args);
    },
  });
  assert.equal(queuedAttributeLists.length > 0, true);
  for (const names of queuedAttributeLists) {
    assert.deepEqual(names, ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesDelayed']);
    for (const name of names) {
      assert.equal(DEPLOYMENT_SQS_DEPTH_ATTRIBUTES.includes(name), true, `${name} is a valid SQS depth attribute`);
    }
  }
});

// Issue #195 blocking fix: `deploy-runtime` once passed queue *names* where the
// bake's `sqs get-queue-attributes --queue-url` needs URLs. The gate consumes
// exactly the four contract values it is handed, and every SQS read names a full
// `https://sqs.` URL.
test('the live runner reads the four queues only by their full https://sqs. URLs', async () => {
  const urlsRead = [];
  const clock = virtualClock();
  await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: (args) => {
      if (args[0] === 'sqs' && args[1] === 'get-queue-attributes') {
        urlsRead.push(args[args.indexOf('--queue-url') + 1]);
      }
      return fixtureRunAws()(args);
    },
  });
  assert.deepEqual(new Set(urlsRead), new Set(Object.values(QUEUE_URLS)));
  for (const url of urlsRead) {
    assert.match(url, /^https:\/\/sqs\.[a-z0-9.-]+\/\d{12}\/[A-Za-z0-9_.-]+$/, `${url} is a queue URL`);
  }
  // A name is not a URL: the deploy validates the contract values before calling
  // the gate, and a name in `--queue-url` would fail every SQS read at Deployment.
  for (const value of Object.values(QUEUE_URLS)) assert.equal(/^[a-z0-9-]+$/.test(value), false);
});

test('a missing DLQ depth is insufficient and zero is a real value', () => {
  const observations = baseObservations();
  delete observations.sqs.samples[0].queues.auto_tagging_dlq.ApproximateNumberOfMessages;
  assertFailedWith(evaluate(observations), 'sqs_dlq_depth', 'insufficient');
});

test('a three-line outbox read is insufficient', () => {
  const short = baseObservations();
  short.outbox.lines = short.outbox.lines.slice(0, MIN_OUTBOX_LINES - 1);
  const gate = evaluate(short);
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'outbox_oldest_age').state, 'insufficient');
  assert.match(signalOf(gate, 'outbox_oldest_age').exceptions[0], /only 3 "Durable task outbox metrics" lines were observed; 4 are required/);
});

test('the outbox probe fails on an old age or a null age with backlog', () => {
  const old = baseObservations();
  old.outbox.lines[4].age = 150_001;
  assertFailedWith(evaluate(old), 'outbox_oldest_age', 'breaching');
  const atLimit = baseObservations();
  atLimit.outbox.lines[4].age = 150_000;
  assert.equal(evaluate(atLimit).result, 'passed');
  const backlog = baseObservations();
  backlog.outbox.lines[4].backlog = 1;
  assertFailedWith(evaluate(backlog), 'outbox_oldest_age', 'breaching');
  const healthyBacklog = baseObservations();
  healthyBacklog.outbox.lines[4].age = 12_000;
  healthyBacklog.outbox.lines[4].backlog = 1;
  assert.equal(evaluate(healthyBacklog).result, 'passed');
});

test('a missing deployed alarm is insufficient evidence for its signal only', () => {
  const observations = baseObservations();
  delete observations.alarms.states[`${STAGE}-anywear-outbox-oldest-age`];
  assertFailedWith(evaluate(observations), 'outbox_oldest_age', 'insufficient');
});

test('every surface error produces a failed six-signal block, never a pass', () => {
  const gate = failedGate({
    stage: STAGE,
    cluster: CLUSTER,
    logGroup: LOG_GROUP,
    serviceSha: SERVICE_SHA,
    imageDigest: IMAGE_DIGEST,
  });
  assert.equal(gate.result, 'failed');
  assert.equal(gate.signals.length, 6);
  assert.ok(gate.signals.every((signal) => signal.state === 'insufficient'));
});


function fixtureRunAws({ observations = baseObservations(), onMetric } = {}) {
  return (args) => {
    if (args[0] === 'cloudformation') {
      return JSON.stringify({ StackResourceSummaries: [{
        ResourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        PhysicalResourceId: `arn:aws:elasticloadbalancing:ap-east-1:650880818323:loadbalancer/${DIMENSION}`,
      }] });
    }
    if (args[0] === 'cloudwatch' && args[1] === 'get-metric-statistics') {
      const metric = args[args.indexOf('--metric-name') + 1];
      const period = Number(args[args.indexOf('--period') + 1]);
      if (onMetric) return onMetric(metric, period);
      if (metric === 'ApproximateAgeOfOldestMessage') {
        assert.equal(period, 300);
        const dimensions = args[args.indexOf('--dimensions') + 1];
        const queueName = /^Name=QueueName,Value=(.+)$/.exec(dimensions)[1];
        assert.equal(args[args.indexOf('--statistics') + 1], 'Maximum');
        const age = observations.sqs.ages[queueName.replace(`${STAGE}-anywear-`, '').replaceAll('-', '_')];
        return JSON.stringify({
          Datapoints: age === undefined
            ? [] : Array.from({ length: age.datapoints }, () => ({ Maximum: age.seconds })),
        });
      }
      if (metric === 'TargetResponseTime') {
        return JSON.stringify({ Datapoints: observations.p95.seconds.map((value) => ({ ExtendedStatistics: { p95: value } })) });
      }
      const values = metric === 'HTTPCode_Target_5XX_Count' ? observations.alb.target5xx
        : metric === 'HTTPCode_ELB_5XX_Count' ? observations.alb.elb5xx : observations.alb.requests;
      assert.equal(period, 60);
      return JSON.stringify({ Datapoints: values.map((value) => ({ Sum: value })) });
    }
    if (args[0] === 'cloudwatch' && args[1] === 'describe-alarms') {
      return JSON.stringify({ MetricAlarms: Object.entries(observations.alarms.states)
        .map(([name, state]) => ({ AlarmName: name, StateValue: state })) });
    }
    if (args[0] === 'ecs') {
      const sample = observations.ecs.samples[observations.ecs.samples.length - 1];
      return JSON.stringify({ services: [
        { serviceName: `${STAGE}-anywear-api`, runningCount: sample.api.running_count,
          desiredCount: sample.api.desired_count, deployments: Array.from({ length: sample.api.deployment_count },
            () => ({ rolloutState: sample.api.rollout_state })) },
        { serviceName: `${STAGE}-anywear-worker`, runningCount: sample.worker.running_count,
          desiredCount: sample.worker.desired_count, deployments: Array.from({ length: sample.worker.deployment_count },
            () => ({ rolloutState: sample.worker.rollout_state })) },
      ] });
    }
    if (args[0] === 'sqs') {
      const url = args[args.indexOf('--queue-url') + 1];
      const queue = url.slice(url.lastIndexOf('/') + 1).replace(`${STAGE}-anywear-`, '').replaceAll('-', '_');
      const sample = observations.sqs.samples[0];
      return JSON.stringify({ Attributes: sample.queues[queue] });
    }
    if (args[0] === 'logs') {
      return JSON.stringify({ events: observations.outbox.lines.map((line) => ({
        timestamp: line.at,
        message: JSON.stringify({ msg: 'Durable task outbox metrics', outboxOldestAgeMs: line.age, outboxBacklog: line.backlog }),
      })) });
    }
    throw new Error(`Unexpected AWS call ${args.slice(0, 3).join(' ')}`);
  };
}

function virtualClock(start = START - 30_000) {
  let time = start;
  return { now: () => time, sleep: async (milliseconds) => { time += milliseconds; } };
}

test('the live runner reads all six signals from the injected AWS surface', async () => {
  const clock = virtualClock();
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
    runAws: fixtureRunAws(),
  });
  assert.equal(gate.result, 'passed');
  assert.equal(gate.probe.probes_sent, 20);
  assert.equal(signalOf(gate, 'ecs_running_not_desired').reads[0].samples, 10);
  assert.equal(signalOf(gate, 'sqs_dlq_depth').reads[0].samples, 10);
  assert.equal(signalOf(gate, 'outbox_oldest_age').reads[0].samples, 5);
});

test('the live runner fails the gate on a seeded DLQ message and keeps the others healthy', async () => {
  const observations = baseObservations();
  observations.sqs.samples = observations.sqs.samples.map((sample) => ({
    ...sample,
    queues: { ...sample.queues, vto_dlq: { ApproximateNumberOfMessages: '1' } },
  }));
  const clock = virtualClock();
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: fixtureRunAws({ observations }),
  });
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'sqs_dlq_depth').state, 'breaching');
  for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES.filter((signal) => signal !== 'sqs_dlq_depth')) {
    assert.equal(signalOf(gate, name).state, 'not-breaching', `${name} must stay healthy`);
  }
});

test('the live runner waits for five RequestCount datapoints, not the first non-empty read', async () => {
  const clock = virtualClock();
  let requestReads = 0;
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: fixtureRunAws({
      onMetric: (metric) => {
        if (metric === 'TargetResponseTime') {
          return JSON.stringify({ Datapoints: [{ ExtendedStatistics: { p95: 0.12 } }] });
        }
        if (metric === 'ApproximateAgeOfOldestMessage') return JSON.stringify({ Datapoints: [{ Maximum: 0 }] });
        if (metric === 'RequestCount') {
          // One more minute of the window is visible on each retry: 1, 2, 3, 4, 5.
          requestReads += 1;
          return JSON.stringify({ Datapoints: Array.from({ length: Math.min(requestReads, 5) }, () => ({ Sum: 4 })) });
        }
        const values = metric === 'HTTPCode_Target_5XX_Count' || metric === 'HTTPCode_ELB_5XX_Count'
          ? Array(5).fill(0) : Array(5).fill(4);
        return JSON.stringify({ Datapoints: values.map((value) => ({ Sum: value })) });
      },
    }),
  });
  // Four datapoints were not a usable denominator: the runner took a fifth read,
  // and only that made it stop retrying and evaluate the window.
  assert.equal(requestReads, 5);
  assert.equal(gate.result, 'passed');
  assert.equal(signalOf(gate, 'alb_5xx_rate').reads[2].metric_name, 'RequestCount');
  assert.equal(signalOf(gate, 'alb_5xx_rate').reads[2].datapoints, 5);
  assert.equal(signalOf(gate, 'alb_5xx_rate').value.request_count, 20);
});

test('the live runner also reads the whole-window signals at --period 300 and the ALB counts at --period 60', async () => {
  const clock = virtualClock();
  const periods = [];
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: (args) => {
      if (args[0] === 'cloudwatch' && args[1] === 'get-metric-statistics') {
        periods.push([args[args.indexOf('--metric-name') + 1], Number(args[args.indexOf('--period') + 1])]);
      }
      return fixtureRunAws()(args);
    },
  });
  assert.equal(gate.result, 'passed');
  const expectedPeriod = (metric) => (metric === 'TargetResponseTime'
    || metric === 'ApproximateAgeOfOldestMessage' ? 300 : 60);
  for (const [metric, period] of periods) {
    assert.equal(period, expectedPeriod(metric), `${metric} is read at --period ${expectedPeriod(metric)}`);
  }
  assert.ok(periods.some(([metric]) => metric === 'TargetResponseTime'), 'the p95 read was requested');
  assert.ok(periods.filter(([metric]) => metric === 'ApproximateAgeOfOldestMessage').length >= 2,
    'both work-queue age reads were requested');
  assert.ok(periods.some(([metric, period]) => metric === 'RequestCount' && period === 60),
    'RequestCount keeps its one-minute periods');
  assert.equal(signalOf(gate, 'alb_p95_latency').reads[0].period_seconds, 300);
  const ageReads = signalOf(gate, 'sqs_oldest_message_age').reads
    .filter((read) => read.metric_name === 'ApproximateAgeOfOldestMessage');
  assert.equal(ageReads.length, 2);
  for (const read of ageReads) assert.equal(read.period_seconds, 300);
});

test('the live runner retries a lagging metric, then fails closed at its own deadline', async () => {
  const clock = virtualClock();
  const gate = await runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: QUEUE_URLS,
    logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: clock.now, sleep: clock.sleep,
    fetchImpl: async () => new Response('ok', { status: 200 }),
    runAws: fixtureRunAws({
      onMetric: (metric) => {
        if (metric === 'TargetResponseTime') return JSON.stringify({ Datapoints: [] });
        if (metric === 'ApproximateAgeOfOldestMessage') return JSON.stringify({ Datapoints: [{ Maximum: 0 }] });
        const values = metric === 'HTTPCode_Target_5XX_Count' || metric === 'HTTPCode_ELB_5XX_Count'
          ? Array(5).fill(0) : Array(5).fill(4);
        return JSON.stringify({ Datapoints: values.map((value) => ({ Sum: value })) });
      },
    }),
  });
  assert.equal(gate.result, 'failed');
  assert.equal(signalOf(gate, 'alb_p95_latency').state, 'insufficient');
  assert.match(signalOf(gate, 'alb_p95_latency').exceptions.join('; '), /of 1 period|not read/);
  for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES.filter((signal) => signal !== 'alb_p95_latency')) {
    assert.equal(signalOf(gate, name).state, 'not-breaching', `${name} must stay healthy`);
  }
  // The clock advanced through the whole ingestion budget, never a wall clock.
  assert.ok(clock.now() >= START + 300_000 + 180_000 - 1000);
});

test('an unreadable load balancer aborts before any signal is invented', async () => {
  await assert.rejects(runBakeGate({
    stage: STAGE, stack: 'AnyWearRuntimeStack-beta',
    apiBaseUrl: 'https://d111111abcdef8.cloudfront.net', cluster: CLUSTER,
    queueUrls: {}, logGroup: LOG_GROUP, serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST,
    now: () => START, sleep: async () => {}, fetchImpl: async () => new Response('ok'),
    runAws: () => { throw new Error('AccessDenied'); },
  }), /AccessDenied/);
});
