import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchArguments, dispatchGateRun, FALLBACK_WAIT_MS, findDispatchedRun,
  HOLD_CEILING_MS, observeGateRun, OBSERVATION_INTERVAL_MS, gateOutcomeLine,
  gatePayload, recordGateOutcome, RUN_READ_ATTEMPTS, runReadWaits,
  RUN_READ_WAIT_MS } from '../../scripts/e2e-dispatch.mjs';

// #226: the deploy chain's qualification hop. The payloads are the two rows of the
// design's E2E dispatch table; the pre-dispatch dedupe and the post-dispatch
// verification are what make a re-run dispatch nothing and a created run be
// confirmed by the id the dispatch response names, not by a title that can lag it.
const serviceCommit = 'b'.repeat(40);
const dispatchedBy = 'https://github.com/git-malu/AnyWear-Service/actions/runs/40123456789';
const clientDispatchedBy = 'https://github.com/git-malu/AnyWear-Client/actions/runs/40123456790';
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
const runName = (payload = { operation: 'full', trigger: 'deploy-gate' }) =>
  `Beta qualification: ${payload.operation} · ${payload.trigger} · ${payload.operation === 'full' ? serviceCommit : '-'} · by ${key}`;

// A fake `gh` that answers the active-run listings, the dispatch POST and the
// post-dispatch run read. Every call is recorded, so the tests prove what was
// requested. `dispatchResponse` replaces the dispatch body — omit `workflow_run_id`
// to exercise the fallback; `dispatchError` makes the dispatch POST itself throw;
// `listSnapshots` answers each successive active-run lookup with one snapshot, so
// the pre-dispatch lookup is the first; `reads` answers the by-id read from a result
// sequence instead, whose entries are run bodies or `Error`s that are thrown, and
// whose last entry repeats.
function fakeGh({ queued = [], in_progress = [], failingStatus, listSnapshots,
  dispatchResponse, dispatchError, created = { id: 4242, html_url: createdUrl }, reads } = {}) {
  const calls = [];
  const output = [];
  let lookup;
  let lookups = 0;
  let readIndex = 0;
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
    if (createdRun) {
      if (reads) {
        const entry = reads[Math.min(readIndex++, reads.length - 1)];
        if (entry instanceof Error) throw entry;
        return { stdout: JSON.stringify(entry), stderr: '' };
      }
      return { stdout: JSON.stringify(created), stderr: '' };
    }
    throw new Error(`unexpected gh api ${path}`);
  };
  return { calls, run, out: { write: chunk => output.push(chunk) }, output: () => output.join('') };
}

const inputFields = args => args.reduce((fields, value) => {
  const match = /^inputs\[([a-z_]+)\]=(.+)$/.exec(value);
  if (match) fields[match[1]] = match[2];
  return fields;
}, {});

test('a merge dispatches full/deploy-gate and a manual deployment dispatches smoke/deploy-smoke', () => {
  assert.deepEqual(gatePayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })), {
    operation: 'full', trigger: 'deploy-gate', expected_service_commit: serviceCommit,
    worker_slot_offset: '0', dispatched_by: key,
  });
  const manual = gatePayload(dispatchEnv());
  assert.deepEqual(manual, { operation: 'smoke', trigger: 'deploy-smoke', worker_slot_offset: '0', dispatched_by: key });
  // The manual row carries no expected commits at all.
  assert.equal(Object.hasOwn(manual, 'expected_service_commit'), false);
  assert.equal(Object.hasOwn(manual, 'expected_client_commit'), false);
  // Only the two operations that carry chain context dispatch.
  assert.throws(() => gatePayload(dispatchEnv({ INFRA_OPERATION: 'migrate', DELIVERY_TRIGGER: 'manual' })),
    /Only deploy-runtime and publish-client dispatches a gate run/);
  // The deploy payload requires the deployed commit; the preflight already proved
  // it, and the payload refuses to build without it.
  assert.throws(() => gatePayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy,
    SERVICE_COMMIT: undefined })), /deployed Service commit/);
});

// #344: the Client publication dispatches the post-publication `smoke` inside its
// held run. It is the manual Runtime deployment's row — `smoke`/`deploy-smoke`, no
// expected commits — and it requires the publication chain's own event.
test('a Client publication dispatches smoke/deploy-smoke and nothing else', () => {
  const publishEnv = overrides => dispatchEnv({ INFRA_OPERATION: 'publish-client', DELIVERY_TRIGGER: 'publish',
    DISPATCHED_BY: clientDispatchedBy, SERVICE_COMMIT: '', SERVICE_ARTIFACT_TAG: '',
    CLIENT_RUN_ID: '40123456789', CLIENT_RUN_ATTEMPT: '2', CLIENT_BUNDLE_DIGEST: 'd'.repeat(64), ...overrides });
  const payload = gatePayload(publishEnv());
  assert.deepEqual(payload, { operation: 'smoke', trigger: 'deploy-smoke', worker_slot_offset: '0', dispatched_by: key });
  assert.equal(Object.hasOwn(payload, 'expected_service_commit'), false,
    'a publication seals no qualification record, so it names no expected commit');
  // A manual publication keeps the same no-wait shape.
  assert.deepEqual(gatePayload(publishEnv({ DELIVERY_TRIGGER: 'manual', DISPATCHED_BY: '' })), payload);
  // The deploy chain's event belongs to the Runtime deployment, not to a publication.
  assert.throws(() => gatePayload(publishEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })),
    /publish-client requires delivery_trigger=publish or manual/);
  assert.throws(() => gatePayload(publishEnv({ DELIVERY_TRIGGER: 'release' })),
    /delivery_trigger=release is refused/);
  // The dispatch is the same REST call with this run's URL as the key.
  const args = dispatchArguments(payload);
  assert.deepEqual(inputFields(args), payload);
  assert.ok(args.includes(`inputs[dispatched_by]=${key}`));
});

test('the dispatch goes through the REST endpoint with return_run_details and prints the created run', async () => {
  const gh = fakeGh();
  const result = await dispatchGateRun({ env: dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy }),
    run: gh.run, out: gh.out });
  assert.equal(result.dispatched, true);
  const post = gh.calls.find(args => args.includes('--method'));
  assert.ok(post, 'the dispatch is a POST');
  assert.equal(post[3], 'repos/anywear-ai/AnyWear-E2E/actions/workflows/beta-e2e.yml/dispatches');
  assert.equal(post[post.indexOf('return_run_details=true') - 1], '-F', 'the boolean uses the typed field flag');
  assert.equal(post[post.indexOf('ref=main') - 1], '-f');
  assert.deepEqual(inputFields(post), gatePayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })));
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
  const result = await dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out });
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
  const foreign = fakeGh({ created: { id: 4242, display_title: 'Some Foreign Run', html_url: createdUrl } });
  const ignored = await dispatchGateRun({ env: dispatchEnv(), run: foreign.run, out: foreign.out });
  assert.equal(ignored.dispatched, true, 'a title that does not name this run does not fail the hook');
  assert.equal(ignored.run_url, createdUrl);
  assert.equal(ignored.run_id, 4242);
});

test('a re-run whose key is already in an active run name dispatches nothing', async () => {
  const existingUrl = 'https://github.com/git-malu/AnyWear-E2E/actions/runs/999';
  const gh = fakeGh({ queued: [{ id: 999, display_title: runName(), html_url: existingUrl }] });
  const result = await dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out });
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
  const result = await dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out,
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
  await assert.rejects(dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out,
    attempts: 3, wait: async milliseconds => waits.push(milliseconds) }),
  /No active gate run carried https:\/\/github\.com\/git-malu\/AnyWear-Infra\/actions\/runs\/77 after 3 attempts/);
  const postIndex = gh.calls.findIndex(args => args.includes('--method'));
  const lookups = gh.calls.slice(postIndex + 1).filter(args => String(args[1]).includes('status=queued'));
  assert.equal(lookups.length, 3, 'every attempt is made before the failure');
  assert.deepEqual(waits, [FALLBACK_WAIT_MS, FALLBACK_WAIT_MS], 'the wait runs between attempts, not after the last');
});

test('a failed run listing dispatches anyway and says so', async () => {
  const gh = fakeGh({ failingStatus: 'queued' });
  const result = await dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out });
  assert.equal(result.dispatched, true);
  assert.match(gh.output(), /dispatching anyway/);
  assert.ok(gh.calls.some(args => args.includes('--method')), 'the dispatch still happens');
});

test('the hook refuses a missing token, a release trigger and an unknown operation before any call', async () => {
  const gh = fakeGh();
  await assert.rejects(dispatchGateRun({ env: dispatchEnv({ GH_TOKEN: '' }), run: gh.run, out: gh.out }),
    /write-scoped AnyWear-E2E App token/);
  await assert.rejects(dispatchGateRun({ env: dispatchEnv({ DELIVERY_TRIGGER: 'release', DISPATCHED_BY: dispatchedBy }),
    run: gh.run, out: gh.out }), /delivery_trigger=release is refused/);
  await assert.rejects(dispatchGateRun({ env: dispatchEnv({ INFRA_OPERATION: 'migrate', INFRA_IDENTITY_PHASE: 'retired' }),
    run: gh.run, out: gh.out }), /Only deploy-runtime and publish-client dispatches a gate run/);
  assert.deepEqual(gh.calls, [], 'no GitHub or AWS call precedes the refusal');
});

test('the dispatch arguments carry exactly the payload inputs and the verbatim key', () => {
  const payload = gatePayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy }));
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
// `passed`, `failed` or `unobserved` — the failed jobs are named only when
// the run is a non-success, a run that cannot be read is `unobserved` rather than a
// verdict, and the recorder writes one summary line and the step output. The
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
  const result = await observeGateRun({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
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

test('the dispatch exposes the created run URL, id and receipt through GITHUB_OUTPUT', async () => {
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh();
    const result = await dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out });
    assert.equal(result.run_id, 4242);
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\nreceipt=created\n`,
      'the workflow step receives exactly the values the observation reads');
  });
  // The values are published before the read-back that verifies them, so a run the
  // dispatcher created but could not verify is still observed rather than misread as
  // "no run was created".
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh({ created: { id: 999 } });
    await assert.rejects(dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out }),
      /was not returned by id/);
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\nreceipt=created\n`);
  });
});

// #342: the by-id read of the run the dispatch created. GitHub answers `404` for a
// run it has already created, and after a `queue: max` overflow it answers with a
// run it has already cancelled under the same id. So only the `404` is retried,
// against the same id, and a terminal non-success run fails the hand-off; the
// dispatch itself is sent exactly once on every path.
const notFoundError = () => {
  const error = new Error('Command failed: gh api repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
  error.stdout = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/actions/workflow-runs","status":"404"}';
  return error;
};
const rejectionOf = promise => promise.then(() => undefined, error => error);
const byIdReads = gh => gh.calls.filter(args => args[1] === 'repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
const dispatchPosts = gh => gh.calls.filter(args => args.includes('--method'));

test('a first read that answers 404 is retried against the same id and succeeds', async () => {
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh({ reads: [notFoundError(), { id: 4242, html_url: createdUrl }] });
    const waits = [];
    const result = await dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out,
      wait: async milliseconds => waits.push(milliseconds) });
    assert.equal(result.dispatched, true);
    assert.equal(result.run_id, 4242);
    assert.equal(result.run_url, createdUrl);
    assert.equal(byIdReads(gh).length, 2, 'the retry reads the same id, and only that id');
    assert.equal(dispatchPosts(gh).length, 1, 'the dispatch is not sent a second time');
    assert.deepEqual(waits, [1000], 'the wait after the first read is the first entry of the schedule');
    assert.match(gh.output(), /read attempt 2\/5/);
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\nreceipt=created\n`);
  });
});

test('every read answering 404 fails after the bounded attempts, dispatching once', async () => {
  const gh = fakeGh({ reads: [notFoundError()] });
  const waits = [];
  const failure = await rejectionOf(dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out,
    wait: async milliseconds => waits.push(milliseconds) }));
  assert.ok(failure instanceof Error, 'the exhausted reads fail the dispatch');
  assert.ok(failure.message.includes(createdUrl), 'the failure names the run');
  assert.match(failure.message, /was not readable after 5 reads over 15000 ms, every read answering 404/);
  assert.equal(byIdReads(gh).length, 5, 'five reads and no more, all of the same id');
  assert.deepEqual(waits, [1000, 2000, 4000, 8000], 'the waits are the schedule, in order');
  assert.equal(dispatchPosts(gh).length, 1, 'the dispatch is accepted once and never repeated');
  const retrying = gh.output().split('\n').filter(line => line.includes('retrying'));
  assert.equal(retrying.length, 4, 'a retry is logged after each of the first four reads, never after the fifth');
  assert.ok(retrying[3].includes('on attempt 4/5'));
  assert.equal(retrying.some(line => line.includes('on attempt 5/5')), false, 'the fifth read logs no retry');
  // The schedule is pinned as literals rather than through its own exports' semantics.
  assert.equal(RUN_READ_ATTEMPTS, 5);
  assert.equal(RUN_READ_WAIT_MS, 1000);
  assert.deepEqual(runReadWaits(), [1000, 2000, 4000, 8000]);
  assert.equal(runReadWaits().length, 4);
  assert.equal(runReadWaits().reduce((total, value) => total + value, 0), 15000);
  assert.ok(runReadWaits().every(milliseconds => milliseconds <= 8000), 'no wait exceeds 8000 ms');
});

test('a non-404 read failure is not retried', async () => {
  const gateway = new Error('gh: HTTP 502 Bad Gateway');
  gateway.stderr = 'gh: HTTP 502 Bad Gateway\n';
  const gh = fakeGh({ reads: [gateway] });
  const waits = [];
  const failure = await rejectionOf(dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out,
    wait: async milliseconds => waits.push(milliseconds) }));
  assert.ok(failure instanceof Error, 'the read failure fails the dispatch');
  assert.ok(failure.message.includes(createdUrl), 'the failure names the run');
  assert.ok(failure.message.includes('HTTP 502'), 'the underlying status is carried verbatim');
  assert.equal(byIdReads(gh).length, 1, 'a non-404 read failure is terminal');
  assert.equal(dispatchPosts(gh).length, 1);
  assert.equal(gh.output().includes('retrying'), false, 'a terminal read failure schedules no retry');
  assert.deepEqual(waits, []);
});

test('a run already terminal with a non-success conclusion fails the hand-off without a retry', async () => {
  const gh = fakeGh({ reads: [{ id: 4242, status: 'completed', conclusion: 'cancelled' }] });
  const failure = await rejectionOf(dispatchGateRun({ env: dispatchEnv(), run: gh.run, out: gh.out }));
  assert.ok(failure instanceof Error, 'a run cancelled under the same id fails the hand-off');
  assert.ok(failure.message.includes(createdUrl), 'the failure names the run');
  assert.match(failure.message, /had already completed with conclusion cancelled/);
  assert.equal(byIdReads(gh).length, 1, 'a terminal run is not read again');
  assert.equal(dispatchPosts(gh).length, 1, 'the dispatch is never repeated');
});

// Issue #338's acceptance: "all four outcomes: ... a thrown error when the dispatch
// itself fails". A `422` proves the request was refused, so the receipt is
// `not_submitted`: nothing after the POST may run — no read-back of a created run
// and no fallback listing — and `$GITHUB_OUTPUT` carries only that receipt, which
// `scripts/e2e-observe.mjs` maps to `failed` naming it.
test('a refused dispatch throws before any run read and publishes only the receipt', async () => {
  await withOutputFiles(async ({ output }) => {
    await writeFile(output, '');
    const gh = fakeGh({ dispatchError: new Error('gh: HTTP 422 Unprocessable Entity') });
    await assert.rejects(
      dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out }),
      /gh: HTTP 422 Unprocessable Entity/);
    const postIndex = gh.calls.findIndex(args => args.includes('--method'));
    assert.ok(postIndex > -1, 'the dispatch POST is the failing call');
    assert.equal(gh.calls.filter(args => args.includes('--method')).length, 1, 'the dispatch is attempted once');
    assert.deepEqual(gh.calls.slice(postIndex + 1), [],
      'nothing follows the failed dispatch: no created-run read and no fallback listing');
    assert.equal(await readFile(output, 'utf8'), 'receipt=not_submitted\n',
      'the refusal is published as the receipt, and no run is named');
  });
});

// The receipt says what the dispatch step can prove: a `5xx` or a timeout may have
// been accepted before it broke, so it is `acceptance_unknown`, never `not_submitted`.
test('a dispatch failure that may have been accepted records acceptance_unknown', async () => {
  for (const dispatchError of [new Error('gh: HTTP 502 Bad Gateway'),
    Object.assign(new Error('Command failed: gh api repos/anywear-ai/AnyWear-E2E/actions/workflows/beta-e2e.yml/dispatches'),
      { killed: true, signal: 'SIGTERM' })]) {
    await withOutputFiles(async ({ output }) => {
      const gh = fakeGh({ dispatchError });
      await assert.rejects(dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output }), run: gh.run, out: gh.out }),
        /HTTP 502|Command failed/);
      assert.equal(await readFile(output, 'utf8'), 'receipt=acceptance_unknown\n',
        'a failure that may have been accepted names no run and no refusal');
    });
  }
});

test('a payload failure publishes not_submitted before the dispatch runs', async () => {
  await withOutputFiles(async ({ output }) => {
    const gh = fakeGh();
    await assert.rejects(dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output,
      DELIVERY_TRIGGER: 'release', DISPATCHED_BY: dispatchedBy }), run: gh.run, out: gh.out }),
    /delivery_trigger=release is refused/);
    assert.deepEqual(gh.calls, [], 'the payload is built before any request');
    assert.equal(await readFile(output, 'utf8'), 'receipt=not_submitted\n',
      'the recorder reads a refusal, not an unknown dispatch');
  });
});

// #354: `validateOperationInputs` runs before the payload is built, so a refused
// identity phase is equally a pre-request failure and must read `not_submitted`.
test('a validation failure before the payload publishes not_submitted', async () => {
  await withOutputFiles(async ({ output }) => {
    await writeFile(output, '');
    const gh = fakeGh();
    await assert.rejects(dispatchGateRun({ env: dispatchEnv({ GITHUB_OUTPUT: output,
      INFRA_IDENTITY_PHASE: 'invalid' }), run: gh.run, out: gh.out }),
    /Explicit identity phase required/);
    assert.deepEqual(gh.calls, [], 'no GitHub call precedes the validation refusal');
    assert.equal(await readFile(output, 'utf8'), 'receipt=not_submitted\n',
      'a pre-request refusal names no run and is not acceptance_unknown');
  });
});

test('a success run passes at its first terminal read and polling stops there', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('in_progress'), runState('completed', 'success')] });
  const sink = sinkOf();
  // No run id is passed: the trailing `/runs/<id>` of the dispatched URL is enough.
  const result = await observeGateRun({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runUrl: createdUrl });
  assert.deepEqual({ outcome: result.outcome, run_url: result.run_url, conclusion: result.conclusion,
    failed_jobs: result.failed_jobs }, { outcome: 'passed', run_url: createdUrl, conclusion: 'success', failed_jobs: [] });
  assert.deepEqual(clock.waits, [OBSERVATION_INTERVAL_MS], 'one interval between the two reads');
  assert.equal(gh.calls.length, 2, 'the terminal read is the last read');
  assert.equal(gh.calls.some(args => String(args[1]).endsWith('/jobs')), false,
    'a successful run names no failed jobs and reads no job list');
});

test('a failure run fails with the names of the jobs that were neither success nor skipped', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('completed', 'failure')], jobs: { jobs: [
    { name: 'preflight', conclusion: 'success' },
    { name: 'reconcile', conclusion: 'skipped' },
    { name: 'full', conclusion: 'failure' },
    { name: 'record', conclusion: 'failure' },
  ] } });
  const sink = sinkOf();
  const result = await observeGateRun({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runId: 4242 });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.conclusion, 'failure');
  assert.deepEqual(result.failed_jobs, ['full', 'record'], 'API order, and skipped is not a failure');
  assert.equal(clock.waits.length, 0, 'a run that is already terminal needs no wait');
  assert.equal(gh.calls.filter(args => String(args[1]).endsWith('/jobs')).length, 1);
});

test('a cancelled or timed-out run fails', async () => {
  for (const conclusion of ['cancelled', 'timed_out']) {
    const { result } = await observe({ reads: [runState('completed', conclusion)] });
    assert.equal(result.outcome, 'failed', conclusion);
    assert.equal(result.conclusion, conclusion);
    assert.deepEqual(result.failed_jobs, []);
  }
});

test('the ceiling returns failed without waiting past the deadline', async () => {
  const clock = observationClock();
  const gh = observationGh({ reads: [runState('in_progress')] });
  const sink = sinkOf();
  const result = await observeGateRun({ env: { GH_TOKEN: 'ghs_read_only' }, run: gh.run,
    wait: clock.wait, now: clock.now, out: sink.out, runId: 4242 });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.ceiling, true, 'the recorder writes a warning, never an error');
  assert.match(result.reason, /the 55-minute hold ceiling was reached/);
  assert.equal(clock.waits.reduce((total, value) => total + value, 0), HOLD_CEILING_MS,
    'the wait sums to exactly the ceiling, never past it');
  assert.ok(clock.waits.every(milliseconds => milliseconds <= OBSERVATION_INTERVAL_MS),
    'no single wait is longer than the interval');
  assert.equal(gh.calls.length, clock.waits.length,
    'one read per interval; the read that would start at the deadline is replaced by the ceiling');
});

test('a read failure is thrown as the shared module error, never recorded as a ceiling', async () => {
  const first = await rejectionOf(observe({ reads: [new Error('gh: HTTP 401 Bad credentials')] }));
  assert.equal(first.code, 'read-failed', 'the authentication failure is its own read failure');
  assert.equal(first.reads, 1, 'a 401 is terminal on its first read');
  assert.ok(first.message.includes('gh: HTTP 401 Bad credentials'), 'the status is carried verbatim');
  const later = await rejectionOf(observe({ reads: [runState('in_progress'), new Error('gh: HTTP 502 Bad Gateway')] }));
  assert.equal(later.code, 'read-failed', 'a later 5xx is a read failure too');
  assert.equal(later.reads, 1);
});

test('a terminal non-success run whose job list cannot be read records its conclusion', async () => {
  const { result, gh } = await observe({ reads: [runState('completed', 'failure')],
    jobs: new Error('gh: HTTP 502 Bad Gateway') });
  assert.equal(result.outcome, 'failed', 'the conclusion stands; the unread job list does not change it');
  assert.equal(result.conclusion, 'failure');
  assert.deepEqual(result.failed_jobs, []);
  assert.match(result.failed_jobs_note, /gh: HTTP 502 Bad Gateway/);
  assert.equal(gh.calls.filter(args => String(args[1]).endsWith('/jobs')).length, 1, 'the job list is read once');
});

test('the one outcome line names the run, the conclusion and the failed jobs, or the reason none ran', () => {
  assert.equal(gateOutcomeLine({ outcome: 'passed', run_url: createdUrl, conclusion: 'success' }),
    `E2E gate passed: ${createdUrl} concluded success.`);
  assert.equal(gateOutcomeLine({ outcome: 'failed', run_url: createdUrl, conclusion: 'failure',
    failed_jobs: ['full', 'record'] }),
  `E2E gate failed: ${createdUrl} concluded failure; failed job(s): full, record.`);
  assert.equal(gateOutcomeLine({ outcome: 'failed', run_url: createdUrl, conclusion: 'failure',
    failed_jobs: [], failed_jobs_note: 'gh: HTTP 502 Bad Gateway' }),
  `E2E gate failed: ${createdUrl} concluded failure; failed job(s): none named`
    + ' (the job list could not be read: gh: HTTP 502 Bad Gateway).');
  assert.equal(gateOutcomeLine({ outcome: 'failed', run_url: createdUrl,
    failed_jobs: [], ceiling: true, ceiling_ms: HOLD_CEILING_MS }),
  `E2E gate failed: ${createdUrl} had not reached a terminal state when the 55-minute hold ceiling was reached.`);
  assert.equal(gateOutcomeLine({ outcome: 'failed', service_commit: serviceCommit,
    reason: 'no dispatched run id or URL was recorded by the dispatch step (receipt: not_submitted),'
      + ' so this deployment names no qualification run' }),
  'E2E gate failed: no dispatched run id or URL was recorded by the dispatch step (receipt: not_submitted),'
    + ` so this deployment names no qualification run for Service commit ${serviceCommit}.`);
});

// #354: a hold that could not read the dispatched run records `unobserved`, and
// that word names the reads, the wait schedule's total and the dispatch receipt.
test('an unobserved outcome names the reads, the waits and the receipt, never the ceiling', () => {
  const line = gateOutcomeLine({ outcome: 'unobserved', run_url: createdUrl, reads: 5,
    attempts: 5, waits_ms: 15000, elapsed_ms: 16000, read_failure: 'not-readable',
    read_cause: 'every read answering 404', receipt: 'created', service_commit: serviceCommit });
  assert.equal(line, `E2E gate unobserved: ${createdUrl} could not be read (every read answering 404)`
    + ' after 5 reads over 15000 ms of waits; dispatch receipt: created, so no gate verdict was recorded'
    + ` for Service commit ${serviceCommit}.`);
  assert.equal(line.includes('hold ceiling'), false, 'a failed read is never reported as the ceiling');
  assert.equal(gateOutcomeLine({ outcome: 'unobserved', reads: 0, waits_ms: 15000,
    read_cause: 'no dispatch receipt was recorded' }),
  'E2E gate unobserved: the dispatched gate run could not be read (no dispatch receipt was recorded)'
    + ' after 0 reads over 15000 ms of waits; dispatch receipt: no receipt was recorded,'
    + ' so no gate verdict was recorded.');
});

test('the recorder writes exactly one summary line, the step outcome and the right annotation', async () => {
  await withOutputFiles(async ({ summary, output }) => {
    const sink = sinkOf();
    const failed = { outcome: 'failed', run_url: createdUrl, conclusion: 'failure',
      failed_jobs: ['full', 'record'], service_commit: serviceCommit };
    const line = await recordGateOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: failed, out: sink.out });
    assert.equal(await readFile(summary, 'utf8'), `${line}\n`, 'exactly one outcome line');
    assert.equal(await readFile(output, 'utf8'), 'outcome=failed\n');
    assert.match(line, new RegExp(`^E2E gate failed: ${createdUrl.replaceAll('/', '\\/')} concluded failure`));
    assert.equal(sink.text(), `${line}\n`, 'a terminal non-success is not an error annotation');

    const warn = sinkOf();
    const ceilingLine = await recordGateOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: { outcome: 'failed', run_url: createdUrl, failed_jobs: [], ceiling: true, ceiling_ms: HOLD_CEILING_MS },
      out: warn.out });
    assert.equal(warn.text(), `::warning::${ceilingLine}\n`, 'the ceiling carries a ::warning');
    assert.equal(await readFile(summary, 'utf8'), `${line}\n${ceilingLine}\n`,
      'the ceiling appends one more line, never a second line for the same outcome');
    assert.equal(await readFile(output, 'utf8'), 'outcome=failed\noutcome=failed\n');

    const unread = sinkOf();
    const unobservedLine = await recordGateOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: { outcome: 'unobserved', run_url: createdUrl, reads: 1, waits_ms: 15000,
        read_cause: 'gh: HTTP 401 Bad credentials', receipt: 'created', service_commit: serviceCommit },
      out: unread.out });
    assert.equal(unread.text(), `::error::${unobservedLine}\n`, 'unobserved carries a ::error');
    assert.equal(await readFile(output, 'utf8'), 'outcome=failed\noutcome=failed\noutcome=unobserved\n');

    const note = sinkOf();
    const notedLine = await recordGateOutcome({ env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      result: { outcome: 'failed', run_url: createdUrl, conclusion: 'failure', failed_jobs: [],
        failed_jobs_note: 'gh: HTTP 502 Bad Gateway' }, out: note.out });
    assert.equal(note.text(), `::warning::${notedLine}\n`, 'an unread job list is a warning on a known conclusion');
  });
});
