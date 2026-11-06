import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperation } from '../../scripts/runtime-operation.mjs';
import { runtimeStack } from '../../scripts/lib/one-writer.mjs';
import { sha256 } from '../../scripts/lib/json-contract.mjs';

// #213: with `/anywear/beta/tester_allowlist` the only admission parameter, the
// three operations whose admission precondition was removed must complete while
// the retired mode parameter does not exist. This test's restricted session
// refuses every SSM read that is not the allowlist, so a reintroduced mode read
// fails the test rather than being satisfied by a fixture.
const serviceCommit = 'b'.repeat(40);
const imageDigest = `sha256:${'9'.repeat(64)}`;
const infraSha = 'a'.repeat(40);
const allowlist = ['tester@example.com'];
const statusLine = () => ({ action: 'status', tester_count: allowlist.length,
  tester_allowlist_hash: sha256(JSON.stringify(allowlist)) });
const baseEnv = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha, GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true', TESTER_EMAILS: '[]',
};
const platformOutputs = () => Object.fromEntries(['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId',
  'VerificationTaskRoleArn', 'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost',
  'DatabasePort', 'DatabaseName', 'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl', 'ServiceRepositoryUri',
  'ServiceRepositoryName', 'ApiDistributionId', 'ApiDistributionDomainName', 'ApiBaseUrl']
  .map(key => [key, key === 'EcsClusterName' ? 'beta-anywear'
    : key === 'ApiDistributionId' ? 'E2ABCDEFGHIJKL'
      : key === 'ApiDistributionDomainName' ? 'd111111abcdef8.cloudfront.net'
        : key === 'ApiBaseUrl' ? 'https://d111111abcdef8.cloudfront.net' : `${key}-value`]));
const entries = outputs => Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

function modeAbsentIo() {
  const calls = [];
  const platform = { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_COMPLETE',
    Outputs: entries(platformOutputs()) };
  // #243: `migrate` refuses a stopped Beta by name, so the migration case needs the
  // Egress stack Beta runs with by default. It reads it and changes nothing.
  const egress = { StackName: 'AnyWearEgressStack-beta', StackStatus: 'UPDATE_COMPLETE' };
  const runtime = { StackName: runtimeStack, StackStatus: 'UPDATE_COMPLETE',
    Parameters: [{ ParameterKey: 'ServiceImageDigest', ParameterValue: imageDigest },
      { ParameterKey: 'ServiceCommitSha', ParameterValue: serviceCommit },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:test' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-test' }] };
  return { calls, io: {
    async aws(args) {
      calls.push([...args]);
      if (args[0] === 'sts') return { Account: '650880818323' };
      if (args[0] === 'ecr') return { imageDetails: [{ imageDigest, imageTags: [`service-artifacts-${serviceCommit}`] }] };
      if (args[0] === 'cloudformation') {
        const name = args[args.indexOf('--stack-name') + 1];
        return { Stacks: [name === runtimeStack ? runtime : name === egress.StackName ? egress : platform] };
      }
      if (args[0] === 'ssm') {
        const name = args[args.indexOf('--name') + 1];
        assert.equal(name, '/anywear/beta/tester_allowlist', 'only the tester allowlist may be read');
        return { Parameter: { Name: name, Value: JSON.stringify(allowlist) } };
      }
      if (args[0] === 'cloudfront') {
        return { Distribution: { Id: 'E2ABCDEFGHIJKL', DomainName: 'd111111abcdef8.cloudfront.net', Status: 'Deployed' } };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
    async deploy(stack) { calls.push(['deploy', stack]); },
    async oneShot(role, revision, action, payload) {
      calls.push(['oneShot', role, action, payload]);
      if (role === 'lifecycle' && action === 'status') return statusLine();
      return undefined;
    },
  } };
}

async function captureStdout(run) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { value: await run(), lines }; }
  finally { process.stdout.write = original; }
}

test('runtime.yml state reports the allowlist with the mode parameter absent', async () => {
  const surface = modeAbsentIo();
  const { lines } = await captureStdout(() => runOperation({
    ...baseEnv, GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main',
    INFRA_OPERATION: 'state',
  }, { createIo: async () => surface.io }));
  const state = lines.map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line))
    .find(state => Object.hasOwn(state, 'stacks'));
  assert.deepEqual(state.admission, { tester_count: 1, tester_allowlist_hash: sha256(JSON.stringify(allowlist)) });
  const retiredModeField = ['admission', 'mode'].join('_');
  assert.equal(Object.hasOwn(state.admission, retiredModeField), false);
  assert.ok(surface.calls.some(call => call[0] === 'ssm'), 'the observer still reads the allowlist');
  assert.ok(!surface.calls.some(call => call[0] === 'oneShot' || call[0] === 'deploy'));
});

test('migrate completes with the mode parameter absent and reads no admission state', async () => {
  const surface = modeAbsentIo();
  // #243: the migration takes the sealed artifact identity; Beta's Platform and
  // Egress stacks are present and terminal, which is Beta's normal running state.
  await captureStdout(() => runOperation({ ...baseEnv, INFRA_OPERATION: 'migrate',
    SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit },
  { createIo: async () => surface.io }));
  assert.ok(surface.calls.some(call => call[0] === 'oneShot' && call[1] === 'migrate'));
  assert.equal(surface.calls.some(call => call[0] === 'ssm'), false, 'migrate reads no admission state');
});

test('restore-release completes with the mode parameter absent and reads no admission state', async () => {
  const surface = modeAbsentIo();
  await captureStdout(() => runOperation({ ...baseEnv, INFRA_OPERATION: 'restore-release',
    SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit },
  { createIo: async () => surface.io }));
  assert.ok(surface.calls.some(call => call[0] === 'deploy' && call[1] === 'AnyWearPlatformStack-beta'));
  assert.equal(surface.calls.some(call => call[0] === 'ssm'), false, 'restore-release reads no admission state');
  assert.equal(surface.calls.some(call => call[0] === 'oneShot'), false, 'restore-release runs no task');
});
