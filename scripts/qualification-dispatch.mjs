import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { matches, parseJson, SHA } from './lib/json-contract.mjs';
import { DELIVERY_TRIGGER_OPERATION, dispatchingRunUrl } from './lib/delivery-inputs.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

// The deploy chain's qualification hop (#226). After `deploy` succeeded for
// `deploy-runtime`, this dispatches the E2E `beta-qualification.yml` run that
// qualifies the tuple the deployment left live, and it does not wait for it: a red
// qualification is a red E2E run and leaves the deployment green. The job holds no
// AWS credential and no environment; its only token is one App installation token
// narrowed to AnyWear-E2E with `actions: write`.
//
// The dispatch cannot be deduplicated from workflow inputs — the REST run object
// exposes none — so the pre-dispatch skip and the fallback post-dispatch lookup use
// `display_title`, which for a `workflow_dispatch` run is exactly its `run-name`.
// The receiving workflow renders `dispatched_by` into that name, and this run's own
// URL is the value it sends. The normal post-dispatch check does not use the title:
// the dispatch response names the created run, and that run is verified by id.
const execute = promisify(execFile);
export const E2E_REPOSITORY = 'anywear-ai/AnyWear-E2E';
export const QUALIFICATION_WORKFLOW = 'beta-qualification.yml';
export const QUALIFICATION_REF = 'main';
export const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'in_progress']);
const WORKFLOW_PATH = `repos/${E2E_REPOSITORY}/actions/workflows/${QUALIFICATION_WORKFLOW}`;
const MAX_BUFFER = 10 * 1024 * 1024;
const GH_OPTIONS = { timeout: 60_000, maxBuffer: MAX_BUFFER };

/**
 * The exact dispatch payload for this deployment's entry event, per `## Data
 * Models`: a merge sends `full` with `deploy-qualify` and the deployed Service
 * commit; a manual dispatch sends `smoke` with `deploy-smoke` and no expected
 * commits. Both carry `worker_slot_offset=0` and this run's URL as `dispatched_by`.
 */
export function qualificationPayload(env = process.env) {
  if (env.INFRA_OPERATION !== DELIVERY_TRIGGER_OPERATION) {
    throw new Error(`Only ${DELIVERY_TRIGGER_OPERATION} dispatches a qualification`);
  }
  const dispatchedBy = dispatchingRunUrl(env);
  if (env.DELIVERY_TRIGGER === 'deploy') {
    matches(env.SERVICE_COMMIT, SHA, 'deployed Service commit');
    return { operation: 'full', trigger: 'deploy-qualify', expected_service_commit: env.SERVICE_COMMIT,
      worker_slot_offset: '0', dispatched_by: dispatchedBy };
  }
  if (env.DELIVERY_TRIGGER === 'manual') {
    // No expected commits: this operation deployed the Service tuple, not a Client one.
    return { operation: 'smoke', trigger: 'deploy-smoke', worker_slot_offset: '0', dispatched_by: dispatchedBy };
  }
  throw new Error('deploy-runtime requires delivery_trigger=deploy or manual to dispatch a qualification');
}

/**
 * `gh workflow run` does not expose `return_run_details`, so the dispatch goes
 * through the REST endpoint via `gh api`. All workflow inputs are strings; the one
 * boolean field travels typed with `-F`.
 */
export function dispatchArguments(payload) {
  return ['api', '--method', 'POST', `${WORKFLOW_PATH}/dispatches`,
    '-f', `ref=${QUALIFICATION_REF}`,
    '-F', 'return_run_details=true',
    ...Object.entries(payload).flatMap(([name, value]) => ['-f', `inputs[${name}]=${value}`])];
}

/** The queued and in-progress runs of the target workflow, newest first as returned. */
export async function listActiveRuns(run, env) {
  const runs = [];
  for (const status of ACTIVE_RUN_STATUSES) {
    const response = parseJson((await run('gh', ['api', `${WORKFLOW_PATH}/runs?status=${status}&per_page=100`],
      { env, ...GH_OPTIONS })).stdout);
    if (!Array.isArray(response?.workflow_runs)) throw new Error(`The ${status} qualification run list is malformed`);
    runs.push(...response.workflow_runs);
  }
  return runs;
}

/** The active run an earlier attempt of this dispatcher created, matched by its own URL. */
export function findDispatchedRun(runs, key) {
  return (runs ?? []).find(entry => typeof entry?.display_title === 'string' && entry.display_title.includes(key));
}

export const FALLBACK_ATTEMPTS = 5;
export const FALLBACK_WAIT_MS = 3_000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const firstText = (...values) => values.find(value => typeof value === 'string' && value !== '');
const qualificationRunUrl = id => `https://github.com/${E2E_REPOSITORY}/actions/runs/${id}`;

/** The run id the dispatch response names, or `undefined` when it names none usable. */
function dispatchedRunId(details) {
  const id = details?.workflow_run_id;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The fallback when the dispatch response names no run id: look the created run up
 * in the target's active runs, keyed on this run's URL in its `display_title`. A
 * freshly created run can enter that list before its title settles, so one
 * immediate read is not enough; the attempts and the wait between them are
 * injected so tests observe the bound without sleeping.
 */
async function pollDispatchedRun({ run, ghEnv, key, attempts, wait }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const match = findDispatchedRun(await listActiveRuns(run, ghEnv), key);
      if (match) return match;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(FALLBACK_WAIT_MS);
  }
  const cause = lastError === undefined
    ? 'the run was dropped at birth or named differently'
    : `the last listing failed: ${lastError?.message ?? lastError}`;
  throw new Error(`No active qualification run carried ${key} after ${attempts} attempts: ${cause}`);
}

/**
 * Skip the dispatch when this run's URL is already in an active run's name; list
 * failures dispatch anyway and say so, because a duplicate qualification wastes a
 * run while a skipped legitimate one would hide a release. After dispatching, when
 * the response names the created run, read that run once by id and accept it when
 * the API returns the same id — never the title, which can lag the run itself. When
 * the response names no run id, poll the active-run list for this run's URL a
 * bounded number of attempts and fail only after they are exhausted, which still
 * catches a run dropped at birth by a full `queue: max` queue.
 */
export async function dispatchQualification({ env = process.env, run = execute, out = process.stdout,
  attempts = FALLBACK_ATTEMPTS, wait = sleep } = {}) {
  validateOperationInputs(env);
  if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN) {
    throw new Error('A write-scoped AnyWear-E2E App token is required to dispatch the qualification');
  }
  const payload = qualificationPayload(env);
  const key = payload.dispatched_by;
  const ghEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN, GH_TELEMETRY: 'disabled' };
  let existing;
  try {
    existing = findDispatchedRun(await listActiveRuns(run, ghEnv), key);
  } catch (error) {
    out.write(`Could not list the target's queued and in-progress runs (${error?.message ?? error}); dispatching anyway.\n`);
  }
  if (existing) {
    out.write(`Qualification already dispatched by ${key}: ${existing.html_url}\n`);
    return { dispatched: false, payload, run_url: existing.html_url };
  }
  const details = parseJson((await run('gh', dispatchArguments(payload), { env: ghEnv, ...GH_OPTIONS })).stdout);
  const id = dispatchedRunId(details);
  // Print the URL the dispatch response names before reading the run back, so the
  // operator has it even if the verification fails.
  const dispatchedUrl = firstText(details?.html_url, details?.run_url, id === undefined ? undefined : qualificationRunUrl(id));
  out.write(`Dispatched qualification ${payload.operation}/${payload.trigger}${dispatchedUrl ? ` as ${dispatchedUrl}` : ''}\n`);
  if (id !== undefined) {
    // The dispatch response names the run it created, so verify that run by id once.
    // A run whose `display_title` has not propagated yet is still the same run.
    const created = parseJson((await run('gh', ['api', `repos/${E2E_REPOSITORY}/actions/runs/${id}`],
      { env: ghEnv, ...GH_OPTIONS })).stdout);
    if (created?.id !== id) {
      throw new Error(`The dispatched qualification run ${id} was not returned by id: the run API answered ${String(created?.id)}`);
    }
    return { dispatched: true, payload, run_url: firstText(created.html_url, dispatchedUrl) };
  }
  out.write(`The dispatch response carried no run id; looking for ${key} in the target's active runs.\n`);
  const match = await pollDispatchedRun({ run, ghEnv, key, attempts, wait });
  out.write(`Qualification dispatched by ${key}: ${match.html_url}\n`);
  return { dispatched: true, payload, run_url: match.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await dispatchQualification();
