import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_GATE_COMPARISONS,
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_SIGNAL_NAMES,
  DEPLOYMENT_GATE_THRESHOLDS,
  deploymentAlarmName,
  deploymentAlarmNames,
  deploymentBakeName,
  deploymentQueueNames,
  runtimeStageFromStack,
  WORKER_ALARM_THRESHOLDS,
} from '../../lib/contracts.mjs';

// Issue #207 retired the record-gate block validator, so this file now owns only
// the stage-free bake-control surface the contract still ships: the 300-second
// window, the probe budget, the six fixed ordered signal names, the one threshold
// table and the name builders. A breached or short signal is refused by the bake
// itself in AnyWear-Infra's `scripts/bake-gate.mjs`; its test file owns that
// behavioural coverage.
test('the threshold table and comparison strings are stage-free; only names carry the stage', () => {
  assert.equal(DEPLOYMENT_GATE_DURATION_SECONDS, 300);
  assert.equal(DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS, 15);
  assert.equal(DEPLOYMENT_GATE_REQUEST_FLOOR, 15);
  assert.equal(DEPLOYMENT_GATE_MAX_PROBES, 20);
  assert.deepEqual([...DEPLOYMENT_GATE_SIGNAL_NAMES], [
    'alb_5xx_rate', 'alb_p95_latency', 'ecs_running_not_desired',
    'sqs_oldest_message_age', 'sqs_dlq_depth', 'outbox_oldest_age',
  ]);
  assert.deepEqual(Object.keys(DEPLOYMENT_GATE_THRESHOLDS).sort(), [...DEPLOYMENT_GATE_SIGNAL_NAMES].sort());
  assert.equal(DEPLOYMENT_GATE_THRESHOLDS.sqs_oldest_message_age.max_seconds, 150);
  assert.equal(DEPLOYMENT_GATE_THRESHOLDS.outbox_oldest_age.max_age_milliseconds, 150_000);
  const serialized = JSON.stringify(DEPLOYMENT_GATE_THRESHOLDS);
  for (const stage of ['beta', 'prod']) {
    assert.equal(serialized.includes(stage), false);
    for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES) assert.equal(DEPLOYMENT_GATE_THRESHOLDS[name][stage], undefined);
  }
  assert.deepEqual(DEPLOYMENT_GATE_COMPARISONS, {
    alb_5xx_rate: 'sum(target_5xx, elb_5xx) > max_5xx; request_count < min_requests is insufficient',
    alb_p95_latency: 'p95_milliseconds > max_milliseconds',
    ecs_running_not_desired: 'longest_gap_seconds >= max_gap_seconds; a non-single or non-COMPLETED deployment is breaching',
    sqs_oldest_message_age: 'max(vto_seconds, auto_tagging_seconds) > max_seconds',
    sqs_dlq_depth: 'vto_depth + auto_tagging_depth > max_depth',
    outbox_oldest_age: 'oldest_age_milliseconds > max_age_milliseconds; backlog > 0 with a null age is breaching',
  });
  const beta = deploymentAlarmNames('beta');
  const prod = deploymentAlarmNames('prod');
  assert.deepEqual(Object.keys(beta), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
  for (const name of DEPLOYMENT_GATE_SIGNAL_NAMES) {
    assert.deepEqual(prod[name], beta[name].map((alarm) => alarm.replace(/^beta-/, 'prod-')));
  }
  assert.deepEqual(beta.alb_5xx_rate, ['beta-anywear-alb-5xx']);
  assert.deepEqual(beta.sqs_dlq_depth, ['beta-anywear-vto-dlq-not-empty', 'beta-anywear-auto-tagging-dlq-not-empty']);
  assert.deepEqual(deploymentQueueNames('beta'), {
    vto: 'beta-anywear-vto',
    vto_dlq: 'beta-anywear-vto-dlq',
    auto_tagging: 'beta-anywear-auto-tagging',
    auto_tagging_dlq: 'beta-anywear-auto-tagging-dlq',
  });
  assert.equal(deploymentBakeName('beta'), 'beta-anywear-deployment-bake');
  assert.throws(() => deploymentAlarmName('beta', 'nope'), /Unknown deployment gate signal/);
  assert.throws(() => deploymentBakeName('Beta'), /Invalid deployment stage/);
  assert.equal(runtimeStageFromStack('AnyWearRuntimeStack-prod'), 'prod');
  assert.throws(() => runtimeStageFromStack('AnyWearPlatformStack-beta'), /Invalid Runtime stack identity/);
});

// Issue #321: the worker's standing-state alarms are worker alarms, not bake
// signals. They are named by the same builder so a deployed alarm and the code
// that reads it cannot disagree, and they are deliberately absent from the six
// gate signals and their comparisons: the 300-second bake cannot observe an
// hours-long failure and must not fail every deploy on standing debt.
test('the worker alarm thresholds and their deployed names are the reviewed stage-free pair', () => {
  assert.deepEqual(Object.keys(WORKER_ALARM_THRESHOLDS), [
    'object_deletion_abandoned', 'object_deletion_reaper_tick',
  ]);
  assert.deepEqual(WORKER_ALARM_THRESHOLDS.object_deletion_abandoned, {
    metric: 'ObjectDeletionAbandonedCount',
    statistic: 'Maximum',
    period_seconds: 60,
    evaluation_periods: 2,
    threshold: 0,
    comparison: 'greater_than_threshold',
    treat_missing_data: 'notBreaching',
  });
  assert.deepEqual(WORKER_ALARM_THRESHOLDS.object_deletion_reaper_tick, {
    metric: 'ObjectDeletionReaperTick',
    statistic: 'Sum',
    period_seconds: 300,
    evaluation_periods: 2,
    threshold: 1,
    comparison: 'less_than_threshold',
    treat_missing_data: 'breaching',
  });
  for (const threshold of Object.values(WORKER_ALARM_THRESHOLDS)) {
    assert.ok(Object.isFrozen(threshold));
    assert.equal(JSON.stringify(threshold).includes('beta'), false);
    assert.equal(JSON.stringify(threshold).includes('prod'), false);
  }
  assert.ok(Object.isFrozen(WORKER_ALARM_THRESHOLDS));
  assert.deepEqual(deploymentAlarmName('beta', 'object_deletion_abandoned'), ['beta-anywear-object-deletion-abandoned']);
  assert.deepEqual(deploymentAlarmName('beta', 'object_deletion_reaper_tick'), ['beta-anywear-object-deletion-reaper-tick']);
  assert.deepEqual(deploymentAlarmName('prod', 'object_deletion_reaper_tick'), ['prod-anywear-object-deletion-reaper-tick']);
  assert.throws(() => deploymentAlarmName('Beta', 'object_deletion_abandoned'), /Invalid deployment stage/);
  // The worker alarms are not gate signals: the six-name list, the gate threshold
  // table and the six alarm names keep exactly their old surface.
  for (const name of Object.keys(WORKER_ALARM_THRESHOLDS)) {
    assert.equal(DEPLOYMENT_GATE_SIGNAL_NAMES.includes(name), false, name);
    assert.equal(Object.hasOwn(DEPLOYMENT_GATE_THRESHOLDS, name), false, name);
    assert.equal(Object.hasOwn(DEPLOYMENT_GATE_COMPARISONS, name), false, name);
  }
  assert.deepEqual(Object.keys(deploymentAlarmNames('beta')), [...DEPLOYMENT_GATE_SIGNAL_NAMES]);
});
