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
//
// The read is one unfiltered snapshot per poll, plus a by-id re-read of every run it
// has ever observed as a holder. The earlier shape queried the five nonterminal
// statuses sequentially and unioned the answers, which is not a snapshot: on
// 2026-11-20, `mutate.yml` run 44719591457 read E2E `full` run 44719510520 as absent
// from both the early `waiting` query and the late `in_progress` query because the
// run moved between jobs in between, so the union came back empty and the gate
// opened while that run was still in flight — even though the same run had already
// been seen as a holder earlier in the wait. A holder is therefore never forgotten:
// an identity seen once is re-read by id until it reports `completed`, and its
// absence from the snapshot is exactly the failure this read must not mistake for
// clear. A failed read is not clear either.
//
// A clear poll is confirmed by one immediate second poll — no interval-sized delay —
// because ADR 0033 §7 and the issue's User Journey promise that an idle gate
// "proceeds immediately when none is nonterminal", and a spaced confirmation would
// turn that promise into a wait. The immediate confirmation still catches a run
// created between the two reads.
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

// The runs API's documented nonterminal status names. The read does not query them:
// it takes one unfiltered snapshot and filters on the complement of `completed`, so
// a status this list does not name — or one the API adds later — is still occupied.
// The list stays exported and pinned as the set the design reasons about.
export const QUALIFICATION_NONTERMINAL_STATUSES = Object.freeze([
  'requested', 'waiting', 'pending', 'queued', 'in_progress',
]);
/** The admission wait is bounded: it refuses, never proceeds silently, after 30 minutes. */
export const ADMISSION_BUDGET_MS = 30 * 60 * 1000;
/** Poll the run list on a fixed interval; the budget, not the interval, is the bound. */
export const ADMISSION_INTERVAL_MS = 30_000;
const WORKFLOW_PATH = `repos/${E2E_REPOSITORY}/actions/workflows/${QUALIFICATION_WORKFLOW}`;
const RUNS_PATH = `${WORKFLOW_PATH}/runs?per_page=100`;
const runPath = id => `repos/${E2E_REPOSITORY}/actions/runs/${id}`;
const MAX_BUFFER = 10 * 1024 * 1024;
const GH_OPTIONS = { timeout: 60_000, maxBuffer: MAX_BUFFER };

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const firstText = (...values) => values.find(value => typeof value === 'string' && value !== '');
const runUrlOf = id => `https://github.com/${E2E_REPOSITORY}/actions/runs/${id}`;

/** A `full` qualification run is the only run that seals a record; `smoke`/`reconcile` seal none. */
export const isFullQualificationRun = entry => typeof entry?.display_title === 'string'
  && entry.display_title.startsWith(QUALIFICATION_FULL_RUN_NAME_PREFIX);

/**
 * The newest run page, read once and filtered client-side: one unfiltered call per
 * poll is the whole point, so no status transition can fall between two
 * status-filtered queries. A failed or malformed read throws, and the caller keeps
 * the gate closed.
 */
export async function listNonterminalFullRuns(run, env) {
  const response = parseJson((await run('gh', ['api', RUNS_PATH], { env, ...GH_OPTIONS })).stdout);
  if (!Array.isArray(response?.workflow_runs)) throw new Error('The qualification run list is malformed');
  return response.workflow_runs.filter(entry => isFullQualificationRun(entry) && entry.status !== 'completed');
}

/**
 * One poll: the single snapshot, then every known holder by id. Nonterminal `full`
 * runs from the snapshot join the holder set; a holder leaves it only when its
 * by-id read reports `completed`; a failed read keeps the holder and is carried to
 * the refusal. Occupied means "a holder exists or this poll failed", never "the
 * snapshot was empty".
 */
async function pollOnce({ run, env, holders, state }) {
  let thisPollHadAnError = false;
  try {
    for (const entry of await listNonterminalFullRuns(run, env)) {
      if (entry.id === undefined) continue;
      holders.set(entry.id, entry);
    }
  } catch (error) {
    thisPollHadAnError = true;
    state.lastError = error;
  }
  for (const id of [...holders.keys()]) {
    try {
      const read = parseJson((await run('gh', ['api', runPath(id)], { env, ...GH_OPTIONS })).stdout);
      if (read?.status === 'completed') {
        holders.delete(id);
        continue;
      }
      holders.set(id, { ...holders.get(id), ...read, id });
    } catch (error) {
      thisPollHadAnError = true;
      state.lastError = error;
    }
  }
  return holders.size > 0 || thisPollHadAnError;
}

const describeHolder = holder => {
  const url = firstText(holder.html_url, Number.isSafeInteger(holder.id) ? runUrlOf(holder.id) : undefined);
  const state = [holder.status, holder.conclusion].filter(value => typeof value === 'string' && value !== '').join('/');
  return `${url ?? `run ${holder.id ?? '<unknown>'}`} (${state || 'nonterminal'})`;
};

/**
 * Wait while any `full` qualification run is known to be nonterminal, and proceed
 * only after two consecutive clear polls. A failed read keeps the gate closed
 * instead of opening it; the budget, never a silent empty read, ends the wait.
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
  const holders = new Map();
  const state = { lastError: undefined };
  for (;;) {
    let occupied = await pollOnce({ run, env, holders, state });
    if (!occupied) {
      // Immediate confirmation, not an interval-sized delay: an idle gate still
      // proceeds at once, and a run created between the two reads is caught here.
      occupied = await pollOnce({ run, env, holders, state });
      if (!occupied) {
        const waitedSeconds = Math.round((now() - startedAt) / 1000);
        out.write(`No full qualification run is nonterminal; the admission check proceeds`
          + `${waitedSeconds > 0 ? ` after ${waitedSeconds} s` : ''}.\n`);
        return 0;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      const parts = [];
      if (holders.size > 0) {
        parts.push(`${holders.size} full qualification run(s) were still nonterminal after the`
          + ` ${budgetMinutes}-minute admission budget: ${[...holders.values()].map(describeHolder).join(', ')}`);
        parts.push('cancel the qualification run to release the environment — never the deployment run');
      }
      if (state.lastError !== undefined) {
        parts.push(`a qualification read failed; the last read failed: ${state.lastError?.message ?? state.lastError}`);
      }
      out.write(`Refusing the mutation: ${parts.join('; ')}.\n`);
      return 1;
    }
    await wait(Math.min(intervalMs, remaining));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
