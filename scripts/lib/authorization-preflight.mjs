import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reads, sessionPolicy, operationReads } from './operation-boundaries.mjs';
import { STAGE_CONTRACT_PARAMETERS } from './stage-contract-parameters.mjs';
import { account, region } from './deployment-contract.mjs';

const execute = promisify(execFile);

// The enforced preflight (#165). Before a runtime-session mutation the operation
// simulates the effective authorization of the runtime role: the base identity
// policy with iam:SimulatePrincipalPolicy, and the generated session policy with
// iam:SimulateCustomPolicy. Both must allow every required read; the effective
// permission is the intersection of the two, so proving them separately is sound.
// PolicyInputList is additive (it does not intersect), which is why the session
// policy is simulated as its own custom policy rather than added to the principal
// simulation. There is one plan, derived from the reviewed reads table; the CDK
// deploy, change-set and destroy paths run no simulation at all (#214), because a
// hardcoded guess at the CDK CLI's call surface cannot fail for a new CDK read.
export const PREFLIGHT_MARKER = 'preflight';
export const SIMULATE_ACTIONS = Object.freeze(['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy']);

const arn = (service, resource, callRegion = region) => `arn:aws:${service}:${callRegion}:${account}:${resource}`;
const stack = (name, callRegion = region) => arn('cloudformation', `stack/${name}/*`, callRegion);
const iamRole = (name) => `arn:aws:iam::${account}:role/${name}`;

const STACKS = Object.freeze([stack('AnyWearFoundationStack'), stack('AnyWearPlatformStack-beta'),
  stack('AnyWearBillingStack-beta', 'us-east-1'), stack('AnyWearRuntimeStack-beta'),
  stack('AnyWearWorkloadStack-beta'), stack('AnyWearEgressStack-beta')]);
const ONE_SHOT_FAMILIES = Object.freeze(['migrate', 'verify', 'lifecycle', 'artifact-verify']);
const TASK_FUNCTIONS = Object.freeze(['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync',
  'AnyWearPlatformStack-beta-*'].map((name) => arn('lambda', `function:${name}`)));
// The runtime role reads the full published stage contract plus the tester
// allowlist, the only admission parameter after #213; the simulator plan uses
// every reviewed name rather than a representative subset. The deploy session no
// longer has a plan: the CDK CLI's own call surface is not modelled here (#214).

const STAGE_PARAMETER_ARNS = Object.freeze([...new Set([...STAGE_CONTRACT_PARAMETERS,
  '/anywear/beta/tester_allowlist',
  '/anywear/beta/infra_selection', '/anywear/beta/infra_deployment']
  .map((name) => `arn:aws:ssm:${region}:${account}:parameter${name}`))]);
const BASE_QUEUES = Object.freeze(['beta-anywear-vto', 'beta-anywear-vto-dlq',
  'beta-anywear-auto-tagging', 'beta-anywear-auto-tagging-dlq'].map((name) => arn('sqs', name)));

// The resource ARNs/forms each reviewed read evaluates. This table is the
// simulation plan's only data source; it mirrors the API-evaluated forms rather
// than the call-site text (for example logs:DescribeLogGroups is evaluated in its
// list form with an empty log-group name).
export const READ_RESOURCES = Object.freeze({
  'cloudformation/describe-stacks': STACKS,
  'cloudformation/get-template': STACKS,
  // The platform list read plus the Egress stack the runtime role reads for
  // `delete-egress` (lib/beta-role-grants.ts).
  'cloudformation/list-stack-resources': Object.freeze([STACKS[1], STACKS[5]]),
  'ssm/get-parameter': STAGE_PARAMETER_ARNS,
  'ssm/get-parameters': STAGE_PARAMETER_ARNS,
  'ecs/describe-services': Object.freeze(['beta-anywear-api', 'beta-anywear-worker']
    .map((name) => arn('ecs', `service/beta-anywear/${name}`))),
  'ecs/describe-tasks': Object.freeze([arn('ecs', 'task/beta-anywear/00000000000000000000000000000000')]),
  // ECS DescribeTaskDefinition has no resource-level permissions: the simulator
  // returns implicitDeny for a concrete task-definition ARN even when the policy
  // allows the action on `*`.
  'ecs/describe-task-definition': Object.freeze(['*']),
  'ecs/list-tasks': Object.freeze(['*']),
  'ecr/describe-images': Object.freeze([arn('ecr', 'repository/beta-anywear-service')]),
  'lambda/get-function': TASK_FUNCTIONS,
  'sqs/get-queue-attributes': BASE_QUEUES,
  // DescribeLogGroups is account-level: its list form has no resource type, so a
  // log-group/log-stream ARN (even an empty-name form) is an implicit deny.
  'logs/describe-log-groups': Object.freeze(['*']),
  // Issue #195: the bake's live reads (`deploy-runtime` only, `readOperations`).
  'cloudwatch/get-metric-statistics': Object.freeze(['*']),
  'cloudwatch/describe-alarms': Object.freeze(['beta-anywear-alb-5xx', 'beta-anywear-api-p95-latency',
    'beta-anywear-ecs-running-not-desired', 'beta-anywear-vto-oldest-message',
    'beta-anywear-auto-tagging-oldest-message', 'beta-anywear-vto-dlq-not-empty',
    'beta-anywear-auto-tagging-dlq-not-empty', 'beta-anywear-outbox-oldest-age']
    .map((name) => arn('cloudwatch', `alarm:${name}`))),
  'logs/filter-log-events': Object.freeze(['/anywear/beta/worker', '/anywear/beta/worker:*']
    .map((name) => arn('logs', `log-group:${name}`))),
});

// Reads that are not simulated, each with the reason. A new reviewed read must be
// either in READ_RESOURCES or recorded here.
export const SIMULATION_SKIPS = Object.freeze({
  'sts/get-caller-identity': 'No IAM permission is required; the call is allowed to every principal.',
  'ecr/batch-get-image': 'The reviewed mapping also needs ecr:BatchCheckLayerAvailability and ecr:GetDownloadUrlForLayer, which the restricted runtime role does not grant; the operation has no Infra call site (operator CLI only) and is not simulated.',
  'cloudfront/get-distribution': 'A conditional legacy fallback whose base grant the runtime role may deny by design; the session never adds grants and the fallback must surface through the deployment itself if it is ever taken.',
  'ecr/describe-images': 'An operator-CLI read (scripts/ecr-retention.mjs); the deployed runtime session does not execute it and the preflight plan does not include operator-only reads.',
  'ecr/get-lifecycle-policy': 'An operator-CLI lifecycle read (scripts/ecr-retention.mjs); not executed by the deployed session.',
  'ecr/get-lifecycle-policy-preview': 'An operator-CLI lifecycle read (scripts/ecr-retention.mjs); not executed by the deployed session.',
  'ecr/start-lifecycle-policy-preview': 'An operator-CLI mutation (scripts/ecr-retention.mjs); the preflight covers reads only.',
  'ecs/wait': 'A waiter is not an action; its polling reads are simulated through ecs/describe-tasks and ecs/describe-services.',
  'ecs/register-task-definition': 'A mutation, not a read; the preflight runs before the task script and must not register a task definition.',
  'ecs/run-task': 'A mutation, not a read; the preflight runs before the task script and must not start a task.',
  'logs/put-retention-policy': 'A mutation, not a read; it is the deployment step the preflight protects.',
  // The IAM policy simulator cannot evaluate CloudWatch Logs log-stream ARNs:
  // every `log-group:...:log-stream:...` form returns implicitDeny even under a
  // session policy that grants `logs:GetLogEvents` on `*` (form probes 2026-10-22).
  // The reviewed runtime grant is on log-stream ARNs and the operation's own read
  // exercises it, so the plan does not simulate this pair.
  'logs/get-log-events': 'CloudWatch Logs log-stream ARNs cannot be evaluated by the IAM policy simulator: every `log-group:...:log-stream:...` form returns implicitDeny even under the session policy that grants `logs:GetLogEvents` on `*` (form probes 2026-10-22). The reviewed runtime grant is on `beta-anywear-<family>/OneShot/*` log-stream ARNs, so the plan cannot prove this read by simulation; the operation\'s own read is the check.',
});

// One reviewed context for every simulation. The conditions in the deployment
// roles use exactly these keys; supplying the values avoids an implicit deny that
// comes from a missing context rather than from a missing grant.
export const CONTEXT_ENTRIES = Object.freeze([
  Object.freeze({ ContextKeyName: 'aws:RequestedRegion', ContextKeyValues: [region], ContextKeyType: 'string' }),
  // `ecs:cluster` is ARN-valued but the simulator has no `arn` context-key type:
  // an ARN condition key is supplied as a string value.
  Object.freeze({ ContextKeyName: 'ecs:cluster', ContextKeyValues: [`arn:aws:ecs:${region}:${account}:cluster/beta-anywear`], ContextKeyType: 'string' }),
  Object.freeze({ ContextKeyName: 'iam:PassedToService', ContextKeyValues: ['ecs-tasks.amazonaws.com'], ContextKeyType: 'string' }),
  Object.freeze({ ContextKeyName: 'ecs:CreateAction', ContextKeyValues: ['RegisterTaskDefinition'], ContextKeyType: 'string' }),
]);

export class AuthorizationPreflightError extends Error {
  constructor(kind, reason, detail, failures = []) {
    super(`Authorization preflight failed for the ${kind} session (${reason}): ${detail}`);
    this.name = 'AuthorizationPreflightError';
    this.kind = kind;
    this.reason = reason;
    this.denial = reason === 'denied' || reason === 'simulator-denied';
    this.failures = failures;
  }
}

// Runtime reads come from the reviewed reads table in operation-boundaries.mjs,
// scoped by `operationReads` to the reads the dispatched operation performs. The
// runtime session is the only preflight session (#214); the CDK deploy,
// change-set and destroy paths run no simulation. Mutations are not simulated:
// the preflight proves the reads before the mutation begins. The scope narrows
// what an operation must already hold; it never removes a read the operation
// performs, so `deploy-runtime` — the only operation that runs the bake — still
// simulates the bake reads and still fails closed when the role lacks them.
export function simulationRequests(kind, env, purpose = 'operation') {
  if (kind !== 'runtime') throw new Error(`Unknown preflight session ${kind}`);
  const requests = [];
  for (const pair of operationReads(env)) {
    if (pair in SIMULATION_SKIPS) continue;
    const resources = READ_RESOURCES[pair];
    if (!resources) throw new Error(`Read ${pair} has no reviewed simulation resources`);
    requests.push({ pair, actions: [reads[pair]], resources: [...resources] });
  }
  // The session policy is the other half of the intersection; its actions are
  // asserted against the same requests by the callers.
  return requests;
}

function policyDocument(kind, env, purpose) {
  return sessionPolicy(kind, env, purpose);
}

function detailsOf(error) {
  const stderr = String(error?.stderr ?? '').trim().split('\n').filter(Boolean);
  return (stderr[stderr.length - 1] ?? error?.message ?? 'unknown error').slice(0, 600);
}

async function evaluate({ kind, request, simulation, run, timeout }) {
  let stdout;
  try {
    stdout = (await run('aws', simulation, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    const detail = detailsOf(error);
    if (/AccessDenied|not authorized|UnauthorizedOperation|AuthorizationError/i.test(detail)) {
      throw new AuthorizationPreflightError(kind, 'simulator-denied',
        `the restricted session cannot simulate authorization: ${detail}`);
    }
    throw new AuthorizationPreflightError(kind, 'simulator-error', detail);
  }
  const body = stdout?.trim() ? JSON.parse(stdout) : {};
  const results = body.EvaluationResults;
  if (!Array.isArray(results) || results.length === 0) {
    throw new AuthorizationPreflightError(kind, 'simulator-error', 'the simulator returned no evaluation results');
  }
  const failures = results.filter((row) => row.EvalDecision !== 'allowed').map((row) => ({
    action: row.EvalActionName, resource: row.EvalResourceName, decision: row.EvalDecision }));
  if (failures.length) {
    throw new AuthorizationPreflightError(kind, 'denied',
      failures.map((failure) => `${failure.action} on ${failure.resource}: ${failure.decision}`).join('; '),
      failures);
  }
  return results.length;
}

async function simulate({ kind, roleArn, policy, request, contextEntries, run, timeout }) {
  const common = ['--action-names', ...request.actions, '--resource-arns', ...request.resources,
    '--context-entries', JSON.stringify(contextEntries), '--output', 'json'];
  // 1. The principal's own attached and inline policies.
  const principal = ['simulate-principal-policy', '--policy-source-arn', roleArn, ...common];
  const principalEvaluations = await evaluate({ kind, request, simulation: principal, run, timeout });
  // 2. The generated session policy, evaluated alone (PolicyInputList is additive,
  //    so the intersection needs its own simulation).
  const custom = ['simulate-custom-policy', '--policy-input-list', JSON.stringify([policy]), ...common];
  const sessionEvaluations = await evaluate({ kind, request, simulation: custom, run, timeout });
  return principalEvaluations + sessionEvaluations;
}

export async function runAuthorizationPreflight({ sessions, env, purpose = 'operation',
  assume, run = execute, timeout = 120_000 } = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('The preflight needs at least one Infra session');
  const evaluations = [];
  for (const kind of sessions) {
    const roleArn = `arn:aws:iam::${account}:role/beta-infra-${kind}-role`;
    const policy = policyDocument(kind, env, purpose);
    const credentials = await assume(kind, env, purpose, { sessionMarker: PREFLIGHT_MARKER });
    for (const request of simulationRequests(kind, env, purpose)) {
      const count = await simulate({ kind, roleArn, policy, request, contextEntries: CONTEXT_ENTRIES,
        run: async (command, args, options) => {
          // The simulator must run under the marked restricted session, never the
          // job's ambient credential.
          if (command !== 'aws' || !Array.isArray(args) || !args[0]?.startsWith('simulate-')) {
            throw new Error('The preflight only runs IAM simulation calls');
          }
          return run(command, ['iam', ...args], { ...options, env: credentials });
        }, timeout });
      evaluations.push({ kind, pair: request.pair, actions: request.actions, resources: request.resources, evaluations: count });
    }
  }
  return { schema_version: 1, record_type: 'anywear_authorization_preflight',
    session_marker: PREFLIGHT_MARKER, result: 'permitted', evaluations,
    reads_simulated: evaluations.length };
}

// The simulation plan must stay inside what the IaC declares. The lint check
// uses this to tie the preflight to the synthesized policy documents.
export function preflightActionSet(kind, env, purpose = 'operation') {
  return [...new Set(simulationRequests(kind, env, purpose).flatMap((request) => request.actions))];
}
