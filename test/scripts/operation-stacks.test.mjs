import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredStacks, configuredStackNames, operationOwnedStacks, changedStackNames } from '../../scripts/lib/operation-stacks.mjs';
import { cdkDeploymentArguments, cdkDestroyArguments } from '../../scripts/runtime-operation.mjs';

const env = { GITHUB_SHA: '5'.repeat(40), GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', INFRA_OPERATION: 'deploy-platform',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true' };
const origin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';

test('the configured stack set is exactly Foundation, the Beta Base stack and Billing', () => {
  assert.deepEqual(configuredStacks.map(stack => [stack.stack_name, stack.region]), [
    ['AnyWearFoundationStack', 'ap-east-1'],
    ['AnyWearPlatformStack-beta', 'ap-east-1'],
    ['AnyWearBillingStack-beta', 'us-east-1'],
  ]);
  assert.deepEqual(configuredStackNames(), configuredStacks.map(stack => stack.stack_name));
  // The disposable stacks stay operation-owned: they exist only while Beta runs,
  // so they are never part of the always-present configured manifest.
  assert.deepEqual(operationOwnedStacks.map(stack => stack.stack_name),
    ['AnyWearEgressStack-beta', 'AnyWearRuntimeStack-beta']);
});

test('deploy-runtime and stop-runtime own the Runtime slice; Egress stays operation-owned', () => {
  assert.deepEqual(changedStackNames('deploy-foundation'), ['AnyWearFoundationStack']);
  assert.deepEqual(changedStackNames('deploy-billing'), ['AnyWearBillingStack-beta']);
  assert.deepEqual(changedStackNames('deploy-platform'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('restore-release'), ['AnyWearPlatformStack-beta']);
  assert.deepEqual(changedStackNames('deploy-egress'), ['AnyWearEgressStack-beta']);
  assert.deepEqual(changedStackNames('delete-egress'), ['AnyWearEgressStack-beta']);
  assert.deepEqual(changedStackNames('deploy-workload'), []);
  assert.deepEqual(changedStackNames('deploy-runtime'), ['AnyWearRuntimeStack-beta']);
  assert.deepEqual(changedStackNames('stop-runtime'), ['AnyWearRuntimeStack-beta']);
});

test('cdk arguments load Service artifacts and pass the API origin parameter only for the Base stack', () => {
  const platform = cdkDeploymentArguments('AnyWearPlatformStack-beta', '/verified', env, { apiOriginDomainName: origin });
  assert.ok(platform.includes('deployScope=application'));
  assert.ok(platform.includes('artifactDirectory=/verified'));
  // #254: the origin is a CloudFormation stack parameter, so it travels as the
  // CDK CLI's `--parameters KEY=VALUE` value and never as the old
  // `-c apiOriginDomainName=<name>` context the synthesis read.
  const parameter = platform.indexOf('--parameters');
  assert.ok(parameter > 0);
  assert.equal(platform[parameter + 1], `ApiOriginDomainName=${origin}`);
  assert.equal(platform.filter((arg) => arg === '--parameters').length, 1);
  assert.equal(platform.some((arg) => arg.startsWith('apiOriginDomainName=')), false);
  assert.throws(() => cdkDeploymentArguments('AnyWearPlatformStack-beta', '/verified', env), /requires the API origin domain name/);
  for (const [stack, scope] of [['AnyWearFoundationStack', 'foundation'], ['AnyWearBillingStack-beta', 'billing'],
    ['AnyWearEgressStack-beta', 'egress']]) {
    const args = cdkDeploymentArguments(stack, '/verified', env);
    assert.ok(args.includes(`deployScope=${scope}`), stack);
    assert.ok(!args.some(arg => arg.startsWith('artifactDirectory=')), `${stack} must not load Service artifacts`);
    assert.ok(!args.includes('--parameters'), `${stack} must not take the API origin parameter`);
    assert.ok(!args.some(arg => arg.startsWith('ApiOriginDomainName=')), `${stack} must not take the API origin`);
  }
  assert.ok(platform.includes(`identityPhase=${env.INFRA_IDENTITY_PHASE}`));
  assert.ok(platform.includes(`ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`));
  // The stop path destroys only the Egress stack through the same reviewed scope.
  const destroy = cdkDestroyArguments('AnyWearEgressStack-beta', env);
  assert.deepEqual(destroy.slice(0, 4), ['cdk', 'destroy', 'AnyWearEgressStack-beta', '--force']);
  assert.ok(destroy.includes('deployScope=egress'));
});
