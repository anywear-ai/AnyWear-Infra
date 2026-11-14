import { readAdmissionState, testerAllowlistHash } from './admission-state.mjs';
import { retainedBetaSizingProfile } from './beta-sizing-profile.mjs';
import { runtimeStack, describeStack } from './one-writer.mjs';
import { DEPLOYMENT_SETTLE_SECONDS, ecsServiceObservation, readServiceTasks, rolloutVerdict } from './ecs-rollout.mjs';
import { RUNTIME_ECS_CLUSTER_INPUT, runtimeEcsClusterName } from './runtime-stage-inputs.mjs';
import { RUNTIME_SERVICE_NAMES } from './runtime-deploy.mjs';

// The allowlist is the only admission value left to observe: a count and a hash,
// never addresses. There is no mode record to report.
function admissionEvidence(admission) {
  const testers = admission?.tester_emails;
  return { tester_count: Array.isArray(testers) ? testers.length : 'unavailable',
    tester_allowlist_hash: Array.isArray(testers) ? testerAllowlistHash(testers) : 'unavailable' };
}

// A service the response does not list is observed as unusable rather than thrown:
// `state` is a read of Beta, and "the Runtime stack exists but ECS does not list one
// of its services" is a fact to report, not a reason to lose the whole read.
function missingServiceObservation(serviceName) {
  return { service_name: serviceName, status: null, task_definition: null, running_count: null,
    desired_count: null, pending_count: null, failed_tasks: 0, deployment_count: 0, rollout_state: null,
    primary_deployment_id: null, newest_deployment_created_at: null, deployments: [] };
}

/**
 * The read-only ECS block (#316). It reads the same two services the deploy proof
 * does, classifies each with the same `rolloutVerdict`, and adds the bounded task
 * attribution only for a service that is not settled. It never waits and never
 * fails on a merely-settling service; the cluster name comes from the reviewed
 * stage contract through the `ssm get-parameter` read this operation already makes.
 */
async function observeRuntimeEcs(io, readAt, windowSeconds) {
  const value = (await io.aws(['ssm', 'get-parameter', '--name', RUNTIME_ECS_CLUSTER_INPUT])).Parameter?.Value;
  const cluster = runtimeEcsClusterName(new Map([[RUNTIME_ECS_CLUSTER_INPUT, value]]));
  const response = await io.aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...RUNTIME_SERVICE_NAMES]);
  const listed = Array.isArray(response.services) ? response.services : [];
  const services = [];
  for (const serviceName of RUNTIME_SERVICE_NAMES) {
    const service = listed.find((candidate) => candidate?.serviceName === serviceName);
    const observation = service ? ecsServiceObservation(service) : missingServiceObservation(serviceName);
    const verdict = rolloutVerdict(observation, { nowMs: readAt, windowSeconds });
    const row = { service_name: serviceName, verdict: verdict.verdict, condition: verdict.condition,
      primary_deployment_id: verdict.deployment.primary_deployment_id,
      running_count: verdict.count.running_count, desired_count: verdict.count.desired_count,
      rollout_age_seconds: verdict.deployment.age_seconds, deployments: observation.deployments };
    if (verdict.verdict !== 'settled') {
      // The bounded attribution is best effort here for the same reason it is in the
      // deploy proof: the verdict is the fact, the attribution is its evidence.
      try {
        row.tasks = await readServiceTasks((args) => io.aws(args), cluster, serviceName);
      } catch {
        row.tasks = [];
      }
    }
    services.push(row);
  }
  return { cluster, services };
}

// This reports infrastructure/SSM/ECS state only; it cannot establish DB/schema
// equality. The result is a run fact printed to the step log, not a record (#207).
export async function observeBetaState(io, { nowMs, windowSeconds = DEPLOYMENT_SETTLE_SECONDS } = {}) {
  const stacks = [];
  const state = { stacks, qualification: 'not-applicable' };
  try {
  const baseName = 'AnyWearPlatformStack-beta';
  const base = await describeStack(io, baseName);
  if (base?.StackName !== baseName || typeof base.StackStatus !== 'string') throw new Error('Beta state stack identity unavailable');
  stacks.push({ stack_name: baseName, status: base.StackStatus });
  // Issue #166: run state is one fact — whether the Runtime stack exists. The
  // absent stack is CloudFormation's own "does not exist" answer, observed as the
  // stopped state here instead of failing the read-only state operation.
  const runtime = await describeStack(io, runtimeStack);
  if (runtime === undefined) {
    stacks.push({ stack_name: runtimeStack, status: 'ABSENT', runtime_exists: false });
  } else {
    if (runtime.StackName !== runtimeStack || typeof runtime.StackStatus !== 'string') {
      throw new Error('Beta state stack identity unavailable');
    }
    stacks.push({ stack_name: runtimeStack, status: runtime.StackStatus, runtime_exists: true });
    const parameters = Object.fromEntries((runtime.Parameters ?? []).map(row => [row.ParameterKey, row.ParameterValue]));
    state.beta_sizing = { beta_api_sizing_profile: retainedBetaSizingProfile(parameters),
      runtime_verification: 'not-applicable' };
    // Issue #316: the run state is known, so the ECS steady state is observable. A
    // stopped Beta reads no ECS at all.
    const readAt = nowMs ?? (typeof io.now === 'function' ? io.now() : Date.now());
    state.ecs = await observeRuntimeEcs(io, readAt, windowSeconds);
  }
  state.admission = admissionEvidence(await readAdmissionState(io));
  return state;
  } catch (cause) {
    // A failed allowlist read is reported as unavailable, never as an empty list.
    state.admission = admissionEvidence(undefined);
    const error = new Error('Complete Beta state observation unavailable', { cause });
    error.observedState = state;
    throw error;
  }
}
