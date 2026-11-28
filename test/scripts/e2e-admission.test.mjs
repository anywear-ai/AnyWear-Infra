import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTED_FULL_RUN_NAME_PREFIXES, ACCEPTED_WORKFLOW_PATHS, ADMISSION_BUDGET_MS,
  ADMISSION_INTERVAL_MS, E2E_FULL_RUN_NAME_PREFIX, E2E_WORKFLOW_PATH, isFullGateRun,
  listNonterminalFullRuns, main, E2E_NONTERMINAL_STATUSES,
  RETIRED_FULL_RUN_NAME_PREFIX, RETIRED_WORKFLOW_PATH, RUNS_PATH,
} from '../../scripts/e2e-admission.mjs';
import { capturedRunPage } from '../fixtures/e2e-repository-runs-page.mjs';

// #338/#358: the pre-mutation admission read. It runs in `mutate.yml`'s `deploy` job
// before the release-byte download and the mutating composite, so its only two
// possible outcomes are "proceed" and "refuse by name". These tests prove the
// refusal is never silent, pin the read's atomicity (one unfiltered snapshot per
// poll, every holder carried forward by id, two consecutive clear polls before the
// gate opens), and pin the repository-level read: one page of the repository's own
// run list per poll, filtered client-side on each run's own `path`, `display_title`
// prefix and nonterminal status. The fake `gh` answers exactly two request paths —
// the repository run list and the by-id read of a holder — and records any other
// request as a violation the helper asserts, so a regression back to a
// workflow-file-scoped or status-filtered listing fails the test itself.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/77';
const runUrl = id => `https://github.com/anywear-ai/AnyWear-E2E/actions/runs/${id}`;
const runName = (prefix, operation) => `${prefix.replace(/: full$/, `: ${operation}`)} · deploy-gate`
  + ` · ${serviceCommit} · by ${dispatchedBy}`;
const fullTitle = prefix => runName(prefix, 'full');

const runState = (id, status, { path = E2E_WORKFLOW_PATH, title = fullTitle(E2E_FULL_RUN_NAME_PREFIX) } = {}) => ({
  id, path, display_title: title, status, conclusion: null, html_url: runUrl(id),
});
const completedRun = (id, { conclusion = 'success', ...options } = {}) =>
  ({ ...runState(id, 'completed', options), conclusion });

// The fake answers exactly the two endpoints the read may use: the repository run
// list (`RUNS_PATH`, one page per poll, `pages` advances per list call with the last
// answer repeating) and the by-id read of a holder (`byId[id]` is one response or a
// per-read sequence, last repeating, and may be an Error). A page answer is an array
// of run entries, a raw response body string, a JSON body object, or an Error; a
// by-id answer is a run object, an Error, or an array of those. Any request path
// other than the two is recorded as a violation and never answered.
function fakeGh({ pages = [[]], byId = {} } = {}) {
  const calls = [];
  const violations = [];
  let polls = 0;
  const reads = new Map();
  const answerAt = (answers, index) => (Array.isArray(answers) ? answers[Math.min(index, answers.length - 1)] : answers);
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    const requestPath = String(args[1]);
    calls.push(requestPath);
    const byIdMatch = /^repos\/anywear-ai\/AnyWear-E2E\/actions\/runs\/(\d+)$/.exec(requestPath);
    if (byIdMatch) {
      const id = Number(byIdMatch[1]);
      const index = reads.get(id) ?? 0;
      reads.set(id, index + 1);
      const answer = answerAt(byId[id], index);
      assert.notEqual(answer, undefined, `the test must answer the by-id read of run ${id}`);
      if (answer instanceof Error) throw answer;
      return { stdout: JSON.stringify(answer), stderr: '' };
    }
    if (requestPath !== RUNS_PATH) {
      violations.push(requestPath);
      throw new Error(`the admission read must not request ${requestPath}`);
    }
    const answer = answerAt(pages, polls++);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'string') return { stdout: answer, stderr: '' };
    if (Array.isArray(answer)) return { stdout: JSON.stringify({ workflow_runs: answer }), stderr: '' };
    return { stdout: JSON.stringify(answer), stderr: '' };
  };
  return { calls, violations, run,
    listCalls: () => calls.filter(path => path === RUNS_PATH).length,
    byIdCalls: () => calls.filter(path => /\/actions\/runs\/\d+$/.test(path)).length };
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
  assert.deepEqual(gh.violations, [], 'the read may request only the repository run list and a run by id');
  return { code, text: sink.text(), waits: clock.waits };
};

const waitedTotal = waits => waits.reduce((total, value) => total + value, 0);

test('the accepted sets are the retired and current literals, and nothing else', async () => {
  // The literals, not the workflow file: `AnyWear-E2E` is not in this checkout, so
  // these tests pin Infra's half and the E2E `run-name`'s own half is Acceptance's.
  assert.equal(RETIRED_WORKFLOW_PATH, '.github/workflows/beta-qualification.yml');
  assert.equal(E2E_WORKFLOW_PATH, '.github/workflows/beta-e2e.yml');
  assert.deepEqual([...ACCEPTED_WORKFLOW_PATHS], [RETIRED_WORKFLOW_PATH, E2E_WORKFLOW_PATH]);
  assert.equal(RETIRED_FULL_RUN_NAME_PREFIX, 'Beta qualification: full');
  assert.equal(E2E_FULL_RUN_NAME_PREFIX, 'Beta E2E gate: full');
  assert.deepEqual([...ACCEPTED_FULL_RUN_NAME_PREFIXES],
    [RETIRED_FULL_RUN_NAME_PREFIX, E2E_FULL_RUN_NAME_PREFIX]);
  assert.equal(Object.isFrozen(ACCEPTED_WORKFLOW_PATHS), true);
  assert.equal(Object.isFrozen(ACCEPTED_FULL_RUN_NAME_PREFIXES), true);
  assert.equal(Object.isFrozen(E2E_NONTERMINAL_STATUSES), true);
  assert.deepEqual([...E2E_NONTERMINAL_STATUSES],
    ['requested', 'waiting', 'pending', 'queued', 'in_progress']);
  assert.equal(RUNS_PATH, 'repos/anywear-ai/AnyWear-E2E/actions/runs?per_page=100');
  assert.equal(isFullGateRun({}), false);
  assert.equal(isFullGateRun({ path: RETIRED_WORKFLOW_PATH }), false,
    'a path alone is not a `full` holder');
  assert.equal(isFullGateRun({ display_title: fullTitle(E2E_FULL_RUN_NAME_PREFIX) }), false,
    'a run-name alone is not a `full` holder');
});

test('the four path × run-name-prefix combinations are each recognised as a full holder', async () => {
  let index = 0;
  for (const path of ACCEPTED_WORKFLOW_PATHS) {
    for (const prefix of ACCEPTED_FULL_RUN_NAME_PREFIXES) {
      const holder = runState(6000 + index++, 'in_progress', { path, title: fullTitle(prefix) });
      assert.equal(isFullGateRun(holder), true, `${path} + ${prefix} must be a full holder`);
      // The holder is never completed, so the budget is what ends the wait: the
      // combination did hold the gate rather than being filtered away.
      const gh = fakeGh({ pages: [[holder]], byId: { [holder.id]: holder } });
      const clock = fakeClock();
      const { code, text, waits } = await admit({ gh, clock });
      assert.equal(code, 1, `${path} + ${prefix} must refuse the mutation`);
      assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
      assert.match(text, /^Refusing the mutation: 1 full gate run\(s\) were still nonterminal/);
      assert.ok(text.includes(runUrl(holder.id)), 'the refusal names the holder URL');
      assert.match(text, /\(in_progress\)/, 'the refusal names the holder status');
    }
  }
});

test('smoke and reconcile runs are not holders under either prefix', async () => {
  let index = 0;
  for (const prefix of ACCEPTED_FULL_RUN_NAME_PREFIXES) {
    for (const operation of ['smoke', 'reconcile']) {
      const run = runState(7000 + index++, 'in_progress', { title: runName(prefix, operation) });
      assert.equal(isFullGateRun(run), false, `${operation} under ${prefix} is not a full run`);
      const gh = fakeGh({ pages: [[run]] });
      const clock = fakeClock();
      const { code, text, waits } = await admit({ gh, clock });
      assert.equal(code, 0, `${operation} seals nothing and must not hold the gate`);
      assert.deepEqual(waits, []);
      assert.match(text, /No full gate run is nonterminal/);
      assert.equal(gh.byIdCalls(), 0);
    }
  }
});

test('the committed fixture is a real page and carries the deleted workflow path', async () => {
  // The surviving evidence for the repository-level read: `.github/workflows/
  // reconcile-schedule.yml` was deleted from AnyWear-E2E long ago, and its runs are
  // still listed with that `path`. The fixture is the real capture, trimmed to the
  // consumed fields, and deliberately contains no entry of the retired gate workflow
  // file: the shrink step of this issue must reach zero occurrences of that name
  // without touching this file.
  const paths = capturedRunPage.workflow_runs.map(run => run.path);
  assert.equal(paths.filter(path => path === '.github/workflows/reconcile-schedule.yml').length > 0, true,
    'the fixture must carry real runs of the long-deleted reconcile-schedule.yml');
  assert.equal(paths.includes(RETIRED_WORKFLOW_PATH), false,
    'the fixture itself must not carry a retired gate-path entry');
  assert.equal(capturedRunPage.workflow_runs.some(run =>
    typeof run.display_title === 'string' && run.display_title.startsWith(RETIRED_FULL_RUN_NAME_PREFIX)), false);
  // Every committed entry is a real run object with the consumed fields, so it is a
  // valid page for the read; none of them is a `full` holder.
  for (const run of capturedRunPage.workflow_runs) {
    assert.equal(typeof run, 'object');
    for (const field of ['id', 'path', 'display_title', 'status', 'conclusion', 'html_url', 'name', 'event',
      'head_branch', 'run_number', 'run_attempt', 'created_at', 'updated_at']) {
      assert.equal(field in run, true, `the captured entry is missing ${field}`);
    }
  }
  const gh = fakeGh({ pages: [capturedRunPage.workflow_runs] });
  const runs = await listNonterminalFullRuns(gh.run, { GH_TOKEN: 'ghs_read_only' });
  assert.deepEqual(runs, [], 'the real page holds no nonterminal full run');
  assert.deepEqual(gh.calls, [RUNS_PATH]);
});

test('a nonterminal holder written under the retired path is still seen', async () => {
  // The design's deleted-file assumption. The holder is built from a real captured
  // `.github/workflows/reconcile-schedule.yml` entry, changing only `path`,
  // `display_title`, `status` and `conclusion`: a run keeps the path of the file it
  // was dispatched from after that file is deleted, so the holder is still visible
  // here while the rename window closes.
  const shape = capturedRunPage.workflow_runs
    .find(run => run.path === '.github/workflows/reconcile-schedule.yml');
  const holder = { ...shape, path: RETIRED_WORKFLOW_PATH,
    display_title: fullTitle(RETIRED_FULL_RUN_NAME_PREFIX), status: 'in_progress', conclusion: null };
  assert.equal(isFullGateRun(holder), true);
  const gh = fakeGh({ pages: [[holder], []],
    byId: { [holder.id]: [holder, { ...holder, status: 'completed', conclusion: 'success' }] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0, 'the retired-path holder kept the gate shut until it completed');
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS],
    'the holder was recognised on the first page and held the mutation for one interval');
  assert.equal(gh.byIdCalls(), 2, 'the holder was re-read by id until it reported completed');
  assert.match(text, /proceeds after 30 s/);
});

test('a holder at the end of a 100-entry mixed page is still found', async () => {
  // The page is 100 entries: the real captured check.yml and reconcile-schedule.yml
  // runs, generated unrelated runs (some of them nonterminal) and the one gate
  // holder last. The filter is over every entry, not just the first, which is what
  // makes "one page per poll" a sound bound rather than a race with position.
  const unrelated = Array.from({ length: 63 }, (_, index) => ({
    id: 900_000 + index,
    path: index % 2 === 0 ? '.github/workflows/diagnostics.yml' : '.github/workflows/pages.yml',
    display_title: `Diagnostics ${index}`,
    status: index % 3 === 0 ? 'in_progress' : 'completed',
    conclusion: index % 3 === 0 ? null : 'success',
    html_url: runUrl(900_000 + index),
  }));
  const holder = runState(4242, 'waiting');
  const page = [...capturedRunPage.workflow_runs, ...unrelated, holder];
  assert.equal(page.length, 100);
  assert.equal(page.at(-1).id, holder.id, 'the holder is last on the page, never first');
  const gh = fakeGh({ pages: [page, []],
    byId: { [holder.id]: [holder, { ...holder, status: 'completed', conclusion: 'success' }] } });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS],
    'finding the holder on the mixed page is what made the step wait at all');
  assert.equal(gh.byIdCalls(), 2);
  assert.equal(gh.listCalls(), 3);
});

// Every read-failure class is a refusal: transport, authentication/authorization,
// `5xx`, timeout, a body that is not JSON and a body whose shape is not a run list.
// Each class is asserted on its own, and each must exhaust the whole budget, exit
// non-zero and name the failure — a failed read never becomes "nothing is running".
const refusalClasses = [
  ['a transport failure', new Error('gh: Could not resolve host: api.github.com (ENOTFOUND)')],
  ['a 401 authentication failure', new Error('gh: HTTP 401 Unauthorized (https://api.github.com/repos/anywear-ai/AnyWear-E2E/actions/runs?per_page=100)')],
  ['a 403 authorization failure', new Error('gh: HTTP 403 Forbidden (https://api.github.com/repos/anywear-ai/AnyWear-E2E/actions/runs?per_page=100)')],
  ['a 502 failure', new Error('gh: HTTP 502 Bad Gateway')],
  ['a 503 failure', new Error('gh: HTTP 503 Service Unavailable')],
  ['a 504 failure', new Error('gh: HTTP 504 Gateway Timeout')],
  ['a timeout', new Error('gh: request to https://api.github.com timed out after 60000 ms (ETIMEDOUT)')],
];
for (const [label, error] of refusalClasses) {
  test(`a failed read refuses the mutation: ${label}`, async () => {
    const gh = fakeGh({ pages: [error] });
    const clock = fakeClock();
    const { code, text, waits } = await admit({ gh, clock });
    assert.equal(code, 1, `${label} must never admit the mutation`);
    assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS, `${label} is retried for the whole budget`);
    assert.match(text, /^Refusing the mutation: a gate run list read failed; the last read failed: /);
    assert.equal(text.includes(error.message), true, `${label} must be named in the refusal`);
  });
}

test('a body that is not JSON refuses the mutation', async () => {
  const gh = fakeGh({ pages: ['<html><body>502 Bad Gateway</body></html>'] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1);
  assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
  assert.match(text, /a gate run list read failed; the last read failed: Invalid JSON value/);
});

test('a body whose shape is not a run list refuses the mutation', async () => {
  const foreignShapes = [
    ['no workflow_runs member', { total_count: 0, items: [] }],
    ['workflow_runs is not an array', { workflow_runs: { 0: { id: 1 } } }],
    ['a bare JSON array body', '[]'],
    ['a null body', 'null'],
  ];
  for (const [label, body] of foreignShapes) {
    const gh = fakeGh({ pages: [body] });
    const clock = fakeClock();
    const { code, text, waits } = await admit({ gh, clock });
    assert.equal(code, 1, `${label} must never admit the mutation`);
    assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
    assert.match(text, /a gate run list read failed/);
    assert.match(text, /run list is malformed/);
  }
  // An entry that is not a run object is the same class: a page that cannot be
  // proven to be a run list is never read as "no matching run".
  for (const entry of [null, 'not-a-run', 42, []]) {
    const gh = fakeGh({ pages: [[runState(1, 'queued'), entry]] });
    const clock = fakeClock();
    const { code, text } = await admit({ gh, clock });
    assert.equal(code, 1, `an entry of ${JSON.stringify(entry)} must never admit the mutation`);
    assert.match(text, /an entry is not a run object/);
  }
});

// The regressions the read already owned: they must survive the change of listing.
test('an empty repository run list proceeds immediately with no wait', async () => {
  const gh = fakeGh();
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0, 'an empty read is admitted');
  assert.deepEqual(waits, [], 'nothing is in flight, so the step does not wait');
  assert.match(text, /No full gate run is nonterminal; the admission check proceeds/);
  assert.equal(gh.listCalls(), 2, 'a clear poll is confirmed by one immediate second poll');
  assert.equal(gh.byIdCalls(), 0);
});

test('a nonterminal full run makes the step wait, then proceed when it clears', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], 'one interval was waited before the run cleared');
  assert.match(text, /proceeds after 30 s/);
});

test('every nonterminal status counts as occupied on its own for a full run', async () => {
  for (const status of E2E_NONTERMINAL_STATUSES) {
    const gh = fakeGh({ pages: [[runState(5000, status)], []],
      byId: { 5000: [runState(5000, status), completedRun(5000)] } });
    const clock = fakeClock();
    const { code, waits } = await admit({ gh, clock });
    assert.equal(code, 0, `${status} eventually cleared`);
    assert.deepEqual(waits, [ADMISSION_INTERVAL_MS], `${status} must hold the mutation for one interval`);
  }
  // Dedupe by id: the page repeating the same run adds one holder, so each poll
  // makes exactly one by-id read for it.
  const duplicate = fakeGh({ pages: [[runState(7, 'queued'), runState(7, 'in_progress')], []],
    byId: { 7: [runState(7, 'in_progress'), completedRun(7)] } });
  const clock = fakeClock();
  const { code } = await admit({ gh: duplicate, clock });
  assert.equal(code, 0);
  assert.equal(duplicate.byIdCalls(), 2, 'one by-id read per holder per poll, not one per page entry');
});

test('a completed full run in the page does not block', async () => {
  const gh = fakeGh({ pages: [[completedRun(99)]] });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, []);
  assert.equal(gh.byIdCalls(), 0);
});

test('the budget expires non-zero and names the holder run URL', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')]], byId: { 4242: runState(4242, 'waiting') } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'a spent budget refuses the mutation');
  assert.equal(ADMISSION_BUDGET_MS, 1_800_000, 'the admission budget is pinned at 30 minutes');
  assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS, 'it waits exactly the budget, never past it');
  assert.match(text, /^Refusing the mutation: 1 full gate run\(s\) were still nonterminal/);
  assert.match(text, /https:\/\/github\.com\/anywear-ai\/AnyWear-E2E\/actions\/runs\/4242 \(waiting\)/);
});

test('a holder that leaves the page is still held by its by-id read (the straddle regression)', async () => {
  // The live shape: the run is listed as nonterminal, then absent from the next
  // page because it moved between jobs, while it is still in flight. Absence must
  // never be read as clear.
  const waiting = runState(4242, 'waiting');
  const gh = fakeGh({ pages: [[waiting], [], []],
    byId: { 4242: [waiting, runState(4242, 'in_progress'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS, ADMISSION_INTERVAL_MS],
    'the empty page poll must not open the gate; only the completed by-id read does');
  assert.equal(gh.listCalls(), 4, 'poll 1, the empty poll 2, the cleared poll 3 and the confirmation poll 4');
  assert.equal(gh.byIdCalls(), 3, 'the holder is re-read on every poll until it reports completed');
  assert.match(text, /No full gate run is nonterminal; the admission check proceeds after 60 s/);
});

test('absence never opens the gate: the budget expires naming the carried holder', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')], []],
    byId: { 4242: runState(4242, 'in_progress') } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'a holder absent from every later page still holds the gate');
  assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
  assert.equal(text.includes(runUrl(4242)), true, 'the refusal names the carried holder URL');
  assert.match(text, /\(in_progress\)/);
});

test('the read never issues a status-filtered or workflow-file-scoped query', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  await admit({ gh, clock });
  assert.ok(gh.calls.length > 0);
  for (const requestPath of gh.calls) {
    const isListing = requestPath === RUNS_PATH;
    const isById = /^repos\/anywear-ai\/AnyWear-E2E\/actions\/runs\/\d+$/.test(requestPath);
    assert.ok(isListing || isById, `unexpected read ${requestPath}`);
    assert.equal(requestPath.includes('?status='), false,
      'the sequential status-filtered reads are the defect this pins');
    assert.equal(/\/actions\/workflows\/[^/]+\/runs/.test(requestPath), false,
      'a workflow-file-scoped listing is the shape this change removes');
  }
});

test('one unfiltered page per poll, one by-id read per holder per poll', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.equal(gh.listCalls(), 3, 'polls: holder, cleared, confirmation');
  assert.equal(gh.byIdCalls(), 2, 'the holder is read once per poll');
});

test('two consecutive empty reads: a run appearing between them blocks the gate', async () => {
  const gh = fakeGh({ pages: [[], [runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), completedRun(4242)] } });
  const clock = fakeClock();
  const { code, waits } = await admit({ gh, clock });
  assert.equal(code, 0);
  assert.deepEqual(waits, [ADMISSION_INTERVAL_MS],
    'the first clear poll alone did not proceed: the immediate confirmation caught the run');
  assert.equal(gh.listCalls(), 4, 'clear poll, confirmation with the run, cleared poll, final confirmation');
});

test('a failed page read keeps the gate closed', async () => {
  // One failed poll then a clear pair: the failed read did not open the gate, and
  // the retry proceeded only when two complete reads found nothing in flight.
  const retry = fakeGh({ pages: [new Error('gh: HTTP 502 Bad Gateway'), [], []] });
  const retryClock = fakeClock();
  const first = await admit({ gh: retry, clock: retryClock });
  assert.equal(first.code, 0);
  assert.equal(retryClock.waits.length, 1, 'the incomplete read was retried after one interval');
  assert.equal(retry.listCalls(), 3, 'failed poll, clear poll, confirming poll');
  // A persistent failure never proves the environment clear, so the budget refuses.
  const persistent = fakeGh({ pages: [new Error('gh: HTTP 502 Bad Gateway')] });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh: persistent, clock });
  assert.equal(code, 1);
  assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
  assert.match(text, /a gate run list read failed; the last read failed: gh: HTTP 502 Bad Gateway/);
});

test('a failed by-id read keeps the holder and the gate closed', async () => {
  const gh = fakeGh({ pages: [[runState(4242, 'waiting')], []],
    byId: { 4242: [runState(4242, 'waiting'), new Error('gh: HTTP 502 Bad Gateway')] } });
  const clock = fakeClock();
  const { code, text, waits } = await admit({ gh, clock });
  assert.equal(code, 1, 'an unread holder is never clear');
  assert.equal(waitedTotal(waits), ADMISSION_BUDGET_MS);
  assert.ok(text.includes(runUrl(4242)), 'the refusal still names the holder');
  assert.match(text, /a gate run list read failed; the last read failed: gh: HTTP 502 Bad Gateway/);
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
