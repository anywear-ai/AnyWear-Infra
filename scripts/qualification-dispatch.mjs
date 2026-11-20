import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { matches, parseJson, SHA } from './lib/json-contract.mjs';
import { DELIVERY_TRIGGER_OPERATIONS, dispatchingRunUrl } from './lib/delivery-inputs.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

// The deploy chain's qualification hop and hold (#226, #338). After `deploy`
// succeeded for `deploy-runtime`, this dispatches the E2E `beta-qualification.yml`
// run that qualifies the tuple the deployment left live. For
// `delivery_trigger=deploy` the job then reads that run to a terminal state: the
// deployment run — and with it `anywear-infra-runtime` — stays alive for the
// qualification, so a later merge waits in the group instead of replacing the
// tuple under test. The ceiling is 55 minutes from the moment the dispatched run
// was created, under the one-hour lifetime of the observation token that is minted
// immediately before the dispatch; the job's `timeout-minutes` is 65, so the
// observation's own deadline fires first and the recorder still runs. A red
// qualification is a red E2E run and never a failed deployment. The job holds no
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
/** The hold ends at most 55 minutes after the dispatched run was created (#338). */
export const HOLD_CEILING_MS = 55 * 60 * 1000;
/** Read the dispatched run at least once every 30 seconds, well inside the design's 90-second bound. */
export const OBSERVATION_INTERVAL_MS = 30_000;
const WORKFLOW_PATH = `repos/${E2E_REPOSITORY}/actions/workflows/${QUALIFICATION_WORKFLOW}`;
const MAX_BUFFER = 10 * 1024 * 1024;
const GH_OPTIONS = { timeout: 60_000, maxBuffer: MAX_BUFFER };

/**
 * The exact dispatch payload for this run's entry event, per ADR 0033 §7 and §8:
 * a Service merge sends `full` with `deploy-qualify` and the deployed Service
 * commit; a manual Runtime deployment and every Client publication send `smoke`
 * with `deploy-smoke` and no expected commits. All carry `worker_slot_offset=0`
 * and this run's URL as `dispatched_by`.
 */
export function qualificationPayload(env = process.env) {
  if (!DELIVERY_TRIGGER_OPERATIONS.includes(env.INFRA_OPERATION)) {
    throw new Error(`Only ${DELIVERY_TRIGGER_OPERATIONS.join(' and ')} dispatches a qualification`);
  }
  // The ADR's exact refusal, whatever the operation: a version tag never deploys and
  // never publishes, so it dispatches no qualification either.
  if (env.DELIVERY_TRIGGER === 'release') {
    throw new Error('delivery_trigger=release is refused: the release chain never deploys');
  }
  const dispatchedBy = dispatchingRunUrl(env);
  // Issue #344: the Client publication dispatches the post-publication `smoke`
  // inside its own held run. It is the same row a manual Runtime deployment sends:
  // a publication seals no qualification record, so it names no expected commit.
  if (env.INFRA_OPERATION === 'publish-client') {
    if (env.DELIVERY_TRIGGER !== 'publish' && env.DELIVERY_TRIGGER !== 'manual') {
      throw new Error('publish-client requires delivery_trigger=publish or manual to dispatch a qualification');
    }
    return { operation: 'smoke', trigger: 'deploy-smoke', worker_slot_offset: '0', dispatched_by: dispatchedBy };
  }
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
 * Expose the dispatched run to the workflow step that observes it. The workflow
 * step owns the output file (`GITHUB_OUTPUT`); this appends only the values that
 * are known, so the observation can fall back from the id to the URL.
 */
async function publishDispatchedRun(env, runUrl, runId) {
  if (typeof env.GITHUB_OUTPUT !== 'string' || env.GITHUB_OUTPUT === '') return;
  const lines = [];
  if (typeof runUrl === 'string' && runUrl !== '') lines.push(`run_url=${runUrl}`);
  if (Number.isSafeInteger(runId) && runId > 0) lines.push(`run_id=${runId}`);
  if (lines.length > 0) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
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
 *
 * #338: the created run's id and URL are also appended to the workflow step's
 * `GITHUB_OUTPUT`, so the job's final step can observe exactly the run this
 * dispatch created.
 *
 * Issue #344: the body is shared with the scheduled entry, whose payload is built
 * from its own operation menu; only the payload differs.
 */
export async function dispatchRun({ env = process.env, run = execute, out = process.stdout, payload,
  attempts = FALLBACK_ATTEMPTS, wait = sleep } = {}) {
  if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN) {
    throw new Error('A write-scoped AnyWear-E2E App token is required to dispatch the qualification');
  }
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
    await publishDispatchedRun(env, existing.html_url, existing.id);
    return { dispatched: false, payload, run_url: existing.html_url, run_id: existing.id };
  }
  const details = parseJson((await run('gh', dispatchArguments(payload), { env: ghEnv, ...GH_OPTIONS })).stdout);
  const id = dispatchedRunId(details);
  // Print the URL the dispatch response names before reading the run back, so the
  // operator has it even if the verification fails.
  const dispatchedUrl = firstText(details?.html_url, details?.run_url, id === undefined ? undefined : qualificationRunUrl(id));
  out.write(`Dispatched qualification ${payload.operation}/${payload.trigger}${dispatchedUrl ? ` as ${dispatchedUrl}` : ''}\n`);
  if (id !== undefined) {
    // The response names the created run, so publish it now — before the read-back
    // that can fail — and let the observation still find a run the dispatcher could
    // not verify. The browsable URL is the response's `html_url`, or the one built
    // from the id; a response's API `run_url` is only a last resort for display.
    const observedUrl = firstText(details?.html_url, qualificationRunUrl(id));
    await publishDispatchedRun(env, observedUrl, id);
    // The dispatch response names the run it created, so verify that run by id once.
    // A run whose `display_title` has not propagated yet is still the same run.
    const created = parseJson((await run('gh', ['api', `repos/${E2E_REPOSITORY}/actions/runs/${id}`],
      { env: ghEnv, ...GH_OPTIONS })).stdout);
    if (created?.id !== id) {
      throw new Error(`The dispatched qualification run ${id} was not returned by id: the run API answered ${String(created?.id)}`);
    }
    return { dispatched: true, payload, run_url: firstText(created.html_url, observedUrl), run_id: id };
  }
  out.write(`The dispatch response carried no run id; looking for ${key} in the target's active runs.\n`);
  const match = await pollDispatchedRun({ run, ghEnv, key, attempts, wait });
  out.write(`Qualification dispatched by ${key}: ${match.html_url}\n`);
  const matchId = Number.isSafeInteger(match.id) && match.id > 0 ? match.id : undefined;
  await publishDispatchedRun(env, match.html_url, matchId);
  return { dispatched: true, payload, run_url: match.html_url, run_id: matchId };
}

export async function dispatchQualification({ env = process.env, ...options } = {}) {
  validateOperationInputs(env);
  return dispatchRun({ env, ...options, payload: qualificationPayload(env) });
}

/** The run id to observe: the dispatch output, or the trailing `/runs/<id>` of its URL. */
function observedRunId({ runId, runUrl }) {
  const direct = Number(runId);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  const match = /\/runs\/(\d+)\/?$/.exec(String(runUrl ?? ''));
  if (match) return Number(match[1]);
  throw new Error('No dispatched qualification run id or URL is available to observe');
}

/** `created_at + ceiling`, or the entry time plus the ceiling when the run names no usable `created_at`. */
function holdDeadline(createdAt, fallback, ceilingMs) {
  const created = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  return (Number.isFinite(created) ? created : fallback) + ceilingMs;
}

/** An authentication-shaped read failure: the observation token, not the run, is the problem. */
const isAuthenticationFailure = error => /(?:\b401\b|\b403\b|Bad credentials|authentication)/i.test(
  `${error?.message ?? ''} ${error?.stderr ?? ''}`);

const ceilingMinutes = ceilingMs => Math.round(ceilingMs / 60_000);

function ceilingOutcome({ runId, runUrl, current, ceilingMs, detail = '' }) {
  const minutes = ceilingMinutes(ceilingMs);
  return { outcome: 'unqualified', run_id: runId, run_url: runUrl, conclusion: current?.conclusion ?? null,
    failed_jobs: [], status: current?.status,
    reason: `the run had not reached a terminal state when the ${minutes}-minute hold ceiling was reached`
      + ` (last status ${current?.status ?? 'unknown'}${detail})`,
    ceiling: true, ceiling_ms: ceilingMs };
}

/**
 * The names of the jobs that stopped the run, in API order. `skipped` is not a
 * failure: the E2E workflow skips the jobs a non-`full` operation does not need.
 */
async function failedJobNames({ run, ghEnv, runId, runUrl }) {
  let body;
  try {
    body = parseJson((await run('gh', ['api', `repos/${E2E_REPOSITORY}/actions/runs/${runId}/jobs`],
      { env: ghEnv, ...GH_OPTIONS })).stdout);
  } catch (error) {
    throw new Error(`The qualification run ${runUrl} concluded non-success but its jobs could not be read: `
      + `${error?.message ?? error}`);
  }
  if (!Array.isArray(body?.jobs)) throw new Error(`The qualification run ${runUrl} job list is malformed`);
  return body.jobs
    .filter(job => job?.conclusion !== 'success' && job?.conclusion !== 'skipped')
    .map(job => job?.name)
    .filter(name => typeof name === 'string' && name !== '');
}

/**
 * Read the dispatched run until it is `completed`, on a fixed interval, and never
 * past `created_at + HOLD_CEILING_MS` (#338). `qualified` means the E2E run
 * concluded `success`, which for a `full` dispatch only the `record` job produces
 * after verifying and attaching the qualification record. A terminal non-success
 * run and the ceiling both return `unqualified`; the ceiling result carries
 * `ceiling: true` so the recorder writes a `::warning` rather than an error. A
 * read failure fails the observation, except an authentication-shaped failure
 * inside the final interval before the ceiling: that is recorded as the ceiling,
 * so a token that outlived its margin cannot turn a named state into a red run.
 */
export async function observeQualification({ env = process.env, run = execute, wait = sleep, out = process.stdout,
  now = Date.now, runId, runUrl, ceilingMs = HOLD_CEILING_MS, intervalMs = OBSERVATION_INTERVAL_MS } = {}) {
  const id = observedRunId({ runId, runUrl });
  if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN) {
    throw new Error('A read-scoped AnyWear-E2E App token is required to observe the qualification');
  }
  const ghEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN, GH_TELEMETRY: 'disabled' };
  const readRun = async () => {
    const body = parseJson((await run('gh', ['api', `repos/${E2E_REPOSITORY}/actions/runs/${id}`],
      { env: ghEnv, ...GH_OPTIONS })).stdout);
    if (body === null || typeof body !== 'object') throw new Error(`The qualification run ${id} read is malformed`);
    return body;
  };
  const startedAt = now();
  // The first read is the one that establishes the deadline, and the token was
  // minted moments before it: a failure here is an observation failure, never the
  // ceiling exception below, which only exists for a token near its own expiry.
  let current;
  try {
    current = await readRun();
  } catch (error) {
    throw new Error(`The qualification run ${id} could not be read: ${error?.message ?? error}`);
  }
  const deadline = holdDeadline(current?.created_at, startedAt, ceilingMs);
  const resolvedUrl = firstText(current?.html_url, runUrl, qualificationRunUrl(id));
  out.write(`Observing qualification ${resolvedUrl}: interval ${intervalMs} ms, hold ceiling ${new Date(deadline).toISOString()}.\n`);
  for (;;) {
    if (current?.status === 'completed') {
      const conclusion = typeof current.conclusion === 'string' && current.conclusion !== '' ? current.conclusion : 'unknown';
      if (conclusion === 'success') {
        out.write(`The qualification run ${resolvedUrl} concluded success.\n`);
        return { outcome: 'qualified', run_id: id, run_url: resolvedUrl, conclusion, failed_jobs: [] };
      }
      const jobs = await failedJobNames({ run, ghEnv, runId: id, runUrl: resolvedUrl });
      out.write(`The qualification run ${resolvedUrl} concluded ${conclusion}`
        + `; failed job(s): ${jobs.length > 0 ? jobs.join(', ') : 'none named'}.\n`);
      return { outcome: 'unqualified', run_id: id, run_url: resolvedUrl, conclusion, failed_jobs: jobs };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      out.write(`The ${ceilingMinutes(ceilingMs)}-minute hold ceiling was reached while the run was ${current?.status ?? 'unknown'}.\n`);
      return ceilingOutcome({ runId: id, runUrl: resolvedUrl, current, ceilingMs });
    }
    await wait(Math.min(intervalMs, remaining));
    try {
      current = await readRun();
    } catch (error) {
      if (isAuthenticationFailure(error) && now() >= deadline - intervalMs) {
        out.write(`The observation token no longer authenticated inside the final interval before the hold ceiling`
          + ` (${error?.message ?? error}); recording the ceiling.\n`);
        return ceilingOutcome({ runId: id, runUrl: resolvedUrl, current, ceilingMs,
          detail: `; the final read failed: ${error?.message ?? error}` });
      }
      throw new Error(`The qualification run ${resolvedUrl} could not be read: ${error?.message ?? error}`);
    }
  }
}

/**
 * The one outcome line #338 records, for the step summary and the job log. The
 * cause is only ever what was observed: a conclusion when the run reached a
 * terminal state, the ceiling when the hold actually expired, and the recorded
 * `reason` otherwise — a read failure must never be reported as the ceiling.
 */
export function qualificationOutcomeLine(result) {
  const tuple = typeof result.service_commit === 'string' && result.service_commit !== ''
    ? ` for Service commit ${result.service_commit}` : '';
  if (result.outcome === 'qualified') {
    return `Qualification qualified: ${result.run_url} concluded ${result.conclusion}${tuple}.`;
  }
  const runUrl = typeof result.run_url === 'string' && result.run_url !== '' ? result.run_url : undefined;
  const conclusion = typeof result.conclusion === 'string' && result.conclusion !== '' ? result.conclusion : undefined;
  if (conclusion !== undefined) {
    const failed = Array.isArray(result.failed_jobs) && result.failed_jobs.length > 0
      ? `; failed job(s): ${result.failed_jobs.join(', ')}` : '';
    return `Qualification unqualified: ${runUrl ?? 'the dispatched qualification run'} concluded`
      + ` ${conclusion}${tuple}${failed}.`;
  }
  if (result.ceiling === true) {
    return `Qualification unqualified: ${runUrl ?? 'the dispatched qualification run'} had not reached a`
      + ` terminal state when the ${ceilingMinutes(result.ceiling_ms ?? HOLD_CEILING_MS)}-minute hold ceiling`
      + ` was reached${tuple}.`;
  }
  const reason = typeof result.reason === 'string' && result.reason !== ''
    ? result.reason : 'the qualification observation recorded no cause';
  const named = runUrl !== undefined && !reason.includes(runUrl) ? `${runUrl}: ` : '';
  return `Qualification unqualified: ${named}${reason}${tuple}.`;
}

/**
 * Record exactly one outcome line. The step summary is the durable record and the
 * step output carries the verdict for the run; the ceiling is an annotation on the
 * step log (`::warning`), never an error, because the deployment's own conclusion
 * stands.
 */
export async function recordQualificationOutcome({ env = process.env, result, out = process.stdout } = {}) {
  const line = qualificationOutcomeLine(result);
  out.write(`${result.ceiling === true ? '::warning::' : ''}${line}\n`);
  if (typeof env.GITHUB_STEP_SUMMARY === 'string' && env.GITHUB_STEP_SUMMARY !== '') {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT !== '') {
    await appendFile(env.GITHUB_OUTPUT, `outcome=${result.outcome}\n`);
  }
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await dispatchQualification();
