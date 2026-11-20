import { parseJson, canonicalJson } from './json-contract.mjs';
import { changedStackNames } from './operation-stacks.mjs';
import { normalizeTesterEmails } from './tester-allowlist.mjs';
import { account, region } from './deployment-contract.mjs';
import { apiOriginUpdateArguments } from './runtime-deploy.mjs';
import { REARM_COMMAND, REARM_OBJECT_DELETION, rearmCommand, rearmRequestArgument } from './object-deletion-rearm.mjs';
import { clientInvalidationArguments, clientSyncArguments } from './client-interface.mjs';

// One dispatch surface per deployable unit. `runtime.yml` hosts the read-only
// `state` entry; every mutation shares `mutate.yml`, including since #195 the
// release slice's `deploy-runtime` and `stop-runtime`. Issue #207 retired the
// `observe` operation with the record it produced; #213 retired the admission
// open/close operations, leaving the tester allowlist surface. Issue #321 adds
// the one operator repair for an abandoned object-deletion manifest. Issue #344
// adds `publish-client`, the single writer of the Client's served assets.
export const workflowOperations = Object.freeze({
  '.github/workflows/runtime.yml': ['state'],
  '.github/workflows/mutate.yml': ['deploy-foundation', 'deploy-billing', 'deploy-platform',
    'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
    'admission-status', 'add-testers', 'set-testers', REARM_OBJECT_DELETION, 'publish-client'],
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
  // Issue #321: the abandoned-manifest re-arm has `migrate`'s shape — a one-shot
  // runtime data operation from the immutable release image under an existing task
  // role. It is not a deployment, not an admission write and not read-only
  // observation, so it joins the schema family instead of introducing an operation
  // family of its own; its one-shot role allow-list is the lifecycle role it
  // already has.
  'rearm-object-deletion': 'beta-schema',
  // Issue #344: the Client publication is its own family because it changes no
  // stack — no CDK deploy, no change set, no one-shot task. It writes S3 and
  // CloudFront and then writes one publication record, so it cannot share the
  // deployment family's deploy-session or one-shot rules; the family name is what
  // makes "changes no stack" visible next to the eight operations that do.
  'publish-client': 'beta-publish',
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
  // Issue #266: a repository's numeric id is immutable across an owner transfer
  // while its owner name is not, so the executor is identified by id and the
  // workflow ref is compared against this run's own full name.
  const paths = env.GITHUB_REPOSITORY_ID === '1409047265' ? qualifiedWorkflowPaths
    : env.GITHUB_REPOSITORY_ID === '1317091305' ? e2eExecutorPaths : [];
  if (!paths.some(file => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${file}@refs/heads/main`)) {
    throw new Error('Protected executor workflow required');
  }
  // An Infra executor must execute the reviewed revision. AnyWear-E2E executes
  // from its own pinned checkout and states the observed Infra helper revision
  // explicitly, so its run SHA is the executor identity rather than the Infra SHA.
  if (env.GITHUB_REPOSITORY_ID === '1409047265' && env.GITHUB_SHA !== infraSha) {
    throw new Error('Protected executor source required');
  }
  if (!Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT))) throw new Error('Executor run identity required');
  return { repository: env.GITHUB_REPOSITORY, sha: infraSha, workflow_path: env.GITHUB_WORKFLOW_REF.split('/').slice(2).join('/').split('@')[0],
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}

export function operationBoundary(env) {
  const operation = env.INFRA_OPERATION;
  // Issue #266: the workflow ref names this run's own repository, so the same
  // exact match holds under either owner.
  const workflow = Object.keys(workflowOperations).find(file => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${file}@refs/heads/main`);
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
// Issue #344: an operation whose own restricted session performs a closed set of
// reads declares that set here. It is the same read table and the same
// `operationReads` lookup — the universal set above is what an operation that
// shares the runtime session reads, and `publish-client` shares nothing: its
// session is the Client publication's, and it reads exactly the three calls the
// live-interface resolution makes. A read absent from this list is refused for
// the operation by the same allow-list branch every other operation uses, so the
// entry cannot drift into a fourth read without a reviewed diff here.
export const closedReadSets = Object.freeze({
  'publish-client': Object.freeze(['sts/get-caller-identity', 'cloudformation/describe-stacks', 'ssm/get-parameter']),
});
// The reviewed read set the dispatched operation's runtime session performs. The
// simulation plan, the generated session policy and the AWS call allow-list all
// derive from this one function, so an operation cannot be granted a read it does
// not perform and cannot call a read another operation's session needs.
export function operationReads(env) {
  const operation = env?.INFRA_OPERATION;
  if (closedReadSets[operation] !== undefined) return [...closedReadSets[operation]];
  return Object.keys(reads).filter((pair) => !(pair in readOperations) || readOperations[pair].includes(operation));
}
// Issue #316: the read-only `state` entry reads the same ECS steady-state facts the
// `deploy-runtime` proof does — the two services' deployments, and the bounded task
// attribution for a service that is not settled. All three actions are already held
// by `beta-infra-runtime-role` (`lib/beta-role-grants.ts`), so this adds a read to
// the operation's reviewed session, not an IAM grant. `state` performs no `ecs wait`,
// registers no task, runs none and writes nothing.
export const stateReads = ['sts/get-caller-identity', 'cloudformation/describe-stacks', 'cloudformation/get-template', 'ssm/get-parameter',
  'ecs/describe-services', 'ecs/list-tasks', 'ecs/describe-tasks'];
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
  // Issue #321: one fenced repair on the existing lifecycle task role — no new
  // role and no new one-shot family.
  'rearm-object-deletion': Object.freeze(['lifecycle']),
  // Issue #344: the Client publication launches no one-shot task and registers no
  // task definition; its only writes go through the client-publish session.
  'publish-client': Object.freeze([]),
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
// lists them. `set-testers` is the only admission action that carries a payload.
// Issue #321 adds the abandoned-manifest repair as the lifecycle role's one new
// action; its payload is the composed manifest/generation argument below.
export const lifecycleActions = operation => ({ 'admission-status': ['status'], 'add-testers': ['set-testers', 'status'],
  'set-testers': ['set-testers', 'status'], [REARM_OBJECT_DELETION]: [REARM_OBJECT_DELETION] }[operation] ?? []);
// Issue #194: the `verify` family's only non-URL action is the read-only
// `schema-journal` read. It takes no payload; any other action is refused.
export const verifyActions = operation => ({ 'deploy-runtime': ['schema-journal'] }[operation] ?? []);
const payloadActions = ['set-testers', REARM_OBJECT_DELETION];
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
  // Issue #321: the re-arm payload is composed from the two dispatch inputs, so a
  // payload that is not exactly that composed argument — a changed manifest, a
  // changed generation, an extra field or a different serialisation — is refused
  // before the task is registered.
  if (role === 'lifecycle' && action === REARM_OBJECT_DELETION
    && payload !== rearmRequestArgument(env)) throw new Error('Re-arm helper requires the exact composed manifest/generation payload');
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
    // sealed artifact before any credential.
    return [];
  }
  if (purpose !== 'operation') throw new Error('Unknown credential purpose');
  return boundary.readOnly ? [] : [...operationRoles[env.INFRA_OPERATION]];
}
// Issue #254: `deploy-runtime` repairs the Beta edge with exactly one Base-stack
// parameter write, so the deploy session may call `cloudformation update-stack`
// on `AnyWearPlatformStack-beta` and nothing else. The whole argument vector is
// compared with the one builder that constructs it, `apiOriginUpdateArguments`:
// an extra flag (`--tags`, `--notification-arns`, `--stack-policy-body`,
// `--disable-rollback`, `--rollback-configuration`, `--timeout-in-minutes`, a
// template body or URL, an invocation role), a duplicate, a reordering or a
// different parameter set is refused instead of passing a flag scan. The builder
// also refuses a non-DNS origin.
const BASE_ORIGIN_TOKEN = 'ParameterKey=ApiOriginDomainName,ParameterValue=';
function baseOriginUpdate(env, args) {
  if (env.INFRA_OPERATION !== 'deploy-runtime') return false;
  const originTokens = args.filter(value => typeof value === 'string' && value.startsWith(BASE_ORIGIN_TOKEN));
  if (originTokens.length !== 1) return false;
  let expected;
  try {
    expected = apiOriginUpdateArguments(originTokens[0].slice(BASE_ORIGIN_TOKEN.length));
  } catch {
    return false;
  }
  return args.length === expected.length && expected.every((token, index) => args[index] === token);
}
// Issue #344: the Client publication session performs exactly two writes, and both
// are compared as whole argument vectors the way the Base origin update above is:
// `aws s3 sync <verified tree> s3://<live bucket> --delete` and `aws
// cloudfront create-invalidation --distribution-id <live id> --paths /*`. The
// local directory, the bucket and the distribution are the values this run
// resolved, so a different bucket, a different distribution, a second path, a
// `s3 cp`, a `s3 rm`, a `cloudfront update-distribution`, an extra flag, a
// duplicate or a reordering is refused instead of passing a flag scan. Nothing is
// admitted before the live interface has been resolved (`resources` absent), so the
// read-only resolution session cannot write at all.
function clientPublishWrite(env, resources, args) {
  if (env.INFRA_OPERATION !== 'publish-client' || resources === undefined) return false;
  const expected = [clientSyncArguments(resources.bucket),
    clientInvalidationArguments(resources.distribution_id)];
  return expected.some(tokens => args.length === tokens.length && tokens.every((token, index) => args[index] === token));
}
export function assertAwsAllowed(env, args, purpose = 'operation', session = 'runtime', resources = undefined) {
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
  // Issue #344: the Client publication session's two writes. The reads above are
  // the only other calls it may make, so this branch ends the session's surface:
  // anything else — a stack update, a task, a secret read — is refused here.
  if (session === 'client-publish') {
    if (purpose === 'operation' && clientPublishWrite(env, resources, args)) return;
    throw new Error(`AWS action ${key} is forbidden for the client-publish session`);
  }
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
      // The re-arm action is not a beta-lifecycle action: its one accepted
      // registration is the object-deletion entry point below, so this branch
      // refuses it even with an otherwise valid action/payload pair.
      if (family === 'lifecycle' && command[1] === 'dist/ops/beta-lifecycle.js' && [3, 4].includes(command.length)
        && command[2] !== REARM_OBJECT_DELETION) {
        assertOneShotAllowed(env, 'lifecycle', command[2], command[3]); return;
      }
      // Issue #321: the re-arm's only accepted registration is the exact command
      // the reviewed dispatch inputs compose — the one fixed entry point plus the
      // one canonical JSON argument. A reordered or extra argument, a second
      // payload or a different image/role is refused at registration.
      if (family === 'lifecycle' && env.INFRA_OPERATION === REARM_OBJECT_DELETION) {
        let expected;
        try { expected = rearmCommand(env); } catch { expected = undefined; }
        if (expected && canonicalJson(command) === canonicalJson(expected)) {
          assertOneShotAllowed(env, 'lifecycle', REARM_OBJECT_DELETION, command[2]); return;
        }
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
export function sessionPolicy(kind, env, purpose = 'operation', resources = undefined) {
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
  } else if (kind === 'client-publish') {
    // Issue #344: the Client publication runs under `beta-client-publish-role`.
    // Its grants are unchanged (S3 on the one client bucket, the two invalidation
    // actions on the one distribution, DescribeStacks and the two Cognito
    // parameter reads); this session narrows them to the exact calls the
    // publication makes. A session policy cannot name a bucket or a distribution
    // whose name is only known after the live read, so the run assumes the same
    // role twice: without `resources` this is the read-only resolution session and
    // it carries only the three reads, and with `resources` it is the publication
    // session and it adds exactly the two writes on the resources it resolved.
    if (purpose !== 'operation' || env.INFRA_OPERATION !== 'publish-client') {
      throw new Error('Client publish credentials are forbidden for this operation');
    }
    statements = [statement(operationReads(env).map(read => reads[read]))];
    if (resources !== undefined) {
      const bucketArn = `arn:aws:s3:::${resources.bucket}`;
      statements.push(
        statement(['s3:ListBucket', 's3:GetBucketLocation'], bucketArn),
        // The role's three object actions: `s3 sync` lists the bucket, uploads the
        // changed files and, with `--delete`, removes the keys the verified tree no
        // longer carries. No bucket-level write and no delete-bucket.
        statement(['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], `${bucketArn}/*`),
        statement(['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
          `arn:aws:cloudfront::650880818323:distribution/${resources.distribution_id}`));
    }
  } else throw new Error('Unknown dedicated role');
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: statements });
  if (policy.length > 2048) throw new Error('STS session policy exceeds the inline policy limit');
  return policy;
}
