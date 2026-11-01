import { parseJson, canonicalJson } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';
import { INFRA_REPOSITORY, account, region } from './deployment-contract.mjs';

// One dispatch surface per deployable unit. `runtime.yml` hosts the read-only
// `state` entry; every mutation shares `mutate.yml`, including since #195 the
// release slice's `deploy-runtime` and `stop-runtime`. Issue #207 retired the
// `observe` operation with the record it produced; #213 retired the admission
// open/close operations, leaving the tester allowlist surface.
export const workflowOperations = Object.freeze({
  '.github/workflows/runtime.yml': ['state'],
  '.github/workflows/mutate.yml': ['deploy-foundation', 'deploy-billing', 'deploy-platform',
    'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
    'admission-status', 'add-testers', 'set-testers'],
});

// The operation -> family mapping keeps the pre-#207 families stable for the
// surfaces that still name one (session-policy and tester read-backs), and keeps
// read-only `state` out of every mutating family. No record is written any more.
export const operationFamilies = Object.freeze({
  state: 'beta-observe',
  'deploy-foundation': 'beta-deploy',
  'deploy-billing': 'beta-deploy',
  'deploy-platform': 'beta-deploy',
  'deploy-egress': 'beta-deploy',
  'delete-egress': 'beta-deploy',
  'deploy-runtime': 'beta-deploy',
  'stop-runtime': 'beta-deploy',
  'restore-release': 'beta-deploy',
  migrate: 'beta-schema',
  'admission-status': 'beta-admission',
  'add-testers': 'beta-admission',
  'set-testers': 'beta-admission',
});

// Live entries that execute verification or deployment. Every other path is a
// dispatch surface only: `check.yml` is automatic and `production.yml` is
// `workflow_call`-only.
export const qualifiedWorkflowPaths = Object.freeze(['.github/workflows/runtime.yml', '.github/workflows/mutate.yml']);

// AnyWear-E2E executes exactly one reviewed workflow. `integration.yml` was
// retired with the E2E consolidation; adding another path here would admit a
// second, unreviewed E2E producer without a reviewed executor.
export const e2eExecutorPaths = Object.freeze(['.github/workflows/beta-qualification.yml']);

// The reviewed executor/source/account/region gate shared by the observation and
// the recovery drivers. It reads only repository identity and dispatch
// metadata, so it runs before any AWS call.
export function assertProtectedExecutor(infraSha, env = process.env) {
  if (typeof infraSha !== 'string' || !/^[a-f0-9]{40}$/.test(infraSha)) throw new Error('Reviewed Infra source required');
  if (typeof env.GITHUB_SHA !== 'string' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) || env.GITHUB_REF !== 'refs/heads/main'
    || env.AWS_ACCOUNT_ID !== account || env.AWS_REGION !== region) throw new Error('Protected executor/account/region/source required');
  const paths = env.GITHUB_REPOSITORY === INFRA_REPOSITORY ? qualifiedWorkflowPaths
    : env.GITHUB_REPOSITORY === 'git-malu/AnyWear-E2E' ? e2eExecutorPaths : [];
  if (!paths.some(file => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${file}@refs/heads/main`)) {
    throw new Error('Protected executor workflow required');
  }
  // An Infra executor must execute the reviewed revision. AnyWear-E2E executes
  // from its own pinned checkout and states the observed Infra helper revision
  // explicitly, so its run SHA is the executor identity rather than the Infra SHA.
  if (env.GITHUB_REPOSITORY === INFRA_REPOSITORY && env.GITHUB_SHA !== infraSha) {
    throw new Error('Protected executor source required');
  }
  if (!Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('Executor run identity required');
  return { repository: env.GITHUB_REPOSITORY, sha: infraSha, workflow_path: env.GITHUB_WORKFLOW_REF.split('/').slice(2).join('/').split('@')[0],
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export function operationBoundary(env) {
  const operation = env.INFRA_OPERATION;
  const workflow = Object.keys(workflowOperations).find(file => env.GITHUB_WORKFLOW_REF === `git-malu/AnyWear-Infra/${file}@refs/heads/main`);
  if (!workflow || !workflowOperations[workflow].includes(operation)) throw new Error('Operation is forbidden for this workflow family');
  return { workflow, family: operationFamilies[operation], readOnly: operation === 'state' };
}

export const reads = {
  'sts/get-caller-identity': 'sts:GetCallerIdentity',
  'cloudformation/describe-stacks': 'cloudformation:DescribeStacks',
  'cloudformation/get-template': 'cloudformation:GetTemplate',
  'cloudformation/list-stack-resources': 'cloudformation:ListStackResources',
  'ssm/get-parameter': 'ssm:GetParameter',
  'ssm/get-parameters': 'ssm:GetParameters',
  'ecs/describe-services': 'ecs:DescribeServices', 'ecs/describe-tasks': 'ecs:DescribeTasks',
  'ecs/describe-task-definition': 'ecs:DescribeTaskDefinition', 'ecs/list-tasks': 'ecs:ListTasks',
  'ecr/describe-images': 'ecr:DescribeImages', 'ecr/batch-get-image': 'ecr:BatchGetImage',
  'lambda/get-function': 'lambda:GetFunction', 'sqs/get-queue-attributes': 'sqs:GetQueueAttributes',
  'logs/get-log-events': 'logs:GetLogEvents', 'logs/describe-log-groups': 'logs:DescribeLogGroups',
  // Issue #195: the bake's live reads. The change-set read is deploy-session
  // only and is handled by `assertAwsAllowed`'s deploy branch, not this table.
  'cloudwatch/get-metric-statistics': 'cloudwatch:GetMetricStatistics',
  'cloudwatch/describe-alarms': 'cloudwatch:DescribeAlarms',
  'logs/filter-log-events': 'logs:FilterLogEvents',
  // The base role may deny this legacy fallback; this session never adds grants.
  'cloudfront/get-distribution': 'cloudfront:GetDistribution',
};
// Reads that only some operations perform. A read absent from this table is
// performed by every operation that uses the runtime session; a listed read is
// simulated and granted only for the operations named here. Issue #195: the
// 300-second bake runs only inside `deploy-runtime`, and two of its grants are
// installed by a Platform deploy, so requiring them from every runtime-session
// operation would leave no reviewed operation able to install them.
export const readOperations = Object.freeze({
  'cloudwatch/get-metric-statistics': Object.freeze(['deploy-runtime']),
  'cloudwatch/describe-alarms': Object.freeze(['deploy-runtime']),
  'logs/filter-log-events': Object.freeze(['deploy-runtime']),
});
// The reviewed read set the dispatched operation's runtime session performs. The
// simulation plan, the generated session policy and the AWS call allow-list all
// derive from this one function, so an operation cannot be granted a read it does
// not perform and cannot call a read another operation's session needs.
export function operationReads(env) {
  const operation = env?.INFRA_OPERATION;
  return Object.keys(reads).filter((pair) => !(pair in readOperations) || readOperations[pair].includes(operation));
}
export const stateReads = ['sts/get-caller-identity', 'cloudformation/describe-stacks', 'cloudformation/get-template', 'ssm/get-parameter'];
// One frozen one-shot role allow-list per operation. Each entry is exactly the
// set of one-shot task families the operation's own session may invoke, so an
// operation cannot touch a family it was not reviewed for. Every operation in
// `workflowOperations` appears here, so an operation with no verification
// dependency is a recorded decision instead of a missing lookup. Issue #207
// removed the retired record's `qualified_by`/`evidence` prose: the run's own
// conclusion and the platform facts are the evidence, not a record column.
export const operationRoles = Object.freeze({
  state: Object.freeze([]),
  'deploy-foundation': Object.freeze([]),
  'deploy-billing': Object.freeze([]),
  'deploy-platform': Object.freeze([]),
  'deploy-egress': Object.freeze([]),
  'delete-egress': Object.freeze([]),
  // Issue #194: the pre-mutation schema-boundary gate runs one read-only
  // `schema-journal` task from the existing `verify` family, under the existing
  // verification-task role.
  'deploy-runtime': Object.freeze(['verify']),
  'stop-runtime': Object.freeze([]),
  'restore-release': Object.freeze([]),
  migrate: Object.freeze(['migrate']),
  'admission-status': Object.freeze(['lifecycle']),
  'add-testers': Object.freeze(['lifecycle']),
  'set-testers': Object.freeze(['lifecycle']),
});
const oneShotRoles = operation => operationRoles[operation];
// The task role each one-shot family registers under. `verify` keeps the existing
// verification-task role (#194): the schema-journal read adds no role, task
// family, log group or IAM statement.
const ONE_SHOT_TASK_ROLES = Object.freeze({
  migrate: 'migration', lifecycle: 'lifecycle', verify: 'verification',
});
const oneShotTaskRole = family => ONE_SHOT_TASK_ROLES[family];
// The only non-URL verify action: one read-only journal read.
const VERIFY_SCHEMA_JOURNAL_COMMAND = Object.freeze(['node', 'dist/verify.js', 'schema-journal']);
// The tester allowlist surface is the whole surviving admission operation set:
// `status` reads it and `set-testers` replaces it. #213 retired the mode
// open/close actions (`resume`/`suspend`) with the mode parameter, so no entry
// lists them. `set-testers` is the only payload-bearing action; `status` takes
// none.
export const lifecycleActions = operation => ({ 'admission-status': ['status'], 'add-testers': ['set-testers', 'status'],
  'set-testers': ['set-testers', 'status'] }[operation] ?? []);
// Issue #194: the `verify` family's only non-URL action is the read-only
// `schema-journal` read. It takes no payload; any other action is refused.
export const verifyActions = operation => ({ 'deploy-runtime': ['schema-journal'] }[operation] ?? []);
const payloadActions = ['set-testers'];
export function assertOneShotAllowed(env, role, action = '', payload) {
  operationBoundary(env);
  if (!oneShotRoles(env.INFRA_OPERATION).includes(role)
    || role === 'lifecycle' && !lifecycleActions(env.INFRA_OPERATION).includes(action)
    || role === 'verify' && (!verifyActions(env.INFRA_OPERATION).includes(action) || payload !== undefined)
    || role !== 'lifecycle' && payload !== undefined
    || role === 'lifecycle' && !payloadActions.includes(action) && payload !== undefined) throw new Error('One-shot role/action is forbidden for this operation');
  if (role === 'lifecycle' && action === 'set-testers') {
    if (payload !== normalizeTesterEmails(payload)) throw new Error('Tester helper requires canonical normalized payload');
    if (env.INFRA_OPERATION === 'set-testers' && payload !== normalizeTesterEmails(env.TESTER_EMAILS)) throw new Error('Tester replacement differs from explicit dispatch input');
    if (parseJson(normalizeTesterEmails(env.TESTER_EMAILS)).some(email => !parseJson(payload).includes(email))) throw new Error('Tester addition omits explicit dispatch input');
  }
}
export function assertDeployAllowed(env, stack) {
  operationBoundary(env);
  if (!changedStackNames(env.INFRA_OPERATION).includes(stack)) throw new Error('Stack deployment is forbidden for this operation');
}
export function families(env, purpose) {
  const boundary = operationBoundary(env);
  if (purpose === 'qualification') {
    if (boundary.readOnly) throw new Error('Read-only observation cannot qualify with tasks');
    // Observation no longer runs a verification task: the immutable-release
    // check that produced it moved into the deployment operations that prove the
    // sealed release before any credential.
    return [];
  }
  if (purpose !== 'operation') throw new Error('Unknown credential purpose');
  return boundary.readOnly ? [] : [...operationRoles[env.INFRA_OPERATION]];
}
// Issue #254: `deploy-runtime` repairs the Beta edge with exactly one Base-stack
// parameter write, so the deploy session may call `cloudformation update-stack`
// on `AnyWearPlatformStack-beta` and nothing else. The call shape is pinned: the
// previous template is reused (no `--template-body`/`--template-url`), no
// invocation role is named, the only capability is the named-IAM one the CDK
// change-set path already needs, and the only parameters are the retained CDK
// bootstrap version and the new DNS-name origin.
const BASE_ORIGIN_PARAMETER = /^ParameterKey=ApiOriginDomainName,ParameterValue=[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const BASE_ORIGIN_BOOTSTRAP = 'ParameterKey=BootstrapVersion,UsePreviousValue=true';
function baseOriginUpdate(env, args) {
  if (env.INFRA_OPERATION !== 'deploy-runtime') return false;
  const values = flag => args.reduce((found, value, index) => (value === flag ? [...found, args[index + 1]] : found), []);
  if (values('--stack-name').join() !== 'AnyWearPlatformStack-beta') return false;
  if (values('--capabilities').join() !== 'CAPABILITY_NAMED_IAM') return false;
  if (!args.includes('--use-previous-template')) return false;
  if (args.some(value => /^--(?:template-body|template-url|role-arn|cli-input-json|no-use-previous-template)/.test(value))) return false;
  // `--parameters` is followed by one value per parameter, not by a repeated flag.
  if (args.filter(value => value === '--parameters').length !== 1) return false;
  const parameters = [];
  for (let index = args.indexOf('--parameters') + 1; index < args.length && !args[index].startsWith('--'); index += 1) {
    parameters.push(args[index]);
  }
  return parameters.length === 2 && parameters.filter(value => value === BASE_ORIGIN_BOOTSTRAP).length === 1
    && parameters.filter(value => BASE_ORIGIN_PARAMETER.test(value)).length === 1;
}
export function assertAwsAllowed(env, args, purpose = 'operation', session = 'runtime') {
  const boundary = operationBoundary(env);
  const key = `${args[0]}/${args[1]}`;
  const argument = flag => args[args.indexOf(flag) + 1];
  if (args.includes('--with-decryption')) throw new Error('Runtime parameter decryption is forbidden');
  // The deploy session is a change-set driver plus, since #254, one pinned
  // Base-stack parameter update. CDK creates the change set through the bootstrap
  // deploy role, so no create action is needed or granted here.
  if (session === 'deploy') {
    if (purpose === 'operation' && args[0] === 'cloudformation'
      && ['describe-change-set', 'execute-change-set', 'delete-change-set'].includes(args[1])
      && ['deploy-runtime', 'stop-runtime'].includes(env.INFRA_OPERATION)
      && argument('--stack-name') === 'AnyWearRuntimeStack-beta'
      && /^anywear-runtime-[0-9]+$/.test(argument('--change-set-name') ?? '')) return;
    if (purpose === 'operation' && args[0] === 'cloudformation' && args[1] === 'update-stack'
      && baseOriginUpdate(env, args)) return;
    throw new Error(`AWS action ${key} is forbidden for the deploy session`);
  }
  if (reads[key] && operationReads(env).includes(key) && (!boundary.readOnly || stateReads.includes(key))) return;
  if (args[0] === 'ecs' && args[1] === 'wait') {
    const allowed = args[2] === 'tasks-stopped' || !boundary.readOnly && args[2] === 'services-stable';
    if (!boundary.readOnly && allowed) return;
  }
  const allowedFamilies = families(env, purpose);
  if (args[0] === 'ecs' && args[1] === 'register-task-definition') {
    const definition = parseJson(argument('--cli-input-json'));
    const family = allowedFamilies.find(allowed => definition.family === `beta-anywear-${allowed}`);
    const role = oneShotTaskRole(family);
    const container = definition.containerDefinitions?.find(row => row.name === 'OneShot');
    const command = container?.command;
    if (family && definition.taskRoleArn === `arn:aws:iam::650880818323:role/beta-anywear-${role}-task`
      && definition.executionRoleArn === 'arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution'
      && command?.[0] === 'node') {
      if (family === 'lifecycle' && command[1] === 'dist/ops/beta-lifecycle.js' && [3, 4].includes(command.length)) {
        assertOneShotAllowed(env, 'lifecycle', command[2], command[3]); return;
      }
      if (family === 'migrate' && command[1] === 'dist/migrate.js' && command.length === 2) return;
      // Issue #194: the verify family's only accepted registration is the exact
      // schema-journal read, with no payload and no other command.
      if (family === 'verify' && canonicalJson(command) === canonicalJson(VERIFY_SCHEMA_JOURNAL_COMMAND)) {
        assertOneShotAllowed(env, 'verify', 'schema-journal'); return;
      }
    }
  }
  if (args[0] === 'ecs' && ['run-task', 'deregister-task-definition'].includes(args[1])) {
    const definition = argument('--task-definition');
    if (allowedFamilies.some(family => new RegExp(`^arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${family}:[1-9][0-9]*$`).test(definition ?? ''))) return;
  }
  if (key === 'logs/put-retention-policy' && purpose === 'operation'
    && changedStackNames(env.INFRA_OPERATION).includes('AnyWearPlatformStack-beta')) return;
  throw new Error(`AWS action ${key} is forbidden for this operation`);
}

const arn = (service, suffix, awsRegion = 'ap-east-1') => `arn:aws:${service}:${awsRegion}:650880818323:${suffix}`;
// Issue #165/#214: the authorization preflight calls the IAM policy simulator
// from inside the restricted runtime session; the simulator actions have no
// resource-level scope, so the generated runtime session policy carries them on
// `*`. The deploy session no longer simulates anything, so its copy is gone; the
// two roles' identity grants stay (#196 owns narrowing those).
const simulate = ['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy'];
export function sessionPolicy(kind, env, purpose = 'operation') {
  const boundary = operationBoundary(env);
  const statement = (Action, Resource = '*', Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  let statements;
  if (kind === 'deploy') {
    if (purpose !== 'operation' || !changedStackNames(env.INFRA_OPERATION).length) throw new Error('Deploy credentials are forbidden for this operation');
    const regions = env.INFRA_OPERATION === 'deploy-billing' ? ['us-east-1'] : ['ap-east-1'];
    statements = [statement(['sts:GetCallerIdentity', 'cloudformation:DescribeStacks', 'ssm:GetParameter',
      'ec2:DescribeManagedPrefixLists']),
      statement('sts:AssumeRole', regions.flatMap(roleRegion => ['deploy', 'file-publishing', 'lookup'].map(role =>
        `arn:aws:iam::650880818323:role/cdk-hnb659fds-${role}-role-650880818323-${roleRegion}`))),
      statement('secretsmanager:GetSecretValue', arn('secretsmanager', 'secret:/anywear/beta/cloudfront_origin_header-*'))];
    // Issue #195: the deploy-runtime session describes the change set it created
    // and executes or deletes it. The statement is scoped to the Runtime stack
    // and its change-set collection; no create action is needed because the CDK
    // CLI creates the change set through the bootstrap deploy role.
    if (env.INFRA_OPERATION === 'deploy-runtime') {
      statements.push(statement(['cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet',
        'cloudformation:DeleteChangeSet'],
      [arn('cloudformation', 'stack/AnyWearRuntimeStack-beta/*'), arn('cloudformation', 'changeSet/*')]));
      // Issue #254: the same session writes exactly one Base-stack parameter after
      // the Runtime stack is terminal, so the edge points at the load balancer the
      // run created. Scoped to the Base stack; the call allow-list refuses a
      // template body or URL, so the template itself cannot change.
      statements.push(statement('cloudformation:UpdateStack', arn('cloudformation', 'stack/AnyWearPlatformStack-beta/*')));
    }
  } else if (kind === 'runtime') {
    const allowedFamilies = families(env, purpose);
    statements = [statement((boundary.readOnly ? stateReads : operationReads(env)).map(read => reads[read])
      .concat(boundary.readOnly ? [] : simulate))];
    if (allowedFamilies.length) {
      const definitions = allowedFamilies.map(family => arn('ecs', `task-definition/beta-anywear-${family}:*`));
      statements.push(statement(['ecs:RegisterTaskDefinition', 'ecs:RunTask'], definitions),
        statement('ecs:DeregisterTaskDefinition'),
        statement('iam:PassRole', [...new Set(allowedFamilies.map(oneShotTaskRole))]
          .map(role => `arn:aws:iam::650880818323:role/beta-anywear-${role}-task`)
          .concat('arn:aws:iam::650880818323:role/beta-anywear-one-shot-execution'),
        { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } }));
    }
    if (purpose === 'operation' && changedStackNames(env.INFRA_OPERATION).includes('AnyWearPlatformStack-beta')) {
      statements.push(statement('logs:PutRetentionPolicy', ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*']
        .map(name => arn('logs', `log-group:/aws/lambda/${name}:*`))));
    }
  } else throw new Error('Unknown dedicated role');
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  if (policy.length > 2048) throw new Error('STS session policy exceeds the inline policy limit');
  return policy;
}
