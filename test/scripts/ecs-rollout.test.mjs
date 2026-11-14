import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedServiceEvents, DEPLOYMENT_EVENT_LIMIT, DEPLOYMENT_READ_SEQUENCE_LIMIT, DEPLOYMENT_REFUSAL_LIMIT_BYTES,
  DEPLOYMENT_SETTLE_MAX_READS, DEPLOYMENT_SETTLE_POLL_SECONDS, DEPLOYMENT_SETTLE_SECONDS, DEPLOYMENT_TASK_LIMIT,
  deploymentAgeSeconds, ecsServiceObservation, ecsTaskObservation, isRefusal, observedAt, readServiceTasks,
  REFUSING_VERDICTS, refusalEvidence, refusalLine, rolloutRefusalMessage, ROLLOUT_CONDITIONS, ROLLOUT_VERDICTS,
  rolloutVerdict,
} from '../../scripts/lib/ecs-rollout.mjs';

// Issue #316: the incident's own timings. Worker deployment `ecs-svc/0322933281545872705`
// was created at 14:53:12Z, the gate read once at 14:56:59Z and threw, and ECS wrote
// `COMPLETED` at 14:57:22.051Z.
const CREATED_AT = '2026-11-15T14:53:12.000Z';
const FIRST_READ_MS = Date.parse('2026-11-15T14:56:59.000Z');
const COMPLETED_MS = Date.parse('2026-11-15T14:57:22.051Z');
const INCIDENT_READS_MS = [FIRST_READ_MS, FIRST_READ_MS + 15_000, FIRST_READ_MS + 30_000];

function rawService({ rolloutState = 'COMPLETED', createdAt = CREATED_AT, runningCount = 1, desiredCount = 1,
  status = 'ACTIVE', deployments, ...rest } = {}) {
  return {
    serviceName: 'beta-anywear-worker', status, serviceArn: 'arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-worker',
    taskDefinition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:134',
    runningCount, desiredCount, pendingCount: 0, failedTasks: 0,
    deployments: deployments ?? [{ id: 'ecs-svc/0322933281545872705', status: 'PRIMARY', rolloutState, createdAt,
      updatedAt: createdAt, runningCount, desiredCount, pendingCount: 0, failedTasks: 0 }],
    ...rest,
  };
}

const observe = (options) => ecsServiceObservation(rawService(options));
const verdictOf = (options, extra) => rolloutVerdict(observe(options), { nowMs: FIRST_READ_MS, ...extra });

test('the settle window and its poll interval are the reviewed values, and the read bound follows from them', () => {
  assert.equal(DEPLOYMENT_SETTLE_SECONDS, 600);
  assert.equal(DEPLOYMENT_SETTLE_POLL_SECONDS, 15);
  // 600 / 15 + 1 = 41: the read at `createdAt + 600 s` is inclusive.
  assert.equal(DEPLOYMENT_SETTLE_MAX_READS, 41);
  assert.equal(DEPLOYMENT_SETTLE_MAX_READS, DEPLOYMENT_SETTLE_SECONDS / DEPLOYMENT_SETTLE_POLL_SECONDS + 1);
  assert.deepEqual([...ROLLOUT_VERDICTS], ['settled', 'settling', 'stalled', 'failed', 'foreign', 'unusable']);
  assert.deepEqual([...REFUSING_VERDICTS], ['stalled', 'failed', 'foreign', 'unusable']);
  // Every condition the predicate can return is in the published vocabulary.
  assert.equal(ROLLOUT_CONDITIONS.length, 8);
  assert.equal(DEPLOYMENT_EVENT_LIMIT, 10);
  assert.equal(DEPLOYMENT_TASK_LIMIT, 10);
  assert.equal(DEPLOYMENT_READ_SEQUENCE_LIMIT, 10);
  assert.equal(DEPLOYMENT_REFUSAL_LIMIT_BYTES, 8192);
});

test('the verdict reports the two halves separately and derives one observation shape', () => {
  const settled = observe();
  assert.equal(settled.deployment_count, 1);
  assert.equal(settled.rollout_state, 'COMPLETED');
  assert.equal(settled.primary_deployment_id, 'ecs-svc/0322933281545872705');
  assert.equal(settled.newest_deployment_created_at, CREATED_AT);
  const verdict = rolloutVerdict(settled, { nowMs: FIRST_READ_MS });
  assert.deepEqual(Object.keys(verdict).sort(), ['baseline_deployment_ids', 'condition', 'count',
    'deployment', 'observed_deployment_ids', 'service_name', 'verdict']);
  assert.equal(verdict.deployment.settled, true);
  assert.equal(verdict.deployment.condition, null);
  assert.equal(verdict.deployment.age_seconds, 250 - 23);
  assert.equal(verdict.count.settled, true);
  assert.equal(verdict.count.running_count, 1);
  assert.equal(verdict.count.desired_count, 1);
});

test('the incident\'s own timings settle inside the window instead of refusing', () => {
  // The rollout is `IN_PROGRESS` on the first two reads and `COMPLETED` from the
  // third, because ECS wrote the deployment's completion between them. The gate
  // that failed run 43606836697 read once, at the first of these instants.
  const verdicts = INCIDENT_READS_MS.map((nowMs, index) => rolloutVerdict(observe({
    rolloutState: nowMs >= COMPLETED_MS ? 'COMPLETED' : 'IN_PROGRESS' }), { nowMs }));
  assert.deepEqual(verdicts.map((verdict) => verdict.verdict), ['settling', 'settling', 'settled']);
  assert.deepEqual(verdicts.map((verdict) => verdict.condition),
    ['deployment-in-progress', 'deployment-in-progress', null]);
  // ECS wrote `COMPLETED` 250.051 s after the deployment was created, and the read
  // that first saw it came 7 s later. Both are inside the 600 s window.
  const settleSeconds = (COMPLETED_MS - Date.parse(CREATED_AT)) / 1000;
  assert.equal(settleSeconds.toFixed(3), '250.051');
  assert.equal(verdicts[2].deployment.age_seconds, 257);
  assert.ok(settleSeconds < DEPLOYMENT_SETTLE_SECONDS);
});

test('the window boundary is exact: 600 s is still settling, 601 s is stalled', () => {
  const createdMs = Date.parse(CREATED_AT);
  const inProgress = { rolloutState: 'IN_PROGRESS' };
  assert.equal(rolloutVerdict(observe(inProgress), { nowMs: createdMs + 600_000 }).verdict, 'settling',
    'the read at createdAt + 600 s is inside the window');
  assert.equal(rolloutVerdict(observe(inProgress), { nowMs: createdMs + 601_000 }).verdict, 'stalled');
  assert.equal(rolloutVerdict(observe(inProgress), { nowMs: createdMs + 601_000 }).condition, 'rollout-stalled');
  // Exactly one proof fits in 41 reads at the recorded cadence.
  assert.equal(DEPLOYMENT_SETTLE_SECONDS * 1000 / (DEPLOYMENT_SETTLE_POLL_SECONDS * 1000), 40);
});

test('a deployment with no readable createdAt is unusable, never waited on', () => {
  for (const createdAt of [undefined, null, '', 'not-a-date']) {
    const verdict = verdictOf({ deployments: [{ id: 'ecs-svc/1', status: 'PRIMARY', rolloutState: 'IN_PROGRESS', createdAt }] });
    assert.equal(verdict.verdict, 'unusable', String(createdAt));
    assert.equal(verdict.condition, 'deployment-age-unknown');
    assert.equal(verdict.deployment.age_seconds, null);
  }
  // An age the clock cannot have seen is equally unknown: the window is never
  // applied to a `createdAt` after the read.
  assert.equal(rolloutVerdict(observe({ rolloutState: 'IN_PROGRESS' }), { nowMs: Date.parse(CREATED_AT) - 1000 }).verdict, 'unusable');
  assert.equal(deploymentAgeSeconds(CREATED_AT, Date.parse(CREATED_AT) + 90_500), 90);
  assert.equal(deploymentAgeSeconds(CREATED_AT, undefined), undefined);
});

test('a FAILED rollout is refused at any age, however young', () => {
  const createdMs = Date.parse(CREATED_AT);
  for (const nowMs of [createdMs, createdMs + 1_000, createdMs + 3_600_000]) {
    const verdict = rolloutVerdict(observe({ rolloutState: 'FAILED' }), { nowMs });
    assert.equal(verdict.verdict, 'failed');
    assert.equal(verdict.condition, 'rollout-failed');
  }
});

test('two listed deployments are settling inside the window and stalled after it', () => {
  const two = { deployments: [
    { id: 'ecs-svc/old', status: 'ACTIVE', rolloutState: 'COMPLETED', createdAt: '2026-11-15T14:50:00.000Z' },
    { id: 'ecs-svc/new', status: 'PRIMARY', rolloutState: 'IN_PROGRESS', createdAt: CREATED_AT },
  ] };
  assert.equal(verdictOf(two).verdict, 'settling');
  assert.equal(verdictOf(two).condition, 'deployment-shape');
  assert.deepEqual(verdictOf(two).observed_deployment_ids, ['ecs-svc/old', 'ecs-svc/new']);
  assert.equal(verdictOf(two, { nowMs: Date.parse(CREATED_AT) + 601_000 }).verdict, 'stalled');
  // A service that lists no deployment at all is not a rollout.
  assert.equal(verdictOf({ deployments: [] }).verdict, 'unusable');
  assert.equal(verdictOf({ deployments: [] }).condition, 'no-deployment');
});

test('a service that is not ACTIVE and at a task definition is unusable', () => {
  for (const options of [{ status: 'DRAINING' }, { status: 'INACTIVE' }, { taskDefinition: undefined }]) {
    assert.equal(verdictOf(options).verdict, 'unusable', JSON.stringify(options));
    assert.equal(verdictOf(options).condition, 'service-not-active');
  }
});

test('the baseline is the bake\'s argument: a foreign PRIMARY id is refused, the settled id is not', () => {
  const baseline = ['ecs-svc/0322933281545872705'];
  assert.equal(verdictOf({}, { baselineDeploymentIds: baseline }).verdict, 'settled');
  const foreign = verdictOf({}, { baselineDeploymentIds: ['ecs-svc/1164516558847022624'] });
  assert.equal(foreign.verdict, 'foreign');
  assert.equal(foreign.condition, 'deployment-shape');
  assert.deepEqual(foreign.baseline_deployment_ids, ['ecs-svc/1164516558847022624']);
  assert.deepEqual(foreign.observed_deployment_ids, baseline);
  // No baseline (or an empty one) means "no comparison", not "everything is foreign".
  assert.equal(verdictOf({}).verdict, 'settled');
  assert.equal(verdictOf({}, { baselineDeploymentIds: [] }).verdict, 'settled');
});

test('the count half is separate: a completed rollout below its desired count refuses now', () => {
  const below = verdictOf({ runningCount: 0 });
  assert.equal(below.verdict, 'stalled');
  assert.equal(below.condition, 'running-not-desired');
  assert.equal(below.deployment.settled, true, 'the deployment half is settled; only the count half is not');
  assert.deepEqual(below.count, { settled: false, running_count: 0, desired_count: 1, pending_count: 0 });
  // Above the desired count is not a mismatch the composite waits out either: the
  // proof waits on the composite, so the replacement overlap is judged by shape.
  assert.equal(verdictOf({ runningCount: 2 }).verdict, 'stalled');
  assert.equal(verdictOf({ runningCount: 2 }).condition, 'running-not-desired');
  // isRefusal is the one rule both readers use to stop waiting.
  for (const verdict of [below, verdictOf({ rolloutState: 'FAILED' }), verdictOf({ deployments: [] })]) {
    assert.equal(isRefusal(verdict), true, verdict.verdict);
  }
  assert.equal(isRefusal(verdictOf({ rolloutState: 'IN_PROGRESS' })), false);
  assert.equal(isRefusal(verdictOf({})), false);
});

test('each condition has exactly one refusal sentence that repeats condition, service and ids', () => {
  const serviceName = 'beta-anywear-worker';
  const deployments = [{ id: 'ecs-svc/0322933281545872705', rollout_state: 'IN_PROGRESS' }];
  const expected = {
    'service-not-active': 'is not usable',
    'no-deployment': 'has no deployment',
    'deployment-shape': 'does not have exactly one deployment',
    'rollout-failed': 'has a failed rollout',
    'deployment-age-unknown': 'has a deployment of unknown age',
    'rollout-stalled': 'has not completed its rollout',
    'deployment-in-progress': 'has not completed its rollout',
    'running-not-desired': 'is not at its desired count',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...ROLLOUT_CONDITIONS].sort());
  for (const [condition, phrase] of Object.entries(expected)) {
    const message = rolloutRefusalMessage({ serviceName, condition, deployments, readAtMs: FIRST_READ_MS, ageSeconds: 250 });
    assert.match(message, new RegExp(`The Runtime ECS service ${serviceName} ${phrase}`), condition);
    assert.match(message, new RegExp(`condition ${condition}`), condition);
    assert.match(message, /deployments ecs-svc\/0322933281545872705:IN_PROGRESS/, condition);
    assert.match(message, /read_at 2026-11-15T14:56:59\.000Z/, condition);
  }
  assert.throws(() => rolloutRefusalMessage({ serviceName, condition: 'invented' }), /Unknown ECS rollout condition/);
});

test('a refusal line carries its members and stays inside every recorded cap', () => {
  const deployments = observe({ rolloutState: 'IN_PROGRESS' }).deployments;
  const readSequence = Array.from({ length: 3 }, (_, index) => ({ read_at: observedAt(FIRST_READ_MS + index * 15_000),
    verdict: 'settling', primary_deployment_id: deployments[0].id, rollout_states: { 'beta-anywear-worker': 'IN_PROGRESS' } }));
  const evidence = refusalEvidence({ serviceName: 'beta-anywear-worker', condition: 'rollout-stalled',
    verdict: verdictOf({ rolloutState: 'IN_PROGRESS' }), readAtMs: FIRST_READ_MS, pollCount: 3,
    deployments, events: [{ at: CREATED_AT, message: 'service reached a steady state' }],
    tasks: [], readSequence });
  assert.equal(evidence.gate, 'beta-anywear-ecs-steady-state-unmet');
  assert.equal(evidence.result, 'unmet');
  assert.equal(evidence.window_seconds, DEPLOYMENT_SETTLE_SECONDS);
  assert.equal(evidence.read_at, observedAt(FIRST_READ_MS));
  assert.equal(evidence.poll_count, 3);
  assert.equal(evidence.service, 'beta-anywear-worker');
  assert.equal(evidence.condition, 'rollout-stalled');
  assert.equal(evidence.rollout_age_seconds, 227);
  assert.deepEqual(Object.keys(evidence.deployments[0]), ['id', 'status', 'rollout_state', 'rollout_state_reason',
    'created_at', 'updated_at', 'task_definition', 'running_count', 'desired_count', 'pending_count', 'failed_tasks']);
  assert.equal(evidence.deployments[0].id, 'ecs-svc/0322933281545872705');
  assert.equal(evidence.deployments[0].rollout_state, 'IN_PROGRESS');
  assert.equal(JSON.parse(refusalLine(evidence)).gate, 'beta-anywear-ecs-steady-state-unmet');
});

test('a worst-case refusal is trimmed to the 8 KiB line and keeps the condition and ids', () => {
  const longText = 'x'.repeat(400);
  const deployments = Array.from({ length: 2 }, (_, index) => ({ id: `ecs-svc/${index}`, status: 'PRIMARY',
    rollout_state: 'IN_PROGRESS', rollout_state_reason: longText, created_at: CREATED_AT, updated_at: CREATED_AT,
    task_definition: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-worker:134',
    running_count: 1, desired_count: 1, pending_count: 0, failed_tasks: 0 }));
  const tasks = Array.from({ length: DEPLOYMENT_TASK_LIMIT * 2 }, (_, index) => ecsTaskObservation({
    taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${index}`, lastStatus: index % 2 ? 'STOPPED' : 'RUNNING',
    healthStatus: 'UNKNOWN', desiredStatus: index % 2 ? 'STOPPED' : 'RUNNING', stoppedReason: longText,
    stoppedAt: CREATED_AT, containers: [{ name: 'worker', exitCode: 137, reason: longText }] }));
  const events = Array.from({ length: DEPLOYMENT_EVENT_LIMIT }, () => ({ at: CREATED_AT, message: longText }));
  const readSequence = Array.from({ length: DEPLOYMENT_READ_SEQUENCE_LIMIT }, (_, index) => ({ read_at: observedAt(FIRST_READ_MS + index * 15_000),
    verdict: 'settling', primary_deployment_id: 'ecs-svc/0', rollout_states: { 'beta-anywear-api': 'IN_PROGRESS', 'beta-anywear-worker': 'IN_PROGRESS' } }));
  const line = refusalLine(refusalEvidence({ serviceName: 'beta-anywear-worker', condition: 'rollout-stalled',
    verdict: verdictOf({ rolloutState: 'IN_PROGRESS' }), readAtMs: FIRST_READ_MS, pollCount: 41,
    deployments, events, tasks, readSequence }));
  assert.ok(Buffer.byteLength(line, 'utf8') <= DEPLOYMENT_REFUSAL_LIMIT_BYTES,
    `the refusal line is ${Buffer.byteLength(line, 'utf8')} bytes`);
  const parsed = JSON.parse(line);
  // The trimming drops the redundant read rows first; the decidable part survives.
  assert.equal(parsed.gate, 'beta-anywear-ecs-steady-state-unmet');
  assert.equal(parsed.condition, 'rollout-stalled');
  assert.equal(parsed.poll_count, 41);
  assert.equal(parsed.service, 'beta-anywear-worker');
  assert.deepEqual(parsed.deployments.map((row) => row.id), ['ecs-svc/0', 'ecs-svc/1']);
  assert.ok(parsed.read_sequence.length <= DEPLOYMENT_READ_SEQUENCE_LIMIT);
  assert.ok(parsed.events.length <= DEPLOYMENT_EVENT_LIMIT);
  assert.ok(parsed.tasks.length <= DEPLOYMENT_TASK_LIMIT * 2);
  assert.ok(parsed.tasks.length >= 1, 'the last task row is kept');
});

test('the service events keep the newest DEPLOYMENT_EVENT_LIMIT rows and only their at/message', () => {
  const events = Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, createdAt: `2026-11-15T14:5${index % 10}:00.000Z`,
    message: `event ${index}` }));
  const kept = boundedServiceEvents({ events });
  assert.equal(kept.length, DEPLOYMENT_EVENT_LIMIT);
  assert.deepEqual(Object.keys(kept[0]), ['at', 'message']);
  assert.equal(kept[0].message, 'event 0', 'ECS returns the newest first; the line keeps that order');
  assert.deepEqual(boundedServiceEvents(undefined), []);
});

test('the task attribution reads both desired statuses, bounded, through the caller\'s read runner', async () => {
  const calls = [];
  const aws = async (args) => {
    calls.push(args);
    if (args[1] === 'list-tasks') {
      return { taskArns: Array.from({ length: 14 }, (_, index) => `arn:aws:ecs:ap-east-1:650880818323:task/${args[4]}/${index}`) };
    }
    const arns = args.slice(args.indexOf('--tasks') + 1);
    return { tasks: arns.map((arn) => ({ taskArn: arn, lastStatus: 'RUNNING', healthStatus: 'UNKNOWN',
      desiredStatus: 'RUNNING', containers: [{ name: 'worker', exitCode: 0 }] })) };
  };
  const tasks = await readServiceTasks(aws, 'beta-anywear', 'beta-anywear-worker');
  assert.deepEqual(calls.filter((args) => args[1] === 'list-tasks')
    .map((args) => args[args.indexOf('--desired-status') + 1]), ['RUNNING', 'STOPPED']);
  // At most 10 RUNNING plus 10 STOPPED, each described in one bounded read.
  assert.equal(calls.filter((args) => args[1] === 'describe-tasks').length, 2);
  assert.equal(calls[1].length, calls[1].indexOf('--tasks') + 11);
  assert.equal(tasks.length, DEPLOYMENT_TASK_LIMIT * 2);
  assert.deepEqual(Object.keys(tasks[0]), ['task_arn', 'last_status', 'health_status', 'desired_status',
    'stopped_reason', 'stopped_at', 'containers']);
  assert.deepEqual(tasks[0].containers, [{ name: 'worker', exit_code: 0, reason: null }]);
  // A service with no tasks performs no describe-tasks read at all.
  calls.length = 0;
  assert.deepEqual(await readServiceTasks(async (args) => { calls.push(args); return { taskArns: [] }; }, 'beta-anywear', 'x'), []);
  assert.equal(calls.every((args) => args[1] === 'list-tasks'), true);
});
