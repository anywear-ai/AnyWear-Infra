import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ADMISSION_BUDGET_MS, ADMISSION_INTERVAL_MS, isFullQualificationRun,
  listNonterminalFullRuns, main, QUALIFICATION_FULL_RUN_NAME_PREFIX,
  QUALIFICATION_NONTERMINAL_STATUSES } from '../../scripts/qualification-admission.mjs';

// #338: the pre-mutation admission read. It runs in `mutate.yml`'s `deploy` job
// before the release-byte download and the mutating composite, so its only two
// possible outcomes are "proceed" and "refuse by name". These tests prove the
// refusal is never silent, and pin the read's atomicity: one unfiltered snapshot per
// poll, every holder carried forward by id, and two consecutive clear polls before
// the gate opens. The fake `gh` answers both endpoints and records every call, so a
// regression back to sequential status-filtered queries fails here.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/77';
const runsPath = 'repos/anywear-ai/AnyWear-E2E/actions/workflows/beta-qualification.yml/runs?per_page=100';
const fullTitle = () => `${QUALIFICATION_FULL_RUN_NAME_PREFIX} · deploy-qualify · ${serviceCommit} · by ${dispatchedBy}`;
const smokeTitle = () => 'Beta qualification: smoke · deploy-smoke · - · by ' + dispatchedBy;
const reconcileTitle = () => 'Beta qualification: reconcile · scheduled · - · by @anywear-agent';
const runUrl = id => `https://github.com/anywear-ai/AnyWear-E2E/actions/runs/${id}`;
const runState = (id, status, title = fullTitle()) => ({ id, status, conclusion: null, display_title: title,
  html_url: runUrl(id) });
const completedRun = (id, conclusion = 'success', title = fullTitle()) => ({
  ...runState(id, 'completed', title), conclusion });

// The fake answers exactly the two endpoints the read may use: the one unfiltered
// snapshot (`?per_page=100`, one per poll, `snapshots` advances per list call with
// the last repeating) and the by-id read of a holder (`byId[id]` is one response or
// a per-read sequence, last repeating, and may be an Error). Any other path — in
// particular a `?status=` query — fails the test.
function fakeGh({ snapshots = [[]], byId = {}, failingListPolls = 0, listError = 'gh: HTTP 502 Bad Gateway' } = {}) {
  const calls = [];
  let polls = 0;
  const reads = new Map();
  const sequence = (value, index) => Array.isArray(value) ? value[Math.min(index, value.length - 1)] : value;
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const requestPath = String(args[1]);
    const byIdMatch = /\/actions\/runs\/(\d+)$/.exec(requestPath);
    if (byIdMatch) {
      const id = Number(byIdMatch[1]);
      const index = reads.get(id) ?? 0;
      reads.set(id, index + 1);
      const answer = sequence(byId[id], index);
      assert.notEqual(answer, undefined, `the test must answer the by-id read of run ${id}`);
      if (answer instanceof Error) throw answer;
      return { stdout: JSON.stringify(answer), stderr: '' };
    }
    assert.equal(requestPath, runsPath, 'the only listing is the one unfiltered snapshot');
    const poll = polls++;
    if (poll < failingListPolls) throw new Error(listError);
    return { stdout: JSON.stringify({ workflow_runs: snapshots[Math.min(poll, snapshots.length - 1)] }), stderr: '' };
  };
  return { calls, run,
    listCalls: () => calls.filter(args => String(args[1]) === runsPath).length,
    byIdCalls: () => calls.filter(args => /\/actions\/runs\/\d+$/.test(String(args[1]))).length };
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
  assert.equal(isFullQualificationRun(runState(1, 'queued')), true);
  assert.equal(isFullQualificationRun(runState(2, 'queued', smokeTitle())), false);
  assert.equal(isFullQualificationRun(runState(3, 'queued', reconcileTitle())), false);
  assert.equal(isFullQualificationRun({ display_title: QUALIFICATION_FULL_RUN_NAME_PREFIX }), true);
  assert.equal(isFullQualificationRun({}), false);
  // The matcher must not restate the literal it is pinned to.
  const source = await readFile(new URL('../../scripts/qualification-admission.mjs', import.meta.url), 'utf8');
  assert.match(source, /display_title\.startsWith\(QUALIFICATION_FULL_RUN_NAME_PREFIX\)/);
});

test('the snapshot is one unfiltered read that drops completed and non-full runs', async () => {
  const gh = fakeGh({ snapshots: [[runState(1, 'waiting'), completedRun(2), runState(3, 'queued', smokeTitle())]] });
  const runs = await listNonterminalFullRuns(gh.run, { GH_TOKEN: 'ghs_read_only' });
  assert.deepEqual(runs.map(entry => entry.id), [1], 'only the nonterminal full run survives the client-side filter');
  assert.equal(gh.calls.length, 1, 'one snapshot is one call');
  assert.equal(gh.calls[0][1], runsPath);
  assert.equal(gh.calls[0][1].includes('?status='), false);
});

test('an empty qualification run list proceeds immediately with no wait', async () => {
  const gh = fakeGh();
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0, 'an empty read is admitted');
  assert.deepEqual(waits, [], 'nothing is in flight, so the step does not wait');
  assert.match(text, /No full qualification run is nonterminal; the admission check proceeds/);
  assert.equal(gh.listCalls(), 2, 'a clear poll is confirmed by one immediate second poll');
  assert.equal(gh.byIdCalls(), 0);
});

test('a nonterminal full run makes the step wait, then proceed when it clears', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], 'one interval was waited before the run cleared');
  assert.match(text, /proceeds after 30 s/);
});

test('every nonterminal status counts as occupied on its own for a full run', async () => {
  for (const status of QUALIFICATION_NONTERMINAL_STATUSES) {
    const gh = fakeGh({ snapshots: [[runState(5000, status)], []],
      byId: { 5000: [runState(5000, status), completedRun(5000)] } });
    const clock = fakeClock();
    const { code, waits } = await admit({ gh, clock });
    assert.equal(code, 0, `${status} eventually cleared`);
    assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], `${status} must hold the mutation for one interval`);
  }
  // Dedupe by id: the snapshot repeating the same run adds one holder, so each poll
  // makes exactly one by-id read for it.
  const duplicate = fakeGh({ snapshots: [[runState(7, 'queued'), runState(7, 'in_progress')], []],
    byId: { 7: [runState(7, 'in_progress'), completedRun(7)] } });
  const clock = fakeClock();
  const { code } = await admit({ gh: duplicate, clock });
  assert.equal(code, 0);
  assert.equal(duplicate.byIdCalls(), 2, 'one by-id read per holder per poll, not one per snapshot entry');
});

test('a completed full run in the snapshot does not block', async () => {
  const gh = fakeGh({ snapshots: [[completedRun(99)]] });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, []);
  assert.equal(gh.byIdCalls(), 0);
});

test('smoke and reconcile runs do not block a mutation', async () => {
  const gh = fakeGh({ snapshots: [[runState(11, 'queued', smokeTitle()), runState(12, 'in_progress', reconcileTitle())]] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [], 'a run that seals no record holds nothing');
  assert.match(text, /No full qualification run is nonterminal/);
  assert.equal(gh.byIdCalls(), 0);
});

test('the budget expires non-zero and names the holder run URL', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')]], byId: { 4242: runState(4242, 'waiting') } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'a spent budget refuses the mutation');
  assert.equal(ADMISSION_BUDGET_MS, 1_800_000, 'the admission budget is pinned at 30 minutes');
  assert.equal(waits.reduce((total, value) => total + value, 0), ADMISSION_BUDGET_MS,
    'it waits exactly the budget, never past it');
  assert.match(text, /^Refusing the mutation: 1 full qualification run\(s\) were still nonterminal/);
  assert.match(text, /https:\/\/github\.com\/anywear-ai\/AnyWear-E2E\/actions\/runs\/4242 \(waiting\)/);
});

test('a holder that leaves the snapshot is still held by its by-id read (the straddle regression)', async () => {
  // The live shape: the run is listed as nonterminal, then absent from the next
  // snapshot because it moved between jobs, while it is still in flight. Absence must
  // never be read as clear.
  const waiting = runState(4242, 'waiting');
  const gh = fakeGh({ snapshots: [[waiting], [], []],
    byId: { 4242: [waiting, runState(4242, 'in_progress'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS, ADMISSION_INTERVAL_MS],
    'the empty snapshot poll must not open the gate; only the completed by-id read does');
  assert.equal(gh.listCalls(), 4, 'poll 1, the empty poll 2, the cleared poll 3 and the confirmation poll 4');
  assert.equal(gh.byIdCalls(), 3, 'the holder is re-read on every poll until it reports completed');
  assert.match(text, /No full qualification run is nonterminal; the admission check proceeds after 60 s/);
});

test('absence never opens the gate: the budget expires naming the carried holder', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')], []],
    byId: { 4242: runState(4242, 'in_progress') } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'a holder absent from every later snapshot still holds the gate');
  assert.equal(waits.reduce((total, value) => total + value, 0), ADMISSION_BUDGET_MS);
  assert.equal(text.includes(runUrl(4242)), true, 'the refusal names the carried holder URL');
  assert.match(text, /\(in_progress\)/);
});

test('the read never issues a status-filtered query', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  await admit({ gh, clock });
  assert.ok(gh.calls.length > 0);
  for (const args of gh.calls) {
    const requestPath = String(args[1]);
    const isSnapshot = requestPath === runsPath;
    const isById = /^repos\/anywear-ai\/AnyWear-E2E\/actions\/runs\/\d+$/.test(requestPath);
    assert.ok(isSnapshot || isById, `unexpected read ${requestPath}`);
    assert.equal(requestPath.includes('?status='), false,
      'the sequential status-filtered reads are the defect this pins');
  }
});

test('one unfiltered snapshot per poll, one by-id read per holder per poll', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.equal(gh.listCalls(), 3, 'polls: holder, cleared, confirmation');
  assert.equal(gh.byIdCalls(), 2, 'the holder is read once per poll');
});

test('two consecutive empty reads: a run appearing between them blocks the gate', async () => {
  const gh = fakeGh({ snapshots: [[], [runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS],
    'the first clear poll alone did not proceed: the immediate confirmation caught the run');
  assert.equal(gh.listCalls(), 4, 'clear poll, confirmation with the run, cleared poll, final confirmation');
});

test('a failed list read keeps the gate closed', async () => {
  // One failed poll then a clear pair: the failed read did not open the gate, and
  // the retry proceeded only when two complete reads found nothing in flight.
  const retry = fakeGh({ snapshots: [[], []], failingListPolls: 1 });
  const retryClock = fakeClock();
  const first = await admit({ gh: retry, clock: retryClock });
  assert.equal(first.code, 0);
  assert.equal(retryClock.waits.length, 1, 'the incomplete read was retried after one interval');
  assert.equal(retry.listCalls(), 3, 'failed poll, clear poll, confirming poll');
  // A persistent failure never proves the environment clear, so the budget refuses.
  const persistent = fakeGh({ snapshots: [[]], failingListPolls: Number.POSITIVE_INFINITY });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh: persistent, clock });
  assert.equal(code, 1);
  assert.equal(waits.reduce((total, value) => total + value, 0), ADMISSION_BUDGET_MS);
  assert.match(text, /a qualification read failed; the last read failed: gh: HTTP 502 Bad Gateway/);
});

test('a failed by-id read keeps the holder and the gate closed', async () => {
  const gh = fakeGh({ snapshots: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), new Error('gh: HTTP 502 Bad Gateway')] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'an unread holder is never clear');
  assert.equal(waits.reduce((total, value) => total + value, 0), ADMISSION_BUDGET_MS);
  assert.ok(text.includes(runUrl(4242)), 'the refusal still names the holder');
  assert.match(text, /a qualification read failed; the last read failed: gh: HTTP 502 Bad Gateway/);
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
