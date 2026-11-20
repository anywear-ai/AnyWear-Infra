import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOLD_CEILING_MS } from '../../scripts/qualification-dispatch.mjs';
import { runQualificationObservation } from '../../scripts/qualification-observe.mjs';

// #338: the hold recorder's exit codes. Nothing else imports
// `scripts/qualification-observe.mjs`, so without this file an inverted 0/1 would
// leave every other test green. The entry is the one place that maps the observed
// state to the job's conclusion:
//
//   no recorded run                          -> outcome unqualified, exit 0 (the job is red elsewhere)
//   dispatched run unreadable                -> outcome unqualified, exit 1
//   terminal non-success / ceiling / success -> one outcome, exit 0
//
// Every case writes real `$GITHUB_STEP_SUMMARY` and `$GITHUB_OUTPUT` files and moves
// its clock only through the injected wait, so no test sleeps.
const clockStart = 1_700_000_000_000;
const createdUrl = 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/4242';
const serviceCommit = 'b'.repeat(40);
const runState = (status, conclusion = null, extra = {}) => ({ id: 4242, status, conclusion, html_url: createdUrl,
  created_at: new Date(clockStart).toISOString(), ...extra });

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
    assert.equal(requestPath, 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
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
      env: { ...env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      run: gh.run, wait: clock.wait, now: clock.now, out: { write: chunk => chunks.push(chunk) },
    });
    return { code, calls: gh.calls, waits: clock.waits, log: chunks.join(''),
      summary: await readFile(summary, 'utf8'), output: await readFile(output, 'utf8') };
  });
}

test('no recorded run exits zero and says that no qualification run was created', async () => {
  const result = await observeEntry({ env: { GH_TOKEN: 'ghs_read_only', SERVICE_COMMIT: serviceCommit } });
  assert.equal(result.code, 0, 'the recorder does not add a failure to a job that is already red elsewhere');
  assert.deepEqual(result.calls, [], 'nothing is read when the job recorded no dispatched run');
  assert.match(result.summary,
    /^Qualification unqualified: no qualification run was created and no dispatched run id or URL was recorded/);
  assert.ok(result.summary.includes(`for Service commit ${serviceCommit}.`));
  assert.equal(result.summary.includes('hold ceiling'), false, 'no cause is invented');
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.log.includes('::warning::'), false);
});

test('a dispatched run that cannot be read exits non-zero with the read cause, not the ceiling', async () => {
  const result = await observeEntry({
    env: { GH_TOKEN: 'ghs_read_only', QUALIFICATION_RUN_URL: createdUrl, SERVICE_COMMIT: serviceCommit },
    reads: [new Error('gh: HTTP 401 Bad credentials')],
  });
  assert.equal(result.code, 1, 'an unknown hold is never recorded as a good one');
  assert.ok(result.summary.includes('gh: HTTP 401 Bad credentials'), 'the real read cause is recorded');
  assert.ok(result.summary.includes(createdUrl), 'the unread run is named');
  assert.equal(result.summary.includes('hold ceiling'), false, 'the ceiling is not the cause of a read failure');
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.match(result.log, /^Qualification unqualified:/m);
  assert.equal(result.log.includes('::warning::'), false);
});

test('a non-success run whose job list cannot be read exits non-zero and names the read cause', async () => {
  const result = await observeEntry({
    env: { GH_TOKEN: 'ghs_read_only', QUALIFICATION_RUN_URL: createdUrl },
    reads: [runState('completed', 'failure')],
    jobs: new Error('gh: HTTP 502 Bad Gateway'),
  });
  assert.equal(result.code, 1);
  assert.ok(result.summary.includes('concluded non-success but its jobs could not be read'), 'the unread diagnosis is named');
  assert.ok(result.summary.includes('gh: HTTP 502 Bad Gateway'));
  assert.equal(result.summary.includes('hold ceiling'), false);
  assert.equal(result.output, 'outcome=unqualified\n');
});

test('a terminal non-success run records unqualified and exits zero', async () => {
  const result = await observeEntry({
    env: { GH_TOKEN: 'ghs_read_only', QUALIFICATION_RUN_URL: createdUrl },
    reads: [runState('completed', 'failure')],
    jobs: { jobs: [{ name: 'full', conclusion: 'failure' }, { name: 'record', conclusion: 'failure' }] },
  });
  assert.equal(result.code, 0, 'the deployment verdict stands: a red qualification is a red E2E run');
  assert.match(result.summary, /Qualification unqualified: https:\/\/github\.com\/anywear-ai\/AnyWear-E2E\/actions\/runs\/4242 concluded failure/);
  assert.match(result.summary, /failed job\(s\): full, record/);
  assert.equal(result.output, 'outcome=unqualified\n');
  assert.equal(result.log.includes('::warning::'), false);
});

test('a qualified run records qualified and exits zero', async () => {
  const result = await observeEntry({
    env: { GH_TOKEN: 'ghs_read_only', QUALIFICATION_RUN_URL: createdUrl },
    reads: [runState('completed', 'success')],
  });
  assert.equal(result.code, 0);
  assert.match(result.summary, /Qualification qualified: https:\/\/github\.com\/anywear-ai\/AnyWear-E2E\/actions\/runs\/4242 concluded success/);
  assert.equal(result.output, 'outcome=qualified\n');
});

test('the ceiling records unqualified with a warning annotation and exits zero', async () => {
  // The run was created 55 minutes before the observation starts, so the deadline
  // has already passed on the first read: no wait is needed to reach the ceiling.
  const result = await observeEntry({
    env: { GH_TOKEN: 'ghs_read_only', QUALIFICATION_RUN_URL: createdUrl },
    reads: [runState('in_progress', null, { created_at: new Date(clockStart - HOLD_CEILING_MS).toISOString() })],
  });
  assert.equal(result.code, 0, 'the ceiling is a warning, not a failed deployment');
  assert.deepEqual(result.waits, [], 'the deadline had already passed, so nothing was waited');
  assert.match(result.log, /^::warning::Qualification unqualified:/m, 'the ceiling carries a ::warning');
  assert.match(result.summary, /had not reached a terminal state when the 55-minute hold ceiling was reached/);
  assert.equal(result.output, 'outcome=unqualified\n');
});
