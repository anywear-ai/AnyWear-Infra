import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOLD_CEILING_MS, RUN_READ_ATTEMPTS, runReadWaits } from '../../scripts/qualification-dispatch.mjs';
import { runQualificationObservation } from '../../scripts/qualification-observe.mjs';

// #338/#354: the hold recorder's exit codes and its three-value vocabulary. Nothing
// else imports `scripts/qualification-observe.mjs`, so without this file an inverted
// 0/1 would leave every other test green. The entry is the one place that maps the
// observed state to the job's conclusion:
//
//   receipt not_submitted, no run   -> unqualified, exit 0 (the dispatch step already reddened the job)
//   no run, any other receipt       -> unobserved, exit 1
//   dispatched run unreadable       -> unobserved, exit 1
//   terminal non-success / ceiling / success -> one verdict, exit 0
//
// Every case writes real `$GITHUB_STEP_SUMMARY` and `$GITHUB_OUTPUT` files and moves
// its clock only through the injected wait, so no test sleeps.
const clockStart = 1_700_000_000_000;
const createdUrl = 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/4242';
const runPath = 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242';
const serviceCommit = 'b'.repeat(40);
const waitsMs = runReadWaits().reduce((total, value) => total + value, 0);
const runState = (status, conclusion = null, extra = {}) => ({ id: 4242, status, conclusion, html_url: createdUrl,
  created_at: new Date(clockStart).toISOString(), ...extra });
const notFoundError = () => {
  const error = new Error('Command failed: gh api repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
  error.stdout = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/actions/workflow-runs","status":"404"}';
  return error;
};

function fakeGh({ reads, jobs = { jobs: [] } }) {
  const calls = [];
  let index = 0;
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const requestPath = String(args[1]);
    if (requestPath.endsWith('/jobs')) {
      if (jobs instanceof Error) throw jobs;
      return { stdout: JSON.stringify(jobs), stderr: '' };
    }
    assert.equal(requestPath, runPath);
    const entry = reads[Math.min(index, reads.length - 1)];
    index += 1;
    if (entry instanceof Error) throw entry;
    return { stdout: JSON.stringify(entry), stderr: '' };
  };
  return { calls, run };
}

const observationClock = () => {
  let current = clockStart;
  const waits = [];
  return { waits, now: () => current, wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; } };
};

async function withOutputs(body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-observe-'));
  try {
    const summary = path.join(directory, 'summary.md');
    const output = path.join(directory, 'output');
    await writeFile(summary, '');
    await writeFile(output, '');
    return await body({ directory, summary, output });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function observeEntry({ env = {}, reads = [], jobs } = {}) {
  return withOutputs(async ({ summary, output }) => {
    const gh = fakeGh({ reads, jobs });
    const clock = observationClock();
    const chunks = [];
    const code = await runQualificationObservation({
      env: { GH_TOKEN: 'ghs_read_only', ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      run: gh.run, wait: clock.wait, now: clock.now, out: { write: chunk => chunks.push(chunk) },
    });
    return { code, calls: gh.calls, waits: clock.waits, log: chunks.join(''),
      summary: await readFile(summary, 'utf8'), output: await readFile(output, 'utf8') };
  });
}

const dispatchCalls = calls => calls.filter(args => args.includes('--method'));

test('a not_submitted receipt with no recorded run exits zero and says nothing was submitted', async () => {
  const result = await observeEntry({ env: { SERVICE_COMMIT: serviceCommit, QUALIFICATION_RECEIPT: 'not_submitted' } });
  assert.equal(result.code, 0, 'the recorder does not add a failure to a job that is already red elsewhere');
  assert.deepEqual(result.calls, [], 'nothing is read when the dispatch proves nothing was submitted');
  assert.equal(result.summary, 'Qualification unqualified: no dispatched run id or URL was recorded by the dispatch step'
    + ` (receipt: not_submitted), so this deployment names no qualification run for Service commit ${serviceCommit}.\n`);
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.log.includes('::warning::'), false);
});

test('no recorded run without a not_submitted receipt records unobserved and exits non-zero', async () => {
  for (const [receipt, cause] of [[undefined, /wrote no receipt/],
    ['acceptance_unknown', /recorded receipt acceptance_unknown/], ['created', /recorded receipt created/]]) {
    const result = await observeEntry({ env: { SERVICE_COMMIT: serviceCommit,
      ...(receipt === undefined ? {} : { QUALIFICATION_RECEIPT: receipt }) } });
    assert.equal(result.code, 1, `${String(receipt)}: a run may exist that this step cannot name`);
    assert.deepEqual(result.calls, [], 'nothing is read');
    assert.match(result.summary, /^Qualification unobserved: .* could not be read \(/);
    assert.match(result.summary, cause);
    assert.match(result.summary, /after 0 reads over 15000 ms of waits/);
    assert.equal(result.output, 'outcome=unobserved\n');
    assert.equal(result.summary.includes('hold ceiling'), false);
    assert.equal(result.log.includes('::error::'), true);
  }
});

test('the opening observation read retries a 404 against the same id', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads: [notFoundError(), notFoundError(), notFoundError(), notFoundError(), runState('completed', 'success')],
  });
  assert.equal(result.code, 0);
  assert.equal(result.output, 'outcome=qualified\n');
  assert.equal(result.calls.length, 5, 'the four 404 answers are retried and the fifth read succeeds');
  assert.deepEqual(result.calls.map(args => args[1]), Array(5).fill(runPath),
    'every retry reads the same by-id path, nothing else');
  assert.deepEqual(result.waits, [1000, 2000, 4000, 8000], 'the waits are the schedule, in order');
  const retrying = result.log.split('\n').filter(line => line.includes('retrying'));
  assert.equal(retrying.length, 4, 'the fifth read logs no retry');
  retrying.forEach((line, index) => {
    assert.equal(line, `the by-id read of the dispatched qualification run ${createdUrl} answered 404`
      + ` on attempt ${index + 1}/5; retrying in ${[1000, 2000, 4000, 8000][index]} ms`);
  });
  assert.match(result.log, /is run 4242 \(read attempt 5\/5\)/);
  assert.equal(dispatchCalls(result.calls).length, 0, 'the observation never dispatches');
});

test('every read answering 404 records unobserved with the reads and the receipt', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created', SERVICE_COMMIT: serviceCommit },
    reads: [notFoundError()],
  });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, RUN_READ_ATTEMPTS, 'five bounded reads and no more');
  assert.deepEqual(result.calls.map(args => args[1]), Array(RUN_READ_ATTEMPTS).fill(runPath));
  assert.deepEqual(result.waits, [1000, 2000, 4000, 8000]);
  assert.equal(result.output, 'outcome=unobserved\n');
  assert.equal(result.summary, `Qualification unobserved: ${createdUrl} could not be read`
    + ` (every read answering 404) after 5 reads over ${waitsMs} ms of waits; dispatch receipt: created,`
    + ` so no qualification verdict was recorded for Service commit ${serviceCommit}.\n`);
  assert.equal(result.summary.includes('hold ceiling'), false, 'a read failure is not the ceiling');
  assert.equal(result.log.includes('::error::'), true);
  const retrying = result.log.split('\n').filter(line => line.includes('retrying'));
  assert.equal(retrying.length, 4, 'the retry is legible up to the bounded fifth read');
});

test('a read failure other than 404 records unobserved with the cause and no retry', async () => {
  for (const [message, pattern] of [['gh: HTTP 401 Bad credentials', /gh: HTTP 401 Bad credentials/],
    ['gh: HTTP 403 Forbidden', /gh: HTTP 403 Forbidden/],
    ['gh: HTTP 500 Internal Server Error', /gh: HTTP 500 Internal Server Error/],
    ['gh: HTTP 502 Bad Gateway', /gh: HTTP 502 Bad Gateway/]]) {
    const result = await observeEntry({
      env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'adopted' },
      reads: [new Error(message)],
    });
    assert.equal(result.code, 1, message);
    assert.equal(result.calls.length, 1, `${message}: one read, no retry`);
    assert.deepEqual(result.waits, [], `${message}: no wait is scheduled`);
    assert.equal(result.output, 'outcome=unobserved\n');
    assert.match(result.summary, /^Qualification unobserved: /);
    assert.match(result.summary, pattern);
    assert.match(result.summary, /after 1 reads over 15000 ms of waits; dispatch receipt: adopted,/);
    assert.match(result.summary, /no qualification verdict was recorded/);
    assert.equal(result.summary.includes('hold ceiling'), false);
  }
});

test('a 200 naming another run id records unobserved with id-mismatch and names both ids', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads: [{ id: 999, status: 'completed', conclusion: 'success', html_url: 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/999' }],
  });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1, 'an identity mismatch consumes no retry');
  assert.equal(result.output, 'outcome=unobserved\n');
  assert.match(result.summary, /could not be read \(the run API answered run 999, not run 4242\)/);
  assert.equal(result.summary.includes('concluded success'), false, 'the other run\'s verdict is never recorded');
});

test('a body that is not a run records unobserved with read-failed', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads: [null],
  });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 1, 'a malformed body consumes no retry');
  assert.equal(result.output, 'outcome=unobserved\n');
  assert.match(result.summary, /could not be read \(the read body is null\)/);
});

test('a terminal non-success run whose job list cannot be read still records its conclusion', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created', SERVICE_COMMIT: serviceCommit },
    reads: [runState('completed', 'failure')],
    jobs: new Error('gh: HTTP 502 Bad Gateway'),
  });
  assert.equal(result.code, 0, 'the conclusion stands and the deployment verdict is unchanged');
  assert.deepEqual(result.waits, []);
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.summary, `Qualification unqualified: ${createdUrl} concluded failure`
    + ` for Service commit ${serviceCommit}; failed job(s): none named`
    + ' (the job list could not be read: gh: HTTP 502 Bad Gateway).\n');
  assert.match(result.log, /^::warning::Qualification unqualified:/m, 'the unread job list is a warning');
});

test('a terminal non-success run records unqualified and exits zero', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads: [runState('completed', 'failure')],
    jobs: { jobs: [{ name: 'full', conclusion: 'failure' }, { name: 'record', conclusion: 'failure' }] },
  });
  assert.equal(result.code, 0, 'the deployment verdict stands: a red qualification is a red E2E run');
  assert.equal(result.summary, `Qualification unqualified: ${createdUrl} concluded failure`
    + '; failed job(s): full, record.\n');
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.log.includes('::warning::'), false);
});

test('a qualified run records qualified and exits zero', async () => {
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created', SERVICE_COMMIT: serviceCommit },
    reads: [runState('completed', 'success')],
  });
  assert.equal(result.code, 0);
  assert.equal(result.summary, `Qualification qualified: ${createdUrl} concluded success`
    + ` for Service commit ${serviceCommit}.\n`);
  assert.equal(result.output, 'outcome=qualified\n');
});

test('the ceiling keeps unqualified with a warning and exits zero', async () => {
  // The run was created 55 minutes before the observation starts, so the deadline
  // has already passed on the first read: no wait is needed to reach the ceiling.
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created', SERVICE_COMMIT: serviceCommit },
    reads: [runState('in_progress', null, { created_at: new Date(clockStart - HOLD_CEILING_MS).toISOString() })],
  });
  assert.equal(result.code, 0, 'the ceiling is a warning, not a failed deployment');
  assert.deepEqual(result.waits, [], 'the deadline had already passed, so nothing was waited');
  assert.match(result.log, /^::warning::Qualification unqualified:/m, 'the ceiling carries a ::warning');
  assert.equal(result.summary, `Qualification unqualified: ${createdUrl} had not reached a terminal state`
    + ` when the 55-minute hold ceiling was reached for Service commit ${serviceCommit}.\n`);
  assert.equal(result.output, 'outcome=unqualified\n');
});

test('an authentication failure inside the final interval records unobserved', async () => {
  const reads = [...Array(109).fill(runState('in_progress')), new Error('gh: HTTP 401 Bad credentials')];
  const result = await observeEntry({ env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads });
  assert.equal(result.code, 1, 'a token that failed inside the interval is a read failure, not the ceiling');
  assert.equal(result.output, 'outcome=unobserved\n');
  assert.match(result.summary, /could not be read \(gh: HTTP 401 Bad credentials\) after 1 reads over 15000 ms of waits/);
  assert.equal(result.summary.includes('hold ceiling'), false);
  assert.match(result.log, /^::error::Qualification unobserved:/m);
  assert.equal(result.waits.reduce((total, value) => total + value, 0), HOLD_CEILING_MS - 30_000,
    'the failure happened inside the last interval before the ceiling');
  assert.equal(result.calls.at(-1)[1], runPath);
});

test('the hold deadline is created_at plus the ceiling even when the opening read is retried', async () => {
  // The run was created 54 minutes and 30 seconds before the observation starts, so
  // only 30 seconds remain: the opening 404 does not move the bound.
  const createdAt = new Date(clockStart - (HOLD_CEILING_MS - 30_000)).toISOString();
  const result = await observeEntry({
    env: { QUALIFICATION_RUN_URL: createdUrl, QUALIFICATION_RECEIPT: 'created' },
    reads: [notFoundError(), runState('in_progress', null, { created_at: createdAt })],
  });
  assert.equal(result.code, 0, 'the ceiling is the hold\'s own bound');
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.summary.includes('hold ceiling was reached'), true);
  // The retried opening read consumed 1000 ms of the remaining 30 seconds; the
  // observation then waits exactly the rest, never past created_at + 55 minutes.
  assert.deepEqual(result.waits, [1000, 29_000]);
  assert.equal(result.waits.reduce((total, value) => total + value, 0), 30_000);
});
