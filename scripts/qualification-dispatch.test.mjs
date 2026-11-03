import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchArguments, dispatchQualification, findDispatchedRun, qualificationPayload } from './qualification-dispatch.mjs';

// #226: the deploy chain's qualification hop. The payloads are the two rows of the
// design's E2E dispatch table; the dedupe and the post-dispatch name check are what
// make a re-run dispatch nothing and a dropped run fail the job.
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

// A fake `gh` that answers the two active-run listings, the dispatch POST and the
// created-run read. Every call is recorded, so the tests prove what was requested.
function fakeGh({ queued = [], in_progress = [], failingStatus, createdName = runName(), createdHtml = createdUrl } = {}) {
  const calls = [];
  const output = [];
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const path = args[1] === '--method' ? args[3] : args[1];
    if (args[1] === '--method') {
      return { stdout: JSON.stringify({ workflow_run_id: 4242, run_url: `https://api.github.com${path}`, html_url: createdHtml }), stderr: '' };
    }
    const status = /\?status=(queued|in_progress)/.exec(path);
    if (status) {
      if (failingStatus === status[1]) throw new Error('gh: HTTP 502 Bad Gateway');
      return { stdout: JSON.stringify({ workflow_runs: status[1] === 'queued' ? queued : in_progress }), stderr: '' };
    }
    const created = /actions\/runs\/(\d+)$/.exec(path);
    if (created) {
      return { stdout: JSON.stringify({ id: Number(created[1]), display_title: createdName, html_url: createdHtml }), stderr: '' };
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
  assert.equal(post[3], 'repos/git-malu/AnyWear-E2E/actions/workflows/beta-qualification.yml/dispatches');
  assert.equal(post[post.indexOf('return_run_details=true') - 1], '-F', 'the boolean uses the typed field flag');
  assert.equal(post[post.indexOf('ref=main') - 1], '-f');
  assert.deepEqual(inputFields(post), qualificationPayload(dispatchEnv({ DELIVERY_TRIGGER: 'deploy', DISPATCHED_BY: dispatchedBy })));
  // The created run is read back and its name checked; the printed line carries
  // the URL the operator follows.
  assert.ok(gh.calls.some(args => args[1] === 'repos/git-malu/AnyWear-E2E/actions/runs/4242'));
  assert.ok(gh.output().includes(createdUrl));
  assert.equal(result.run_url, createdUrl);
});

test('a re-run whose key is already in an active run name dispatches nothing', async () => {
  const existingUrl = 'https://github.com/git-malu/AnyWear-E2E/actions/runs/999';
  const gh = fakeGh({ queued: [{ display_title: runName(), html_url: existingUrl }] });
  const result = await dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out });
  assert.equal(result.dispatched, false);
  assert.equal(result.run_url, existingUrl);
  assert.equal(gh.calls.some(args => args.includes('--method')), false, 'no dispatch when the key already exists');
  assert.ok(gh.output().includes(existingUrl), 'the skipped run URL is printed');
  // The in-progress list is part of the pre-dispatch read.
  assert.ok(gh.calls.some(args => String(args[1]).includes('status=in_progress')));
});

test('a created run whose name does not carry the key fails the job', async () => {
  const gh = fakeGh({ createdName: 'Beta Qualification' });
  await assert.rejects(dispatchQualification({ env: dispatchEnv(), run: gh.run, out: gh.out }),
    /does not carry https:\/\/github\.com\/git-malu\/AnyWear-Infra\/actions\/runs\/77/);
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
