import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ADMISSION_BUDGET_MS, ADMISSION_INTERVAL_MS, isFullQualificationRun,
  listNonterminalFullRuns, main, QUALIFICATION_FULL_RUN_NAME_PREFIX,
  QUALIFICATION_NONTERMINAL_STATUSES } from '../../scripts/qualification-admission.mjs';

// #338: the pre-mutation admission read. It runs in `mutate.yml`'s `deploy` job
// before the release-byte download and the mutating composite, so its only two
// possible outcomes are "proceed" and "refuse by name". These tests prove the
// refusal is never silent: an empty read proceeds, every nonterminal status of a
// `full` run holds the mutation, only `full` holds it, and the budget refuses
// non-zero naming the holder. The fake `gh` also proves the full status set is
// queried: a read that asked only `queued`/`in_progress` would miss three of the
// five states the runs API accepts.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/77';
const fullTitle = () => `${QUALIFICATION_FULL_RUN_NAME_PREFIX} · deploy-qualify · ${serviceCommit} · by ${dispatchedBy}`;
const smokeTitle = () => 'Beta qualification: smoke · deploy-smoke · - · by ' + dispatchedBy;
const reconcileTitle = () => 'Beta qualification: reconcile · scheduled · - · by @anywear-agent';
const holder = (id, status, title = fullTitle()) => ({ id, status, conclusion: null, display_title: title,
  html_url: `https://github.com/anywear-ai/AnyWear-E2E/actions/runs/${id}` });

// Each listing pass reads the five statuses in the module's order; `snapshots`
// answers one pass each, with the last snapshot repeating. The clock only moves
// when the injected wait does, so the tests prove the bound without sleeping.
function fakeGh({ snapshots = [{}], failingStatus, failingPasses = Number.POSITIVE_INFINITY } = {}) {
  const calls = [];
  let pass = 0;
  let snapshot = {};
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const status = /\?status=([a-z_]+)/.exec(String(args[1] ?? ''))?.[1];
    assert.ok(status, `unexpected gh api ${args[1]}`);
    if (status === QUALIFICATION_NONTERMINAL_STATUSES[0]) {
      snapshot = snapshots[Math.min(pass++, snapshots.length - 1)];
    }
    if (failingStatus === status && pass <= failingPasses) {
      throw new Error(`gh: HTTP 502 Bad Gateway while listing ${status}`);
    }
    return { stdout: JSON.stringify({ workflow_runs: snapshot[status] ?? [] }), stderr: '' };
  };
  return { calls, run };
}

function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  const waits = [];
  return { waits, now: () => current,
    wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; } };
}

const output = () => {
  const chunks = [];
  return { chunks, out: { write: chunk => chunks.push(chunk) }, text: () => chunks.join('') };
};

const admit = async ({ gh, clock, overrides = {} } = {}) => {
  const sink = output();
  const code = await main({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run, wait: clock.wait, now: clock.now,
    out: sink.out, ...overrides });
  return { code, text: sink.text(), waits: clock.waits };
};

test('the full filter is the pinned run-name prefix and the matcher uses it', async () => {
  // The literal, not the workflow file: `AnyWear-E2E` is not in this checkout, so
  // this test pins Infra's half and the E2E run-name's own half is Acceptance's.
  assert.equal(QUALIFICATION_FULL_RUN_NAME_PREFIX, 'Beta qualification: full');
  assert.equal(Object.isFrozen(QUALIFICATION_NONTERMINAL_STATUSES), true);
  assert.deepEqual([...QUALIFICATION_NONTERMINAL_STATUSES],
    ['requested', 'waiting', 'pending', 'queued', 'in_progress']);
  assert.equal(isFullQualificationRun(holder(1, 'queued')), true);
  assert.equal(isFullQualificationRun(holder(2, 'queued', smokeTitle())), false);
  assert.equal(isFullQualificationRun(holder(3, 'queued', reconcileTitle())), false);
  assert.equal(isFullQualificationRun({ display_title: QUALIFICATION_FULL_RUN_NAME_PREFIX }), true);
  assert.equal(isFullQualificationRun({}), false);
  // The matcher must not restate the literal it is pinned to.
  const source = await readFile(new URL('../../scripts/qualification-admission.mjs', import.meta.url), 'utf8');
  assert.match(source, /display_title\.startsWith\(QUALIFICATION_FULL_RUN_NAME_PREFIX\)/);
});

test('an empty qualification run list proceeds immediately with no wait', async () => {
  const gh = fakeGh();
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0, 'an empty read is admitted');
  assert.deepEqual(waits, [], 'nothing is in flight, so the step does not wait');
  assert.match(text, /No full qualification run is nonterminal; the admission check proceeds/);
  // It really read the full status set, once each.
  assert.deepEqual(gh.calls.map(args => /\?status=([a-z_]+)/.exec(String(args[1]))[1]),
    [...QUALIFICATION_NONTERMINAL_STATUSES]);
});

test('a nonterminal full run makes the step wait, then proceed when it clears', async () => {
  const gh = fakeGh({ snapshots: [{ queued: [holder(4242, 'queued')] }, {}] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], 'one interval was waited before the run cleared');
  assert.match(text, /proceeds after 30 s/);
});

test('every nonterminal status counts as occupied on its own for a full run', async () => {
  for (const status of QUALIFICATION_NONTERMINAL_STATUSES) {
    const gh = fakeGh({ snapshots: [{ [status]: [holder(5000, status)] }, {}] });
    const clock = fakeClock();
    const { code, waits } = await admit({ gh, clock });
    assert.equal(code, 0, `${status} eventually cleared`);
    assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], `${status} must hold the mutation for one interval`);
  }
  // Dedupe by id: the same run reported under two statuses is one holder.
  const duplicate = fakeGh({ snapshots: [{ queued: [holder(7, 'queued')], in_progress: [holder(7, 'in_progress')] }] });
  const clock = fakeClock();
  const listing = await listNonterminalFullRuns(duplicate.run, { GH_TOKEN: 'ghs_read_only' });
  assert.equal(listing.holders.length, 1);
  assert.equal(listing.error, undefined);
});

test('a terminal full run reported by a status filter does not block', async () => {
  const completed = { ...holder(99, 'completed'), conclusion: 'success' };
  const gh = fakeGh({ snapshots: [{ queued: [completed] }] });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, []);
});

test('smoke and reconcile runs do not block a mutation', async () => {
  const gh = fakeGh({ snapshots: [{ queued: [holder(11, 'queued', smokeTitle())],
    in_progress: [holder(12, 'in_progress', reconcileTitle())] }] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [], 'a run that seals no record holds nothing');
  assert.match(text, /No full qualification run is nonterminal/);
});

test('the budget expires non-zero and names the holder run URL', async () => {
  const gh = fakeGh({ snapshots: [{ queued: [holder(4242, 'queued')] }] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'a spent budget refuses the mutation');
  assert.equal(waits.reduce((total, value) => total + value, 0), ADMISSION_BUDGET_MS,
    'it waits exactly the budget, never past it');
  assert.match(text, /^Refusing the mutation: 1 full qualification run\(s\) were still nonterminal/);
  assert.match(text, /https:\/\/github\.com\/anywear-ai\/AnyWear-E2E\/actions\/runs\/4242 \(queued\)/);
});

test('a failed listing is not clear: it retries, then refuses naming the last error', async () => {
  // One failed pass then a clear pass: the failed read did not open the gate, and
  // the retry proceeded only when a complete read found nothing in flight.
  const retry = fakeGh({ snapshots: [{}, {}], failingStatus: 'in_progress', failingPasses: 1 });
  const retryClock = fakeClock();
  const first = await admit({ gh: retry, clock: retryClock, overrides: {} });
  assert.equal(first.code, 0);
  assert.equal(retryClock.waits.length, 1, 'the incomplete read was retried after one interval');
  // A persistent failure never proves the environment clear, so the budget refuses.
  const persistent = fakeGh({ snapshots: [{ queued: [holder(4242, 'queued')] }], failingStatus: 'in_progress' });
  const clock = fakeClock();
  const { code, text } = await admit({ gh: persistent, clock });
  assert.equal(code, 1);
  assert.match(text, /the run list could not be read completely; the last read failed: gh: HTTP 502/);
});

test('the admission refuses to run without the read-only token', async () => {
  const gh = fakeGh();
  const clock = fakeClock();
  const sink = output();
  const code = await main({ env: {}, run: gh.run, wait: clock.wait, now: clock.now, out: sink.out });
  assert.equal(code, 1);
  assert.match(sink.text(), /read-only AnyWear-E2E App token is missing/);
  assert.deepEqual(gh.calls, [], 'no GitHub call precedes the refusal');
});
