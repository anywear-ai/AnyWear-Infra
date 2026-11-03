import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeIo, runOperation } from './runtime-operation.mjs';
import { runtimeStack } from './one-writer.mjs';

const baseName = 'AnyWearPlatformStack-beta';
const workloadName = 'AnyWearWorkloadStack-beta';
const origin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';
const env = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-platform', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: 'beta-test', SERVICE_COMMIT: 'b'.repeat(40),
};


// The pre-mutation preflight simulates the deploy and runtime roles before the
// mutation; answer its IAM simulator calls with an allowed evaluation.
function simulatorAllowed(args) {
  const actions = args.slice(args.indexOf('--action-names') + 1, args.indexOf('--resource-arns'));
  const resources = args.slice(args.indexOf('--resource-arns') + 1, args.indexOf('--context-entries'));
  const results = [];
  for (const action of actions.filter((value) => value.includes(':'))) {
    for (const resource of resources.filter((value) => value.includes(':') || value === '*')) {
      results.push({ EvalActionName: action, EvalResourceName: resource, EvalDecision: 'allowed' });
    }
  }
  return { stdout: JSON.stringify({ EvaluationResults: results }) };
}

function stackAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

test('a completed Base deploy is a changed stack even when the retention step then fails', async () => {
  const changedStacks = [];
  const run = async (command, args) => {
    if (command === 'npx') return { stdout: '', stderr: '' };
    assert.equal(command, 'aws');
    const [service, action] = args;
    if (service === 'iam' && action?.startsWith('simulate-')) return simulatorAllowed(args);
    if (service === 'cloudformation' && action === 'describe-stacks') {
      const name = args[args.indexOf('--stack-name') + 1];
      if (name === runtimeStack) throw stackAbsenceError(name);
      if (name === baseName) return { stdout: JSON.stringify({ Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] }) };
      if (name === workloadName) {
        return { stdout: JSON.stringify({ Stacks: [{ StackName: workloadName, StackStatus: 'UPDATE_COMPLETE',
          Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: origin }] }] }) };
      }
      throw new Error(`Unexpected stack ${name}`);
    }
    if (service === 'cloudformation' && action === 'get-template') {
      return { stdout: JSON.stringify({ TemplateBody: { Resources: {} } }) };
    }
    // Retention's account check returns a foreign account, so the post-deploy
    // retention step throws after the CDK deploy already completed.
    if (service === 'sts' && action === 'get-caller-identity') {
      return { stdout: JSON.stringify({ Account: '111111111111' }) };
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  const io = await createRuntimeIo(env, {
    purpose: 'operation', run, changedStacks,
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' }),
  });
  await assert.rejects(io.deploy(baseName), /Unexpected Beta log retention account/);
  // The mutation landed before the failure: the operation knows the stack changed,
  // which is the "changed but unqualified" fact the step summary publishes.
  assert.deepEqual(io.changedStacks, [baseName]);
});

test('a completed non-Base deploy marks exactly its own stack changed', async () => {
  const changedStacks = [];
  const foundationEnv = { ...env, INFRA_OPERATION: 'deploy-foundation', SERVICE_ARTIFACT_TAG: '', SERVICE_COMMIT: '' };
  const run = async (command, args) => {
    if (command === 'npx') return { stdout: '', stderr: '' };
    if (command === 'aws' && args[0] === 'iam' && args[1]?.startsWith('simulate-')) return simulatorAllowed(args);
    throw new Error('No AWS read is required for a Foundation deploy');
  };
  const io = await createRuntimeIo(foundationEnv, {
    purpose: 'operation', run, changedStacks,
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' }),
  });
  await io.deploy('AnyWearFoundationStack');
  assert.deepEqual(io.changedStacks, ['AnyWearFoundationStack']);
});

test('a failed operation that already changed a stack appends one run-summary line naming it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-run-summary-'));
  const summary = path.join(directory, 'summary.md');
  try {
    const changedStacks = [];
    const io = {
      changedStacks,
      region: 'ap-east-1', now: Date.now, sleep: async () => {},
      async aws(args) {
        if (args[0] === 'sts' && args[1] === 'get-caller-identity') return { Account: '650880818323' };
        if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
          const name = args[args.indexOf('--stack-name') + 1];
          if (name === baseName) return { Stacks: [{ StackName: baseName, StackStatus: 'UPDATE_COMPLETE' }] };
          throw stackAbsenceError(name);
        }
        throw new Error(`Unexpected AWS call ${args.join(' ')}`);
      },
      // The mutation returned, then a later gate refused: the run must end failed
      // and its summary must name the stack it already changed.
      async deploy(stack) {
        io.changedStacks.push(stack);
        throw new Error('the post-mutation gate refused');
      },
    };
    const createIo = async (_environment, options) => { io.changedStacks = options.changedStacks; return io; };
    const operationEnv = { ...env, INFRA_OPERATION: 'deploy-foundation', SERVICE_ARTIFACT_TAG: '',
      SERVICE_COMMIT: '', GITHUB_STEP_SUMMARY: summary };
    await assert.rejects(runOperation(operationEnv, { createIo }), /the post-mutation gate refused/);
    const line = await readFile(summary, 'utf8');
    assert.match(line, /AnyWearFoundationStack/);
    assert.match(line, /did not complete/);
    assert.equal(line.trim().split('\n').length, 1, 'exactly one summary line');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a refusal before any mutation appends no changed-stack summary line', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-run-summary-'));
  const summary = path.join(directory, 'summary.md');
  try {
    const io = {
      changedStacks: [],
      async aws() { throw new Error('refused before any mutation'); },
      async deploy() { throw new Error('must not deploy'); },
    };
    const createIo = async () => io;
    const operationEnv = { ...env, INFRA_OPERATION: 'deploy-foundation', SERVICE_ARTIFACT_TAG: '',
      SERVICE_COMMIT: '', GITHUB_STEP_SUMMARY: summary };
    await assert.rejects(runOperation(operationEnv, { createIo }), /refused before any mutation/);
    await assert.rejects(readFile(summary, 'utf8'), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
