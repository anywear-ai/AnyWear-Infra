import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBetaState } from '../../scripts/lib/observe-beta-state.mjs';
import { runtimeStack } from '../../scripts/lib/one-writer.mjs';
import { sha256 } from '../../scripts/lib/json-contract.mjs';
import { DEPLOYMENT_SETTLE_SECONDS } from '../../scripts/lib/ecs-rollout.mjs';

const baseName = 'AnyWearPlatformStack-beta';
// Issue #316: the ECS block reads the cluster name through the same singular
// `ssm get-parameter` call the allowlist uses, so state adds no SSM action.
const CLUSTER_PARAMETER = '/anywear/beta/ecs_cluster_name';
const CLUSTER = 'beta-anywear';
// The incident's worker deployment, and a clock 250 s after it was created.
const CREATED_AT = '2026-11-15T14:53:12.000Z';
const READ_AT = Date.parse('2026-11-15T14:57:22.051Z');

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

function service(purpose, { rolloutState = 'COMPLETED', runningCount = 1, deployments } = {}) {
  return {
    serviceName: `beta-anywear-${purpose}`,
    status: 'ACTIVE',
    serviceArn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
    taskDefinition: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:7`,
    runningCount, desiredCount: 1,
    deployments: deployments ?? [{ id: `ecs-svc/${purpose}`, status: 'PRIMARY', rolloutState,
      rolloutStateReason: null, createdAt: CREATED_AT, updatedAt: CREATED_AT, runningCount, desiredCount: 1 }],
  };
}

// The read-only state operation must observe the stopped state without failing:
// Base is present and the Infra-owned Runtime stack is simply absent. The only
// admission value the observer reads is the tester allowlist; any other AWS call
// fails the test.
function stateIo({ runtime = undefined, runtimeError, allowlist = '[]', allowlistError,
  services = [service('api'), service('worker')], tasks = undefined, clusterValue = CLUSTER } = {}) {
  const calls = [];
  return {
    calls,
    now: () => READ_AT,
    async aws(args) {
      calls.push([...args]);
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        const name = args[args.length - 1];
        if (name === baseName) return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
        if (name === runtimeStack) {
          if (runtimeError) throw runtimeError;
          if (!runtime) throw stackAbsenceError(name);
          return { Stacks: [runtime] };
        }
        throw new Error(`Unexpected stack ${name}`);
      }
      if (args[0] === 'ssm' && args[1] === 'get-parameter') {
        const name = args[args.length - 1];
        if (name === CLUSTER_PARAMETER) return { Parameter: { Name: name, Value: clusterValue } };
        assert.equal(name, '/anywear/beta/tester_allowlist', 'the state observer reads only the allowlist and the cluster name');
        if (allowlistError) throw allowlistError;
        return { Parameter: { Name: name, Value: allowlist } };
      }
      if (args[0] === 'ecs' && args[1] === 'describe-services') {
        assert.equal(args[args.indexOf('--cluster') + 1], CLUSTER);
        return { services };
      }
      if (args[0] === 'ecs' && args[1] === 'list-tasks') {
        const desiredStatus = args[args.indexOf('--desired-status') + 1];
        assert.ok(['RUNNING', 'STOPPED'].includes(desiredStatus), desiredStatus);
        return { taskArns: tasks === undefined || desiredStatus === 'STOPPED' ? [] : tasks.map((task) => task.taskArn) };
      }
      if (args[0] === 'ecs' && args[1] === 'describe-tasks') {
        return { tasks };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
  };
}
const allowlistHash = emails => sha256(JSON.stringify(emails));
const runtimeFixture = () => ({
  StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE',
  Parameters: [
    { ParameterKey: 'ServiceImageDigest', ParameterValue: `sha256:${'a'.repeat(64)}` },
    { ParameterKey: 'ServiceCommitSha', ParameterValue: 'b'.repeat(40) },
    { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm' },
    { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-1234' },
    { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
  ],
});

test('read-only state observes the stopped state: Base present, Runtime absent, no throw', async () => {
  const io = stateIo({ allowlist: '["a@example.com"]' });
  const state = await observeBetaState(io);
  assert.deepEqual(state.stacks, [
    { stack_name: baseName, status: 'UPDATE_COMPLETE' },
    { stack_name: runtimeStack, status: 'ABSENT', runtime_exists: false },
  ]);
  assert.deepEqual(state.admission, { tester_count: 1, tester_allowlist_hash: allowlistHash(['a@example.com']) });
  assert.equal(state.qualification, 'not-applicable');
  assert.equal(Object.hasOwn(state, 'beta_sizing'), false);
  // Issue #316: a stopped Beta reads no ECS and no cluster name.
  assert.equal(Object.hasOwn(state, 'ecs'), false);
  assert.equal(io.calls.some((args) => args[0] === 'ecs'), false, 'no ECS read is attempted');
});

test('read-only state records a running Runtime and its sizing parameters', async () => {
  const state = await observeBetaState(stateIo({ runtime: runtimeFixture() }));
  assert.deepEqual(state.stacks[1], { stack_name: runtimeStack, status: 'UPDATE_COMPLETE', runtime_exists: true });
  assert.deepEqual(state.beta_sizing, {
    beta_api_sizing_profile: 's1', runtime_verification: 'not-applicable',
  });
});

test('read-only state prints the ECS block: verdict, primary id, counts and age per service', async () => {
  const io = stateIo({ runtime: runtimeFixture() });
  const state = await observeBetaState(io);
  assert.deepEqual(Object.keys(state.ecs), ['cluster', 'services']);
  assert.equal(state.ecs.cluster, CLUSTER);
  assert.deepEqual(state.ecs.services.map((row) => row.service_name), ['beta-anywear-api', 'beta-anywear-worker']);
  for (const [index, row] of state.ecs.services.entries()) {
    assert.equal(row.verdict, 'settled');
    assert.equal(row.condition, null);
    assert.equal(row.primary_deployment_id, `ecs-svc/${['api', 'worker'][index]}`);
    assert.equal(row.running_count, 1);
    assert.equal(row.desired_count, 1);
    assert.equal(row.rollout_age_seconds, 250);
    assert.equal(row.deployments.length, 1);
    assert.equal(Object.hasOwn(row, 'tasks'), false, 'a settled service carries no task attribution');
  }
  // Only the three reviewed ECS reads, and never a wait or a write.
  assert.deepEqual([...new Set(io.calls.filter((args) => args[0] === 'ecs').map((args) => args[1]))],
    ['describe-services']);
});

test('a merely-settling service is reported, not failed, and carries its bounded task evidence', async () => {
  const tasks = [{ taskArn: 'arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/abc', lastStatus: 'RUNNING',
    healthStatus: 'UNKNOWN', desiredStatus: 'RUNNING', containers: [{ name: 'worker', exitCode: null }] }];
  const state = await observeBetaState(stateIo({ runtime: runtimeFixture(),
    services: [service('api'), service('worker', { rolloutState: 'IN_PROGRESS' })], tasks }));
  const worker = state.ecs.services[1];
  assert.equal(worker.verdict, 'settling');
  assert.equal(worker.condition, 'deployment-in-progress');
  assert.equal(worker.rollout_age_seconds, 250);
  assert.equal(worker.tasks.length, 1);
  assert.equal(worker.tasks[0].last_status, 'RUNNING');
  assert.deepEqual(worker.tasks[0].containers, [{ name: 'worker', exit_code: null, reason: null }]);
  // The api service is settled and was not attributed.
  assert.equal(Object.hasOwn(state.ecs.services[0], 'tasks'), false);
});

test('the ECS block never fails the read for a shape it can classify', async () => {
  const state = await observeBetaState(stateIo({ runtime: runtimeFixture(),
    services: [service('api'), service('worker', { runningCount: 0 })] }));
  assert.equal(state.ecs.services[1].verdict, 'stalled');
  assert.equal(state.ecs.services[1].condition, 'running-not-desired');
  // A service the response does not list is reported unusable rather than thrown.
  const missing = await observeBetaState(stateIo({ runtime: runtimeFixture(), services: [service('api')] }));
  assert.equal(missing.ecs.services[1].verdict, 'unusable');
  assert.equal(missing.ecs.services[1].condition, 'service-not-active');
  assert.deepEqual(missing.ecs.services[1].deployments, []);
});

test('the settle window the block applies is the shared one, and an old deployment is stalled', async () => {
  const old = service('worker', { rolloutState: 'IN_PROGRESS',
    deployments: [{ id: 'ecs-svc/worker', status: 'PRIMARY', rolloutState: 'IN_PROGRESS',
      createdAt: new Date(READ_AT - (DEPLOYMENT_SETTLE_SECONDS + 1) * 1000).toISOString(), updatedAt: CREATED_AT,
      runningCount: 1, desiredCount: 1 }] });
  const state = await observeBetaState(stateIo({ runtime: runtimeFixture(), services: [service('api'), old] }));
  assert.equal(state.ecs.services[1].verdict, 'stalled');
  assert.equal(state.ecs.services[1].condition, 'rollout-stalled');
  assert.equal(state.ecs.services[1].rollout_age_seconds, DEPLOYMENT_SETTLE_SECONDS + 1);
});

test('read-only state still fails on a non-absence Runtime read failure', async () => {
  const throttle = Object.assign(new Error('aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
    { stderr: 'aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' });
  await assert.rejects(observeBetaState(stateIo({ runtimeError: throttle })), /Complete Beta state observation unavailable/);
});

test('an unreadable allowlist is reported as unavailable, never as an empty list', async () => {
  const error = await observeBetaState(stateIo({ allowlistError: new Error('AccessDenied') }))
    .then(() => undefined, (cause) => cause);
  assert.ok(error, 'the observation fails closed');
  assert.deepEqual(error.observedState.admission, { tester_count: 'unavailable', tester_allowlist_hash: 'unavailable' });
});

test('an unexpected AWS call still throws instead of being absorbed', async () => {
  await assert.rejects(observeBetaState(stateIo({ runtime: runtimeFixture(), clusterValue: 'not a cluster name' })),
    /Complete Beta state observation unavailable/);
});
