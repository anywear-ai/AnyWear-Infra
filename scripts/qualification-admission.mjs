import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseJson } from './lib/json-contract.mjs';
import { E2E_REPOSITORY, QUALIFICATION_WORKFLOW } from './qualification-dispatch.mjs';

// #338: the pre-mutation admission read. It runs at the head of `mutate.yml`'s
// `deploy` job — after checkout and the dependency install, before the release-byte
// download and therefore before `./.github/actions/deploy-operation` — so a refusal
// happens before any AWS credential request. It mints one read-only App installation
// token narrowed to AnyWear-E2E with `actions: read` and nothing else.
//
// The hold (`qualify-hold`) prevents a successor from starting while the deployment
// that dispatched a qualification is still alive. This read is the net underneath
// it: a holder that died, a hold that expired at its 55-minute ceiling, or an
// operator `release-qualify` dispatch leaves a live qualification run with no run
// holding `anywear-infra-runtime`, and this is what sees it before the next
// mutation. Neither mechanism can see a qualification that starts after the read.
const execute = promisify(execFile);

// The `full` filter is the run-name prefix, not the run's own operation output: the
// workflow's `run-name` is the only field the runs API exposes. This constant is the
// `full` half of `AnyWear-E2E/.github/workflows/beta-qualification.yml`'s
// `run-name: "Beta qualification: ${{ inputs.operation }} · ${{ inputs.trigger }} ·
// ${{ inputs.expected_service_commit || '-' }} · by ${{ inputs.dispatched_by ||
// format('@{0}', github.actor) }}"`, and the workflow's `operation` input is a
// choice of `full|smoke|reconcile`; only `full` seals a qualification record. The
// other side of that check — that the E2E workflow's own `run-name` still begins
// `Beta qualification: ${{ inputs.operation }}` — belongs to Acceptance (issue
// #338), because that file is not in this checkout.
export const QUALIFICATION_FULL_RUN_NAME_PREFIX = 'Beta qualification: full';

// The runs API accepts all five as a `status` filter. `ACTIVE_RUN_STATUSES` in
// `qualification-dispatch.mjs` is a strict subset used by the dispatcher's own
// dedupe lookup; an admission read that reused it would read "empty" while a run
// waits for approval or sits pending, so the full set is listed here explicitly.
export const QUALIFICATION_NONTERMINAL_STATUSES = Object.freeze([
  'requested', 'waiting', 'pending', 'queued', 'in_progress',
]);
/** The admission wait is bounded: it refuses, never proceeds silently, after 30 minutes. */
export const ADMISSION_BUDGET_MS = 30 * 60 * 1000;
/** Poll the run list on a fixed interval; the budget, not the interval, is the bound. */
export const ADMISSION_INTERVAL_MS = 30_000;
const WORKFLOW_PATH = `repos/${E2E_REPOSITORY}/actions/workflows/${QUALIFICATION_WORKFLOW}`;
const MAX_BUFFER = 10 * 1024 * 1024;
const GH_OPTIONS = { timeout: 60_000, maxBuffer: MAX_BUFFER };

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const firstText = (...values) => values.find(value => typeof value === 'string' && value !== '');
const runUrlOf = id => `https://github.com/${E2E_REPOSITORY}/actions/runs/${id}`;

/** A `full` qualification run is the only run that seals a record; `smoke`/`reconcile` seal none. */
export const isFullQualificationRun = entry => typeof entry?.display_title === 'string'
  && entry.display_title.startsWith(QUALIFICATION_FULL_RUN_NAME_PREFIX);

/**
 * Every nonterminal `full` qualification run, across the full status set, deduped by
 * id. A status listing that fails makes the whole read incomplete: the result keeps
 * the runs it did see and the last error, and the caller must treat the environment
 * as not proven clear rather than as empty.
 */
export async function listNonterminalFullRuns(run, env) {
  const holders = new Map();
  let lastError;
  for (const status of QUALIFICATION_NONTERMINAL_STATUSES) {
    try {
      const response = parseJson((await run('gh', ['api', `${WORKFLOW_PATH}/runs?status=${status}&per_page=100`],
        { env, ...GH_OPTIONS })).stdout);
      if (!Array.isArray(response?.workflow_runs)) throw new Error(`The ${status} qualification run list is malformed`);
      for (const entry of response.workflow_runs) {
        if (!isFullQualificationRun(entry) || entry.status === 'completed') continue;
        const key = entry.id ?? entry.html_url;
        if (key === undefined) continue;
        holders.set(key, entry);
      }
    } catch (error) {
      // The first failure already makes the read incomplete; a later one replaces it
      // so the refusal names the most recent cause.
      lastError = error;
    }
  }
  return { holders: [...holders.values()], error: lastError };
}

const describeHolder = holder => {
  const url = firstText(holder.html_url, Number.isSafeInteger(holder.id) ? runUrlOf(holder.id) : undefined);
  const state = [holder.status, holder.conclusion].filter(value => typeof value === 'string' && value !== '').join('/');
  return `${url ?? `run ${holder.id ?? '<unknown>'}`} (${state || 'nonterminal'})`;
};

/**
 * Wait while any `full` qualification run is nonterminal, and proceed only when a
 * complete read proves there is none. A failed listing keeps waiting instead of
 * opening the gate; the budget, never a silent empty read, ends the wait.
 */
export async function main({ env = process.env, run = execute, wait = sleep, now = Date.now,
  out = process.stdout, budgetMs = ADMISSION_BUDGET_MS, intervalMs = ADMISSION_INTERVAL_MS } = {}) {
  if (typeof env.GH_TOKEN !== 'string' || env.GH_TOKEN === '') {
    out.write('Refusing the mutation: the read-only AnyWear-E2E App token is missing, so the admission check'
      + ' cannot prove that no full qualification run is in flight.\n');
    return 1;
  }
  const budgetMinutes = Math.round(budgetMs / 60_000);
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let lastError;
  for (;;) {
    const { holders, error } = await listNonterminalFullRuns(run, env);
    if (error !== undefined) lastError = error;
    if (holders.length === 0 && error === undefined) {
      const waitedSeconds = Math.round((now() - startedAt) / 1000);
      out.write(`No full qualification run is nonterminal; the admission check proceeds`
        + `${waitedSeconds > 0 ? ` after ${waitedSeconds} s` : ''}.\n`);
      return 0;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const parts = [];
      if (holders.length > 0) {
        parts.push(`${holders.length} full qualification run(s) were still nonterminal after the`
          + ` ${budgetMinutes}-minute admission budget: ${holders.map(describeHolder).join(', ')}`);
        parts.push('cancel the qualification run to release the environment — never the deployment run');
      }
      if (lastError !== undefined) {
        parts.push(`the run list could not be read completely; the last read failed: ${lastError?.message ?? lastError}`);
      }
      out.write(`Refusing the mutation: ${parts.join('; ')}.\n`);
      return 1;
    }
    await wait(Math.min(intervalMs, remaining));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
