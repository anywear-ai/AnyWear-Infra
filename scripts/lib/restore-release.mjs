import { assertProtectedExecutor } from './operation-boundaries.mjs';
import { assertTerminalRuntime, assertRuntimeReady, describeStack, terminalStackStatuses, runtimeStack } from './one-writer.mjs';
import { SHA } from './json-contract.mjs';

const platformName = 'AnyWearPlatformStack-beta';
const runtimeName = runtimeStack;
const stableStatuses = terminalStackStatuses;
// The Base stack is the only stack this operation deploys. A release recovery
// restores the persistent Base and leaves the Runtime slice to Infra's
// `deploy-runtime` operation; the Runtime is read here to prove it exists and is
// terminal before and after the deploy, so the two operations never cross a
// deployment.
const platformInterfaceKeys = ['EcsClusterName', 'PrivateSubnetIds', 'OneShotSecurityGroupId', 'VerificationTaskRoleArn',
  'OneShotExecutionRoleArn', 'OneShotLogGroupName', 'DatabaseSecretArn', 'DatabaseHost', 'DatabasePort', 'DatabaseName',
  'WardrobeBucketName', 'VtoQueueUrl', 'AutoTaggingQueueUrl', 'ServiceRepositoryUri', 'ServiceRepositoryName',
  'ApiDistributionId', 'ApiDistributionDomainName', 'ApiBaseUrl'];
const outputs = stack => Object.fromEntries((stack?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
const selectOutputs = (all, keys) => Object.fromEntries(keys.map(key => [key, all[key]]));
const stackRead = (io, name) => describeStack(io, name);

function assertContext(infraSha, env) {
  assertProtectedExecutor(infraSha, env);
  // Issue #266: the repository numeric id is the durable identity, and the
  // workflow ref is this run's own full name, so the guard passes under either
  // owner.
  if (env.GITHUB_REPOSITORY_ID !== '1409047265' || !SHA.test(infraSha ?? '') || env.GITHUB_SHA !== infraSha
    || env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/.github/workflows/mutate.yml@refs/heads/main`) {
    throw new Error('Restore requires the reviewed Infra executor source');
  }
  if (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true') {
    throw new Error('Restore requires retired identity and retention protection');
  }
}

// Closed admission and a live Runtime were the old preconditions; #213 removed the
// admission surface, so a restore reads no admission state. A live Runtime and a
// stable stack status remain: stable CloudFormation status is a mutation-safety
// requirement, not an activation requirement. A missing Runtime means the operator
// must start first (deploy-egress, then the Service deploy) instead of restoring
// an environment nothing is serving.
function assertRestoreTarget(platform) {
  if (!stableStatuses.has(platform?.StackStatus)) throw new Error(`Restore requires stable ${platformName}`);
  if (outputs(platform).EcsClusterName !== 'beta-anywear') throw new Error('Restore is restricted to beta-anywear');
}

function assertRuntimeStarted(runtime) {
  assertRuntimeReady(runtime, 'Restore');
}

// One writer per stack: a Base deploy must not cross a Runtime deployment, so
// the Runtime is terminal before and after. This is a read-only precondition, not
// a claim to deploy or observe its resources.
function assertRuntimeTerminal(runtime) {
  assertTerminalRuntime(runtime, 'Restore');
}

function assertRestoredPlatform(platform) {
  if (!stableStatuses.has(platform?.StackStatus)) throw new Error(`Restore requires stable ${platformName} after deploy`);
}

// A restore may move outputs the operation does not consume, but a consumed
// interface output must stay present and unchanged.
function assertInterface(actual, original) {
  for (const key of platformInterfaceKeys) {
    if (!actual[key]) throw new Error(`Restore interface output ${key} missing after deploy`);
    if (actual[key] !== original[key]) throw new Error(`Restore interface output ${key} changed after deploy`);
  }
}

// The adopted API distribution must still be serving after the Base update: the
// CloudFront status is the postcondition the CloudFormation stack alone cannot
// prove.
async function assertDistributionDeployed(io, platform) {
  const all = outputs(platform);
  const id = all.ApiDistributionId;
  const domain = all.ApiDistributionDomainName;
  if (!id || !domain) throw new Error('Restore requires the Base API distribution id and domain outputs');
  const distribution = (await io.aws(['cloudfront', 'get-distribution', '--id', id])).Distribution;
  if (distribution?.Id !== id || distribution?.Status !== 'Deployed' || distribution?.DomainName !== domain) {
    throw new Error(`Restore requires the Base API distribution ${id} to be Deployed with its recorded domain`);
  }
}

async function failureReadback(io, stage) {
  const observed = { failure_stage: stage };
  for (const [key, name] of [['base', platformName], ['runtime', runtimeName]]) {
    try {
      const stack = await stackRead(io, name);
      observed[`${key}_status`] = /^[A-Z_]{1,64}$/.test(stack?.StackStatus ?? '') ? stack.StackStatus : 'unavailable';
      observed[`${key}_exists`] = stack?.StackName === name;
    } catch {
      observed[`${key}_status`] = 'unavailable'; observed[`${key}_exists`] = 'unavailable';
    }
  }
  return observed;
}

// Called inside the ordinary Infra queue after the reviewed Service release and
// source checks. Only the Base stack is deployed; the Runtime slice is neither
// verified nor deployed here, because both moved to Infra's `deploy-runtime`.
// Each stage and the failure readback are printed to the step log; there is no
// record (#207).
const say = event => process.stdout.write(`${JSON.stringify({ operation: 'restore-release', ...event })}\n`);

export async function runRestoreRelease({ io, infraSha, env = process.env }) {
  // Reject source/context before any authenticated read or deploy.
  assertContext(infraSha, env);
  let stage = 'preconditions';
  // A restore reads no admission state: #213 removed the mode, and the allowlist
  // constrains registration only, so it is neither a precondition nor a
  // postcondition of recovering the Base stack.
  const phase = async (name, action) => {
    stage = name;
    say({ stage, result: 'began' });
    assertContext(infraSha, env);
    const result = await action();
    assertContext(infraSha, env);
    say({ stage, result: 'succeeded' });
    return result;
  };
  try {
    say({ stage, result: 'began' });
    assertContext(infraSha, env);
    const platform = await stackRead(io, platformName); const runtime = await stackRead(io, runtimeName);
    assertRestoreTarget(platform);
    // "Start first": a restore requires the Runtime stack to exist and be stable.
    // A stopped environment first runs `deploy-egress` and the Service deploy.
    assertRuntimeStarted(runtime);
    const originalPlatformInterface = selectOutputs(outputs(platform), platformInterfaceKeys);
    say({ stage, result: 'succeeded' });

    const readSelected = async () => {
      const actualPlatform = await stackRead(io, platformName); const actualRuntime = await stackRead(io, runtimeName);
      assertRestoredPlatform(actualPlatform); assertRuntimeTerminal(actualRuntime);
      assertInterface(outputs(actualPlatform), originalPlatformInterface);
      await assertDistributionDeployed(io, actualPlatform);
      return actualPlatform;
    };
    await phase('platform-deploy', () => io.deploy(platformName));
    await phase('platform-readback', readSelected);
    await phase('final-readback', readSelected);
    return { restored_stack: platformName };
  } catch (error) {
    const observed = await failureReadback(io, stage);
    // The readback is a run fact: the step log names the failed stage and both
    // stack statuses, and the thrown message carries "explicit recovery required".
    // Nothing here resumes a sibling deployment or reads admission state.
    say({ result: 'failed', ...observed });
    throw new Error(`Beta Base restore failed at ${stage}; explicit recovery required; Base=${observed.base_status} (${observed.base_exists}), Runtime=${observed.runtime_status} (${observed.runtime_exists})`, { cause: error });
  }
}
