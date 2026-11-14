// Issue #316: one ECS steady-state verdict, shared by the three readers that used
// to classify the same `DescribeServices` response differently, or with no
// tolerance at all.
//
// The `deploy-runtime` identity proof (`scripts/lib/runtime-deploy.mjs`) reads the
// two Runtime services once and throws one sentence for either an unsettled
// deployment or a wrong running count; the 300-second bake
// (`scripts/lib/bake-gate.mjs`) treats any sample that is not exactly one
// `COMPLETED` deployment as breaching; the read-only `state` entry
// (`scripts/lib/observe-beta-state.mjs`) cannot read ECS at all. Two consecutive
// healthy worker rollouts were refused 23 s and 24 s before ECS wrote `COMPLETED`
// (Infra runs 43606836697 and 43616072349), so the tolerance has to be a property
// of the deployment, not of one read.
//
// This module holds the one settle window, the one predicate and the refusal
// vocabulary. It performs no AWS call of its own except the two bounded reads the
// refusal evidence needs (`list-tasks` / `describe-tasks`), which both callers
// invoke through the same reviewed operation boundaries. Nothing here writes,
// waits on ECS or registers a task.
//
// The predicate has two halves on purpose, and the two readers judge different
// ones:
//
// - `deployment` — exactly one listed deployment, that deployment `PRIMARY` and
//   `COMPLETED`, and (when a baseline is supplied) the same deployment id the
//   proof settled on. The proof waits for this half inside the window; the bake
//   requires it on every sample with no tolerance, because after the proof
//   settled any new id is a concurrent writer.
// - `count` — `runningCount` against `desiredCount`. The proof waits for it as
//   part of the composite, which is what absorbs the rolling replacement overlap
//   where ECS runs the old and the new task together (`runningCount` 2 >
//   `desiredCount` 1). The bake does NOT judge it through this predicate: its
//   existing `ecs_running_not_desired.max_gap_seconds = 120` continuous rule stays
//   the count contract, so a single count dip is still tolerated. Folding the
//   count half into the bake's per-sample judgement would re-introduce exactly
//   the zero-tolerance defect this issue removes.

// The settle window, measured from the unsettled deployment's own `createdAt`.
//
// 600 s is measured margin, not a proof: the two refused worker rollouts settled
// 250.1 s and 246.9 s after their deployment was created, and the one older
// reference point (the 2026-11-10 stack create, `ecs-svc/8979704885599744614`)
// settled at about 174 s. A 300-second window would have passed both incidents by
// roughly 50 s — 17 % of the budget — and the variable part of the settle is the
// first ~100 s (image pull, cold placement, task start), where one slow pull
// spends that margin and reproduces the defect. 600 s is about 2.4x the worst
// measured settle, and it delays only a *stalled* rollout: a `FAILED` rollout is
// refused at any age, and the whole path stays inside the `deploy` job's
// 120-minute timeout.
export const DEPLOYMENT_SETTLE_SECONDS = 600;
export const DEPLOYMENT_SETTLE_POLL_SECONDS = 15;
// The read at `createdAt + 600 s` is inclusive, so one proof takes at most 41
// `DescribeServices` reads (the read at the window's first instant plus one per
// poll interval). The proof also refuses as soon as a read's own age exceeds the
// window, so the cap bounds a poll that started late in the deployment's life.
export const DEPLOYMENT_SETTLE_MAX_READS = DEPLOYMENT_SETTLE_SECONDS / DEPLOYMENT_SETTLE_POLL_SECONDS + 1;
// The refusal line's bounds. They are part of the design: one refusal writes one
// line of at most 8 KiB, and that line carries at most 10 service events, at most
// 10 RUNNING plus 10 STOPPED tasks and at most 10 read-verdict rows.
export const DEPLOYMENT_EVENT_LIMIT = 10;
export const DEPLOYMENT_TASK_LIMIT = 10;
export const DEPLOYMENT_READ_SEQUENCE_LIMIT = 10;
export const DEPLOYMENT_REFUSAL_LIMIT_BYTES = 8 * 1024;

// The composite verdict vocabulary. `settled` is the only state a rollout leaves
// without a refusal; `settling` is the only state that waits.
export const ROLLOUT_VERDICTS = Object.freeze(['settled', 'settling', 'stalled', 'failed', 'foreign', 'unusable']);
// Every condition a refusal can name, in the order the predicate checks them.
export const ROLLOUT_CONDITIONS = Object.freeze(['service-not-active', 'no-deployment', 'deployment-shape',
  'rollout-failed', 'deployment-age-unknown', 'rollout-stalled', 'deployment-in-progress', 'running-not-desired']);
// The verdicts a reader must not wait on. `stalled` is here because waiting longer
// cannot help: the deployment is either past its window or already `COMPLETED`
// while the count is not at its desired value.
export const REFUSING_VERDICTS = Object.freeze(['stalled', 'failed', 'foreign', 'unusable']);

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
const count = (value) => (Number.isSafeInteger(value) ? value : null);

/** ISO 8601 from epoch milliseconds, for the line's read and transition times. */
export function observedAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

/**
 * The deployment rows a `DescribeServices` response already carries, kept in the
 * snake_case shape both the bake's sample and the refusal line use. The verdict
 * reads these rows; `deployment_count`, `rollout_state`, `primary_deployment_id`
 * and `newest_deployment_created_at` are derived from them once, here, so every
 * reader sees the same numbers.
 */
export function ecsServiceObservation(service) {
  if (!service || typeof service !== 'object') throw new Error('An ECS service observation is required');
  const rows = Array.isArray(service.deployments) ? service.deployments : [];
  const deployments = rows.map((row) => ({
    id: text(row?.id),
    status: text(row?.status),
    rollout_state: text(row?.rolloutState),
    rollout_state_reason: text(row?.rolloutStateReason),
    created_at: text(row?.createdAt),
    updated_at: text(row?.updatedAt),
    task_definition: text(row?.taskDefinition),
    running_count: count(row?.runningCount),
    desired_count: count(row?.desiredCount),
    pending_count: count(row?.pendingCount),
    failed_tasks: count(row?.failedTasks),
  }));
  // ECS lists exactly one `PRIMARY` deployment per service; a response listing a
  // single deployment is that deployment. A multi-row response with no `PRIMARY`
  // leaves the row undefined, and the verdict refuses the shape instead of guessing.
  const primary = deployments.find((row) => row.status === 'PRIMARY')
    ?? (deployments.length === 1 ? deployments[0] : undefined);
  const createdTimes = deployments.map((row) => row.created_at).filter((value) => value !== null)
    .map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
  return {
    service_name: text(service.serviceName),
    status: text(service.status),
    task_definition: text(service.taskDefinition),
    running_count: count(service.runningCount),
    desired_count: count(service.desiredCount),
    pending_count: count(service.pendingCount),
    failed_tasks: count(service.failedTasks) ?? 0,
    deployment_count: deployments.length,
    rollout_state: primary?.rollout_state ?? null,
    primary_deployment_id: primary?.id ?? null,
    newest_deployment_created_at: createdTimes.length ? observedAt(Math.max(...createdTimes)) : null,
    deployments,
  };
}

/**
 * The deployment's age in whole seconds, from its own `createdAt` to `nowMs`.
 * `undefined` means the age cannot be established — a missing or unparseable
 * `createdAt`, a missing clock, or a `createdAt` after the read — and the window
 * is never applied to an unknown age.
 */
export function deploymentAgeSeconds(createdAt, nowMs) {
  if (!Number.isFinite(nowMs) || typeof createdAt !== 'string') return undefined;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs) || createdMs > nowMs) return undefined;
  return Math.floor((nowMs - createdMs) / 1000);
}

/**
 * Classify one service observation into the two halves and the composite verdict.
 * Pure: the clock is `nowMs`, the window is `windowSeconds`, and the only optional
 * input is the deployment ids the proof settled on.
 *
 * `baselineDeploymentIds` is the bake's argument, not the proof's: after a settled
 * proof, a sample whose `PRIMARY` id is not one of the settled ids is a concurrent
 * writer, so the deployment half is not settled even though its shape looks right.
 */
export function rolloutVerdict(observation, { nowMs, windowSeconds = DEPLOYMENT_SETTLE_SECONDS, baselineDeploymentIds } = {}) {
  if (!observation || typeof observation !== 'object') throw new Error('An ECS service observation is required');
  const deployments = Array.isArray(observation.deployments) ? observation.deployments : [];
  const baseline = Array.isArray(baselineDeploymentIds) && baselineDeploymentIds.length
    ? baselineDeploymentIds.filter((id) => typeof id === 'string' && id !== '') : undefined;
  const ageSeconds = deploymentAgeSeconds(observation.newest_deployment_created_at, nowMs);
  const primary = deployments.find((row) => row.status === 'PRIMARY')
    ?? (deployments.length === 1 ? deployments[0] : undefined);
  const countSettled = Number.isSafeInteger(observation.running_count)
    && Number.isSafeInteger(observation.desired_count)
    && observation.running_count === observation.desired_count && observation.running_count >= 1;
  const deploymentHalf = {
    settled: false,
    condition: null,
    deployment_count: deployments.length,
    primary_deployment_id: primary?.id ?? null,
    rollout_state: primary?.rollout_state ?? null,
    rollout_state_reason: primary?.rollout_state_reason ?? null,
    created_at: primary?.created_at ?? null,
    updated_at: primary?.updated_at ?? null,
    age_seconds: ageSeconds ?? null,
  };
  const countHalf = {
    settled: countSettled,
    running_count: observation.running_count ?? null,
    desired_count: observation.desired_count ?? null,
    pending_count: observation.pending_count ?? null,
  };
  const verdictOf = (verdict, condition, deploymentSettled = false) => ({
    service_name: observation.service_name ?? null,
    verdict,
    condition,
    deployment: { ...deploymentHalf, settled: deploymentSettled, condition },
    count: countHalf,
    baseline_deployment_ids: baseline ?? [],
    observed_deployment_ids: deployments.map((row) => row.id).filter((id) => id !== null),
  });
  const unsettledShape = () => {
    // More than one listed deployment is the rolling replacement still holding both
    // tasks. It is `settling` inside the window and `stalled` past it; an unknown
    // age is refused instead of waited on.
    if (ageSeconds === undefined) return verdictOf('unusable', 'deployment-age-unknown');
    return ageSeconds > windowSeconds
      ? verdictOf('stalled', 'deployment-shape')
      : verdictOf('settling', 'deployment-shape');
  };

  // The service itself first: a DRAINING or absent service is not a rollout.
  if (observation.status !== 'ACTIVE' || typeof observation.task_definition !== 'string') {
    return verdictOf('unusable', 'service-not-active');
  }
  if (deployments.length === 0) return verdictOf('unusable', 'no-deployment');
  if (deployments.length > 1) return unsettledShape();
  const row = deployments[0];
  // A `FAILED` rollout is refused at any age: waiting cannot complete it.
  if (row.rollout_state === 'FAILED') return verdictOf('failed', 'rollout-failed');
  // The settled deployment half: one deployment, `COMPLETED`, and — when a baseline
  // is supplied — the id the proof settled on.
  if (row.rollout_state === 'COMPLETED') {
    if (baseline !== undefined && (row.id === null || !baseline.includes(row.id))) {
      return verdictOf('foreign', 'deployment-shape');
    }
    // A completed deployment whose task died leaves a count that waiting will not
    // repair by itself, so the composite refuses now instead of polling. The
    // deployment half is settled; only the count half is not.
    if (!countSettled) return verdictOf('stalled', 'running-not-desired', true);
    return verdictOf('settled', null, true);
  }
  // Any other rollout state is a rollout in progress, judged on its own age. An
  // absent state is treated the same way: the predicate never assumes completion.
  if (ageSeconds === undefined) return verdictOf('unusable', 'deployment-age-unknown');
  return ageSeconds > windowSeconds
    ? verdictOf('stalled', 'rollout-stalled')
    : verdictOf('settling', 'deployment-in-progress');
}

/** True when a reader must refuse instead of waiting. */
export function isRefusal(verdict) {
  return REFUSING_VERDICTS.includes(verdict?.verdict);
}

/**
 * The thrown sentence for a refusal. It repeats the decidable part — the condition,
 * the service and every deployment id with its `rolloutState` — so the one-line
 * failure in the job log states what the structured line states in the step log.
 */
export function rolloutRefusalMessage({ serviceName, condition, deployments = [], readAtMs, ageSeconds } = {}) {
  const phrase = {
    'service-not-active': 'is not usable',
    'no-deployment': 'has no deployment',
    'deployment-shape': 'does not have exactly one deployment',
    'rollout-failed': 'has a failed rollout',
    'deployment-age-unknown': 'has a deployment of unknown age',
    'rollout-stalled': 'has not completed its rollout',
    'deployment-in-progress': 'has not completed its rollout',
    'running-not-desired': 'is not at its desired count',
  }[condition];
  if (phrase === undefined) throw new Error(`Unknown ECS rollout condition ${condition}`);
  const ids = deployments.map((row) => `${row.id ?? 'no-id'}:${row.rollout_state ?? 'no-rollout-state'}`).join(',');
  const read = Number.isFinite(readAtMs) ? observedAt(readAtMs) : 'unknown';
  const age = Number.isFinite(ageSeconds) ? `${ageSeconds}s` : 'unknown';
  return `The Runtime ECS service ${serviceName} ${phrase}; condition ${condition}; deployments ${ids || 'none'}; rollout_age ${age}; read_at ${read}`;
}

/**
 * The last `DEPLOYMENT_EVENT_LIMIT` service events of one `DescribeServices` row.
 * ECS returns them newest first; the line keeps that order and its own bound.
 */
export function boundedServiceEvents(service) {
  const events = Array.isArray(service?.events) ? service.events : [];
  return events.slice(0, DEPLOYMENT_EVENT_LIMIT)
    .map((event) => ({ at: text(event?.createdAt), message: text(event?.message) }));
}

/** One task row, keeping only the attribution a refusal needs. */
export function ecsTaskObservation(task) {
  return {
    task_arn: text(task?.taskArn),
    last_status: text(task?.lastStatus),
    health_status: text(task?.healthStatus),
    desired_status: text(task?.desiredStatus),
    stopped_reason: text(task?.stoppedReason),
    stopped_at: text(task?.stoppedAt),
    containers: (Array.isArray(task?.containers) ? task.containers : []).map((container) => ({
      name: text(container?.name),
      exit_code: count(container?.exitCode),
      reason: text(container?.reason),
    })),
  };
}

/**
 * The bounded task attribution for one service: at most `DEPLOYMENT_TASK_LIMIT`
 * `RUNNING` tasks and the same number of `STOPPED` ones, both through the two
 * reads `beta-infra-runtime-role` already grants. `aws` is the caller's reviewed
 * read runner, so `deploy-runtime` and the read-only `state` entry share it.
 */
export async function readServiceTasks(aws, cluster, serviceName, { limit = DEPLOYMENT_TASK_LIMIT } = {}) {
  const tasks = [];
  for (const desiredStatus of ['RUNNING', 'STOPPED']) {
    const listed = await aws(['ecs', 'list-tasks', '--cluster', cluster,
      '--service-name', serviceName, '--desired-status', desiredStatus]);
    const arns = (Array.isArray(listed?.taskArns) ? listed.taskArns : []).slice(0, limit);
    if (arns.length === 0) continue;
    const described = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...arns]);
    for (const task of Array.isArray(described?.tasks) ? described.tasks : []) tasks.push(ecsTaskObservation(task));
  }
  return tasks;
}

/**
 * The `beta-anywear-ecs-steady-state-unmet` line's members. One refusal writes one
 * of these; it is a step-log line, not a record (#207, ADR-0030 §1).
 */
export function refusalEvidence({ serviceName, condition, verdict, readAtMs, windowSeconds = DEPLOYMENT_SETTLE_SECONDS,
  pollCount, deployments, events, tasks, readSequence }) {
  return {
    gate: 'beta-anywear-ecs-steady-state-unmet',
    result: 'unmet',
    read_at: observedAt(readAtMs),
    window_seconds: windowSeconds,
    poll_count: pollCount,
    service: serviceName,
    condition,
    rollout_age_seconds: verdict?.deployment?.age_seconds ?? null,
    deployments: (deployments ?? []).map((row) => ({
      id: row.id, status: row.status, rollout_state: row.rollout_state,
      rollout_state_reason: row.rollout_state_reason, created_at: row.created_at, updated_at: row.updated_at,
      task_definition: row.task_definition, running_count: row.running_count, desired_count: row.desired_count,
      pending_count: row.pending_count, failed_tasks: row.failed_tasks,
    })),
    events: [...(events ?? [])],
    tasks: [...(tasks ?? [])],
    read_sequence: [...(readSequence ?? [])],
  };
}

/**
 * Serialise a refusal line inside its 8 KiB bound. The caps keep a normal refusal
 * well under the limit; a worst-case one — a long `rolloutStateReason`, ten long
 * events, twenty task rows with long stop reasons — is trimmed here instead of
 * being dropped or thrown, because the refusal is the only evidence the run gets.
 * The read-verdict rows go first (they repeat what `poll_count` and `deployments`
 * already state), then the events, then the task rows down to the last one.
 */
export function refusalLine(evidence) {
  const document = { ...evidence, events: [...(evidence.events ?? [])], tasks: [...(evidence.tasks ?? [])],
    read_sequence: [...(evidence.read_sequence ?? [])] };
  const rendered = () => JSON.stringify(document);
  // The bound is bytes, not characters: a task's `stoppedReason` or a container's
  // `reason` is arbitrary text and may carry multi-byte characters.
  const fits = (line) => Buffer.byteLength(line, 'utf8') <= DEPLOYMENT_REFUSAL_LIMIT_BYTES;
  let line = rendered();
  while (!fits(line) && document.read_sequence.length > 0) {
    document.read_sequence.pop();
    line = rendered();
  }
  while (!fits(line) && document.events.length > 0) {
    document.events.pop();
    line = rendered();
  }
  while (!fits(line) && document.tasks.length > 1) {
    document.tasks.pop();
    line = rendered();
  }
  return line;
}
