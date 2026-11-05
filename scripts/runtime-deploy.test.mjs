import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DECLARED_DIAGNOSTIC_EXCLUSION,
  DECLARED_DIAGNOSTIC_RESOURCE_TYPES,
  RUNTIME_DEPLOY_PARAMETER_KEYS,
  RUNTIME_STACK,
  acceptedLiveRuntimeHashes,
  assertCreateOnlyChangeSet,
  assertLiveRuntimeIdentity,
  assertReleaseStableChangeSet,
  assertRuntimePhase,
  assertSynthesizedRuntimeIdentity,
  apiOriginUpdateArguments,
  classifyChangeSet,
  deployRuntime,
  readRuntimeHealth,
  recordedLivePredecessors,
  recordedRuntimePhaseHash,
  runtimeCdkDeployArguments,
  runtimeChangeSetName,
  runtimeDeployParameters,
  stopRuntime,
} from './runtime-deploy.mjs';
import {
  RUNTIME_ECS_CLUSTER_INPUT,
  RUNTIME_QUEUE_URL_NAMES,
  RUNTIME_STAGE_INPUT_NAMES,
  readRuntimeStageContract,
  runtimeBakeQueueUrls,
  runtimeEcsClusterName,
  runtimeStageInputBatches,
} from './runtime-stage-inputs.mjs';
import { runOperation, validateOperationInputs } from './runtime-operation.mjs';
import { sha256 } from './json-contract.mjs';
import { failedGate } from './bake-gate.mjs';
import { SchemaBoundaryError, runSchemaBoundaryGate } from './schema-gate.mjs';
import { gateBlock, IMAGE_DIGEST, SERVICE_SHA } from '../test/contracts/gate-fixture.mjs';

// Credential-free tests for the `deploy-runtime` operation (#195, #194). The
// synthesis, health probe, bake and schema-boundary gate are injected; every AWS
// surface is a fake that records calls, so each failure leaves the stack untouched
// and writes no deployment record (#207).
const release = { releaseTag: `service-artifacts-${SERVICE_SHA}`, serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST };
// The gate's admitted comparison is a return value and a log line now, so a fake
// gate that resolves is all the deploy path needs from it.
const SCHEMA_GATE = async () => ({ result: 'compatible' });
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main', GITHUB_REF: 'refs/heads/main',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  // #226: this deploy was dispatched by a human, so the deploy chain's context is
  // the workflow default pair.
  DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '', ...overrides,
});
const TEMPLATE = JSON.parse(readFileSync('test/baselines/beta-active/AnyWearRuntimeStack-beta.template.json', 'utf8'));
const SYNTHESIZED = { template: TEMPLATE, raw_sha256: 'a'.repeat(64),
  normalised_sha256: '24492de063394e857b1d8f5cbdc33467eaba84a5a629f5b7b34625f84518f5e4',
  expected: '24492de063394e857b1d8f5cbdc33467eaba84a5a629f5b7b34625f84518f5e4' };
// The fixture synthesises the legacy-phase baseline (`TEMPLATE`), whose normalised
// hash is its own `expected`, while the recorded roles-added identity differs. The
// live-template acceptance set is a deploy seam, so the fixture pins it to that
// hash rather than widening production's recorded set; the dedicated accepted-set
// test below exercises the real `acceptedLiveRuntimeHashes()` and its precedence.
const FIXTURE_ACCEPTED_LIVE = Object.freeze([SYNTHESIZED.expected]);
const deploy = (options) => deployRuntime({ schemaGate: SCHEMA_GATE,
  acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE, ...options });
const HEALTH = async () => 0;
const BAKE = async () => gateBlock();
const SSM = ['vlm_config_arn', 'cloudfront_prefix_list_id'].map((name) => ({ name }));
// The contract values the deploy reads: the two reviewed constants, the API
// endpoint, the four queue URLs and the ECS cluster name. Never literals in the
// operation itself.
const QUEUE_URLS = Object.freeze({
  '/anywear/beta/vto_queue_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto',
  '/anywear/beta/auto_tagging_queue_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging',
  '/anywear/beta/vto_dlq_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-vto-dlq',
  '/anywear/beta/auto_tagging_dlq_url': 'https://sqs.ap-east-1.amazonaws.com/650880818323/beta-anywear-auto-tagging-dlq',
});
const CONTRACT_VALUES = Object.freeze({
  '/anywear/beta/vlm_config_arn': 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf',
  '/anywear/beta/cloudfront_prefix_list_id': 'pl-0123456789abcdef',
  '/anywear/beta/api_base_url': 'https://d111111abcdef8.cloudfront.net',
  '/anywear/beta/ecs_cluster_name': 'beta-anywear',
  ...QUEUE_URLS,
});
const stageValue = (name) => CONTRACT_VALUES[name] ?? `value:${name}`;

// The bake's options are captured so the tests prove what the operation actually
// handed the gate, not only what the helpers would accept.
function capturingBake(gate = () => gateBlock()) {
  const baked = [];
  return { baked, bake: async (options) => { baked.push(options); return gate(); } };
}

// The real CloudFormation change-set row shape: `Type` is always `Resource` and
// the action is `ResourceChange.Action`. Issue #220's first deployment was refused
// because the guard read `Type`; every fixture below is built from this shape so
// the classifier and both guards are exercised the way a live change set is.
function changeRow(action, { logicalId, resourceType, replacement = 'False' }) {
  return {
    Type: 'Resource',
    ResourceChange: { Action: action, LogicalResourceId: logicalId, ResourceType: resourceType, Replacement: replacement },
  };
}


function liveStack({ identityUnchanged = true, terminal = true, origin = API_ORIGIN_OLD } = {}) {
  return {
    StackName: RUNTIME_STACK, StackStatus: terminal ? 'UPDATE_COMPLETE' : 'UPDATE_IN_PROGRESS',
    LastUpdatedTime: '2026-10-22T12:15:43.000Z',
    RoleARN: 'arn:aws:iam::650880818323:role/beta-service-deploy-cfn-role',
    Parameters: [
      { ParameterKey: 'ServiceCommitSha', ParameterValue: identityUnchanged ? SERVICE_SHA : 'b'.repeat(40) },
      { ParameterKey: 'ServiceImageDigest', ParameterValue: identityUnchanged ? IMAGE_DIGEST : `sha256:${'9'.repeat(64)}` },
      { ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's1' },
      { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/vlm_config-AbCdEf' },
      { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-0123456789abcdef' },
    ],
    // Issue #254: the load balancer the Base distribution's origin must follow.
    Outputs: [{ OutputKey: 'ApiLoadBalancerDnsName', OutputValue: origin }],
  };
}

// Issue #254: the Beta edge repair. The Base stack records the origin as its
// `ApiOriginDomainName` parameter, and the Runtime stack publishes the load
// balancer the same run created as `ApiLoadBalancerDnsName`. The default fixture
// is self-consistent (equal values), so every pre-existing success test keeps
// proving "equal writes nothing".
const API_ORIGIN_OLD = 'beta-anywear-api-2018499908.ap-east-1.elb.amazonaws.com';
const API_ORIGIN_NEW = 'beta-anywear-api-1554590841.ap-east-1.elb.amazonaws.com';
const BASE_STACK = 'AnyWearPlatformStack-beta';
const baseStackFixture = ({ parameters } = {}) => ({
  StackName: BASE_STACK, StackStatus: 'UPDATE_COMPLETE', LastUpdatedTime: '2026-10-28T02:47:06.000Z',
  Parameters: parameters ?? [{ ParameterKey: 'BootstrapVersion', ParameterValue: '7' },
    { ParameterKey: 'ApiOriginDomainName', ParameterValue: API_ORIGIN_OLD }],
});

// CloudFormation answers a missing stack with this exact ValidationError, which
// `describeStack` turns into `undefined`; the poll must treat that as a failure.
function baseAbsenceError(stackName) {
  const stderr = `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`;
  return Object.assign(new Error(stderr), { stderr });
}

function fakeIo({ base = baseStackFixture(), runtime = liveStack(), changeSet = undefined,
  executeError = undefined, postExecuteRuntime = undefined, updateError = undefined,
  updateDelays = 0, updateStaleReads = 0, updateRollback = false,
  pollReadError = undefined, pollAbsent = false } = {}) {
  const calls = [];
  // The changed-stack set the failed-run summary publishes. It starts as the
  // fake's own array and `runOperation` re-binds it to the array it owns.
  const changedStacks = [];
  let runtimeObserved = runtime;
  // A deleted change set can no longer be described. The fail-closed path deletes
  // the set, so a post-delete describe is a test failure: the operation must not
  // depend on re-reading a deleted set.
  let changeSetDeleted = false;
  // Issue #254's repair poll: after `update-stack` the fake can still answer with
  // the pre-update terminal state for a few reads (`updateStaleReads`), then with
  // `UPDATE_IN_PROGRESS` reads (`updateDelays`), then with the updated stack. A
  // post-update read can also fault once (`pollReadError`) or report absence
  // (`pollAbsent`) to prove the repair names the edge instead of polling on.
  let staleReads = 0;
  let inProgressReads = 0;
  let updateAccepted = false;
  let pollReadFailures = 0;
  let pollAbsences = 0;
  let preUpdateBase;
  const io = {
    calls, changedStacks, now: () => 0, sleep: async () => {},
    // The one changed-stack mechanism: the fake proves the operation records a
    // landed mutation through `io.markChanged`, not by reaching into its own state.
    markChanged(stack) { io.changedStacks.push(stack); },
    async aws(args) {
      const key = `${args[0]}/${args[1]}`;
      calls.push({ session: 'runtime', key, args });
      if (key === 'sts/get-caller-identity') return { Account: '650880818323' };
      if (key === 'ecr/describe-images') {
        const tag = args[args.indexOf('--image-ids') + 1].replace(/^imageTag=/, '');
        return { imageDetails: [{ imageTags: [tag], imageDigest: IMAGE_DIGEST }] };
      }
      if (key === 'cloudformation/describe-stacks') {
        const name = args[args.indexOf('--stack-name') + 1];
        if (name === BASE_STACK) {
          if (!base) throw new Error(`Stack ${BASE_STACK} does not exist`);
          if (updateAccepted && pollReadError && pollReadFailures < 1) {
            pollReadFailures += 1;
            throw pollReadError;
          }
          if (updateAccepted && pollAbsent && pollAbsences < 1) {
            pollAbsences += 1;
            throw baseAbsenceError(BASE_STACK);
          }
          if (staleReads > 0) { staleReads -= 1; return { Stacks: [structuredClone(preUpdateBase)] }; }
          if (inProgressReads > 0) {
            inProgressReads -= 1;
            return { Stacks: [{ ...structuredClone(base), StackStatus: 'UPDATE_IN_PROGRESS' }] };
          }
          return { Stacks: [structuredClone(base)] };
        }
        if (name === RUNTIME_STACK) {
          if (runtimeObserved) return { Stacks: [runtimeObserved] };
          throw new Error(`Stack with id ${RUNTIME_STACK} does not exist`);
        }
        throw new Error(`unexpected stack ${name}`);
      }
      if (key === 'cloudformation/get-template') return { TemplateBody: JSON.stringify(TEMPLATE) };
      if (key === 'ssm/get-parameters') {
        const names = args.slice(args.indexOf('--names') + 1);
        return { Parameters: names.map((name) => ({ Name: name, Version: 3, Value: stageValue(name) })) };
      }
      if (key === 'ssm/get-parameter') {
        const name = args[args.indexOf('--name') + 1];
        return { Parameter: { Name: name, Version: 3, Value: stageValue(name) } };
      }
      if (key === 'ecs/describe-services') {
        return { services: ['api', 'worker'].map((purpose) => ({
          serviceName: `beta-anywear-${purpose}`, status: 'ACTIVE',
          serviceArn: `arn:aws:ecs:ap-east-1:650880818323:service/beta-anywear/beta-anywear-${purpose}`,
          taskDefinition: `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:7`,
          runningCount: 1, desiredCount: 1, deployments: [{ rolloutState: 'COMPLETED' }],
        })) };
      }
      if (key === 'ecs/describe-task-definition') {
        const arn = args[args.indexOf('--task-definition') + 1];
        const purpose = arn.includes('worker') ? 'worker' : 'api';
        return { taskDefinition: { family: `beta-anywear-${purpose}`, taskRoleArn: `arn:aws:iam::650880818323:role/beta-anywear-${purpose}-task`,
          executionRoleArn: `arn:aws:iam::650880818323:role/beta-anywear-${purpose}-execution`, networkMode: 'awsvpc', cpu: '512', memory: '1024',
          containerDefinitions: [{ name: `${purpose}`, image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${IMAGE_DIGEST}`,
            command: ['node', 'dist/index.js'], environment: [] }] } };
      }
      throw new Error(`unexpected runtime read ${key}`);
    },
    async awsAs(session, args) {
      calls.push({ session, key: `${args[0]}/${args[1]}`, args });
      if (args[1] === 'describe-change-set') {
        if (changeSetDeleted) throw new Error('describe-change-set after delete-change-set');
        return changeSet;
      }
      if (args[1] === 'delete-change-set') changeSetDeleted = true;
      if (args[1] === 'execute-change-set') {
        if (executeError) throw executeError;
        runtimeObserved = postExecuteRuntime ?? liveStack();
      }
      if (args[1] === 'update-stack') {
        if (updateError) throw updateError;
        const value = args.find((arg) => typeof arg === 'string'
          && arg.startsWith('ParameterKey=ApiOriginDomainName,ParameterValue='));
        preUpdateBase = structuredClone(base);
        base.Parameters = base.Parameters.map((entry) => (entry.ParameterKey === 'ApiOriginDomainName'
          ? { ...entry, ParameterValue: value.slice('ParameterKey=ApiOriginDomainName,ParameterValue='.length) }
          : entry));
        base.LastUpdatedTime = '2026-11-01T12:00:00.000Z';
        updateAccepted = true;
        staleReads = updateStaleReads;
        inProgressReads = updateDelays;
        if (updateRollback) base.StackStatus = 'UPDATE_ROLLBACK_COMPLETE';
      }
      return {};
    },
    async deployRuntimeChangeSet({ args }) { calls.push({ session: 'deploy', key: 'cdk/deploy', args }); },
    async runtimeAwsRunner() { return () => '{}'; },
    async destroy(stack) { calls.push({ session: 'deploy', key: 'cdk/destroy', stack }); },
  };
  return { io, calls, setRuntime: (value) => { runtimeObserved = value; } };
}

test('the five deploy parameters are the release identity, the retained sizing profile and the two reviewed constants', () => {
  assert.deepEqual([...RUNTIME_DEPLOY_PARAMETER_KEYS], ['ServiceImageDigest', 'ServiceCommitSha',
    'BetaApiSizingProfile', 'VlmConfigArn', 'CloudFrontPrefixListId']);
  const parameters = runtimeDeployParameters({ liveParameters: [], deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' },
    release });
  assert.deepEqual(Object.keys(parameters).sort(), [...RUNTIME_DEPLOY_PARAMETER_KEYS].sort());
  assert.equal(Object.keys(parameters).length, 5);
  // The reviewed default applies only when the live stack never carried it.
  assert.equal(parameters.BetaApiSizingProfile, 's1');
  const retained = runtimeDeployParameters({ liveParameters: liveStack().Parameters,
    deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' }, release });
  assert.equal(retained.BetaApiSizingProfile, 's1');
  assert.throws(() => runtimeDeployParameters({ liveParameters: [{ ParameterKey: 'BetaApiSizingProfile', ParameterValue: 's3' }],
    deployValues: { VlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:x', CloudFrontPrefixListId: 'pl-1' }, release }), /Unreviewed retained Beta sizing profile/);
  assert.throws(() => runtimeDeployParameters({ liveParameters: [], deployValues: { VlmConfigArn: 'x', CloudFrontPrefixListId: 'pl-1' },
    release: { ...release, imageDigest: 'not-a-digest' } }), /Invalid release image digest/);
});

test('the bake input helpers accept only full contract URLs and the contract cluster, never queue names', () => {
  const values = new Map(Object.entries(CONTRACT_VALUES));
  const queueUrls = runtimeBakeQueueUrls(values);
  assert.deepEqual(queueUrls, {
    vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
    auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
    vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
    auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
  });
  assert.ok(Object.isFrozen(queueUrls));
  // Issue #195 blocking fix: the review found the deploy passing queue *names* to
  // `sqs get-queue-attributes --queue-url`. Every value must be a full https URL.
  for (const url of Object.values(queueUrls)) assert.match(url, /^https:\/\/sqs\./);
  assert.equal(runtimeEcsClusterName(values), 'beta-anywear');
  // The hardcoded names the operation used before the fix now fail closed.
  const HARDCODED_NAMES = { vto: 'beta-anywear-vto', auto_tagging: 'beta-anywear-auto-tagging',
    vto_dlq: 'beta-anywear-vto-dlq', auto_tagging_dlq: 'beta-anywear-auto-tagging-dlq' };
  for (const [purpose, name] of Object.entries(RUNTIME_QUEUE_URL_NAMES)) {
    assert.throws(() => runtimeBakeQueueUrls(new Map(values).set(name, HARDCODED_NAMES[purpose])),
      new RegExp(`${name} is not an https://sqs\\. queue URL`), purpose);
    const missing = new Map(values);
    missing.delete(name);
    assert.throws(() => runtimeBakeQueueUrls(missing), /is not an https:\/\/sqs\. queue URL/, purpose);
    for (const malformed of [`http://sqs.ap-east-1.amazonaws.com/650880818323/q`, 'https://sqs.', 'beta-anywear-vto']) {
      assert.throws(() => runtimeBakeQueueUrls(new Map(values).set(name, malformed)), /not an https:\/\/sqs\./,
        `${purpose}: ${malformed}`);
    }
  }
  for (const cluster of [undefined, '', 'beta anywear', 'beta-anywear/other']) {
    assert.throws(() => runtimeEcsClusterName(new Map(values).set(RUNTIME_ECS_CLUSTER_INPUT, cluster)),
      /ecs_cluster_name is not an ECS cluster name/, String(cluster));
  }
  assert.throws(() => runtimeEcsClusterName(new Map()), /ecs_cluster_name is not an ECS cluster name/);
});

test('the CDK arguments pass one stack-qualified flag per parameter and disable previous parameters', () => {
  const parameters = Object.fromEntries(RUNTIME_DEPLOY_PARAMETER_KEYS.map((key) => [key, `${key}-value`]));
  const args = runtimeCdkDeployArguments({ parameters, changeSetName: 'anywear-runtime-1', identityPhase: 'roles-added', retentionProtection: 'true' });
  assert.deepEqual(args.slice(0, 6), ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never']);
  assert.ok(args.includes('--no-execute'));
  assert.ok(args.includes('deployScope=runtime'));
  assert.ok(args.includes('identityPhase=roles-added'));
  assert.ok(!args.some((arg) => arg.startsWith('artifactDirectory=')));
  assert.ok(!args.includes('--role-arn'), 'the standard synthesizer chooses the execution role');
  // Issue #194: the CLI's `--parameters` is an `array` option with `nargs: 1` and
  // documents `STACK:KEY=VALUE`, so the single-flag form kept only its first value
  // and `--previous-parameters` (default true) retained the rest. The exact array
  // is asserted, so a missing pair or a missing fail-closed flag fails this test.
  assert.deepEqual(args, ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never',
    '--no-execute', '--change-set-name', 'anywear-runtime-1',
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', 'identityPhase=roles-added', '-c', 'ecrImageRetention=true',
    '--previous-parameters=false',
    ...RUNTIME_DEPLOY_PARAMETER_KEYS.flatMap((key) => ['--parameters', `${RUNTIME_STACK}:${key}=${key}-value`])]);
  assert.equal(args.filter((arg) => arg === '--parameters').length, 5,
    'every parameter needs its own --parameters flag (nargs: 1)');
  for (const key of RUNTIME_DEPLOY_PARAMETER_KEYS) {
    assert.ok(args.includes(`${RUNTIME_STACK}:${key}=${key}-value`), key);
    assert.ok(!args.includes(`${key}=${key}-value`), `${key} must be stack-qualified`);
  }
  assert.throws(() => runtimeCdkDeployArguments({ parameters: { ServiceCommitSha: 'x' }, changeSetName: 'anywear-runtime-1',
    identityPhase: 'roles-added', retentionProtection: 'true' }), /exactly the five reviewed parameters/);
});

// Issue #220's transition deployed in `mutate.yml` `deploy-runtime` run 39988090020
// (2026-10-23), so its one recorded live predecessor is retired and the live record
// accepts only the recorded roles-added identity. The read path keeps its predecessor
// support — inert and fail-closed for the live record — while the synthesis check and
// the post-deploy read-back stay exact against the recorded identity, which the deploy
// tests above prove with the fixture-pinned seam.
test('the live record accepts only the recorded identity, with its one predecessor retired', () => {
  const RECORDED = '2fc979d5b645c72551e2c35982e3c0ef54ee9cebd5980a6c7c6e7d7c96488745';
  const PREDECESSOR = 'ed4e99ee6e8c640ea6e71349f74bd7fed31f60627914f92121b1bc3b1f93c8be';
  // Against the live record the accepted set is exactly the recorded identity: the
  // pre-transition template the deploy started from is no longer accepted.
  assert.deepEqual(acceptedLiveRuntimeHashes(), [RECORDED]);
  assert.equal(acceptedLiveRuntimeHashes()[0], recordedRuntimePhaseHash());
  assert.doesNotThrow(() => assertLiveRuntimeIdentity(RECORDED));
  assert.equal(assertLiveRuntimeIdentity(RECORDED), RECORDED);
  assert.throws(() => assertLiveRuntimeIdentity(PREDECESSOR), /not the recorded roles-added identity/);
  assert.throws(() => assertLiveRuntimeIdentity('f'.repeat(64)), /not the recorded roles-added identity/);
  // An empty accepted set can never pass.
  assert.throws(() => assertLiveRuntimeIdentity(RECORDED, []), /accepted Runtime live identities are unavailable/);
  // The absent-member case is the live record itself: it carries no predecessor
  // member and its reader yields none.
  const liveRecord = JSON.parse(readFileSync('test/baselines/provenance.json', 'utf8'));
  assert.equal(Object.hasOwn(liveRecord.runtime_identity.identity_revision, 'accepted_live_predecessors'), false);
  assert.deepEqual(recordedLivePredecessors(liveRecord.runtime_identity.identity_revision), []);
  // A record that does carry one predecessor still yields [recorded, predecessor] and
  // accepts it, so the read path stays inert rather than removed; a malformed list or
  // entry fails closed instead of widening the drift allowance.
  const record = (identityRevision) => ({ runtime_identity: { identity_phases: { 'roles-added': RECORDED },
    identity_revision: identityRevision } });
  assert.deepEqual(acceptedLiveRuntimeHashes(record(undefined)), [RECORDED]);
  assert.deepEqual(acceptedLiveRuntimeHashes(record({})), [RECORDED]);
  assert.deepEqual(recordedLivePredecessors(undefined), []);
  assert.deepEqual(acceptedLiveRuntimeHashes(record({ accepted_live_predecessors: [PREDECESSOR] })), [RECORDED, PREDECESSOR]);
  assert.doesNotThrow(() => assertLiveRuntimeIdentity(PREDECESSOR,
    acceptedLiveRuntimeHashes(record({ accepted_live_predecessors: [PREDECESSOR] }))));
  for (const malformed of [{ accepted_live_predecessors: PREDECESSOR },
    { accepted_live_predecessors: ['not-a-digest'] },
    { accepted_live_predecessors: [PREDECESSOR, 'a'.repeat(63)] }]) {
    assert.throws(() => acceptedLiveRuntimeHashes(record(malformed)), /Runtime live predecessor/);
  }
});

test('a change set is classified as converged or as a delta, and the guards fail closed', () => {
  assert.deepEqual(classifyChangeSet(undefined).converged, true);
  assert.deepEqual(classifyChangeSet({ Status: 'FAILED', StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." }), {
    converged: true, failed: false, status: 'FAILED', execution_status: 'unknown',
    reason: "The submitted information didn't contain changes. Submit different information to create a change set.",
    changes: [], resource_changes: [], diagnostic_changes: [], replacement: false,
  });
  assert.equal(classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [] }).converged, true);
  const delta = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'ComputeRuntimeApiServiceD2475D0A', resourceType: 'AWS::ECS::Service', replacement: 'Conditional' }),
    changeRow('Add', { logicalId: 'New', resourceType: 'AWS::S3::Bucket' }),
  ] });
  assert.equal(delta.converged, false);
  assert.equal(delta.replacement, true);
  // The real row keeps the change-set row type in `action` and the real action in
  // `action_type`; the guards judge the latter (issue #220's deployment defect).
  assert.equal(delta.changes[0].action, 'Resource');
  assert.equal(delta.changes[0].action_type, 'Modify');
  assert.equal(delta.changes[1].action_type, 'Add');
  // Issue #220: the unchanged-release guard refuses the conditional replacement.
  assert.throws(() => assertReleaseStableChangeSet(delta),
    /only Add\/Modify changes without replacement; the change set lists 1 refused: Modify ComputeRuntimeApiServiceD2475D0A \(Conditional\)/);
  assert.throws(() => assertReleaseStableChangeSet({ ...classifyChangeSet({ Status: 'FAILED', StatusReason: 'AccessDenied' }) }),
    /change set failed/);
  // A non-replacement Add or Modify is what the board authorized: admitted.
  assert.doesNotThrow(() => assertReleaseStableChangeSet(classifyChangeSet({ Status: 'CREATE_COMPLETE', Changes: [
    changeRow('Add', { logicalId: 'A', resourceType: 'AWS::S3::Bucket' }),
    changeRow('Modify', { logicalId: 'B', resourceType: 'AWS::CloudWatch::Alarm' })] })));
  // The Add-only create path judges the real action too: all-Add rows are
  // admitted, and one Modify or Remove row refuses the whole set.
  const createOnly = classifyChangeSet({ Status: 'CREATE_COMPLETE', Changes: [
    changeRow('Add', { logicalId: 'A', resourceType: 'AWS::S3::Bucket' }),
    changeRow('Add', { logicalId: 'B', resourceType: 'AWS::CloudFormation::WaitConditionHandle' })] });
  assert.doesNotThrow(() => assertCreateOnlyChangeSet(createOnly));
  for (const action of ['Modify', 'Remove']) {
    const notCreateOnly = classifyChangeSet({ Status: 'CREATE_COMPLETE', Changes: [
      changeRow('Add', { logicalId: 'A', resourceType: 'AWS::S3::Bucket' }),
      changeRow(action, { logicalId: 'B', resourceType: 'AWS::S3::Bucket' })] });
    assert.throws(() => assertCreateOnlyChangeSet(notCreateOnly), /created only with Add changes/, action);
  }
  assert.throws(() => assertCreateOnlyChangeSet(delta), /created only with Add changes/);

  // Issue #195: `AWS::CDK::Metadata` is the declared diagnostic metadata the
  // template normalisation drops, so a change to it is evidence, not a stack
  // change, a delta or a replacement.
  assert.deepEqual(DECLARED_DIAGNOSTIC_RESOURCE_TYPES, ['AWS::CDK::Metadata']);
  const diagnostic = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'CDKMetadata', resourceType: 'AWS::CDK::Metadata', replacement: 'Conditional' })] });
  const diagnosticRow = { action: 'Resource', logical_id: 'CDKMetadata', resource_type: 'AWS::CDK::Metadata',
    action_type: 'Modify', replacement: 'Conditional', declared_diagnostic: true, excluded: DECLARED_DIAGNOSTIC_EXCLUSION };
  assert.equal(diagnostic.converged, true);
  assert.equal(diagnostic.failed, false);
  assert.equal(diagnostic.replacement, false, 'a diagnostic conditional replacement is not a replacement');
  assert.deepEqual(diagnostic.resource_changes, []);
  assert.deepEqual(diagnostic.diagnostic_changes, [diagnosticRow]);
  assert.deepEqual(diagnostic.changes, [diagnosticRow]);
  assert.doesNotThrow(() => assertReleaseStableChangeSet(diagnostic));

  // A real non-replacement Modify beside a diagnostic row is admitted by the issue
  // #220 rule; only real rows count and only their replacement flags report.
  const mixed = classifyChangeSet({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'ComputeRuntimeApiServiceD2475D0A', resourceType: 'AWS::ECS::Service' }),
    changeRow('Modify', { logicalId: 'CDKMetadata', resourceType: 'AWS::CDK::Metadata', replacement: 'Conditional' })] });
  assert.equal(mixed.converged, false);
  assert.equal(mixed.replacement, false, 'the diagnostic row does not raise the replacement flag');
  assert.deepEqual(mixed.resource_changes.map((change) => change.logical_id), ['ComputeRuntimeApiServiceD2475D0A']);
  assert.doesNotThrow(() => assertReleaseStableChangeSet(mixed));
  // The issue #220 deployment shape itself: five real rows, all Add/Modify with
  // Replacement False, are admitted as one delta.
  assert.doesNotThrow(() => assertReleaseStableChangeSet(classifyChangeSet({ Status: 'CREATE_COMPLETE', Changes: [
    changeRow('Modify', { logicalId: 'ComputeRuntimeAutoTaggingAgeAlarmDF06D465', resourceType: 'AWS::CloudWatch::Alarm' }),
    changeRow('Modify', { logicalId: 'ComputeRuntimeOutboxOldestAgeAlarm3F5E8F76', resourceType: 'AWS::CloudWatch::Alarm' }),
    changeRow('Modify', { logicalId: 'ComputeRuntimeVtoAgeAlarm02DEBB57', resourceType: 'AWS::CloudWatch::Alarm' }),
    changeRow('Modify', { logicalId: 'ComputeRuntimeWorkerOutboxMetricFilterD1E82153', resourceType: 'AWS::Logs::MetricFilter' }),
    changeRow('Add', { logicalId: 'ComputeRuntimeWorkerOutboxMissingAgeFilterCE0F140F', resourceType: 'AWS::Logs::MetricFilter' })] })));
});

test('only the recorded live identity phase passes for the Runtime operations', () => {
  assert.doesNotThrow(() => assertRuntimePhase('deploy-runtime', env()));
  for (const phase of ['legacy', 'retired', undefined]) {
    assert.throws(() => assertRuntimePhase('deploy-runtime', { ...env(), INFRA_IDENTITY_PHASE: phase }),
      /requires the recorded live identity phase roles-added/);
  }
  assert.throws(() => assertRuntimePhase('deploy-platform', env()), /Runtime operation required/);
  assert.equal(runtimeChangeSetName({ GITHUB_RUN_ID: '123' }), 'anywear-runtime-123');
});

test('/health identity mismatches fail immediately and an unavailable endpoint times out', async () => {
  const fetchJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: 'd'.repeat(40), image_digest: IMAGE_DIGEST, minimum_client_version: 0 }) }),
  /health commit/);
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: SERVICE_SHA, image_digest: IMAGE_DIGEST, minimum_client_version: -1 }) }),
  /minimum client version/);
  await assert.rejects(readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), timeoutMs: 1 }), /did not identify the release/);
  assert.equal(await readRuntimeHealth('https://example.cloudfront.net', release,
    { fetchImpl: fetchJson({ status: 'ok', service_commit: SERVICE_SHA, image_digest: IMAGE_DIGEST, minimum_client_version: 4 }) }), 4);
});

test('a non-terminal Base or Runtime fails before any change set or mutation', async () => {
  await assert.rejects(deploy({ env: env(), release,
    io: fakeIo({ base: { StackName: 'AnyWearPlatformStack-beta', StackStatus: 'UPDATE_IN_PROGRESS' } }).io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Base stack/);
  const nonTerminal = fakeIo({ runtime: liveStack({ terminal: false }) });
  await assert.rejects(deploy({ env: env(), release, io: nonTerminal.io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }), /terminal Runtime stack/);
  assert.equal(nonTerminal.calls.some((call) => call.key === 'cdk/deploy'), false);
});

// Issue #194 acceptance: a schema-boundary refusal stops the run at the gate. The
// gate is the real runner (only its asset, probe, log and comparison transport are
// injected), so the refusal is the production one. Nothing after the gate runs: no
// synthesis, no CDK change-set call, no deployed identity.
test('a schema-boundary refusal fails the run before synthesis, the change set and the record', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  const assetBytes = readFileSync('test/fixtures/schema-boundary/schema-asset.json');
  const liveRead = JSON.parse(readFileSync('test/fixtures/schema-boundary/live-read-compatible.json', 'utf8'));
  // Synthetic ahead variant: one applied row the release does not contain. The
  // captured last serial is 133, so the next applied row would be 134.
  const ahead = structuredClone(liveRead);
  ahead.applied.push({ id: 134, tag: '0026_newer_fly', created_at: ahead.applied.at(-1).created_at + 1000,
    hash: 'f'.repeat(64) });
  const definitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7';
  const task = { taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
    clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', lastStatus: 'STOPPED',
    taskDefinitionArn: definitionArn,
    containers: [{ name: 'OneShot', exitCode: 0, imageDigest: IMAGE_DIGEST }] };
  const definition = { family: 'beta-anywear-verify', taskDefinitionArn: definitionArn };
  let synthesized = 0;
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => { synthesized += 1; return SYNTHESIZED; }, health: HEALTH, bake: BAKE,
    schemaGate: (options) => runSchemaBoundaryGate({ ...options,
      loadAsset: async () => ({ asset: JSON.parse(assetBytes.toString('utf8')), bytes: assetBytes,
        sha256: sha256(assetBytes) }),
      probe: async () => ({ task, definition }), readLog: async () => ahead }) }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'applied-beyond-release'
    && /expected release journal ends at 0025_new_human_fly/.test(error.message)
    && /observed database row 134 at index 26 0026_newer_fly/.test(error.message));
  assert.equal(synthesized, 0, 'synthesis never runs after a refusal');
  assert.equal(calls.some((call) => call.key === 'cdk/deploy'), false, 'no CDK change-set call');
  assert.equal(calls.some((call) => call.key === 'cloudformation/describe-change-set'), false);
});

// Issue #252 acceptance: the schema-journal connect timeout (exit 4) is a named
// refusal, and it still stops the run at the gate before synthesis, the change
// set and any stack mutation. The real gate runs; only its transport is injected.
test('a schema-journal connect timeout fails the run before synthesis, the change set and the record', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  const assetBytes = readFileSync('test/fixtures/schema-boundary/schema-asset.json');
  const definitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:207';
  const task = { taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`,
    clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear', lastStatus: 'STOPPED',
    taskDefinitionArn: definitionArn,
    containers: [{ name: 'OneShot', exitCode: 4, imageDigest: IMAGE_DIGEST }] };
  const definition = { family: 'beta-anywear-verify', taskDefinitionArn: definitionArn };
  let synthesized = 0;
  let logReads = 0;
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => { synthesized += 1; return SYNTHESIZED; }, health: HEALTH, bake: BAKE,
    schemaGate: (options) => runSchemaBoundaryGate({ ...options,
      loadAsset: async () => ({ asset: JSON.parse(assetBytes.toString('utf8')), bytes: assetBytes,
        sha256: sha256(assetBytes) }),
      probe: async () => ({ task, definition }),
      readLog: async () => { logReads += 1; return null; } }) }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'reader-connect-timeout'
    && /connect timeout/i.test(error.message)
    && /did not answer in time/i.test(error.message)
    && /dispatch the run again/i.test(error.message)
    && /not a schema-boundary disagreement/i.test(error.message));
  assert.equal(synthesized, 0, 'synthesis never runs after a refusal');
  assert.equal(logReads, 0, 'the exit code is judged before any journal read');
  assert.equal(calls.some((call) => call.key === 'cdk/deploy'), false, 'no CDK change-set call');
  assert.equal(calls.some((call) => call.key === 'cloudformation/describe-change-set'), false);
});

test('a converged stack records an empty change set, executes nothing and returns the deployed identity', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  let gateOptions;
  const deployment = await deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE,
    schemaGate: async (options) => { gateOptions = options; return { result: 'compatible' }; } });
  assert.deepEqual(deployment, { service_sha: SERVICE_SHA, image_digest: IMAGE_DIGEST,
    minimum_client_version: 0, template_sha256: SYNTHESIZED.normalised_sha256 });
  // Issue #194: the gate runs on the release identity and the revision the
  // pre-state parameters pin.
  assert.deepEqual(gateOptions.release, { releaseTag: release.releaseTag, serviceCommit: SERVICE_SHA,
    imageDigest: IMAGE_DIGEST });
  assert.deepEqual(gateOptions.deployedRevision, { serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST });
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'a converged no-op executes nothing');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')));
});

// Issue #195 blocking fix: `deploy-runtime` must hand the bake the four queue
// URLs and the cluster name from the 39-name stage-contract read. A queue name
// makes every `sqs get-queue-attributes --queue-url` read fail at Deployment, so
// the gate can never pass and the run fails.
test('the bake receives the contract queue URLs and cluster, not hardcoded names', async () => {
  const { io } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  const captured = capturingBake();
  await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH,
    bake: captured.bake });
  assert.equal(captured.baked.length, 1);
  const options = captured.baked[0];
  assert.deepEqual(options.queueUrls, {
    vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
    auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
    vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
    auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
  });
  for (const [purpose, url] of Object.entries(options.queueUrls)) {
    assert.match(url, /^https:\/\/sqs\.[a-z0-9.-]+\/\d{12}\/[A-Za-z0-9_.-]+$/, purpose);
  }
  assert.equal(options.cluster, 'beta-anywear');
  // The bake still selects the CloudWatch QueueName dimensions by name; the
  // contract read supplies the URLs and the cluster, and nothing in the
  // operation hardcodes an account, region or queue URL.
  const source = readFileSync('scripts/runtime-deploy.mjs', 'utf8');
  assert.equal(/beta-anywear-vto'|sqs\.ap-east-1\.amazonaws\.com/.test(source), false);
});

// Issue #220 (board-authorized): under an unchanged release identity a reviewed,
// non-replacement Runtime template delta is admitted, executed and baked. Every
// `Remove`, and any `Add`/`Modify` whose replacement is `True` or `Conditional`,
// still deletes the change set and fails closed with the named delta.
test('an unchanged release identity admits only a non-replacement Add/Modify delta; Remove and every replacement fail closed', async () => {
  const changesFor = (changes) => ({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: changes });
  const row = (action, replacement, logicalId = 'ComputeRuntimeWorkerOutboxMissingAgeFilterCE0F140F') =>
    changeRow(action, { logicalId, resourceType: 'AWS::Logs::MetricFilter', replacement });
  // The deployment shape this issue produces: three alarm Modify rows, one filter
  // Modify row and one filter Add row, all `Replacement: False`, are one admitted
  // delta (run 39985377613 refused exactly these five real rows).
  {
    const { io, calls } = fakeIo({ changeSet: changesFor([
      changeRow('Modify', { logicalId: 'ComputeRuntimeAutoTaggingAgeAlarmDF06D465', resourceType: 'AWS::CloudWatch::Alarm' }),
      changeRow('Modify', { logicalId: 'ComputeRuntimeOutboxOldestAgeAlarm3F5E8F76', resourceType: 'AWS::CloudWatch::Alarm' }),
      changeRow('Modify', { logicalId: 'ComputeRuntimeVtoAgeAlarm02DEBB57', resourceType: 'AWS::CloudWatch::Alarm' }),
      changeRow('Modify', { logicalId: 'ComputeRuntimeWorkerOutboxMetricFilterD1E82153', resourceType: 'AWS::Logs::MetricFilter' }),
      changeRow('Add', { logicalId: 'ComputeRuntimeWorkerOutboxMissingAgeFilterCE0F140F', resourceType: 'AWS::Logs::MetricFilter' }),
    ]) });
    const captured = capturingBake();
    await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: captured.bake });
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')), 'the real five-row delta executes');
    assert.equal(captured.baked.length, 1, 'the real five-row delta bakes');
    assert.deepEqual(io.changedStacks, [RUNTIME_STACK]);
  }
  // Admitted: the two rows are the shape this issue's own change set has — an Add
  // and a Modify, neither a replacement.
  for (const [action, replacement] of [['Add', 'False'], ['Modify', 'False']]) {
    const { io, calls } = fakeIo({ changeSet: changesFor([
      row('Modify', 'False', 'ComputeRuntimeVtoAgeAlarm02DEBB57'),
      row(action, replacement),
    ]) });
    const captured = capturingBake();
    const deployment = await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
      health: HEALTH, bake: captured.bake });
    assert.equal(deployment.template_sha256, SYNTHESIZED.normalised_sha256, action);
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')), `${action}: the admitted delta executes`);
    assert.equal(calls.some((call) => call.args?.includes('delete-change-set')), false,
      `${action}: an admitted change set is executed, not deleted`);
    assert.equal(captured.baked.length, 1, `${action}: the admitted delta still bakes`);
    assert.deepEqual(io.changedStacks, [RUNTIME_STACK], `${action}: the executed delta is recorded as changed`);
  }
  // Refused: a Remove, and any Add/Modify whose replacement is not `False`. One
  // refused row refuses the whole set.
  for (const [label, changes] of [
    ['Remove', [row('Remove', 'False')]],
    ['Modify/True', [row('Modify', 'True')]],
    ['Modify/Conditional', [row('Modify', 'Conditional')]],
    ['Add/True', [row('Add', 'True')]],
    ['Add/Conditional', [row('Add', 'Conditional')]],
    ['Modify/False plus Remove', [row('Modify', 'False'), row('Remove', 'False', 'ComputeRuntimeVtoAgeAlarm02DEBB57')]],
  ]) {
    const { io, calls } = fakeIo({ changeSet: changesFor(changes) });
    const captured = capturingBake();
    await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
      health: HEALTH, bake: captured.bake }), /only Add\/Modify changes without replacement/, label);
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, `${label}: refused before execution`);
    assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), `${label}: the refused change set is deleted`);
    assert.equal(captured.baked.length, 0, `${label}: no bake`);
    assert.deepEqual(io.changedStacks, [], `${label}: nothing changed`);
  }
  // The widened rule admits nothing else: a different release identity keeps the
  // existing execute path, and the converged no-op and the Add-only create path
  // have their own tests below.
  {
    const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }),
      changeSet: changesFor([row('Modify', 'False', 'ComputeRuntimeVtoAgeAlarm02DEBB57')]) });
    await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE });
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')),
      'a different release identity still executes under the existing path');
  }
});

// Issue #220: the admitted delta must still normalise to the recorded roles-added
// identity, so an unreviewed template is refused before any change-set call.
test('a synthesized Runtime template that does not normalise to the recorded identity is refused', async () => {
  // The fixture template is the recorded legacy-phase baseline; the same
  // normalisation runs with the fixture's own hash and with a wrong one.
  assert.equal(assertSynthesizedRuntimeIdentity(SYNTHESIZED.template, SYNTHESIZED.expected), SYNTHESIZED.expected);
  assert.throws(() => assertSynthesizedRuntimeIdentity(SYNTHESIZED.template, 'f'.repeat(64)),
    /normalises to [a-f0-9]{64}, not the recorded roles-added identity/);
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'ComputeRuntimeVtoAgeAlarm02DEBB57', resourceType: 'AWS::CloudWatch::Alarm' })] } });
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => { assertSynthesizedRuntimeIdentity(SYNTHESIZED.template, 'f'.repeat(64)); },
    health: HEALTH, bake: BAKE }), /not the recorded roles-added identity/);
  assert.equal(calls.some((call) => call.key === 'cdk/deploy'), false, 'no change-set call after a synthesis-identity refusal');
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false);
});

// Issue #195 acceptance: a converged release's only change is the CDKMetadata
// Analytics payload, which the declared normalisation drops. It must execute
// nothing, delete the change set, and let the operation continue to read back and
// bake.
test('a CDKMetadata-only change set is converged: it executes nothing and is deleted', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'CDKMetadata', resourceType: 'AWS::CDK::Metadata', replacement: 'Conditional' })] } });
  const deployment = await deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE });
  assert.equal(deployment.template_sha256, SYNTHESIZED.normalised_sha256);
  assert.equal(deployment.service_sha, SERVICE_SHA);
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'the diagnostic delta executes nothing');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), 'the diagnostic-only change set is deleted');
  const deleteIndex = calls.findIndex((call) => call.args?.includes('delete-change-set'));
  assert.equal(calls.slice(deleteIndex + 1).some((call) => call.args?.includes('describe-change-set')), false,
    'the operation does not depend on describing the deleted change set');
});

// Issue #195 acceptance, kept by #220: only AWS::CDK::Metadata is declared
// diagnostics. A conditional replacement on a real resource still fails closed
// before execution, and the fail-closed path deletes the change set.
test('a Modify with Replacement: Conditional on a real resource fails closed and deletes the change set', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
    changeRow('Modify', { logicalId: 'ComputeRuntimeApiServiceD2475D0A', resourceType: 'AWS::ECS::Service', replacement: 'Conditional' })] } });
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }),
  /only Add\/Modify changes without replacement; the change set lists 1 refused: Modify ComputeRuntimeApiServiceD2475D0A \(Conditional\)/);
  assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, 'a replacement never executes');
  assert.ok(calls.some((call) => call.args?.includes('delete-change-set')), 'the fail-closed path deletes the change set');
});

// Issue #195 acceptance: a change-set execute failure leaves a failed run, and the
// bake never runs.
test('a change-set execute failure fails the run before the bake', async () => {
  const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }),
    changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      changeRow('Add', { logicalId: 'BetaReleaseChange', resourceType: 'AWS::S3::Bucket' })] },
    executeError: Object.assign(new Error('An error occurred (AccessDenied) when calling the ExecuteChangeSet operation'), {
      stderr: 'An error occurred (AccessDenied)' }) });
  const captured = capturingBake();
  await assert.rejects(deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED, health: HEALTH, bake: captured.bake }), /AccessDenied/);
  assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));
  assert.equal(captured.baked.length, 0, 'the bake never runs after a failed execution');
});

test('a breaching or insufficient-data bake fails the run', async () => {
  const healthy = gateBlock();
  const breaching = { ...healthy, result: 'failed', signals: healthy.signals.map((signal, index) => (index === 3
    ? { ...signal, state: 'breaching', exceptions: ['vto oldest-message age 151s exceeds 150s'] }
    : signal)) };
  const insufficient = failedGate({ stage: 'beta', cluster: 'beta-anywear',
    logGroup: '/anywear/beta/worker', serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST });
  assert.equal(insufficient.result, 'failed');
  assert.ok(insufficient.signals.every((signal) => signal.state === 'insufficient'));
  for (const [label, gate] of [['breaching', breaching], ['insufficient', insufficient]]) {
    const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    await assert.rejects(deploy({ env: env(), release, io,
      synthesize: async () => SYNTHESIZED, health: HEALTH, bake: async () => gate }),
    /The 300-second bake failed/, label);
    // A converged no-op still never executes a change set before a failed bake.
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false, label);
  }
});

test('an absent Runtime stack is an Add-only create that executes, and stop of an absent stack is a no-op', async () => {
  const { io, calls, setRuntime } = fakeIo({ runtime: null,
    changeSet: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
      changeRow('Add', { logicalId: 'ComputeRuntimeApiServiceD2475D0A', resourceType: 'AWS::ECS::Service' })] } });
  const deployment = await deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE });
  assert.equal(deployment.service_sha, SERVICE_SHA);
  assert.ok(calls.some((call) => call.args?.includes('execute-change-set')));

  setRuntime(undefined);
  assert.equal(await stopRuntime({ env: env({ INFRA_OPERATION: 'stop-runtime' }), io }), 'absent');
  assert.equal(calls.some((call) => call.key === 'cdk/destroy'), false);
});

test('the stage-input reader reads the reviewed 39 names in bounded batches', () => {
  assert.equal(RUNTIME_STAGE_INPUT_NAMES.length, 39);
  assert.equal(new Set(RUNTIME_STAGE_INPUT_NAMES).size, 39);
  assert.equal(RUNTIME_STAGE_INPUT_NAMES.includes('/anywear/beta/isolated_subnet_ids'), false);
  for (const name of ['/anywear/beta/api_base_url', '/anywear/beta/vlm_config_arn',
    '/anywear/beta/cloudfront_prefix_list_id', '/anywear/beta/qweather_api_host']) assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(name), name);
  const batches = runtimeStageInputBatches();
  assert.equal(batches.flat().length, 39);
  assert.ok(batches.every((batch) => batch.length <= 10));
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 10, 9]);
  // Every queue URL and the cluster name are contract names inside that read.
  for (const name of Object.values(RUNTIME_QUEUE_URL_NAMES)) assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(name), name);
  assert.ok(RUNTIME_STAGE_INPUT_NAMES.includes(RUNTIME_ECS_CLUSTER_INPUT));
});

test('one contract read yields both the hashed stage inputs and the bake values', async () => {
  const { io } = fakeIo();
  const contract = await readRuntimeStageContract(io);
  assert.equal(contract.inputs.length, 39);
  assert.equal(contract.values.size, 39);
  assert.equal(contract.values.get('/anywear/beta/ecs_cluster_name'), 'beta-anywear');
  // The bake consumes the same read the schema-boundary gate compares, so the
  // queue URL bytes can never differ between the operation's reads and the gate's
  // transport.
  assert.deepEqual(runtimeBakeQueueUrls(contract.values), {
    vto: QUEUE_URLS['/anywear/beta/vto_queue_url'],
    auto_tagging: QUEUE_URLS['/anywear/beta/auto_tagging_queue_url'],
    vto_dlq: QUEUE_URLS['/anywear/beta/vto_dlq_url'],
    auto_tagging_dlq: QUEUE_URLS['/anywear/beta/auto_tagging_dlq_url'],
  });
  assert.equal(runtimeEcsClusterName(contract.values), 'beta-anywear');
  for (const row of contract.inputs) {
    assert.match(row.value_sha256, /^[a-f0-9]{64}$/, row.parameter);
  }
});

test('a deploy-runtime dispatch from the wrong source, workflow family, account or region fails before credentials', () => {
  const dispatch = { ...env(), GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
    AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
    SERVICE_ARTIFACT_TAG: release.releaseTag, SERVICE_COMMIT: SERVICE_SHA };
  const inputs = validateOperationInputs(dispatch);
  assert.equal(inputs.operation, 'deploy-runtime');
  assert.deepEqual(inputs.service_release, { releaseTag: release.releaseTag, serviceCommit: SERVICE_SHA });
  // Another repository's dispatch cannot execute this operation, even with a
  // mutate.yml workflow ref: issue #266 compares the workflow ref against the
  // run's own full name, so a foreign repository matches no reviewed workflow.
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REPOSITORY: 'git-malu/AnyWear-Service' }),
    /Operation is forbidden for this workflow family/);
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REPOSITORY_ID: '1158460323' }),
    /Protected Infra main executor and activation required/);
  // Only reviewed main, and only a dispatch event, may run it.
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_REF: 'refs/heads/issue/195-release-slice-merge' }),
    /Protected Infra main executor and activation required/);
  assert.throws(() => validateOperationInputs({ ...dispatch, GITHUB_EVENT_NAME: 'push' }),
    /Protected Infra main executor and activation required/);
  // Wrong account, wrong region and the wrong workflow family fail closed.
  assert.throws(() => validateOperationInputs({ ...dispatch, AWS_ACCOUNT_ID: '111111111111' }), /Unexpected account\/region/);
  assert.throws(() => validateOperationInputs({ ...dispatch, AWS_REGION: 'us-east-1' }), /Unexpected account\/region/);
  assert.throws(() => validateOperationInputs({ ...dispatch,
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main' }),
  /Operation is forbidden for this workflow family/);
  // The sealed artifact identity is mandatory for this operation.
  assert.throws(() => validateOperationInputs({ ...dispatch, SERVICE_ARTIFACT_TAG: '' }),
    /deploy-runtime requires the explicit Service release tag/);
  assert.throws(() => validateOperationInputs({ ...dispatch, SERVICE_COMMIT: 'not-a-sha' }),
    /Service release source commit/);
});

// Review I-B1: `deploy-runtime` executes the change set itself, so the mutation has
// to be recorded at the point it happens — after `execute-change-set` returns and
// before the stack read-back, the ECS identity proof, `/health` and the bake. A
// landed update whose later gate refuses must still leave the one step-summary line
// that says "changed but unqualified"; a converged no-op must leave none.
const DELTA_CHANGE_SET = { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [
  changeRow('Modify', { logicalId: 'ComputeRuntimeApiServiceD2475D0A', resourceType: 'AWS::ECS::Service' })] };

// The dispatch `validateOperationInputs` accepts for `deploy-runtime`, plus the step
// summary the operation's catch appends to.
const operationEnv = (overrides = {}) => ({ ...env(), GITHUB_REPOSITORY_ID: '1409047265', GITHUB_EVENT_NAME: 'workflow_dispatch',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  SERVICE_ARTIFACT_TAG: release.releaseTag, SERVICE_COMMIT: SERVICE_SHA, ...overrides });

async function withSummary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-runtime-summary-'));
  try {
    return await run(path.join(directory, 'summary.md'));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('a bake refusal after the change set executed appends exactly one summary line naming the Runtime stack', async () => {
  await withSummary(async (summary) => {
    const { io, calls } = fakeIo({ runtime: liveStack({ identityUnchanged: false }), changeSet: DELTA_CHANGE_SET });
    const createIo = async (_environment, { changedStacks }) => { io.changedStacks = changedStacks; return io; };
    await assert.rejects(runOperation(operationEnv({ GITHUB_STEP_SUMMARY: summary }), {
      createIo,
      // Only the deploy's own collaborators are fake; the change-set judgement, the
      // mutation, the read-back and the gate ordering are the production ones.
      deployRuntimeDependencies: { schemaGate: SCHEMA_GATE, synthesize: async () => SYNTHESIZED, health: HEALTH,
        acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE,
        bake: async () => failedGate({ stage: 'beta', cluster: 'beta-anywear', logGroup: '/anywear/beta/worker',
          serviceSha: SERVICE_SHA, imageDigest: IMAGE_DIGEST }) },
    }), /The 300-second bake failed/);
    assert.ok(calls.some((call) => call.args?.includes('execute-change-set')), 'the change set executed first');
    const lines = (await readFile(summary, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one summary line');
    assert.match(lines[0], /Infra operation deploy-runtime already changed AnyWearRuntimeStack-beta and did not complete/);
    assert.equal((lines[0].match(/AnyWearRuntimeStack-beta/g) ?? []).length, 1,
      'the Runtime stack is named exactly once');
    assert.deepEqual(io.changedStacks, [RUNTIME_STACK], 'the landed mutation is recorded once');
  });
});

test('a converged deploy-runtime appends no changed-stack summary line', async () => {
  await withSummary(async (summary) => {
    const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
    const createIo = async (_environment, { changedStacks }) => { io.changedStacks = changedStacks; return io; };
    await runOperation(operationEnv({ GITHUB_STEP_SUMMARY: summary }), {
      createIo,
      deployRuntimeDependencies: { schemaGate: SCHEMA_GATE, synthesize: async () => SYNTHESIZED, health: HEALTH,
        acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE, bake: BAKE },
    });
    assert.equal(calls.some((call) => call.args?.includes('execute-change-set')), false,
      'a converged no-op executes nothing');
    const lines = (await readFile(summary, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'only the completed-operation line');
    assert.match(lines[0], /Infra operation deploy-runtime; source a{40}\./);
    assert.equal(lines[0].includes('already changed'), false);
    assert.deepEqual(io.changedStacks, [], 'a converged no-op records no changed stack');
  });
});

test('the executed change set is recorded as changed before the stack read-back can fail', async () => {
  const { io } = fakeIo({ runtime: liveStack({ identityUnchanged: false }), changeSet: DELTA_CHANGE_SET,
    postExecuteRuntime: { ...liveStack(), StackStatus: 'ROLLBACK_IN_PROGRESS' } });
  await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED, health: HEALTH, bake: BAKE }),
    /ended in ROLLBACK_IN_PROGRESS/);
  assert.deepEqual(io.changedStacks, [RUNTIME_STACK]);
});

// Issue #254 acceptance: the edge repair runs after the Runtime stack is terminal
// and its ECS identities are proven, and before the run's `/health` read. A stale
// recorded origin is one pinned previous-template write; an equal origin writes
// nothing and logs nothing; a failed write ends the run red naming the edge and
// reads no `/health`; a Base template without the parameter is refused by name
// before any Base mutation.
async function captureStdout(run) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { return { value: await run(), stdout: chunks.join('') }; }
  finally { process.stdout.write = original; }
}

const baseStackReads = (calls) => calls.filter((call) => call.key === 'cloudformation/describe-stacks'
  && call.args?.[call.args.indexOf('--stack-name') + 1] === BASE_STACK).length;

test('the pinned Base origin update reuses the previous template and only the one parameter', () => {
  assert.deepEqual(apiOriginUpdateArguments(API_ORIGIN_NEW), ['cloudformation', 'update-stack',
    '--stack-name', BASE_STACK, '--use-previous-template',
    '--parameters', 'ParameterKey=BootstrapVersion,UsePreviousValue=true',
    `ParameterKey=ApiOriginDomainName,ParameterValue=${API_ORIGIN_NEW}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM']);
  for (const value of ['', 'not a domain', ` ${API_ORIGIN_NEW}`, undefined]) {
    assert.throws(() => apiOriginUpdateArguments(value), /Invalid API origin DNS name/, String(value));
  }
});

// A Runtime change that leaves the Base origin stale: the start's own run repairs
// it. The `postExecuteRuntime` fixture carries the new load balancer, so the write
// is the one a cold start needs.
function staleOriginSurface(options = {}) {
  return fakeIo({ runtime: liveStack({ identityUnchanged: false, origin: API_ORIGIN_NEW }),
    postExecuteRuntime: liveStack({ origin: API_ORIGIN_NEW }), changeSet: DELTA_CHANGE_SET, ...options });
}

test('a stale Base origin parameter is written exactly once before /health', async () => {
  const { io, calls } = staleOriginSurface({ updateDelays: 1 });
  let healthReads = 0;
  let updateLandedBeforeHealth;
  const captured = await captureStdout(() => deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED,
    health: async () => {
      healthReads += 1;
      updateLandedBeforeHealth = calls.some((call) => call.args?.[1] === 'update-stack');
      return 0;
    },
    bake: BAKE }));
  const updates = calls.filter((call) => call.args?.[1] === 'update-stack');
  assert.equal(updates.length, 1, 'exactly one Base-stack call');
  assert.equal(updates[0].session, 'deploy', 'the write runs through the deploy session');
  assert.deepEqual(updates[0].args, ['cloudformation', 'update-stack', '--stack-name', BASE_STACK,
    '--use-previous-template', '--parameters', 'ParameterKey=BootstrapVersion,UsePreviousValue=true',
    `ParameterKey=ApiOriginDomainName,ParameterValue=${API_ORIGIN_NEW}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM']);
  assert.equal(healthReads, 1);
  assert.equal(updateLandedBeforeHealth, true, 'the origin write lands before /health is read');
  assert.match(captured.stdout, new RegExp(`api_origin_repointed ${API_ORIGIN_OLD} -> ${API_ORIGIN_NEW}`));
  // The Runtime change set and the Base parameter write are both landed changes.
  assert.deepEqual(io.changedStacks, [RUNTIME_STACK, BASE_STACK]);
  assert.ok(baseStackReads(calls) >= 3, 'the repair re-reads and polls the Base stack');
});

test('the repair poll does not accept the pre-update terminal read', async () => {
  // The first post-update read still describes the old `UPDATE_COMPLETE` state
  // with the pre-update `LastUpdatedTime`; only the read whose timestamp moved
  // ends the poll.
  const { io, calls } = staleOriginSurface({ updateStaleReads: 1, updateDelays: 1 });
  let healthReads = 0;
  const captured = await captureStdout(() => deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED,
    health: async () => { healthReads += 1; return 0; }, bake: BAKE }));
  assert.equal(calls.filter((call) => call.args?.[1] === 'update-stack').length, 1);
  assert.equal(healthReads, 1);
  assert.match(captured.stdout, new RegExp(`api_origin_repointed ${API_ORIGIN_OLD} -> ${API_ORIGIN_NEW}`));
  // start read + repair read + stale read + in-progress read + updated read.
  assert.ok(baseStackReads(calls) >= 5, `the poll kept reading past the stale read (${baseStackReads(calls)})`);
});

test('an equal Base origin parameter writes nothing and proceeds to /health', async () => {
  const { io, calls } = fakeIo({ changeSet: { Status: 'FAILED',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." } });
  let healthReads = 0;
  const captured = await captureStdout(() => deploy({ env: env(), release, io,
    synthesize: async () => SYNTHESIZED,
    health: async () => { healthReads += 1; return 0; }, bake: BAKE }));
  assert.equal(calls.some((call) => call.args?.[1] === 'update-stack'), false, 'no AWS write');
  assert.equal(healthReads, 1);
  assert.equal(captured.stdout.includes('api_origin_repointed'), false, 'no origin line');
  assert.deepEqual(io.changedStacks, [], 'the Base stack LastUpdatedTime is untouched');
});

test('a failed Base origin update ends the run red naming the edge and reads no /health', async () => {
  const cases = [
    ['CLI refusal', { updateError: Object.assign(
      new Error('An error occurred (AccessDenied) when calling the UpdateStack operation'),
      { stderr: 'An error occurred (AccessDenied)' }) }, false,
    /Beta edge origin was not written: cloudformation update-stack failed on AnyWearPlatformStack-beta \(ApiOriginDomainName\); \/health was not read/],
    // Deliberate divergence from the finding's wording: an accepted update that
    // rolls back is still a landed Base-stack update (CloudFormation started it),
    // so the change is recorded — exactly as the Runtime stack is recorded at
    // execute-change-set acceptance before `waitForTerminalStack`.
    ['rollback', { updateRollback: true }, true,
      /Beta edge origin was not written: AnyWearPlatformStack-beta's ApiOriginDomainName update to beta-anywear-api-1554590841\.ap-east-1\.elb\.amazonaws\.com ended in UPDATE_ROLLBACK_COMPLETE; \/health was not read/],
  ];
  for (const [label, options, recordsBaseChange, pattern] of cases) {
    const { io } = staleOriginSurface(options);
    let healthReads = 0;
    await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
      health: async () => { healthReads += 1; return 0; }, bake: BAKE }), pattern, label);
    assert.equal(healthReads, 0, `${label}: /health is not read`);
    assert.equal(io.changedStacks.includes(BASE_STACK), recordsBaseChange, recordsBaseChange
      ? `${label}: the accepted write is recorded`
      : `${label}: a refused call records no Base change`);
  }
});

// Issue #254 review: an accepted write whose poll cannot verify the stack is a
// landed Base change, and the failure must name the edge instead of polling to
// the deadline. A thrown read and a CloudFormation-absent read both take that path.
test('an accepted Base origin write whose poll read fails records the change and names the edge', async () => {
  const throttled = Object.assign(
    new Error('An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'),
    { stderr: 'aws: [ERROR]: An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded' });
  const { io } = staleOriginSurface({ pollReadError: throttled });
  let healthReads = 0;
  await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
    health: async () => { healthReads += 1; return 0; }, bake: BAKE }),
  /The Beta edge origin was not verified: ApiOriginDomainName was set to beta-anywear-api-1554590841\.ap-east-1\.elb\.amazonaws\.com but reading AnyWearPlatformStack-beta failed \(An error occurred \(Throttling\)/);
  assert.equal(healthReads, 0, '/health is not read');
  assert.ok(io.changedStacks.includes(BASE_STACK), 'the accepted write is recorded');
});

test('a post-update read that reports the Base stack absent records the change and names the edge', { timeout: 10_000 }, async () => {
  const { io } = staleOriginSurface({ pollAbsent: true });
  let healthReads = 0;
  await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
    health: async () => { healthReads += 1; return 0; }, bake: BAKE }),
  /The Beta edge origin was not verified: ApiOriginDomainName was set to beta-anywear-api-1554590841\.ap-east-1\.elb\.amazonaws\.com but AnyWearPlatformStack-beta is absent after the origin write; \/health was not read/);
  assert.equal(healthReads, 0, '/health is not read');
  assert.ok(io.changedStacks.includes(BASE_STACK), 'the accepted write is recorded');
});

test('a Base stack that does not declare ApiOriginDomainName is refused by name before mutating', async () => {
  const { io, calls } = fakeIo({
    base: baseStackFixture({ parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '7' }] }),
    changeSet: { Status: 'FAILED',
      StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." },
  });
  let healthReads = 0;
  await assert.rejects(deploy({ env: env(), release, io, synthesize: async () => SYNTHESIZED,
    health: async () => { healthReads += 1; return 0; }, bake: BAKE }),
  /AnyWearPlatformStack-beta does not declare the ApiOriginDomainName parameter, so the Beta edge origin cannot be written; one deploy-platform installs it/);
  assert.equal(calls.some((call) => call.args?.[1] === 'update-stack'), false);
  assert.equal(healthReads, 0);
  assert.deepEqual(io.changedStacks, []);
});

// Issue #254: the parameter write is a landed change, so a run that fails after
// it must name the Base stack in its one "changed but unqualified" summary line.
test('a /health refusal after the Base origin write names both changed stacks', async () => {
  await withSummary(async (summary) => {
    const { io } = staleOriginSurface({ updateDelays: 1 });
    const createIo = async (_environment, { changedStacks }) => { io.changedStacks = changedStacks; return io; };
    await assert.rejects(runOperation(operationEnv({ GITHUB_STEP_SUMMARY: summary }), {
      createIo,
      deployRuntimeDependencies: { schemaGate: SCHEMA_GATE, synthesize: async () => SYNTHESIZED,
        health: async () => { throw new Error('The deployed /health did not identify the release'); },
        acceptedLiveHashes: FIXTURE_ACCEPTED_LIVE, bake: BAKE },
    }), /did not identify the release/);
    const lines = (await readFile(summary, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one summary line');
    assert.match(lines[0], /Infra operation deploy-runtime already changed AnyWearRuntimeStack-beta, AnyWearPlatformStack-beta and did not complete/);
  });
});
