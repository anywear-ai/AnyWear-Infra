import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runAuthorizationPreflight, AuthorizationPreflightError, simulationRequests, SIMULATION_SKIPS,
  PREFLIGHT_MARKER, preflightActionSet, CONTEXT_ENTRIES, READ_RESOURCES } from './authorization-preflight.mjs';
import { sessionPolicy, reads, readOperations, workflowOperations } from './operation-boundaries.mjs';
import { createRuntimeIo } from './runtime-operation.mjs';

// The pre-mutation preflight's contract (#165, narrowed by #214): the simulation
// plan comes from the reviewed reads table, both the base policy and the generated
// runtime session policy must allow every read, a missing action stops the
// operation before mutation, and the CDK deploy, change-set and destroy paths run
// no simulation at all.

const operationEnvironment = (operation, workflow = 'mutate') => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra',
  GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
  GITHUB_RUN_ID: '39100318242', GITHUB_RUN_ATTEMPT: '1', ENABLE_BETA_MUTATION: 'true',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', INFRA_IDENTITY_PHASE: 'retired',
  INFRA_RETENTION_PROTECTION: 'true', INFRA_OPERATION: operation, TESTER_EMAILS: '[]',
  // #226: every dispatch in this file is a human's, so the deploy chain's context
  // stays at the workflow defaults.
  DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '' });

const simulation = ({ denyAction } = {}) => async (command, args) => {
  if (command !== 'aws') throw new Error(`unexpected command ${command}`);
  // The driver prefixes the service (`iam`) before the simulation subcommand; a
  // direct call carries the subcommand first.
  const offset = args[0] === 'iam' ? 1 : 0;
  const subcommand = args[offset];
  if (subcommand !== 'simulate-principal-policy' && subcommand !== 'simulate-custom-policy') {
    throw new Error(`unexpected aws call ${args.join(' ')}`);
  }
  const actions = args.slice(args.indexOf('--action-names', offset) + 1, args.indexOf('--resource-arns', offset));
  const resources = args.slice(args.indexOf('--resource-arns', offset) + 1, args.indexOf('--context-entries', offset));
  const results = [];
  for (const action of actions.filter((value) => value.includes(':'))) {
    for (const resource of resources.filter((value) => value.includes(':') || value === '*')) {
      results.push({ EvalActionName: action, EvalResourceName: resource,
        EvalDecision: action === denyAction ? 'implicitDeny' : 'allowed' });
    }
  }
  return { stdout: JSON.stringify({ EvaluationResults: results }) };
};

const failingSimulation = (stderr) => async () => {
  const error = new Error('command failed');
  error.stderr = stderr;
  throw error;
};

test('the plan comes from the reviewed reads table and the runtime session policy', () => {
  const env = operationEnvironment('migrate');
  const runtime = simulationRequests('runtime', env, 'operation');
  const runtimePairs = runtime.map((request) => request.pair).sort();
  const expectedPairs = Object.keys(reads).filter((pair) => !(pair in SIMULATION_SKIPS)
    && !(pair in readOperations)).sort();
  assert.deepEqual(runtimePairs, expectedPairs);
  for (const request of runtime) {
    assert.equal(request.actions.includes(reads[request.pair]), true);
    assert.equal(request.resources.length > 0, true);
  }
  // `deploy-runtime` runs the bake, so its plan is every reviewed read, skips aside.
  const bake = simulationRequests('runtime', operationEnvironment('deploy-runtime'), 'operation');
  assert.deepEqual(bake.map((request) => request.pair).sort(),
    Object.keys(reads).filter((pair) => !(pair in SIMULATION_SKIPS)).sort());
  // Every plan action is also granted by the session policy the preflight runs under,
  // for the operation that runs the bake and for one that does not.
  for (const operation of ['migrate', 'deploy-runtime']) {
    const opEnv = operationEnvironment(operation);
    const sessionActions = new Set(JSON.parse(sessionPolicy('runtime', opEnv, 'operation'))
      .Statement.flatMap((statement) => [statement.Action].flat()));
    for (const action of preflightActionSet('runtime', opEnv, 'operation')) {
      assert.equal(sessionActions.has(action), true, `${operation}: ${action} is in the runtime session policy`);
    }
  }
  assert.deepEqual(Object.keys(SIMULATION_SKIPS).sort(), ['cloudfront/get-distribution', 'ecr/batch-get-image',
    'ecr/describe-images', 'ecr/get-lifecycle-policy', 'ecr/get-lifecycle-policy-preview',
    'ecr/start-lifecycle-policy-preview', 'ecs/register-task-definition', 'ecs/run-task', 'ecs/wait',
    'logs/get-log-events', 'logs/put-retention-policy', 'sts/get-caller-identity']);
  assert.equal(Object.keys(SIMULATION_SKIPS).length, 12);
});

test('the runtime plan keeps the reviewed resource forms', () => {
  const plan = simulationRequests('runtime', operationEnvironment('migrate'));
  const ssm = plan.find((request) => request.pair === 'ssm/get-parameters');
  assert.equal(ssm.resources.length, 38);
  assert.ok(ssm.resources.includes('arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/tester_allowlist'));
  assert.ok(ssm.resources.includes('arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/api_base_url'));
  const lambda = plan.find((request) => request.pair === 'lambda/get-function');
  assert.ok(lambda.resources.includes('arn:aws:lambda:ap-east-1:650880818323:function:AnyWearPlatformStack-beta-*'));
  const egress = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearEgressStack-beta/*';
  for (const pair of ['cloudformation/describe-stacks', 'cloudformation/get-template',
    'cloudformation/list-stack-resources']) {
    const request = plan.find((entry) => entry.pair === pair);
    assert.equal(request.resources.includes(egress), true, `${pair} keeps the Egress stack form`);
  }
});

// Issue #214: the deploy session has no plan. A leftover caller must fail before
// any AWS call rather than simulate a hardcoded guess at the CDK CLI's reads.
test('the deploy session throws before any AWS call', () => {
  assert.throws(() => simulationRequests('deploy', { INFRA_OPERATION: 'deploy-runtime' }, 'operation'),
    /Unknown preflight session deploy/);
  assert.throws(() => simulationRequests('deploy', {}), /Unknown preflight session deploy/);
  assert.equal('cloudformation/describe-change-set' in READ_RESOURCES, false);
});

// Run 39787035530: `deploy-runtime` simulated its DescribeChangeSet read on a
// change-set ARN, and the IAM policy simulator returns implicitDeny for that action
// on every change-set ARN form even under an allow-* policy. The simulation is gone
// with the deploy plan (#214), but the deploy session policy still carries the real
// stack and change-set forms the operation calls.
test('the deploy session policy still grants the change-set read the CDK path performs', () => {
  const env = operationEnvironment('deploy-runtime');
  const policy = JSON.parse(sessionPolicy('deploy', env, 'operation'));
  const statement = policy.Statement.find((entry) => [entry.Action].flat().includes('cloudformation:DescribeChangeSet'));
  assert.ok(statement, 'the deploy-runtime session must grant the change-set read');
  assert.deepEqual([statement.Resource].flat().sort(), [
    'arn:aws:cloudformation:ap-east-1:650880818323:changeSet/*',
    'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*']);
  assert.throws(() => preflightActionSet('deploy', env, 'operation'), /Unknown preflight session deploy/);
});

// Issue #195: the runtime session's plan, its session policy and its call
// allow-list are scoped to the reads the dispatched operation performs. The bake
// reads are Platform-installed grants, so requiring them from every operation
// would leave the Platform deploy — the operation that installs them — blocked.
test('only deploy-runtime simulates and is granted the bake reads', () => {
  const operations = Object.values(workflowOperations).flat();
  // 13 operations: #207 retired `observe` with the record it produced, and #213
  // retired the admission open/close operations.
  assert.equal(operations.length, 13);
  const bakeReads = ['cloudwatch/get-metric-statistics', 'cloudwatch/describe-alarms', 'logs/filter-log-events'];
  assert.deepEqual(Object.keys(readOperations).sort(), [...bakeReads].sort());
  for (const pair of bakeReads) {
    assert.ok(pair in reads, `${pair} is a reviewed read`);
    assert.deepEqual(readOperations[pair], ['deploy-runtime']);
  }
  for (const operation of operations) {
    const workflow = operation === 'state' ? 'runtime' : 'mutate';
    const env = operationEnvironment(operation, workflow);
    const plan = new Set(simulationRequests('runtime', env, 'operation').map((request) => request.pair));
    const sessionActions = new Set(JSON.parse(sessionPolicy('runtime', env, 'operation'))
      .Statement.flatMap((statement) => [statement.Action].flat()));
    for (const pair of bakeReads) {
      assert.equal(plan.has(pair), operation === 'deploy-runtime', `${operation}: ${pair} in the plan`);
      assert.equal(sessionActions.has(reads[pair]), operation === 'deploy-runtime',
        `${operation}: ${reads[pair]} in the session policy`);
    }
    // The universal reads stay in every operation's plan.
    assert.equal(plan.has('ssm/get-parameters'), true, `${operation}: the stage-contract read remains`);
    assert.equal(plan.has('cloudformation/describe-stacks'), true, `${operation}: the stack read remains`);
  }
});

test('the preflight passes when both the base policy and the session policy allow every read', async () => {
  const result = await runAuthorizationPreflight({ sessions: ['runtime'],
    env: operationEnvironment('deploy-platform'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: simulation({}) });
  assert.equal(result.result, 'permitted');
  assert.equal(result.session_marker, PREFLIGHT_MARKER);
  assert.ok(result.evaluations.length > 10);
  assert.ok(result.evaluations.every((entry) => entry.evaluations >= 2));
});

test('a missing base grant fails closed before any mutation', async () => {
  const calls = [];
  const deny = async (command, args) => {
    calls.push({ command, args });
    if (command !== 'aws') throw new Error('a mutation must not run');
    return simulation({ denyAction: 'logs:DescribeLogGroups' })(command, args);
  };
  const io = await createRuntimeIo(operationEnvironment('migrate'), {
    purpose: 'operation', assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: deny,
  });
  await assert.rejects(io.oneShot('migrate', { digest: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40) }),
    (error) => {
      assert.ok(error instanceof AuthorizationPreflightError);
      assert.equal(error.denial, true);
      assert.equal(error.reason, 'denied');
      assert.match(error.message, /logs:DescribeLogGroups/);
      return true;
    });
  assert.equal(calls.some((call) => call.command === 'bash'), false, 'the task script must not run');
});

// Issue #214: the CDK paths reach the CLI with no simulation at all. A leftover
// deploy-plan call would appear here as an `iam simulate-*` invocation.
test('the deploy, change-set and destroy paths run zero simulations', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return { stdout: '', stderr: '' };
  };
  const assume = async () => ({ AWS_ACCESS_KEY_ID: 'x' });
  const deployEnv = operationEnvironment('deploy-egress');
  const deployIo = await createRuntimeIo(deployEnv, { purpose: 'operation', run, assume });
  await deployIo.deploy('AnyWearEgressStack-beta');
  const changeSetEnv = { ...operationEnvironment('deploy-runtime'), INFRA_IDENTITY_PHASE: 'roles-added',
    SERVICE_ARTIFACT_TAG: 'service-artifacts-4f2ba555', SERVICE_COMMIT: '4f2ba555'.padEnd(40, '0') };
  const changeSetIo = await createRuntimeIo(changeSetEnv, { purpose: 'operation', run, assume });
  await changeSetIo.deployRuntimeChangeSet({ args: ['cdk', 'deploy', 'AnyWearRuntimeStack-beta', '--no-execute'] });
  const destroyEnv = operationEnvironment('delete-egress');
  const destroyIo = await createRuntimeIo(destroyEnv, { purpose: 'operation', run, assume });
  await destroyIo.destroy('AnyWearEgressStack-beta');
  assert.equal(calls.some((call) => call.command === 'npx'), true, 'each path reaches the CDK CLI');
  assert.equal(calls.filter((call) => (call.args ?? []).some((arg) => String(arg).startsWith('simulate-'))).length, 0,
    'the CDK paths must not call the IAM policy simulator');
  assert.equal(calls.some((call) => call.command === 'aws'), false, 'no AWS call is made by these three paths');
});

// Issue #195's counter-check: the surviving runtime-session preflight must not be
// weakened. `deploy-runtime` still simulates the bake reads before the change set
// (and the schema-journal probe runs the same plan before the change set exists).
test('the schema-journal probe still fails closed when the runtime role denies a bake read', async () => {
  const env = { ...operationEnvironment('deploy-runtime'), INFRA_IDENTITY_PHASE: 'roles-added',
    SERVICE_ARTIFACT_TAG: 'service-artifacts-4f2ba555', SERVICE_COMMIT: '4f2ba555'.padEnd(40, '0') };
  const revision = { digest: `sha256:${'c'.repeat(64)}`, commit: 'd'.repeat(40) };
  for (const denied of ['cloudwatch:DescribeAlarms', 'logs:FilterLogEvents']) {
    const calls = [];
    const deny = async (command, args) => {
      calls.push({ command, args });
      if (command !== 'aws') throw new Error('a mutation must not run');
      return simulation({ denyAction: denied })(command, args);
    };
    const io = await createRuntimeIo(env, {
      purpose: 'operation', assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }), run: deny });
    await assert.rejects(io.oneShotProbe('verify', revision, 'schema-journal'), (error) => {
      assert.ok(error instanceof AuthorizationPreflightError);
      assert.equal(error.kind, 'runtime');
      assert.equal(error.denial, true);
      assert.match(error.message, new RegExp(denied));
      return true;
    });
    assert.equal(calls.some((call) => call.command === 'bash'), false, 'the probe task must not run');
  }
});

// Issue #214: the driver keeps exactly the two runtime-session call sites; the
// deploy, change-set and destroy sites are gone.
test('exactly two preflight call sites remain, both for the runtime session', async () => {
  const source = await readFile(new URL('../scripts/runtime-operation.mjs', import.meta.url), 'utf8');
  const occurrences = source.split('\n').filter((line) => line.includes('runAuthorizationPreflight'));
  assert.equal(occurrences.length, 3, 'one import line plus two call sites');
  assert.match(occurrences[0], /^import \{ runAuthorizationPreflight \}/);
  const sites = source.match(/runAuthorizationPreflight\(\{[^}]*\}\)/g) ?? [];
  assert.equal(sites.length, 2);
  for (const site of sites) assert.match(site, /sessions: \['runtime'\]/);
  assert.doesNotMatch(source, /sessions: \['deploy'/);
});

test('a simulator API error is classified apart from a denial', async () => {
  await assert.rejects(runAuthorizationPreflight({ sessions: ['runtime'],
    env: operationEnvironment('migrate'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }),
    run: failingSimulation('An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation') }),
  (error) => {
    assert.equal(error.reason, 'simulator-denied');
    assert.equal(error.denial, true);
    return true;
  });
  await assert.rejects(runAuthorizationPreflight({ sessions: ['runtime'],
    env: operationEnvironment('migrate'), purpose: 'operation',
    assume: async () => ({ AWS_ACCESS_KEY_ID: 'x' }),
    run: failingSimulation('An error occurred (NoSuchEntity) when calling the SimulateCustomPolicy operation') }),
  (error) => {
    assert.equal(error.reason, 'simulator-error');
    assert.equal(error.denial, false);
    return true;
  });
});

test('the preflight runs under a marked session', async () => {
  const assumed = [];
  await runAuthorizationPreflight({ sessions: ['runtime'], env: operationEnvironment('migrate'),
    purpose: 'operation', assume: async (kind, _env, _purpose, options) => {
      assumed.push({ kind, marker: options.sessionMarker });
      return { AWS_ACCESS_KEY_ID: 'x' };
    }, run: simulation({}) });
  assert.deepEqual(assumed, [{ kind: 'runtime', marker: PREFLIGHT_MARKER }]);
});

test('every simulator context entry uses a valid context-key type', () => {
  // Run 39726665630: the simulator rejected ContextKeyType 'arn' (it has no ARN
  // type), so the preflight failed before any mutation. The CLI mock never
  // validated the enum; this test pins it.
  const allowed = new Set(['binary', 'ipList', 'booleanList', 'ip', 'boolean', 'numericList',
    'dateList', 'numeric', 'date', 'stringList', 'string', 'binaryList']);
  for (const entry of CONTEXT_ENTRIES) {
    assert.ok(allowed.has(entry.ContextKeyType),
      `${entry.ContextKeyName} uses ${entry.ContextKeyType}, which the simulator rejects`);
    assert.notEqual(entry.ContextKeyType, 'arn');
  }
  const cluster = CONTEXT_ENTRIES.find((entry) => entry.ContextKeyName === 'ecs:cluster');
  assert.ok(cluster, 'ecs:cluster must be supplied');
  assert.equal(cluster.ContextKeyType, 'string');
  assert.deepEqual(cluster.ContextKeyValues,
    ['arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear']);
});

test('account-level actions simulate on * and resource-level actions stay concrete', () => {
  // Run 39732059192: ecs:DescribeTaskDefinition has no resource-level support, so a
  // concrete task-definition ARN is an implicit deny even when the policy allows
  // the action on *. Pin the known account-level actions and keep the rest concrete.
  // The deploy plan's `ec2:DescribeManagedPrefixLists` entry went with #214; the
  // runtime plan keeps the four account-level actions below.
  const noResource = new Set(['ecs:DescribeTaskDefinition', 'ecs:ListTasks',
    'cloudwatch:GetMetricStatistics', 'logs:DescribeLogGroups']);
  const plan = simulationRequests('runtime', operationEnvironment('deploy-runtime'));
  const seen = new Set();
  for (const request of plan) {
    for (const action of request.actions) {
      if (noResource.has(action)) {
        seen.add(action);
        assert.deepEqual(request.resources, ['*'], `${action} must simulate on *`);
      } else {
        assert.ok(!(request.resources.length === 1 && request.resources[0] === '*'),
          `${action} has resource-level support and must simulate a concrete form`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...noResource].sort());
  const taskDefinition = plan.find((request) => request.pair === 'ecs/describe-task-definition');
  assert.deepEqual(taskDefinition.resources, ['*']);
  const logGroups = plan.find((request) => request.pair === 'logs/describe-log-groups');
  assert.deepEqual(logGroups.resources, ['*']);
});

test('the simulator-unevaluable log-stream read is skipped and the rest of the runtime plan remains', () => {
  // Read-only validation at e3d2854: every log-group:...:log-stream:... form returns
  // implicitDeny in the simulator, even under the session policy that grants the
  // action on *. The reviewed grant is on log-stream ARNs, so the plan skips it.
  const reason = SIMULATION_SKIPS['logs/get-log-events'];
  assert.ok(reason, 'logs/get-log-events must be a reviewed skip');
  assert.match(reason, /log-stream ARNs/);
  assert.match(reason, /implicitDeny/);
  assert.match(reason, /form probes 2026-10-22/);
  const plan = simulationRequests('runtime', operationEnvironment('deploy-runtime'));
  const pairs = plan.map((request) => request.pair).sort();
  assert.ok(!pairs.includes('logs/get-log-events'));
  assert.equal(plan.length, 15);
  assert.deepEqual(pairs, ['cloudformation/describe-stacks', 'cloudformation/get-template',
    'cloudformation/list-stack-resources', 'cloudwatch/describe-alarms', 'cloudwatch/get-metric-statistics',
    'ecs/describe-services', 'ecs/describe-task-definition', 'ecs/describe-tasks', 'ecs/list-tasks',
    'lambda/get-function', 'logs/describe-log-groups', 'logs/filter-log-events',
    'sqs/get-queue-attributes', 'ssm/get-parameter', 'ssm/get-parameters']);
});

test('production.yml pins the app-token attestations read it needs', async () => {
  // The batch failure: a release-verifying path read the attestation API without
  // the attestations scope. Infra mints an app token for that read, so the input
  // is the declaration; no test pinned it before this one.
  const source = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8');
  const { load } = await import('js-yaml');
  const workflow = load(source);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const token = steps.find((step) => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.ok(token, 'production.yml must mint the reviewed app token');
  assert.equal(token.with['permission-attestations'], 'read');
  assert.equal(token.with['permission-contents'], 'read');
  assert.equal(token.with['permission-actions'], 'read');
});
