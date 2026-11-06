import test from 'node:test';
import assert from 'node:assert/strict';
import { readLifecycleStatus, parseLifecycleStatus } from '../../scripts/lib/lifecycle-status.mjs';

const definition = { taskDefinitionArn: 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-lifecycle:8',
  family: 'beta-anywear-lifecycle', containerDefinitions: [{ name: 'OneShot',
    command: ['node', 'dist/ops/beta-lifecycle.js', 'status'],
    logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/anywear/beta/one-shot',
      'awslogs-region': 'ap-east-1', 'awslogs-stream-prefix': 'beta-anywear-lifecycle' } } }] };
const task = { taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
  clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
  taskDefinitionArn: definition.taskDefinitionArn, lastStatus: 'STOPPED' };
// The #213 Service-Infra status contract: `action` identifies the object, the
// count and the 64-hex allowlist hash are required, and backlog fields ride along.
const hash = 'a'.repeat(64);
const status = { action: 'status', tester_count: 4, tester_allowlist_hash: hash, tasks: 3, outbox: 2,
  outboxStatusCounts: { pending: 1, sent: 2 },
  queues: { vto: { visible: 1, notVisible: 0, delayed: 0 }, tagging: { visible: 0, notVisible: 1, delayed: 2 } } };
function logIo(messages) {
  const calls = [];
  return { calls, async aws(args) {
    calls.push(args);
    return { events: args.includes('--next-token') ? [] : messages.map(message => ({ message })), nextForwardToken: 'end' };
  }, async sleep() {} };
}

test('lifecycle status reads only the actual stopped task log stream, across complete pages', async () => {
  const io = logIo(['Ordinary unrelated log', '{"debug":{"tester_count":2}}', JSON.stringify(status)]);
  assert.deepEqual(await readLifecycleStatus(io, task, definition), status);
  assert.equal(io.calls.length, 4);
  assert.equal(io.calls[0][io.calls[0].indexOf('--log-stream-name') + 1], `beta-anywear-lifecycle/OneShot/${'a'.repeat(32)}`);
  assert.ok(io.calls.every(args => args[0] === 'logs' && args[1] === 'get-log-events'));
});

test('the status selector identifies the object by its action and required allowlist fields', async () => {
  assert.deepEqual(parseLifecycleStatus({ action: 'status', tester_count: 0, tester_allowlist_hash: hash }),
    { action: 'status', tester_count: 0, tester_allowlist_hash: hash });
  // The set-testers line shares the field names but is not status evidence.
  const setLine = { action: 'set-testers', tester_count: 4, tester_allowlist_hash: hash };
  await assert.rejects(readLifecycleStatus(logIo([JSON.stringify(setLine)]), task, definition),
    /status evidence is unavailable/);
});

test('missing, duplicate, malformed and incomplete status logs fail closed', async () => {
  for (const messages of [[], [JSON.stringify(status), JSON.stringify(status)],
    // An apparent status that cannot be parsed fails closed rather than being
    // skipped: the identifying `action` member appears before the truncation.
    [`{"action":"status","tester_count":4,"tester_allowlist_hash":"${'a'.repeat(64)}`],
    // A status without the required fields is malformed, not a status to ignore.
    ['{"action":"status","tester_count":4}'],
    ['{"action":"status","tester_allowlist_hash":"' + hash + '"}'],
    [`{"action":"status","tester_count":51,"tester_allowlist_hash":"${hash}"}`],
    [`{"action":"status","tester_count":4.5,"tester_allowlist_hash":"${hash}"}`],
    ['{"action":"status","tester_count":4,"tester_allowlist_hash":"ABCDEF"}'],
    // A line without the identifying action is not status evidence.
    ['{"previous_mode":"closed"}'],
    ['{"tester_count":4}']]) {
    await assert.rejects(readLifecycleStatus(logIo(messages), task, definition));
  }
  for (const response of [{}, { events: [], nextForwardToken: '' }, { events: [{ message: 3 }], nextForwardToken: 'end' }]) {
    await assert.rejects(readLifecycleStatus({ async aws() { return response; } }, task, definition));
  }
  await assert.rejects(readLifecycleStatus({ async aws() { throw new Error('Logs unavailable'); } }, task, definition), /Logs unavailable/);
});

test('optional backlog fields are validated when present', () => {
  for (const invalid of [{ tasks: -1 }, { outboxOldestAgeMs: -1 }, { outboxOldestAgeMs: 'old' },
    { outboxStatusCounts: [] }, { queues: { vto: {} } }, { dlqs: { tagging: { visible: 1.5, notVisible: 0, delayed: 0 } } }]) {
    assert.throws(() => parseLifecycleStatus({ action: 'status', tester_count: 1, tester_allowlist_hash: hash, ...invalid }),
      /Invalid lifecycle/);
  }
});

test('eventually visible status requires matching full scans and rejects a delayed duplicate', async () => {
  for (const duplicate of [false, true]) {
    let scan = 0;
    const io = { async aws(args) {
      if (args.includes('--next-token')) return { events: [], nextForwardToken: 'end' };
      scan++;
      const messages = scan === 1 ? [] : duplicate && scan >= 3 ? [status, status] : [status];
      return { events: messages.map(value => ({ message: JSON.stringify(value) })), nextForwardToken: 'end' };
    }, async sleep() {} };
    if (duplicate) await assert.rejects(readLifecycleStatus(io, task, definition), /ambiguous/);
    else assert.deepEqual(await readLifecycleStatus(io, task, definition), status);
  }
});

test('foreign or running lifecycle task, command or log destination performs no log read', async () => {
  for (const [actualTask, actualDefinition] of [
    [{ ...task, lastStatus: 'RUNNING' }, definition],
    [{ ...task, clusterArn: 'foreign' }, definition],
    [task, { ...definition, taskDefinitionArn: 'foreign' }],
    [task, { ...definition, family: 'other' }],
    [task, { ...definition, containerDefinitions: [{ ...definition.containerDefinitions[0], command: ['node', 'other.js'] }] }],
    [task, { ...definition, containerDefinitions: [{ ...definition.containerDefinitions[0], logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/foreign' } } }] }],
  ]) {
    const io = logIo([JSON.stringify(status)]);
    await assert.rejects(readLifecycleStatus(io, actualTask, actualDefinition));
    assert.equal(io.calls.length, 0);
  }
});

test('pagination cycles and unbounded status inventories are rejected', async () => {
  let calls = 0;
  await assert.rejects(readLifecycleStatus({ async aws() {
    return { events: [], nextForwardToken: ++calls % 2 ? 'one' : 'two' };
  } }, task, definition), /did not complete/);
  await assert.rejects(readLifecycleStatus({ async aws() {
    return { events: Array(1001).fill({ message: 'x' }), nextForwardToken: 'end' };
  } }, task, definition), /malformed/);
});
