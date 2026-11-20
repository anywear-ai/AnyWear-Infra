import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchArguments, dispatchQualification, FALLBACK_WAIT_MS, findDispatchedRun,
  HOLD_CEILING_MS, observeQualification, OBSERVATION_INTERVAL_MS, qualificationOutcomeLine,
  qualificationPayload, recordQualificationOutcome } from '../../scripts/qualification-dispatch.mjs';

// #226: the deploy chain's qualification hop. The payloads are the two rows of the
// design's E2E dispatch table; the pre-dispatch dedupe and the post-dispatch
// verification are what make a re-run dispatch nothing and a created run be
// confirmed by the id the dispatch response names, not by a title that can lag it.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/git-malu/AnyWear-Service/actions/runs/40123456789';
const key = 'https://github.com/git-malu/AnyWear-Infra/actions/runs/77';
const createdUrl = 'https://github.com/git-malu/AnyWear-E2E/actions/runs/4242';
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-runtime', INFRA_IDENTITY_PHASE: 'roles-added', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: `service-artifacts-${serviceCommit}`, SERVICE_COMMIT: serviceCommit,
  TESTER_EMAILS: '[]', DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '', GH_TOKEN: 'ghs_reviewed_token', ...overrides,
});
const dispatchEnv = (overrides = {}) => env(overrides);
// The receiving workflow's run name, as §7 defines it: the dispatch key is the
// `dispatched_by` half, so this is what the run list exposes as `display_title`.
const runName = (payload = { operation: 'full', trigger: 'deploy-qualify' }) =>
  `Beta qualification: ${payload.operation} · ${payload.trigger} · ${payload.operation === 'full' ? serviceCommit : '-'} · by ${key}`;

// A fake `gh` that answers the active-run listings, the dispatch POST and the
// post-dispatch run read. Every call is recorded, so the tests prove what was
// requested. `dispatchResponse` replaces the dispatch body — omit `workflow_run_id`
// to exercise the fallback; `dispatchError` makes the dispatch POST itself throw;
// `listSnapshots` answers each successive active-run lookup with one snapshot, so
// the pre-dispatch lookup is the first.
function fakeGh({ queued = [], in_progress = [], failingStatus, listSnapshots,
  dispatchResponse, dispatchError, created = { id: 4242, html_url: createdUrl } } = {}) {
  const calls = [];
  const output = [];
  let lookup;
  let lookups = 0;
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const path = args[1] === '--method' ? args[3] : args[1];
    if (args[1] === '--method') {
      if (dispatchError) throw dispatchError;
      const body = dispatchResponse ?? { workflow_run_id: 4242, run_url: `https://api.github.com${path}`, html_url: createdUrl };
      return { stdout: JSON.stringify(body), stderr: '' };
    }
    const status = /\?status=(queued|in_progress)/.exec(path);
    if (status) {
      if (failingStatus === status[1]) throw new Error('gh: HTTP 502 Bad Gateway');
      if (status[1] === 'queued' && listSnapshots) lookup = listSnapshots[Math.min(lookups++, listSnapshots.length - 1)];
      const runs = lookup ? lookup[status[1]] : (status[1] === 'queued' ? queued : in_progress);
      return { stdout: JSON.stringify({ workflow_runs: runs ?? [] }), stderr: '' };
    }
    const createdRun = /actions\/runs\/(\d+)$/.exec(path);
    if (createdRun) return { stdout: JSON.stringify(created), stderr: '' };
    throw new Error(`unexpected gh api ${path}`);
  };
  return { calls, run, out: { write: chunk => output.push(chunk) }, output: () => output.join('') };
}

const inputFields = args => args.reduce((fields, value) => {
  const match = /^inputs\[([a-z_]+)\]=(.+)$/.exec(value);
  if (match) fields[match[1]] = match[2];
  return fields;
}, {});

test('a merge dispatches full/deploy-qualify and a manual deployment dispatches smoke/deploy-smoke', () => {
  assert.deepEqual(qualificationPayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })), {
    operation: 'full', trigger: 'deploy-qualify', expected_service_commit: serviceCommit,
    worker_slot_offset: '0', dispatched_by: key,
  });
  const manual = qualificationPayload(dispatchEnv());
  assert.deepEqual(manual, { operation: 'smoke', trigger: 'deploy-smoke', worker_slot_offset: '0', dispatched_by: key });
  // The manual row carries no expected commits at all.
  assert.equal(Object.hasOwn(manual, 'expected_service_commit'), false);
  assert.equal(Object.hasOwn(manual, 'expected_client_commit'), false);
  // Only the operation that deploys a Runtime tuple dispatches.
  assert.throws(() => qualificationPayload(dispatchEnv({ INFRA_OPERATION: 'migrate' })),
    /Only deploy-runtime dispatches a qualification/);
  // The deploy payload requires the deployed commit; the preflight already proved
  // it, and the payload refuses to build without it.
  assert.throws(() => qualificationPayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy,
    SERVICE_COMMIT: undefined })), /deployed Service commit/);
});

test('the dispatch goes through the REST endpoint with return_run_details and prints the created run', async () => {
  const gh = fakeGh();
  const result = await dispatchQualification({ env: dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy }),
    run: gh.run, out: gh.out });
  assert.equal(result.dispatched, true);
  const post = gh.calls.find(args => args.includes('--method'));
  assert.ok(post, 'the dispatch is a POST');
  assert.equal(post[3], 'repos/anywear-ai/AnyWear-E2E/actions/workflows/beta-qualification.yml/dispatches');
  assert.equal(post[post.indexOf('return_run_details=true') - 1], '-F', 'the boolean uses the typed field flag');
  assert.equal(post[post.indexOf('ref=main') - 1], '-f');
  assert.deepEqual(inputFields(post), qualificationPayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })));
  // The dispatch response names the created run and that run is read back by id;
  // the printed line carries the URL the operator follows.
  assert.ok(gh.calls.some(args => args[1] === 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242'));
  assert.ok(gh.output().includes(createdUrl));
  assert.equal(result.run_url, createdUrl);
  assert.equal(result.run_id, 4242, 'the created run id is returned for the observation step');
});

test('a dispatch response naming the run id is verified by id, never by the run title', async () => {
  // The run object deliberately carries no `display_title`: the title is not read
  // on the by-id path, so a run whose title has not propagated still succeeds.
  const gh = fakeGh();
  const result = await dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out });
  assert.equal(result.dispatched, true);
  assert.equal(result.run_url, createdUrl);
  assert.equal(result.run_id, 4242);
  const postIndex = gh.calls.findIndex(args => args.includes('--method'));
  assert.ok(postIndex > -1, 'the qualification is dispatched');
  assert.equal(gh.calls.filter(args => args.includes('--method')).length, 1, 'the dispatch happens once');
  assert.equal(gh.calls.filter(args => args[1] === 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242').length, 1,
    'the created run is fetched exactly once, by the id the dispatch response named');
  assert.deepEqual(gh.calls.slice(postIndex + 1).filter(args => /\?status=/.test(String(args[1]))), [],
    'the active-run lookup is not consulted after the dispatch');
  // A foreign title is equally irrelevant: the hook does not compare titles.
  const foreign = fakeGh({ created: { id: 4242, display_title: 'Beta Qualification', html_url: createdUrl } });
  const ignored = await dispatchQualification({ env: dispatchEnv(), run: foreign.run, out: foreign.out });
  assert.equal(ignored.dispatched, true, 'a title that does not name this run does not fail the hook');
  assert.equal(ignored.run_url, createdUrl);
  assert.equal(ignored.run_id, 4242);
});

test('a re-run whose key is already in an active run name dispatches nothing', async () => {
  const existingUrl = 'https://github.com/git-malu/AnyWear-E2E/actions/runs/999';
  const gh = fakeGh({ queued: [{ id: 999, display_title: runName(), html_url: existingUrl }] });
  const result = await dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out });
  assert.equal(result.dispatched, false);
  assert.equal(result.run_url, existingUrl);
  assert.equal(result.run_id, 999, 'the skipped run is still the run the observation must read');
  assert.equal(gh.calls.some(args => args.includes('--method')), false, 'no dispatch when the key already exists');
  assert.ok(gh.output().includes(existingUrl), 'the skipped run URL is printed');
  // The in-progress list is part of the pre-dispatch read.
  assert.ok(gh.calls.some(args => String(args[1]).includes('status=in_progress')));
});

test('without a run id the hook polls the active-run list instead of reading it once', async () => {
  const matching = { id: 4242, display_title: runName(), html_url: createdUrl };
  const empty = { queued: [], in_progress: [] };
  // The pre-dispatch lookup and the first fallback attempt are empty; the second
  // fallback attempt carries the run the dispatch created.
  const gh = fakeGh({ dispatchResponse: {}, listSnapshots: [empty, empty, { queued: [matching], in_progress: [] }] });
  const waits = [];
  const result = await dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out,
    wait: async milliseconds => waits.push(milliseconds) });
  assert.equal(result.dispatched, true);
  assert.equal(result.run_url, createdUrl);
  assert.equal(result.run_id, 4242);
  const postIndex = gh.calls.findIndex(args => args.includes('--method'));
  const after = gh.calls.slice(postIndex + 1).filter(args => /\?status=/.test(String(args[1])));
  assert.equal(after.filter(args => String(args[1]).includes('status=queued')).length, 2,
    'the active-run list is consulted on each fallback attempt until the run appears');
  assert.equal(after.length, 4, 'each attempt lists both the queued and the in-progress runs');
  assert.deepEqual(waits, [FALLBACK_WAIT_MS], 'the injected wait runs between the two attempts');
});

test('the fallback fails only after its attempts are exhausted', async () => {
  const gh = fakeGh({ dispatchResponse: {} });
  const waits = [];
  await assert.rejects(dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out,
    attempts: 3, wait: async milliseconds => waits.push(milliseconds) }),
  /No active qualification run carried https:\/\/github\.com\/git-malu\/AnyWear-Infra\/actions\/runs\/77 after 3 attempts/);
  const postIndex = gh.calls.findIndex(args => args.includes('--method'));
  const lookups = gh.calls.slice(postIndex + 1).filter(args => String(args[1]).includes('status=queued'));
  assert.equal(lookups.length, 3, 'every attempt is made before the failure');
  assert.deepEqual(waits, [FALLBACK_WAIT_MS, FALLBACK_WAIT_MS], 'the wait runs between attempts, not after the last');
});

test('a failed run listing dispatches anyway and says so', async () => {
  const gh = fakeGh({ failingStatus: 'queued' });
  const result = await dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out });
  assert.equal(result.dispatched, true);
  assert.match(gh.output(), /dispatching anyway/);
  assert.ok(gh.calls.some(args => args.includes('--method')), 'the dispatch still happens');
});

test('the hook refuses a missing token, a release trigger and an unknown operation before any call', async () => {
  const gh = fakeGh();
  await assert.rejects(dispatchQualification({ env: dispatchEnv({ GH_TOKEN: '' }), run: gh.run, out: gh.out }),
    /write-scoped AnyWear-E2E App token/);
  await assert.rejects(dispatchQualification({ env: dispatchEnv({ DELIVERY_TRIGGER: 'release', DISPATCHED_BY: dispatchedBy }),
    run: gh.run, out: gh.out }), /delivery_trigger=release is refused/);
  await assert.rejects(dispatchQualification({ env: dispatchEnv({ INFRA_OPERATION: 'migrate', INFRA_IDENTITY_PHASE: 'retired' }),
    run: gh.run, out: gh.out }), /Only deploy-runtime dispatches a qualification/);
  assert.deepEqual(gh.calls, [], 'no GitHub or AWS call precedes the refusal');
});

test('the dispatch arguments carry exactly the payload inputs and the verbatim key', () => {
  const payload = qualificationPayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy }));
  const args = dispatchArguments(payload);
  assert.deepEqual(inputFields(args), payload);
  assert.equal(args.includes(`inputs[dispatched_by]=${dispatchedBy}`), false, 'the key is this run, not the upstream run');
  assert.ok(args.includes(`inputs[dispatched_by]=${key}`));
  // A run name only matches when it carries the whole key.
  assert.equal(findDispatchedRun([{ display_title: `by ${dispatchedBy}` }], key), undefined);
  assert.deepEqual(findDispatchedRun([{ display_title: runName(), html_url: createdUrl }], key).html_url, createdUrl);
});

// #338: the hold. The dispatched run is read to a terminal state on a fixed
// interval and never past `created_at + HOLD_CEILING_MS`; the outcome is exactly
// `qualified` or `unqualified`, the failed jobs are named only when the run is a
// non-success, and the recorder writes one summary line and the step output. The
// fake clock moves only when the injected wait does, so no test sleeps and the
// ceiling is proven arithmetically.
const clockStart = 1_700_000_000_000;
const runState = (status, conclusion = null, extra = {}) => ({ id: 4242, status, conclusion,
  html_url: createdUrl, created_at: new Date(clockStart).toISOString(), ...extra });

function observationGh({ reads, jobs = { jobs: [] } }) {
  const calls = [];
  let index = 0;
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const path = String(args[1]);
    if (path.endsWith('/jobs')) {
      if (jobs instanceof Error) throw jobs;
      return { stdout: JSON.stringify(jobs), stderr: '' };
    }
    assert.equal(path, 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
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

const sinkOf = () => {
  const chunks = [];
  return { out: { write: chunk => chunks.push(chunk) }, text: () => chunks.join('') };
};

const observe = async ({ reads, jobs, clock = observationClock(), runId, runUrl = createdUrl }) => {
  const gh = observationGh({ reads, jobs });
  const sink = sinkOf();
  const result = await observeQualification({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runId, runUrl });
  return { result, clock, gh, text: sink.text() };
};

const withOutputFiles = async body => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-qualification-'));
  try {
    return await body({ directory, summary: path.join(directory, 'summary.md'), output: path.join(directory, 'output') });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('the dispatch exposes the created run URL and id through GITHUB_OUTPUT', async () => {
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh();
    const result = await dispatchQualification({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out });
    assert.equal(result.run_id, 4242);
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\n`,
      'the workflow step receives exactly the two values the observation reads');
  });
  // The values are published before the read-back that verifies them, so a run the
  // dispatcher created but could not verify is still observed rather than misread as
  // "no run was created".
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh({ created: { id: 999 } });
    await assert.rejects(dispatchQualification({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out }),
      /was not returned by id/);
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\n`);
  });
});

// Issue #338's acceptance: "all four outcomes: ... a thrown error when the dispatch
// itself fails". The design's edge-case row is "the dispatch fails → records
// `unqualified` naming the dispatch failure as the reason no qualification exists".
// The POST throws, so nothing after it may run — no read-back of a created run and
// no fallback listing — and `$GITHUB_OUTPUT` stays a real but empty file, which is
// exactly the condition `scripts/qualification-observe.mjs` maps to `unqualified`
// naming the dispatch failure.
test('a failed dispatch throws before any run read and publishes no run', async () => {
  await withOutputFiles(async ({ output }) => {
    await writeFile(output, '');
    const gh = fakeGh({ dispatchError: new Error('gh: HTTP 422 Unprocessable Entity') });
    await assert.rejects(
      dispatchQualification({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out }),
      /gh: HTTP 422 Unprocessable Entity/);
    const postIndex = gh.calls.findIndex(args => args.includes('--method'));
    assert.ok(postIndex > -1, 'the dispatch POST is the failing call');
    assert.equal(gh.calls.filter(args => args.includes('--method')).length, 1, 'the dispatch is attempted once');
    assert.deepEqual(gh.calls.slice(postIndex + 1), [],
      'nothing follows the failed dispatch: no created-run read and no fallback listing');
    assert.equal(await readFile(output, 'utf8'), '',
      'no run id or URL is published, so the recorder records the dispatch failure');
  });
});

test('a success run is qualified at its first terminal read and polling stops there', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('in_progress'), runState('completed', 'success')] });
  const sink = sinkOf();
  // No run id is passed: the trailing `/runs/<id>` of the dispatched URL is enough.
  const result = await observeQualification({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runUrl: createdUrl });
  assert.deepEqual({ outcome: result.outcome, run_url: result.run_url, conclusion: result.conclusion,
    failed_jobs: result.failed_jobs }, { outcome: 'qualified', run_url: createdUrl, conclusion: 'success', failed_jobs: [] });
  assert.deepEqual(clock.waits, [OBSERVATION_INTERVAL_MS], 'one interval between the two reads');
  assert.equal(gh.calls.length, 2, 'the terminal read is the last read');
  assert.equal(gh.calls.some(args => String(args[1]).endsWith('/jobs')), false,
    'a successful run names no failed jobs and reads no job list');
});

test('a failure run is unqualified with the names of the jobs that were neither success nor skipped', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('completed', 'failure')], jobs: { jobs: [
    { name: 'preflight', conclusion: 'success' },
    { name: 'reconcile', conclusion: 'skipped' },
    { name: 'full', conclusion: 'failure' },
    { name: 'record', conclusion: 'failure' },
  ] } });
  const sink = sinkOf();
  const result = await observeQualification({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runId: 4242 });
  assert.equal(result.outcome, 'unqualified');
  assert.equal(result.conclusion, 'failure');
  assert.deepEqual(result.failed_jobs, ['full', 'record'], 'API order, and skipped is not a failure');
  assert.equal(clock.waits.length, 0, 'a run that is already terminal needs no wait');
  assert.equal(gh.calls.filter(args => String(args[1]).endsWith('/jobs')).length, 1);
});

test('a cancelled or timed-out run is unqualified', async () => {
  for (const conclusion of ['cancelled', 'timed_out']) {
    const { result } = await observe({ reads: [runState('completed', conclusion)] });
    assert.equal(result.outcome, 'unqualified', conclusion);
    assert.equal(result.conclusion, conclusion);
    assert.deepEqual(result.failed_jobs, []);
  }
});

test('the ceiling returns unqualified without waiting past the deadline', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('in_progress')] });
  const sink = sinkOf();
  const result = await observeQualification({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runId: 4242 });
  assert.equal(result.outcome, 'unqualified');
  assert.equal(result.ceiling, true, 'the recorder writes a warning, never an error');
  assert.match(result.reason, /the 55-minute hold ceiling was reached/);
  assert.equal(clock.waits.reduce((total, value) => total + value, 0), HOLD_CEILING_MS,
    'the wait sums to exactly the ceiling, never past it');
  assert.ok(clock.waits.every(milliseconds => milliseconds <= OBSERVATION_INTERVAL_MS),
    'no single wait is longer than the interval');
  assert.equal(gh.calls.length, clock.waits.length + 1, 'one read per interval plus the first');
});

test('an authentication failure inside the final interval is recorded as the ceiling', async () => {
  const authentication = new Error('gh: HTTP 401 Bad credentials');
  const reads = [...Array(109).fill(runState('in_progress')), authentication];
  const clock = observationClock();
  const { result, gh } = await observe({ reads, clock });
  assert.equal(result.outcome, 'unqualified');
  assert.equal(result.ceiling, true, 'a token that outlived its margin must not turn a named state red');
  assert.match(result.reason, /final read failed: gh: HTTP 401 Bad credentials/);
  assert.equal(clock.waits.reduce((total, value) => total + value, 0), HOLD_CEILING_MS - OBSERVATION_INTERVAL_MS,
    'the failure happened inside the last interval before the ceiling');
  assert.equal(gh.calls.at(-1)[1], 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
});

test('a read failure is an observation failure unless it is authentication near the ceiling', async () => {
  await assert.rejects(observe({ reads: [new Error('gh: HTTP 401 Bad credentials')] }),
    /could not be read: gh: HTTP 401 Bad credentials/);
  await assert.rejects(observe({ reads: [runState('in_progress'), new Error('gh: HTTP 502 Bad Gateway')] }),
    /could not be read: gh: HTTP 502 Bad Gateway/);
});

test('a non-success run whose job list cannot be read fails the observation instead of guessing', async () => {
  await assert.rejects(observe({ reads: [runState('completed', 'failure')], jobs: new Error('gh: HTTP 502 Bad Gateway') }),
    /concluded non-success but its jobs could not be read: gh: HTTP 502/);
});

test('the one outcome line names the run, the conclusion and the failed jobs, or the reason none ran', async () => {
  assert.equal(qualificationOutcomeLine({ outcome: 'qualified', run_url: createdUrl, conclusion: 'success' }),
    `Qualification qualified: ${createdUrl} concluded success.`);
  assert.equal(qualificationOutcomeLine({ outcome: 'unqualified', run_url: createdUrl, conclusion: 'failure',
    failed_jobs: ['full', 'record'] }),
  `Qualification unqualified: ${createdUrl} concluded failure; failed job(s): full, record.`);
  assert.equal(qualificationOutcomeLine({ outcome: 'unqualified', run_url: createdUrl, conclusion: null,
    failed_jobs: [], ceiling: true, ceiling_ms: HOLD_CEILING_MS }),
  `Qualification unqualified: ${createdUrl} had not reached a terminal state when the 55-minute hold ceiling was reached.`);
  assert.equal(qualificationOutcomeLine({ outcome: 'unqualified', service_commit: serviceCommit,
    reason: 'no qualification run was created and no dispatched run id or URL was recorded, so the deployed tuple carries no qualification record' }),
  `Qualification unqualified: no qualification run was created and no dispatched run id or URL was recorded, so the deployed `
    + `tuple carries no qualification record for Service commit ${serviceCommit}.`);
});

// F1: the line states only an observed cause. A known run whose read failed has no
// conclusion and no ceiling, so it carries the recorded reason and never the ceiling
// sentence; the ceiling wording appears only when `ceiling === true`.
test('a read failure is reported as itself, never as the hold ceiling', async () => {
  const reason = `the dispatched qualification ${createdUrl} could not be read, so the deployed tuple carries no `
    + 'qualification record: gh: HTTP 401 Bad credentials';
  const line = qualificationOutcomeLine({ outcome: 'unqualified', run_url: createdUrl, conclusion: null, reason,
    service_commit: serviceCommit });
  assert.ok(line.includes('gh: HTTP 401 Bad credentials'), 'the real read cause is in the line');
  assert.ok(line.includes(createdUrl), 'the line still names the run');
  assert.ok(line.includes('could not be read'), 'the reason is carried verbatim');
  assert.equal(line.includes('hold ceiling'), false, 'an unobserved ceiling is never invented');
  const noRun = qualificationOutcomeLine({ outcome: 'unqualified', reason: 'the observation could not record a cause' });
  assert.equal(noRun, 'Qualification unqualified: the observation could not record a cause.');
});

test('the recorder writes exactly one summary line, the step outcome and a warning only for the ceiling', async () => {
  await withOutputFiles(async ({ summary, output }) => {
    const sink = sinkOf();
    const unqualified = { outcome: 'unqualified', run_url: createdUrl, conclusion: 'failure',
      failed_jobs: ['full', 'record'], service_commit: serviceCommit };
    const line = await recordQualificationOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: unqualified, out: sink.out });
    assert.equal(await readFile(summary, 'utf8'), `${line}\n`, 'exactly one outcome line');
    assert.equal(await readFile(output, 'utf8'), 'outcome=unqualified\n');
    assert.match(line, new RegExp(`^Qualification unqualified: ${createdUrl.replaceAll('/', '\\/')} concluded failure`));
    assert.equal(sink.text(), `${line}\n`, 'a terminal non-success is not an error annotation');

    const warn = sinkOf();
    const ceilingLine = await recordQualificationOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: { outcome: 'unqualified', run_url: createdUrl, conclusion: null, failed_jobs: [], ceiling: true },
      out: warn.out });
    assert.equal(warn.text(), `::warning::${ceilingLine}\n`, 'the ceiling carries a ::warning');
    assert.equal(await readFile(summary, 'utf8'), `${line}\n${ceilingLine}\n`,
      'the ceiling appends one more line, never a second line for the same outcome');
    assert.equal(await readFile(output, 'utf8'), 'outcome=unqualified\noutcome=unqualified\n');
  });
});
