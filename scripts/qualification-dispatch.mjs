import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { matches, parseJson, SHA } from './lib/json-contract.mjs';
import { DELIVERY_TRIGGER_OPERATIONS, dispatchingRunUrl } from './lib/delivery-inputs.mjs';
import { readCreatedRunById, RUN_READ_ATTEMPTS } from './lib/created-run-read.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

// #354: the by-id read of the run this process just created has one
// implementation, `scripts/lib/created-run-read.mjs`, byte-identical to the copies
// AnyWear-Service and AnyWear-Client vendor. The three policy symbols are
// re-exported, never redefined, so their existing importers keep working and the
// census guard can prove the definition exists in exactly one file.
export { RUN_READ_ATTEMPTS, RUN_READ_WAIT_MS, runReadWaits } from './lib/created-run-read.mjs';

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
 * Expose the dispatched run and the dispatch receipt to the workflow step that
 * observes it. The workflow step owns the output file (`GITHUB_OUTPUT`); this
 * appends the run URL, the run id and the receipt together, in that order, in one
 * write, so a step that reaches a decision publishes exactly once. A value that is
 * not known is omitted, so the observation can fall back from the id to the URL and
 * read a receipt whose run it cannot name.
 */
async function publishDispatchedRun(env, runUrl, runId, receipt) {
  if (typeof env.GITHUB_OUTPUT !== 'string' || env.GITHUB_OUTPUT === '') return;
  const lines = [];
  if (typeof runUrl === 'string' && runUrl !== '') lines.push(`run_url=${runUrl}`);
  if (Number.isSafeInteger(runId) && runId > 0) lines.push(`run_id=${runId}`);
  if (typeof receipt === 'string' && receipt !== '') lines.push(`receipt=${receipt}`);
  if (lines.length > 0) await appendFile(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

/**
 * Whether a failed dispatch `POST` proves the request was refused. The status is
 * read from the first error line: a `400`, `403`, `404`, `409` or `422` rejects the
 * request, so nothing was submitted. Any other failure — a `5xx`, a timeout, no
 * status at all — may have been accepted before it broke.
 */
function dispatchRefused(error) {
  const line = [error?.stderr, error?.stdout, error?.message]
    .flatMap(value => String(value ?? '').split('\n'))
    .map(value => value.trim())
    .find(value => value !== '') ?? '';
  return /\b(?:400|403|404|409|422)\b/.test(line);
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
 * The by-id read of the run the dispatch created (#342, unified by #354). The
 * module owns the retry policy: only a `404` is retried, against the same id, five
 * reads in total with a doubling wait between them (15 seconds), and it rejects a
 * run already terminal with a conclusion other than `success`, which no retry
 * could make readable. The dispatch itself is never repeated.
 */
async function readDispatchedRunById({ run, ghEnv, id, runUrl, attempts, wait, out }) {
  return readCreatedRunById({
    read: async path => parseJson((await run('gh', ['api', path], { env: ghEnv, ...GH_OPTIONS })).stdout),
    repository: E2E_REPOSITORY,
    runId: id,
    runUrl,
    label: 'the dispatched qualification run',
    attempts,
    wait,
    log: line => out.write(`${line}\n`),
    requireSuccess: true,
  });
}

/**
 * Skip the dispatch when this run's URL is already in an active run's name; list
 * failures dispatch anyway and say so, because a duplicate qualification wastes a
 * run while a skipped legitimate one would hide a release. After dispatching, when
 * the response names the created run, read that run by id — retrying only a `404`
 * and rejecting a run already terminal with a non-`success` conclusion (#342) —
 * and accept it when the API returns the same id, never the title, which can lag
 * the run itself. When the response names no run id, poll the active-run list for
 * this run's URL a bounded number of attempts and fail only after they are
 * exhausted, which still catches a run dropped at birth by a full `queue: max`
 * queue.
 *
 * #338: the created run's id and URL are also appended to the workflow step's
 * `GITHUB_OUTPUT`, so the job's final step can observe exactly the run this
 * dispatch created. #354 adds the dispatch receipt to the same write: `adopted`,
 * `created`, `not_submitted` or `acceptance_unknown`, decided by how far the
 * dispatch got, so the recorder can tell "nothing was submitted" from "a run may
 * exist that this step cannot name".
 *
 * Issue #344: the body is shared with the scheduled entry, whose payload is built
 * from its own operation menu; only the payload differs.
 */
export async function dispatchRun({ env = process.env, run = execute, out = process.stdout, payload,
  attempts = FALLBACK_ATTEMPTS, readAttempts = RUN_READ_ATTEMPTS, wait = sleep } = {}) {
  if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN) {
    throw new Error('A write-scoped AnyWear-E2E App token is required to dispatch the qualification');
  }
  const key = payload.dispatched_by;
  const ghEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN, GH_TELEMETRY: 'disabled' };
  // The receipt names what the dispatch step can prove about this dispatch. The
  // single `finally` below writes it with the run, in one append, on every path.
  let receipt = 'not_submitted';
  let runUrl;
  let runId;
  try {
    let existing;
    try {
      existing = findDispatchedRun(await listActiveRuns(run, ghEnv), key);
    } catch (error) {
      out.write(`Could not list the target's queued and in-progress runs (${error?.message ?? error}); dispatching anyway.\n`);
    }
    if (existing) {
      out.write(`Qualification already dispatched by ${key}: ${existing.html_url}\n`);
      receipt = 'adopted';
      runUrl = existing.html_url;
      runId = existing.id;
      return { dispatched: false, payload, run_url: runUrl, run_id: runId, receipt };
    }
    let details;
    // The POST may have been accepted even when its response never arrives, so only
    // a status that proves refusal records `not_submitted`; every other failure is
    // `acceptance_unknown` and the observation records `unobserved`.
    try {
      details = parseJson((await run('gh', dispatchArguments(payload), { env: ghEnv, ...GH_OPTIONS })).stdout);
    } catch (error) {
      receipt = dispatchRefused(error) ? 'not_submitted' : 'acceptance_unknown';
      throw error;
    }
    receipt = 'created';
    const id = dispatchedRunId(details);
    // Print the URL the dispatch response names before reading the run back, so the
    // operator has it even if the verification fails.
    const dispatchedUrl = firstText(details?.html_url, details?.run_url, id === undefined ? undefined : qualificationRunUrl(id));
    out.write(`Dispatched qualification ${payload.operation}/${payload.trigger}${dispatchedUrl ? ` as ${dispatchedUrl}` : ''}\n`);
    if (id !== undefined) {
      // The response names the created run, so publish it before the read-back that
      // can fail, and let the observation still find a run the dispatcher could not
      // verify. The browsable URL is the response's `html_url`, or the one built
      // from the id; a response's API `run_url` is only a last resort for display.
      const observedUrl = firstText(details?.html_url, qualificationRunUrl(id));
      runUrl = observedUrl;
      runId = id;
      // The dispatch response names the run it created, so verify that run by id. The
      // module retries a `404` before the run is readable against the same id, rejects
      // a run already terminal with a non-`success` conclusion, and the dispatch is
      // never sent twice (#342, #354).
      const created = await readDispatchedRunById({ run, ghEnv, id, runUrl: observedUrl, attempts: readAttempts, wait, out });
      runUrl = firstText(created.html_url, observedUrl);
      return { dispatched: true, payload, run_url: runUrl, run_id: id, receipt };
    }
    out.write(`The dispatch response carried no run id; looking for ${key} in the target's active runs.\n`);
    const match = await pollDispatchedRun({ run, ghEnv, key, attempts, wait });
    out.write(`Qualification dispatched by ${key}: ${match.html_url}\n`);
    const matchId = Number.isSafeInteger(match.id) && match.id > 0 ? match.id : undefined;
    runUrl = match.html_url;
    runId = matchId;
    return { dispatched: true, payload, run_url: runUrl, run_id: matchId, receipt };
  } finally {
    await publishDispatchedRun(env, runUrl, runId, receipt);
  }
}

/**
 * Build this run's payload and dispatch it. The payload is built before
 * `dispatchRun` is called, so a failure here publishes `receipt=not_submitted`
 * itself — the only write outside `dispatchRun`'s single `finally` — and the two
 * never write together.
 */
export async function dispatchQualification({ env = process.env, ...options } = {}) {
  let payload;
  try {
    validateOperationInputs(env);
    payload = qualificationPayload(env);
  } catch (error) {
    await publishDispatchedRun(env, undefined, undefined, 'not_submitted');
    throw error;
  }
  return dispatchRun({ env, ...options, payload });
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

const ceilingMinutes = ceilingMs => Math.round(ceilingMs / 60_000);

function ceilingOutcome({ runId, runUrl, current, ceilingMs }) {
  const minutes = ceilingMinutes(ceilingMs);
  // The ceiling is the hold's own bound, not a broken read: the record carries no
  // `conclusion` and no `read_failure`, so it cannot be mistaken for a verdict.
  return { outcome: 'unqualified', run_id: runId, run_url: runUrl,
    failed_jobs: [], status: current?.status,
    reason: `the run had not reached a terminal state when the ${minutes}-minute hold ceiling was reached`
      + ` (last status ${current?.status ?? 'unknown'})`,
    ceiling: true, ceiling_ms: ceilingMs };
}

/**
 * The names of the jobs that stopped the run, in API order, or the cause when the
 * job list could not be read. `skipped` is not a failure: the E2E workflow skips the
 * jobs a non-`full` operation does not need. A job-list read that fails never
 * changes the conclusion the run itself established: the caller records the
 * conclusion and the note instead of failing the observation.
 */
async function failedJobNames({ run, ghEnv, runId }) {
  let body;
  try {
    body = parseJson((await run('gh', ['api', `repos/${E2E_REPOSITORY}/actions/runs/${runId}/jobs`],
      { env: ghEnv, ...GH_OPTIONS })).stdout);
  } catch (error) {
    return { jobs: [], note: `${error?.message ?? error}` };
  }
  if (!Array.isArray(body?.jobs)) return { jobs: [], note: 'the response is not a job list' };
  return { jobs: body.jobs
    .filter(job => job?.conclusion !== 'success' && job?.conclusion !== 'skipped')
    .map(job => job?.name)
    .filter(name => typeof name === 'string' && name !== '') };
}

/**
 * Read the dispatched run until it is `completed`, on a fixed interval, and never
 * past `created_at + HOLD_CEILING_MS` (#338). `qualified` means the E2E run
 * concluded `success`, which for a `full` dispatch only the `record` job produces
 * after verifying and attaching the qualification record. A terminal non-success
 * run returns `unqualified` with the failed jobs, or with the job-list cause when
 * that list could not be read, and the ceiling returns `unqualified` with
 * `ceiling: true` so the recorder writes a `::warning`. A read failure is thrown as
 * the shared module's `RunReadError`: a run that could not be read is not a
 * verdict, so the recorder records `unobserved` instead of inventing one.
 *
 * The opening read establishes the deadline from the run's own `created_at` and
 * carries no deadline itself, so a retried opening read cannot extend the hold.
 * Every interval read carries the deadline; a read that reaches it reports the
 * module's `deadline-reached` code, which is mapped here to the ceiling outcome
 * because the ceiling is the hold's own bound, not a broken read.
 */
export async function observeQualification({ env = process.env, run = execute, wait = sleep, out = process.stdout,
  now = Date.now, runId, runUrl, ceilingMs = HOLD_CEILING_MS, intervalMs = OBSERVATION_INTERVAL_MS } = {}) {
  const id = observedRunId({ runId, runUrl });
  if (typeof env.GH_TOKEN !== 'string' || !env.GH_TOKEN) {
    throw new Error('A read-scoped AnyWear-E2E App token is required to observe the qualification');
  }
  const ghEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN, GH_TELEMETRY: 'disabled' };
  let readUrl = firstText(runUrl, qualificationRunUrl(id));
  const readRun = ({ deadlineAtMs } = {}) => readCreatedRunById({
    read: async path => parseJson((await run('gh', ['api', path], { env: ghEnv, ...GH_OPTIONS })).stdout),
    repository: E2E_REPOSITORY,
    runId: id,
    runUrl: readUrl,
    label: 'the dispatched qualification run',
    wait,
    log: line => out.write(`${line}\n`),
    now,
    requireSuccess: false,
    deadlineAtMs,
  });
  const startedAt = now();
  let current = await readRun();
  const deadline = holdDeadline(current?.created_at, startedAt, ceilingMs);
  const resolvedUrl = firstText(current?.html_url, runUrl, qualificationRunUrl(id));
  readUrl = resolvedUrl;
  out.write(`Observing qualification ${resolvedUrl}: interval ${intervalMs} ms, hold ceiling ${new Date(deadline).toISOString()}.\n`);
  for (;;) {
    if (current?.status === 'completed') {
      const conclusion = typeof current.conclusion === 'string' && current.conclusion !== '' ? current.conclusion : 'unknown';
      if (conclusion === 'success') {
        out.write(`The qualification run ${resolvedUrl} concluded success.\n`);
        return { outcome: 'qualified', run_id: id, run_url: resolvedUrl, conclusion, failed_jobs: [] };
      }
      const { jobs, note } = await failedJobNames({ run, ghEnv, runId: id });
      out.write(note === undefined
        ? `The qualification run ${resolvedUrl} concluded ${conclusion}`
          + `; failed job(s): ${jobs.length > 0 ? jobs.join(', ') : 'none named'}.\n`
        : `The qualification run ${resolvedUrl} concluded ${conclusion}; the job list could not be read (${note}),`
          + ' so no failed job is named.\n');
      return { outcome: 'unqualified', run_id: id, run_url: resolvedUrl, conclusion, failed_jobs: jobs,
        ...(note === undefined ? {} : { failed_jobs_note: note }) };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      out.write(`The ${ceilingMinutes(ceilingMs)}-minute hold ceiling was reached while the run was ${current?.status ?? 'unknown'}.\n`);
      return ceilingOutcome({ runId: id, runUrl: resolvedUrl, current, ceilingMs });
    }
    await wait(Math.min(intervalMs, remaining));
    try {
      current = await readRun({ deadlineAtMs: deadline });
    } catch (error) {
      if (error?.code === 'deadline-reached') {
        out.write(`The ${ceilingMinutes(ceilingMs)}-minute hold ceiling was reached before the run could be read again.\n`);
        return ceilingOutcome({ runId: id, runUrl: resolvedUrl, current, ceilingMs });
      }
      throw error;
    }
  }
}

/**
 * The one outcome line #338 records, for the step summary and the job log. The
 * cause is only ever what was observed: a conclusion when the run reached a
 * terminal state, the ceiling when the hold actually expired, the recorded
 * `reason` when the dispatch proves nothing was submitted, and — for
 * `unobserved` — the read failure plus the reads that were made and the dispatch
 * receipt. A failure to read is never reported as the ceiling and never as a
 * verdict the observation did not form.
 */
export function qualificationOutcomeLine(result) {
  const tuple = typeof result.service_commit === 'string' && result.service_commit !== ''
    ? ` for Service commit ${result.service_commit}` : '';
  if (result.outcome === 'qualified') {
    return `Qualification qualified: ${result.run_url} concluded ${result.conclusion}${tuple}.`;
  }
  const runUrl = typeof result.run_url === 'string' && result.run_url !== '' ? result.run_url : undefined;
  if (result.outcome === 'unobserved') {
    const cause = typeof result.read_cause === 'string' && result.read_cause !== ''
      ? result.read_cause : 'no read cause was recorded';
    const reads = Number.isSafeInteger(result.reads) && result.reads >= 0 ? result.reads : 0;
    const waitsMs = Number.isSafeInteger(result.waits_ms) && result.waits_ms >= 0 ? result.waits_ms : 0;
    const receipt = typeof result.receipt === 'string' && result.receipt !== ''
      ? result.receipt : 'no receipt was recorded';
    return `Qualification unobserved: ${runUrl ?? 'the dispatched qualification run'} could not be read (${cause})`
      + ` after ${reads} read${reads === 1 ? '' : 's'} over ${waitsMs} ms of waits; dispatch receipt: ${receipt},`
      + ` so no qualification verdict was recorded${tuple}.`;
  }
  const conclusion = typeof result.conclusion === 'string' && result.conclusion !== '' ? result.conclusion : undefined;
  if (conclusion !== undefined) {
    const failed = Array.isArray(result.failed_jobs) && result.failed_jobs.length > 0
      ? `; failed job(s): ${result.failed_jobs.join(', ')}`
      : (typeof result.failed_jobs_note === 'string' && result.failed_jobs_note !== ''
        ? `; failed job(s): none named (the job list could not be read: ${result.failed_jobs_note})` : '');
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
 * step output carries the verdict for the run. `unobserved` is an error annotation
 * because no verdict was formed and the step exits non-zero; the ceiling and the
 * unreadable job list are warnings on the step log, never errors, because the
 * deployment's own conclusion stands.
 */
export async function recordQualificationOutcome({ env = process.env, result, out = process.stdout } = {}) {
  const line = qualificationOutcomeLine(result);
  const annotation = result.outcome === 'unobserved' ? '::error::'
    : result.ceiling === true || typeof result.failed_jobs_note === 'string' ? '::warning::' : '';
  out.write(`${annotation}${line}\n`);
  if (typeof env.GITHUB_STEP_SUMMARY === 'string' && env.GITHUB_STEP_SUMMARY !== '') {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT !== '') {
    await appendFile(env.GITHUB_OUTPUT, `outcome=${result.outcome}\n`);
  }
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await dispatchQualification();
