import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeIo, validateOperationInputs, cdkDeploymentArguments, deleteOperationStack,
  resolveServiceImageDigest, runOperation, serviceImageTag } from './runtime-operation.mjs';
import { runtimeStack } from './one-writer.mjs';

const egressStack = 'AnyWearEgressStack-beta';
const allocationId = 'eipalloc-0a5198fb91b876949';
const serviceCommit = 'b'.repeat(40);
const imageDigest = `sha256:${'9'.repeat(64)}`;
const env = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-egress', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
};
const stackAbsence = stackName => Object.assign(new Error(`aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`), {
  stderr: `aws: [ERROR]: An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id ${stackName} does not exist`,
});

test('the Egress EIP allocation is accepted only for deploy-egress and must be an eipalloc id', () => {
  const inputs = validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: allocationId });
  assert.equal(inputs.nat_eip_allocation_id, allocationId);
  // Empty means absence, as the workflow input's default.
  assert.equal(Object.hasOwn(validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: '' }), 'nat_eip_allocation_id'), false);
  assert.throws(() => validateOperationInputs({ ...env, INFRA_OPERATION: 'delete-egress', NAT_EIP_ALLOCATION_ID: allocationId }),
    /belongs only to deploy-egress/);
  for (const value of ['eipalloc-XYZ', 'eipalloc-', 'eip-0a5198fb91b876949', 'eipalloc-0a5198fb91b876949 ']) {
    assert.throws(() => validateOperationInputs({ ...env, NAT_EIP_ALLOCATION_ID: value }),
      /must be an Elastic IP allocation id/, value);
  }
});

test('the Egress deploy passes the retained allocation as CDK context', () => {
  const args = cdkDeploymentArguments(egressStack, '/tmp/artifacts', env, { natEipAllocationId: allocationId });
  assert.ok(args.includes('natEipAllocationId=eipalloc-0a5198fb91b876949'));
  assert.ok(args.includes('-c'));
  assert.equal(cdkDeploymentArguments(egressStack, '/tmp/artifacts', env).some(arg => arg.startsWith('natEipAllocationId=')), false);
});

// Issue #254: both Base-deploying operations resolve the origin through
// `readApiOrigin` (the live `ApiOriginDomainName` parameter while the Runtime
// stack is absent) and pass it as the `ApiOriginDomainName` stack parameter, never
// as the old `-c apiOriginDomainName` synthesis context.
test('a Base deploy passes the live Base parameter as the ApiOriginDomainName parameter', async () => {
  const liveOrigin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';
  for (const operation of ['deploy-platform', 'restore-release']) {
    const changedStacks = [];
    const calls = [];
    const run = async (command, args) => {
      if (command === 'npx') { calls.push({ command, args }); return { stdout: '', stderr: '' }; }
      if (command !== 'aws') throw new Error(`Unexpected command ${command}`);
      if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
        return { stdout: JSON.stringify({ Account: '111111111111' }) };
      }
      if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
        const name = args[args.indexOf('--stack-name') + 1];
        if (name === runtimeStack) throw stackAbsence(name);
        if (name === 'AnyWearPlatformStack-beta') {
          return { stdout: JSON.stringify({ Stacks: [{ StackName: 'AnyWearPlatformStack-beta',
            StackStatus: 'UPDATE_COMPLETE',
            Parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '7' },
              { ParameterKey: 'ApiOriginDomainName', ParameterValue: liveOrigin }] }] }) };
        }
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    };
    const io = await createRuntimeIo({ ...env, INFRA_OPERATION: operation, TESTER_EMAILS: '[]',
      SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit }, {
      purpose: 'operation', run, changedStacks,
      assume: async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' }),
      directory: '/verified',
    });
    // The fake's foreign account refuses the post-deploy retention read, so the
    // assertion is on the deploy arguments the run already issued.
    await assert.rejects(io.deploy('AnyWearPlatformStack-beta'), /Unexpected Beta log retention account/);
    const deploy = calls.find(call => call.command === 'npx');
    assert.ok(deploy, operation);
    const parameter = deploy.args.indexOf('--parameters');
    assert.ok(parameter > 0, `${operation}: the origin travels as a stack parameter`);
    assert.equal(deploy.args[parameter + 1], `ApiOriginDomainName=${liveOrigin}`, operation);
    assert.equal(deploy.args.some(arg => arg.startsWith('apiOriginDomainName=')), false,
      `${operation}: the deleted synthesis context is not passed`);
    assert.deepEqual(changedStacks, ['AnyWearPlatformStack-beta'], operation);
  }
});

// The retained EIP is the allocation the next start must reuse, so delete-egress
// still refuses when the stack cannot report it before the destroy.
test('delete-egress proves the retained EIP allocation before destroying the stack', async () => {
  const destroyed = [];
  const io = {
    async aws(args) {
      const name = args[args.indexOf('--stack-name') + 1];
      if (name === runtimeStack) throw stackAbsence(name);
      if (name === egressStack) {
        return { Stacks: [{ StackName: egressStack, StackStatus: 'UPDATE_COMPLETE',
          Outputs: [{ OutputKey: 'EgressNatEipAllocationId', OutputValue: allocationId }] }] };
      }
      throw new Error(`Unexpected stack ${name}`);
    },
    async destroy(stack) { destroyed.push(stack); },
  };
  assert.equal(await deleteOperationStack(io, 'delete-egress'), egressStack);
  assert.deepEqual(destroyed, [egressStack]);
  const withoutOutput = { ...io, async aws(args) {
    const name = args[args.indexOf('--stack-name') + 1];
    if (name === runtimeStack) throw stackAbsence(name);
    return { Stacks: [{ StackName: egressStack, StackStatus: 'UPDATE_COMPLETE', Outputs: [] }] };
  } };
  await assert.rejects(deleteOperationStack(withoutOutput, 'delete-egress'),
    /requires the EgressNatEipAllocationId output/);
});

// #193: a release operation resolves the deployed image digest from the immutable
// ECR tag Service's deploy chain pushes for one Service commit.
test('a release operation resolves the immutable ECR tag to its image digest', async () => {
  const tag = `service-artifacts-${serviceCommit}`;
  const calls = [];
  const io = { async aws(args) { calls.push(args); return { imageDetails: [{ imageDigest, imageTags: [tag] }] }; } };
  assert.equal(serviceImageTag(serviceCommit), tag);
  assert.equal(await resolveServiceImageDigest(io, serviceCommit), imageDigest);
  assert.deepEqual(calls, [['ecr', 'describe-images', '--repository-name', 'beta-anywear-service',
    '--image-ids', `imageTag=${tag}`]]);
});

test('a missing, ambiguous or malformed ECR tag fails before the deploy', async () => {
  const tag = `service-artifacts-${serviceCommit}`;
  const cases = [
    ['missing', { imageDetails: [] }, new RegExp(`ECR tag ${tag} does not resolve to exactly one image`)],
    ['absent', {}, new RegExp(`ECR tag ${tag} does not resolve to exactly one image`)],
    ['ambiguous', { imageDetails: [{ imageDigest, imageTags: [tag] },
      { imageDigest: `sha256:${'8'.repeat(64)}`, imageTags: [tag] }] }, new RegExp(`ECR tag ${tag} does not resolve`)],
    ['another tag', { imageDetails: [{ imageDigest, imageTags: ['service-artifacts-deadbeef'] }] },
      new RegExp(`ECR tag ${tag} does not name the resolved image`)],
    ['malformed digest', { imageDetails: [{ imageDigest: 'sha256:short', imageTags: [tag] }] },
      new RegExp(`Invalid ECR tag ${tag} image digest`)],
  ];
  for (const [label, response, pattern] of cases) {
    await assert.rejects(resolveServiceImageDigest({ aws: async () => response }, serviceCommit), pattern, label);
  }
});

// Issue #194: the non-throwing one-shot probe. `deploy-runtime` needs the verify
// task's container exit code as a *result* (the gate refuses `reader-failed`), so
// the probe returns it instead of turning a non-zero read into a launcher crash.
// The launch, authorization, unique identity, STOPPED, image-digest and command
// checks are the same ones `oneShot` performs and still throw.
const verifyEnv = {
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '',
  SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit,
};
const revision = { commit: serviceCommit, digest: imageDigest };
const verifyTaskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
const verifyDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7';
const verifyTask = (exitCode, digest = imageDigest) => ({
  taskArn: verifyTaskArn, clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
  lastStatus: 'STOPPED', taskDefinitionArn: verifyDefinitionArn,
  containers: [{ name: 'OneShot', exitCode, imageDigest: digest }],
});
const verifyDefinition = (command = ['node', 'dist/verify.js', 'schema-journal']) => ({
  family: 'beta-anywear-verify', taskDefinitionArn: verifyDefinitionArn,
  containerDefinitions: [{ name: 'OneShot', command }],
});

// The probe's launch surface: the preflight simulator answers allowed, the script
// prints the two identities, and the two ECS describes return the stopped task.
function probeIo({ exitCode = 0, scriptFailure = false, stdout, task = verifyTask(exitCode),
  definition = verifyDefinition() } = {}) {
  const calls = [];
  const assumeCalls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'aws' && args[0] === 'iam') {
      return { stdout: JSON.stringify({ EvaluationResults: [{ EvalActionName: 'x', EvalResourceName: '*',
        EvalDecision: 'allowed' }] }) };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-tasks') {
      return { stdout: JSON.stringify({ tasks: [task] }) };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-task-definition') {
      return { stdout: JSON.stringify({ taskDefinition: definition }) };
    }
    if (command === 'bash') {
      const printed = stdout ?? `Task ARN: ${verifyTaskArn}\nTask definition: ${verifyDefinitionArn}\n`;
      if (scriptFailure) throw Object.assign(new Error('script exited 1'), { stdout: printed, stderr: '' });
      return { stdout: printed, stderr: '' };
    }
    throw new Error(`unexpected run ${command} ${args.join(' ')}`);
  };
  const assume = async (kind, _env, _purpose, options = {}) => {
    assumeCalls.push([kind, options.sessionMarker]);
    return { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' };
  };
  return { calls, assumeCalls, run, assume,
    io: () => createRuntimeIo(verifyEnv, { purpose: 'operation', run, assume }) };
}

test('the one-shot probe returns a zero container exit from the measured task', async () => {
  const surface = probeIo({ exitCode: 0 });
  const io = await surface.io();
  const result = await io.oneShotProbe('verify', revision, 'schema-journal');
  assert.equal(result.exitCode, 0);
  assert.equal(result.task.taskArn, verifyTaskArn);
  assert.equal(result.definition.taskDefinitionArn, verifyDefinitionArn);
  // The preflight and the runtime session were used, and the script received the
  // exact action as its fifth argument.
  assert.deepEqual(surface.assumeCalls, [['runtime', 'preflight'], ['runtime', undefined]]);
  const script = surface.calls.find(([command]) => command === 'bash');
  assert.deepEqual(script[1], ['.github/scripts/run-one-shot-task.sh', 'beta', 'verify', imageDigest,
    serviceCommit, 'schema-journal']);
});

test('the one-shot probe returns a non-zero container exit instead of throwing', async () => {
  const surface = probeIo({ exitCode: 3, scriptFailure: true });
  const io = await surface.io();
  // run-one-shot-task.sh exits 1 after printing the identity; the container exit
  // code is the probe result the schema gate judges as reader-failed.
  const result = await io.oneShotProbe('verify', revision, 'schema-journal');
  assert.equal(result.exitCode, 3);
});

test('the one-shot probe refuses a wrong action, command, image or missing identity', async () => {
  const surface = probeIo();
  const io = await surface.io();
  // A verify role with any other action is forbidden before a launch.
  await assert.rejects(io.oneShotProbe('verify', revision, 'status'), /One-shot role\/action is forbidden/);
  // Another verify command is not the schema-journal read.
  const wrongCommand = probeIo({ definition: verifyDefinition(['node', 'dist/verify.js']) });
  await assert.rejects((await wrongCommand.io()).oneShotProbe('verify', revision, 'schema-journal'),
    /Actual verify command differs from the requested action/);
  // A task running another image is not the revision the gate asked for. (The
  // existing file's `imageDigest` is `sha256:9…`, so the wrong image uses `8`.)
  const wrongImage = probeIo({ task: verifyTask(0, `sha256:${'8'.repeat(64)}`) });
  await assert.rejects((await wrongImage.io()).oneShotProbe('verify', revision, 'schema-journal'),
    /Actual one-shot image\/result differs from the deployed revision/);
  // A launch that prints no unique identity is a launch failure, not a result.
  const noIdentity = probeIo({ stdout: 'no identity here' });
  await assert.rejects((await noIdentity.io()).oneShotProbe('verify', revision, 'schema-journal'),
    /One-shot probe identity missing/);
});

// #243: `migrate` takes the sealed Service artifact identity instead of reading an
// image out of `AnyWearRuntimeStack-beta`, and reads Beta's stacks only to refuse a
// stopped or racing environment. These cases drive the real `runOperation` over an
// injected io, so what they observe is the real precondition order: every refusal
// fires before `io.oneShot`, which is what registers the task.
const baseStack = 'AnyWearPlatformStack-beta';
const migrateEnv = (overrides = {}) => ({
  ...env, INFRA_OPERATION: 'migrate',
  SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit, ...overrides,
});

// The stack surface the operation reads: Platform, Egress and Runtime. A `null`
// entry is the CloudFormation absence error `describeStack` translates to
// `undefined`, which is what a stopped Beta answers. The fake has no `deploy`, so a
// migration that tried to reach a stack mutation fails rather than passing.
function migrateStacksIo({ platform = { StackStatus: 'UPDATE_COMPLETE' },
  egress = { StackStatus: 'UPDATE_COMPLETE' }, runtime = null } = {}) {
  const egressStack = 'AnyWearEgressStack-beta';
  const stacks = new Map([[baseStack, platform], [egressStack, egress], [runtimeStack, runtime]]);
  const calls = [];
  const oneShots = [];
  const io = {
    async aws(args) {
      calls.push([...args]);
      if (args[0] === 'sts') return { Account: '650880818323' };
      if (args[0] === 'ecr') return { imageDetails: [{ imageDigest, imageTags: [`service-artifacts-${serviceCommit}`] }] };
      if (args[0] === 'cloudformation') {
        const name = args[args.indexOf('--stack-name') + 1];
        if (!stacks.has(name)) throw new Error(`Unexpected stack ${name}`);
        const stack = stacks.get(name);
        if (stack === null) throw stackAbsence(name);
        return { Stacks: [{ StackName: name, ...stack }] };
      }
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    },
    async oneShot(role, selected) { oneShots.push([role, selected]); },
  };
  return { calls, oneShots, io };
}

// Both streams, so a step-log assertion can be made about either one.
async function captureStreams(run) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    return { value: await run(), stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('migrate without a release identity is refused before any AWS call', async () => {
  let created = false;
  await assert.rejects(runOperation({ ...migrateEnv(), SERVICE_ARTIFACT_TAG: '', SERVICE_COMMIT: '' }, {
    createIo: async () => { created = true; return migrateStacksIo().io; },
  }), /^Error: migrate requires the explicit Service release tag$/);
  assert.equal(created, false, 'the refusal precedes the restricted session');
});

test('migrate refuses a non-terminal Platform stack by name', async () => {
  const surface = migrateStacksIo({ platform: { StackStatus: 'UPDATE_IN_PROGRESS' } });
  await assert.rejects(runOperation(migrateEnv(), { createIo: async () => surface.io }),
    /^Error: migrate requires a terminal AnyWearPlatformStack-beta; observed UPDATE_IN_PROGRESS$/);
  assert.equal(surface.oneShots.length, 0, 'the refusal precedes the task registration');
});

test('migrate refuses an absent Egress stack and names Beta start sequence', async () => {
  const surface = migrateStacksIo({ egress: null });
  await assert.rejects(runOperation(migrateEnv(), { createIo: async () => surface.io }),
    /^Error: migrate requires AnyWearEgressStack-beta; Beta is stopped, run its start sequence$/);
  assert.equal(surface.oneShots.length, 0, 'the refusal precedes the task registration');
});

test('migrate refuses a present but non-terminal Egress stack by name', async () => {
  const surface = migrateStacksIo({ egress: { StackStatus: 'ROLLBACK_IN_PROGRESS' } });
  await assert.rejects(runOperation(migrateEnv(), { createIo: async () => surface.io }),
    /^Error: migrate requires a terminal AnyWearEgressStack-beta; observed ROLLBACK_IN_PROGRESS$/);
  assert.equal(surface.oneShots.length, 0, 'the refusal precedes the task registration');
});

test('migrate refuses a present but non-terminal Runtime stack by name', async () => {
  const surface = migrateStacksIo({ runtime: { StackStatus: 'UPDATE_IN_PROGRESS' } });
  await assert.rejects(runOperation(migrateEnv(), { createIo: async () => surface.io }),
    /^Error: migrate requires a terminal AnyWearRuntimeStack-beta; observed UPDATE_IN_PROGRESS$/);
  assert.equal(surface.oneShots.length, 0, 'the refusal precedes the task registration');
});

test('migrate proceeds to the one-shot when the Runtime stack is absent', async () => {
  const surface = migrateStacksIo();
  const captured = await captureStreams(() => runOperation(migrateEnv(), { createIo: async () => surface.io }));
  assert.deepEqual(surface.oneShots, [['migrate', { digest: imageDigest, commit: serviceCommit }]]);
  // The step log carries the tag, the Service commit and the resolved digest.
  assert.match(captured.stdout,
    new RegExp(`migrate runs Service release service-artifacts-${serviceCommit}@${serviceCommit} from image ${imageDigest}`));
});

test('migrate runs the release digest and never a value read from a stack', async () => {
  const stackDigest = `sha256:${'7'.repeat(64)}`;
  const stackCommit = 'c'.repeat(40);
  const surface = migrateStacksIo({ runtime: { StackStatus: 'UPDATE_COMPLETE', Parameters: [
    { ParameterKey: 'ServiceImageDigest', ParameterValue: stackDigest },
    { ParameterKey: 'ServiceCommitSha', ParameterValue: stackCommit },
    { ParameterKey: 'VlmConfigArn', ParameterValue: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:test' },
    { ParameterKey: 'CloudFrontPrefixListId', ParameterValue: 'pl-test' }] } });
  await captureStreams(() => runOperation(migrateEnv(), { createIo: async () => surface.io }));
  // The ECR-resolved digest and the dispatched commit, not the deployed pair.
  assert.notEqual(imageDigest, stackDigest);
  assert.deepEqual(surface.oneShots, [['migrate', { digest: imageDigest, commit: serviceCommit }]]);
  // Exactly one ECR read under the release tag, and no stack write.
  assert.deepEqual(surface.calls.filter(call => call[0] === 'ecr'),
    [['ecr', 'describe-images', '--repository-name', 'beta-anywear-service',
      '--image-ids', `imageTag=service-artifacts-${serviceCommit}`]]);
});

// The launch surface `oneShot` uses for `migrate`: the preflight simulator answers
// allowed, the task script prints the two identities, and the ECS describes return
// a stopped task. `failing` reproduces the script exiting non-zero after it printed
// the identity, which is the case that used to lose the task.
const migrateTaskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
const migrateDefinitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-migrate:4';
function migrateOneShotSurface({ failing = false } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'aws' && args[0] === 'iam') {
      return { stdout: JSON.stringify({ EvaluationResults: [{ EvalActionName: 'x', EvalResourceName: '*',
        EvalDecision: 'allowed' }] }) };
    }
    if (command === 'bash') {
      const printed = `Task definition: ${migrateDefinitionArn}\nTask ARN: ${migrateTaskArn}\n`;
      if (failing) {
        throw Object.assign(new Error('script exited 1'), { stdout: printed,
          stderr: 'One-shot task failed with exit code 3\n' });
      }
      return { stdout: printed, stderr: '' };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-tasks') {
      return { stdout: JSON.stringify({ tasks: [{ taskArn: migrateTaskArn, lastStatus: 'STOPPED',
        taskDefinitionArn: migrateDefinitionArn, containers: [{ name: 'OneShot', exitCode: 0, imageDigest }] }] }) };
    }
    if (command === 'aws' && args[0] === 'ecs' && args[1] === 'describe-task-definition') {
      return { stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: migrateDefinitionArn,
        containerDefinitions: [{ name: 'OneShot', command: ['node', 'dist/migrate.js'] }] } }) };
    }
    throw new Error(`unexpected run ${command} ${args.join(' ')}`);
  };
  const assume = async () => ({ AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_SESSION_TOKEN: 'z' });
  return { calls, io: () => createRuntimeIo(migrateEnv(), { purpose: 'operation', run, assume }) };
}

test('migrate launches the one-shot with the release digest and commit', async () => {
  const surface = migrateOneShotSurface();
  const io = await surface.io();
  const captured = await captureStreams(() => io.oneShot('migrate', revision));
  // The exact launch surface: the script, the stage, the family, the resolved
  // digest and the dispatched commit.
  const script = surface.calls.find(([command]) => command === 'bash');
  assert.deepEqual(script[1], ['.github/scripts/run-one-shot-task.sh', 'beta', 'migrate', imageDigest,
    serviceCommit, '']);
  // The captured output is written once, not duplicated by the later path.
  assert.equal(captured.stdout.split('Task ARN:').length - 1, 1);
});

test('a failed migrate launch still names the task it started', async () => {
  const surface = migrateOneShotSurface({ failing: true });
  const io = await surface.io();
  const captured = await captureStreams(() => assert.rejects(io.oneShot('migrate', revision),
    /^Error: One-shot execution failed; preserve task resources and inspect redacted run evidence$/));
  // The identity the script printed before it waited reaches the step log.
  assert.equal(captured.stdout.split('Task ARN:').length - 1, 1);
  assert.match(captured.stdout, new RegExp(`Task ARN: ${migrateTaskArn}`));
  assert.match(captured.stdout, new RegExp(`Task definition: ${migrateDefinitionArn}`));
  assert.match(captured.stderr, /One-shot task failed with exit code 3/);
});
