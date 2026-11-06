import test from 'node:test';
import assert from 'node:assert/strict';
import { observeBetaState } from '../../scripts/lib/observe-beta-state.mjs';
import { runtimeStack } from '../../scripts/lib/one-writer.mjs';
import { sha256 } from '../../scripts/lib/json-contract.mjs';

const baseName = 'AnyWearPlatformStack-beta';

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

// The read-only state operation must observe the stopped state without failing:
// Base is present and the Infra-owned Runtime stack is simply absent. The only
// admission value the observer reads is the tester allowlist; any other SSM read
// fails the test.
function stateIo({ runtime = undefined, runtimeError, allowlist = '[]', allowlistError } = {}) {
  return {
    async aws(args) {
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
        assert.equal(name, '/anywear/beta/tester_allowlist', 'the state observer reads only the allowlist');
        if (allowlistError) throw allowlistError;
        return { Parameter: { Name: name, Value: allowlist } };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
  };
}
const allowlistHash = emails => sha256(JSON.stringify(emails));

test('read-only state observes the stopped state: Base present, Runtime absent, no throw', async () => {
  const state = await observeBetaState(stateIo({ allowlist: '["a@example.com"]' }));
  assert.deepEqual(state.stacks, [
    { stack_name: baseName, status: 'UPDATE_COMPLETE' },
    { stack_name: runtimeStack, status: 'ABSENT', runtime_exists: false },
  ]);
  assert.deepEqual(state.admission, { tester_count: 1, tester_allowlist_hash: allowlistHash(['a@example.com']) });
  assert.equal(state.qualification, 'not-applicable');
  assert.equal(Object.hasOwn(state, 'beta_sizing'), false);
});

test('read-only state records a running Runtime and its sizing parameters', async () => {
  const runtime = {
    StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE',
    Parameters: [
      { ParameterKey: 'ServiceImageDigest', ParameterValue: `sha256:${'a'.repeat(64)}` },
      { ParameterKey: 'ServiceCommitSha', ParameterValue: 'b'.repeat(40) },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:ssm:ap-east-1:650880818323:parameter/beta-vlm' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-1234' },
      { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
    ],
  };
  const state = await observeBetaState(stateIo({ runtime }));
  assert.deepEqual(state.stacks[1], { stack_name: runtimeStack, status: 'UPDATE_COMPLETE', runtime_exists: true });
  assert.deepEqual(state.beta_sizing, {
    beta_api_sizing_profile: 's1', runtime_verification: 'not-applicable',
  });
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
