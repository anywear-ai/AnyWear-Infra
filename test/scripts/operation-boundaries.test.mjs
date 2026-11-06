import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowOperations, operationFamilies, operationBoundary, operationRoles, families, assertOneShotAllowed,
  assertDeployAllowed, assertAwsAllowed, sessionPolicy, assertProtectedExecutor, reads, readOperations, operationReads,
  verifyActions } from '../../scripts/lib/operation-boundaries.mjs';
import { SIMULATE_ACTIONS } from '../../scripts/lib/authorization-preflight.mjs';
import { apiOriginUpdateArguments } from '../../scripts/lib/runtime-deploy.mjs';

const infraSha = '5'.repeat(40);
// Issue #266: the fabricated runs keep the old `git-malu` full name on purpose.
// The guard identifies the repository by its immutable numeric id and compares
// the workflow ref against the run's own full name, so the same assertions hold
// before and after the transfer.
const env = (operation, overrides = {}) => {
  const workflow = operation === 'state' ? 'runtime' : 'mutate';
  return { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: infraSha,
    GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-Infra/.github/workflows/${workflow}.yml@refs/heads/main`,
    INFRA_OPERATION: operation, TESTER_EMAILS: '[]', ...overrides };
};

test('the workflow map and family derivation cover every operation', () => {
  assert.deepEqual(Object.keys(workflowOperations).sort(), ['.github/workflows/mutate.yml', '.github/workflows/runtime.yml']);
  assert.deepEqual(workflowOperations['.github/workflows/runtime.yml'], ['state']);
  // #213: the correct post-retirement count is 12, not the 11 the issue text says;
  // `deploy-billing` remains.
  assert.deepEqual(workflowOperations['.github/workflows/mutate.yml'], ['deploy-foundation', 'deploy-billing', 'deploy-platform',
    'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
    'admission-status', 'add-testers', 'set-testers']);
  assert.ok(!workflowOperations['.github/workflows/mutate.yml'].includes('deploy-workload'));
  for (const operation of Object.values(workflowOperations).flat()) {
    const boundary = operationBoundary(env(operation));
    assert.ok(boundary.family, `family required for ${operation}`);
    assert.equal(boundary.readOnly, operation === 'state');
    assert.ok(operationRoles[operation], `role allow-list required for ${operation}`);
  }
  // Issue #166 adds the disposable Egress operations to the same deploy family.
  for (const operation of ['deploy-egress', 'delete-egress']) assert.equal(operationFamilies[operation], 'beta-deploy');
  // #207 retired `observe` with the record it produced; it is no longer a
  // dispatch of any workflow. #213 retired the admission open/close operations.
  assert.throws(() => operationBoundary(env('observe', { GITHUB_WORKFLOW_REF:
    'git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main' })), /forbidden for this workflow family/);
  assert.throws(() => operationBoundary(env('deploy-workload')), /forbidden for this workflow family/);
  for (const retired of [['open', 'admission'], ['close', 'admission']]) {
    assert.equal(operationFamilies[retired.join('-')], undefined, `${retired.join('-')} has no family`);
    assert.throws(() => operationBoundary(env(retired.join('-'))), /forbidden for this workflow family/);
  }
  assert.throws(() => operationBoundary(env('state', { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main' })));
});

test('one-shot roles are exactly the release-slice drivers that remain', () => {
  assert.deepEqual(operationRoles['deploy-egress'], []);
  assert.deepEqual(operationRoles['deploy-platform'], []);
  assert.deepEqual(operationRoles['restore-release'], []);
  assert.deepEqual(operationRoles.migrate, ['migrate']);
  // #213: the tester allowlist surface keeps the lifecycle family for `status` and
  // `set-testers` only.
  assert.deepEqual(operationRoles['admission-status'], ['lifecycle']);
  assert.deepEqual(operationRoles['set-testers'], ['lifecycle']);
  // Issue #194: `deploy-runtime` gains the existing `verify` family for the
  // pre-mutation schema-journal read; no other operation gains one.
  assert.deepEqual(operationRoles['deploy-runtime'], ['verify']);
  assert.deepEqual(families(env('deploy-runtime'), 'operation'), ['verify']);
  assert.deepEqual(verifyActions('deploy-runtime'), ['schema-journal']);
  assert.deepEqual(verifyActions('deploy-platform'), []);
  assert.deepEqual(families(env('deploy-platform'), 'qualification'), []);
  assert.deepEqual(families(env('migrate'), 'operation'), ['migrate']);
  assert.deepEqual(families(env('state'), 'operation'), []);
  assert.throws(() => families(env('state'), 'qualification'), /Read-only observation cannot qualify/);
});

test('one-shot guards admit only the reviewed role/action pairs', () => {
  assertOneShotAllowed(env('migrate'), 'migrate');
  assertOneShotAllowed(env('admission-status'), 'lifecycle', 'status');
  assertOneShotAllowed(env('add-testers', { TESTER_EMAILS: '["e@example.com"]' }), 'lifecycle', 'status');
  // Issue #194: the verify family's only action is the read-only schema-journal
  // read, and it takes no payload.
  assertOneShotAllowed(env('deploy-runtime'), 'verify', 'schema-journal');
  assert.throws(() => assertOneShotAllowed(env('deploy-runtime'), 'verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('deploy-runtime'), 'verify', 'status'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('deploy-runtime'), 'verify', 'schema-journal', '{}'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('deploy-platform'), 'verify', 'schema-journal'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('deploy-platform'), 'lifecycle', 'status'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'artifact-verify'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('migrate'), 'lifecycle', 'status'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'supply'), /forbidden/);
  assert.throws(() => assertOneShotAllowed(env('add-testers'), 'lifecycle', 'set-testers', '["b@example.com","a@example.com"]'), /canonical/);
  assertOneShotAllowed(env('set-testers', { TESTER_EMAILS: '["e@example.com"]' }), 'lifecycle', 'set-testers', '["e@example.com"]');
  // #213 removed the mode actions: the surviving lifecycle entry lists status and
  // set-testers only, so the retired suspend/resume actions are refused.
  for (const action of [['sus', 'pend'].join(''), ['re', 'sume'].join('')]) {
    assert.throws(() => assertOneShotAllowed(env('set-testers'), 'lifecycle', action), /forbidden/, action);
  }
  assert.throws(() => assertOneShotAllowed(env('admission-status'), 'lifecycle', 'set-testers', '[]'), /forbidden/);
});

test('deploy authority is limited to the configured stack set', () => {
  assertDeployAllowed(env('deploy-platform'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('restore-release'), 'AnyWearPlatformStack-beta');
  assertDeployAllowed(env('deploy-foundation'), 'AnyWearFoundationStack');
  assertDeployAllowed(env('deploy-billing'), 'AnyWearBillingStack-beta');
  assertDeployAllowed(env('deploy-egress'), 'AnyWearEgressStack-beta');
  assertDeployAllowed(env('delete-egress'), 'AnyWearEgressStack-beta');
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearEgressStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearWorkloadStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('deploy-platform'), 'AnyWearRuntimeStack-beta'), /forbidden/);
  assert.throws(() => assertDeployAllowed(env('deploy-egress'), 'AnyWearPlatformStack-beta'), /forbidden/);
});

test('AWS allow-list keeps reads, one-shots and retention updates scoped', () => {
  assertAwsAllowed(env('migrate'), ['cloudformation', 'describe-stacks']);
  assertAwsAllowed(env('deploy-platform'), ['ssm', 'get-parameters']);
  assert.throws(() => assertAwsAllowed(env('state'), ['ssm', 'get-parameters']), /forbidden/);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['ssm', 'get-parameter', '--name', '/x', '--with-decryption']), /decryption is forbidden/);
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['ecs', 'run-task']), /forbidden/);
  const lifecycle = { family: 'beta-anywear-lifecycle', taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command: ['node', 'dist/ops/beta-lifecycle.js', 'status'] }] };
  assertAwsAllowed(env('set-testers', { TESTER_EMAILS: '[]' }), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(lifecycle)]);
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(lifecycle)]), /forbidden/);
  // Issue #194: only the exact schema-journal verify registration is accepted,
  // and only for the operation that gained the verify family.
  const verify = { family: 'beta-anywear-verify',
    taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-verification-task',
    executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution',
    containerDefinitions: [{ name: 'OneShot', command: ['node', 'dist/verify.js', 'schema-journal'] }] };
  assertAwsAllowed(env('deploy-runtime'), ['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(verify)]);
  assertAwsAllowed(env('deploy-runtime'), ['ecs', 'run-task', '--task-definition',
    'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7']);
  for (const command of [['node', 'dist/verify.js'], ['node', 'dist/verify.js', 'status'],
    ['node', 'dist/verify.js', 'schema-journal', 'extra'], ['node', 'dist/ops/beta-lifecycle.js', 'status']]) {
    assert.throws(() => assertAwsAllowed(env('deploy-runtime'), ['ecs', 'register-task-definition', '--cli-input-json',
      JSON.stringify({ ...verify, containerDefinitions: [{ name: 'OneShot', command }] })]), /forbidden/, command.join(' '));
  }
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['ecs', 'register-task-definition', '--cli-input-json',
    JSON.stringify(verify)]), /forbidden/, 'the verify family belongs only to deploy-runtime');
  const wrongRole = { ...verify, taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-lifecycle-task' };
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), ['ecs', 'register-task-definition', '--cli-input-json',
    JSON.stringify(wrongRole)]), /forbidden/, 'the verify family registers under the verification task role');
  assertAwsAllowed(env('deploy-platform'), ['logs', 'put-retention-policy']);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['logs', 'put-retention-policy']), /forbidden/);
});

test('session policies carry only the operation\'s own families', () => {
  const deploy = sessionPolicy('deploy', env('deploy-platform'));
  assert.match(deploy, /cdk-hnb659fds-deploy-role-650880818323-ap-east-1/);
  assert.throws(() => sessionPolicy('deploy', env('state')), /Deploy credentials are forbidden/);
  const migration = sessionPolicy('runtime', env('migrate'));
  assert.match(migration, /beta-anywear-migrate/);
  assert.doesNotMatch(migration, /beta-anywear-lifecycle/);
  const state = sessionPolicy('runtime', env('state'));
  assert.match(state, /ssm:GetParameter/);
  assert.doesNotMatch(state, /ecs:RegisterTaskDefinition/);
  assert.doesNotMatch(sessionPolicy('runtime', env('deploy-platform')), /ecs:RegisterTaskDefinition/);
  // Issue #194: `deploy-runtime` adds the verify family's register/run/PassRole
  // statements under the existing verification-task role, and the generated
  // policy stays inside the 2048-byte inline limit. The measured length is
  // recorded in the test failure message so a drift is visible.
  const runtime = sessionPolicy('runtime', env('deploy-runtime'));
  assert.match(runtime, /beta-anywear-verify/);
  assert.match(runtime, /beta-anywear-verification-task/);
  assert.doesNotMatch(runtime, /beta-anywear-lifecycle-task|beta-anywear-migration-task/);
  assert.ok(runtime.length < 2048, `deploy-runtime session policy is ${runtime.length} bytes`);
  assert.equal(JSON.parse(runtime).Version, '2012-10-17');
  // Issue #214: the preflight simulates the runtime session only, so only the
  // runtime session policy carries the simulator actions. The deploy session's
  // copy is gone; both roles' identity grants stay (#196 owns narrowing those).
  const actionsOf = (policy) => JSON.parse(policy).Statement.flatMap((statement) => [statement.Action].flat());
  for (const action of SIMULATE_ACTIONS) {
    assert.equal(actionsOf(sessionPolicy('deploy', env('deploy-platform'), 'operation')).includes(action), false,
      `the deploy session policy must not carry ${action}`);
    for (const operation of ['deploy-platform', 'deploy-runtime']) {
      assert.equal(actionsOf(sessionPolicy('runtime', env(operation), 'operation')).includes(action), true,
        `the ${operation} runtime session policy must carry ${action}`);
    }
  }
});

// Issue #195: the bake runs only inside `deploy-runtime`, and its two new grants
// are installed by a Platform deploy. The read table, the session policy and the
// call allow-list are scoped together so no other operation requires them and
// `deploy-runtime` still does.
test('the runtime read set is scoped to the operation that performs the read', () => {
  const bakeReads = ['cloudwatch/get-metric-statistics', 'cloudwatch/describe-alarms', 'logs/filter-log-events'];
  assert.deepEqual(Object.keys(readOperations).sort(), [...bakeReads].sort());
  for (const pair of bakeReads) {
    assert.ok(pair in reads, `${pair} stays in the reviewed reads table`);
    assert.deepEqual(readOperations[pair], ['deploy-runtime']);
    assert.equal(operationReads(env('deploy-platform')).includes(pair), false, `${pair} is not a Platform-deploy read`);
    assert.equal(operationReads(env('deploy-runtime')).includes(pair), true, `${pair} is a deploy-runtime read`);
  }
  // The universal reads remain in every operation's set.
  for (const pair of ['cloudformation/describe-stacks', 'ssm/get-parameters', 'logs/describe-log-groups']) {
    assert.equal(operationReads(env('migrate')).includes(pair), true, `${pair} is universal`);
  }
  assert.throws(() => assertAwsAllowed(env('deploy-platform'), ['cloudwatch', 'describe-alarms']), /forbidden/);
  assert.throws(() => assertAwsAllowed(env('migrate'), ['logs', 'filter-log-events']), /forbidden/);
  assertAwsAllowed(env('deploy-runtime'), ['cloudwatch', 'describe-alarms']);
  assertAwsAllowed(env('deploy-runtime'), ['logs', 'filter-log-events']);
  const platform = sessionPolicy('runtime', env('deploy-platform'));
  assert.doesNotMatch(platform, /cloudwatch:DescribeAlarms|logs:FilterLogEvents|cloudwatch:GetMetricStatistics/);
  const runtime = sessionPolicy('runtime', env('deploy-runtime'));
  assert.match(runtime, /cloudwatch:DescribeAlarms/);
  assert.match(runtime, /logs:FilterLogEvents/);
  // The read-only state session keeps its own narrower set and never gains a bake read.
  const state = sessionPolicy('runtime', env('state'));
  assert.doesNotMatch(state, /cloudwatch|logs:FilterLogEvents/);
});

// Issue #254: `deploy-runtime` may issue exactly one Base-stack parameter update
// through the deploy session after its Runtime stack is terminal. The whole
// argument vector is compared with the builder that constructs it, so every other
// operation, session, stack, parameter, reordering or added flag stays refused.
test('the deploy session allows only the exact Base-stack origin update vector for deploy-runtime', () => {
  const update = (value = 'beta-anywear-api-1554590841.ap-east-1.elb.amazonaws.com') =>
    ['cloudformation', 'update-stack', '--stack-name', 'AnyWearPlatformStack-beta',
      '--use-previous-template', '--parameters', 'ParameterKey=BootstrapVersion,UsePreviousValue=true',
      `ParameterKey=ApiOriginDomainName,ParameterValue=${value}`, '--capabilities', 'CAPABILITY_NAMED_IAM'];
  assert.doesNotThrow(() => assertAwsAllowed(env('deploy-runtime'), update(), 'operation', 'deploy'));
  // The read-only runtime session never performs the write.
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), update()), /forbidden/);
  // Every other operation is refused, including the other Base deployers.
  for (const operation of ['deploy-platform', 'restore-release', 'deploy-egress', 'delete-egress',
    'stop-runtime', 'deploy-foundation', 'deploy-billing', 'migrate', 'state']) {
    assert.throws(() => assertAwsAllowed(env(operation), update(), 'operation', 'deploy'),
      /forbidden for the deploy session/, operation);
  }
  const replace = (from, to) => update().map((arg) => (arg === from ? to : arg));
  // Another stack, a widened parameter set, and every other call shape fail closed.
  for (const stack of ['AnyWearRuntimeStack-beta', 'AnyWearEgressStack-beta']) {
    assert.throws(() => assertAwsAllowed(env('deploy-runtime'), replace('AnyWearPlatformStack-beta', stack),
      'operation', 'deploy'), /forbidden/, stack);
  }
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'),
    update().filter((arg) => arg !== '--use-previous-template'), 'operation', 'deploy'),
  /forbidden/, 'the previous template is mandatory');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'),
    replace('CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM'), 'operation', 'deploy'), /forbidden/, 'wrong capability');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'),
    [...update(), '--capabilities', 'CAPABILITY_IAM'], 'operation', 'deploy'), /forbidden/, 'extra capability');
  for (const widening of [['--template-body', 'file://template.json'], ['--template-url', 'https://example/t.json'],
    ['--role-arn', 'arn:aws:iam::650880818323:role/cdk-hnb659fds-cfn-exec-role-650880818323-ap-east-1'],
    ['--cli-input-json', 'file://update.json']]) {
    assert.throws(() => assertAwsAllowed(env('deploy-runtime'), [...update(), ...widening],
      'operation', 'deploy'), /forbidden/, widening[0]);
  }
  // Issue #254 review: every optional AWS CLI flag is outside the exact vector, so
  // appending any of it — with its value where the CLI takes one — is refused.
  for (const widening of [['--tags', 'Key=Name,Value=review'],
    ['--notification-arns', 'arn:aws:sns:ap-east-1:650880818323:topic'],
    ['--stack-policy-body', 'file://policy.json'], ['--stack-policy-url', 'https://example/policy.json'],
    ['--disable-rollback'], ['--rollback-configuration', 'RollbackTriggers=[],MonitoringTimeInMinutes=1'],
    ['--timeout-in-minutes', '30']]) {
    assert.throws(() => assertAwsAllowed(env('deploy-runtime'), [...update(), ...widening],
      'operation', 'deploy'), /forbidden/, widening[0]);
  }
  // The vector is order- and count-exact: a reorder or a duplicate is refused.
  const reordered = [...update()];
  [reordered[4], reordered[5]] = [reordered[5], reordered[4]];
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), reordered, 'operation', 'deploy'),
    /forbidden/, 'reordered');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), [...update(), '--capabilities', 'CAPABILITY_NAMED_IAM'],
    'operation', 'deploy'), /forbidden/, 'duplicated capability pair');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), [...update(), 'AnyWearPlatformStack-beta'],
    'operation', 'deploy'), /forbidden/, 'duplicated stack name');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), update('not a domain'),
    'operation', 'deploy'), /forbidden/, 'a non-DNS origin value');
  assert.throws(() => assertAwsAllowed(env('deploy-runtime'), [
    'cloudformation', 'update-stack', '--stack-name', 'AnyWearPlatformStack-beta', '--use-previous-template',
    '--parameters', 'ParameterKey=ApiOriginDomainName,ParameterValue=beta-anywear-api-1554590841.ap-east-1.elb.amazonaws.com',
    '--capabilities', 'CAPABILITY_NAMED_IAM'], 'operation', 'deploy'), /forbidden/, 'the bootstrap parameter is required');
  // The production argument builder is exactly the shape the allow-list admits.
  const args = apiOriginUpdateArguments('beta-anywear-api-1554590841.ap-east-1.elb.amazonaws.com');
  assert.deepEqual(args, update());
  assert.doesNotThrow(() => assertAwsAllowed(env('deploy-runtime'), args, 'operation', 'deploy'));
});

// Issue #254: the generated deploy-session policy carries the one write action on
// the Base stack for `deploy-runtime` only, and stays inside the 2048-character
// inline limit.
test('the deploy-session policy carries UpdateStack only for deploy-runtime', () => {
  const actionsOf = (policy) => JSON.parse(policy).Statement.flatMap((statement) => [statement.Action].flat());
  const runtime = sessionPolicy('deploy', env('deploy-runtime'));
  assert.ok(actionsOf(runtime).includes('cloudformation:UpdateStack'));
  assert.match(runtime, /stack\/AnyWearPlatformStack-beta\/\*/);
  assert.ok(runtime.length < 2048, `deploy-runtime deploy session policy is ${runtime.length} bytes`);
  for (const operation of ['deploy-platform', 'restore-release', 'stop-runtime', 'deploy-egress']) {
    const policy = sessionPolicy('deploy', env(operation));
    assert.equal(actionsOf(policy).includes('cloudformation:UpdateStack'), false, operation);
    assert.doesNotMatch(policy, /AnyWearPlatformStack-beta/, operation);
    assert.ok(policy.length < 2048, `${operation} deploy session policy is ${policy.length} bytes`);
  }
});

test('the protected executor gate binds repository, workflow, source, account and region', () => {
  assert.equal(assertProtectedExecutor(infraSha, env('deploy-platform')).sha, infraSha);
  for (const overrides of [{ GITHUB_SHA: '6'.repeat(40) }, { GITHUB_SHA: 'short' }, { GITHUB_REF: 'refs/heads/other' },
    { AWS_ACCOUNT_ID: '1' }, { AWS_REGION: 'us-east-1' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Client/.github/workflows/x.yml@refs/heads/main' }]) {
    assert.throws(() => assertProtectedExecutor(infraSha, env('deploy-platform', overrides)));
  }
  // Issue #266: the current run's repository is matched by its immutable numeric
  // id and the workflow ref against the run's own full name, so the same reviewed
  // executor is accepted under either owner. A wrong id, a wrong workflow file and
  // a foreign full name still fail closed.
  const transferred = env('deploy-platform', { GITHUB_REPOSITORY: 'anywear-ai/AnyWear-Infra',
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main' });
  assert.equal(assertProtectedExecutor(infraSha, transferred).repository, 'anywear-ai/AnyWear-Infra');
  assert.deepEqual(operationBoundary(transferred), { workflow: '.github/workflows/mutate.yml', family: 'beta-deploy', readOnly: false });
  for (const overrides of [{ GITHUB_REPOSITORY_ID: '1409047264' }, { GITHUB_REPOSITORY_ID: '1158460323' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/production.yml@refs/heads/main' }]) {
    assert.throws(() => assertProtectedExecutor(infraSha, env('deploy-platform', overrides)), /Protected executor|workflow required/);
  }
  // AnyWear-E2E executes from its own pinned checkout and states the observed
  // Infra revision explicitly. Its run SHA is the executor identity, so it must
  // not be forced to equal the Infra helper SHA.
  const e2e = (overrides = {}) => env('deploy-platform', { GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E',
    GITHUB_REPOSITORY_ID: '1317091305', GITHUB_SHA: '6'.repeat(40),
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main', ...overrides });
  const executor = assertProtectedExecutor(infraSha, e2e());
  assert.equal(executor.repository, 'git-malu/AnyWear-E2E');
  assert.equal(executor.sha, infraSha);
  assert.equal(executor.workflow_path, '.github/workflows/beta-qualification.yml');
  // The same E2E executor is accepted under the new owner, and the numeric id is
  // still the branch that selects the E2E allow-list.
  assert.equal(assertProtectedExecutor(infraSha, e2e({ GITHUB_REPOSITORY: 'anywear-ai/AnyWear-E2E',
    GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main' })).repository,
  'anywear-ai/AnyWear-E2E');
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_REPOSITORY_ID: '1409047265' })), /workflow required/);
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_WORKFLOW_REF:
    'git-malu/AnyWear-E2E/.github/workflows/other.yml@refs/heads/main' })), /workflow required/);
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_REF: 'refs/heads/feature' })), /Protected executor/);
  assert.throws(() => assertProtectedExecutor(infraSha, e2e({ GITHUB_SHA: '7'.repeat(39) })), /Protected executor/);
});
