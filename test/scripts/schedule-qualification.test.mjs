import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchScheduledQualification, SCHEDULE_OPERATIONS, SCHEDULE_TRIGGERS,
  schedulePayload, validateScheduleEntry } from '../../scripts/schedule-qualification.mjs';

// Issue #344: the scheduled entry's dispatcher. The three menu operations map to the
// three E2E triggers ADR 0033 §8 defines, the expected commits are `full`-only, and
// the dispatch exposes the created run to the same observation the deploy chain uses.
const serviceCommit = 'b'.repeat(40);
const clientCommit = 'c'.repeat(40);
const key = 'https://github.com/anywear-ai/AnyWear-Infra/actions/runs/77';
const createdUrl = 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/4242';
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'anywear-ai/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'schedule', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
  ENABLE_BETA_MUTATION: 'true', SCHEDULE_OPERATION: 'reconcile',
  EXPECTED_SERVICE_COMMIT: '', EXPECTED_CLIENT_COMMIT: '', GH_TOKEN: 'ghs_reviewed_token', ...overrides,
});

function fakeGh({ queued = [], in_progress = [], dispatchResponse, created = { id: 4242, html_url: createdUrl } } = {}) {
  const calls = [];
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    if (args[1] === '--method') {
      const body = dispatchResponse ?? { workflow_run_id: 4242, html_url: createdUrl };
      return { stdout: JSON.stringify(body), stderr: '' };
    }
    const status = /\?status=(queued|in_progress)/.exec(args[1]);
    if (status) {
      return { stdout: JSON.stringify({ workflow_runs: (status[1] === 'queued' ? queued : in_progress) }), stderr: '' };
    }
    if (/actions\/runs\/\d+$/.test(args[1])) return { stdout: JSON.stringify(created), stderr: '' };
    throw new Error(`unexpected gh api ${args[1]}`);
  };
  const chunks = [];
  return { calls, run, out: { write: chunk => chunks.push(chunk) }, text: () => chunks.join('') };
}

const inputFields = args => args.reduce((fields, value) => {
  const match = /^inputs\[([a-z_]+)\]=(.+)$/.exec(value);
  if (match) fields[match[1]] = match[2];
  return fields;
}, {});

test('the entry validates reviewed main, the stage switch and the operation menu', () => {
  assert.deepEqual(SCHEDULE_OPERATIONS, ['reconcile', 'smoke', 'full']);
  assert.deepEqual(SCHEDULE_TRIGGERS, { reconcile: 'scheduled', smoke: 'deploy-smoke', full: 'release-qualify' });
  assert.deepEqual(validateScheduleEntry(env()),
    { operation: 'reconcile', expected_service_commit: '', expected_client_commit: '', dispatched_by: key });
  // The nightly run reaches the entry with no inputs at all, so the workflow names
  // `reconcile`; the operation must still be one of the three.
  for (const operation of ['smoke', 'reconcile']) {
    assert.equal(validateScheduleEntry(env({ SCHEDULE_OPERATION: operation })).operation, operation);
  }
  assert.throws(() => validateScheduleEntry(env({ GITHUB_REF: 'refs/heads/feature' })), /requires reviewed main/);
  assert.throws(() => validateScheduleEntry(env({ ENABLE_BETA_MUTATION: 'false' })), /requires the stage switch open/);
  assert.throws(() => validateScheduleEntry(env({ ENABLE_BETA_MUTATION: '' })), /requires the stage switch open/);
  for (const operation of ['', 'state', 'deploy', 'manual', 'REconcile', undefined]) {
    assert.throws(() => validateScheduleEntry(env({ SCHEDULE_OPERATION: operation })),
      /requires one of reconcile, smoke, full/, String(operation));
  }
  assert.throws(() => validateScheduleEntry(env({ GITHUB_RUN_ID: '0' })), /dispatching run id/);
});

test('only full takes an expected commit, and full requires the Service commit', () => {
  assert.deepEqual(validateScheduleEntry(env({ SCHEDULE_OPERATION: 'full', EXPECTED_SERVICE_COMMIT: serviceCommit })),
  { operation: 'full', expected_service_commit: serviceCommit, expected_client_commit: '', dispatched_by: key });
  for (const bad of ['', 'b'.repeat(39), `${serviceCommit}0`, 'B'.repeat(40), ' not-a-sha ']) {
    assert.throws(() => validateScheduleEntry(env({ SCHEDULE_OPERATION: 'full', EXPECTED_SERVICE_COMMIT: bad })),
      /expected_service_commit for a full qualification/, JSON.stringify(bad));
  }
  // The Client commit is optional with full and must still be a commit.
  assert.doesNotThrow(() => validateScheduleEntry(env({ SCHEDULE_OPERATION: 'full',
    EXPECTED_SERVICE_COMMIT: serviceCommit, EXPECTED_CLIENT_COMMIT: clientCommit })));
  assert.throws(() => validateScheduleEntry(env({ SCHEDULE_OPERATION: 'full',
    EXPECTED_SERVICE_COMMIT: serviceCommit, EXPECTED_CLIENT_COMMIT: 'short' })), /expected_client_commit/);
  // reconcile and smoke accept neither.
  for (const operation of ['reconcile', 'smoke']) {
    for (const overrides of [{ EXPECTED_SERVICE_COMMIT: serviceCommit }, { EXPECTED_CLIENT_COMMIT: clientCommit }]) {
      assert.throws(() => validateScheduleEntry(env({ SCHEDULE_OPERATION: operation, ...overrides })),
        /Only full accepts an expected commit/, `${operation} ${JSON.stringify(overrides)}`);
    }
  }
});

test('each operation maps to exactly its E2E trigger and payload', () => {
  assert.deepEqual(schedulePayload(env()), { operation: 'reconcile', trigger: 'scheduled', dispatched_by: key });
  assert.deepEqual(schedulePayload(env({ SCHEDULE_OPERATION: 'smoke' })),
    { operation: 'smoke', trigger: 'deploy-smoke', dispatched_by: key });
  assert.deepEqual(schedulePayload(env({ SCHEDULE_OPERATION: 'full', EXPECTED_SERVICE_COMMIT: serviceCommit,
    EXPECTED_CLIENT_COMMIT: clientCommit })),
  { operation: 'full', trigger: 'release-qualify', expected_service_commit: serviceCommit,
    expected_client_commit: clientCommit, dispatched_by: key });
  // A full without a Client commit names only the Service one.
  assert.deepEqual(schedulePayload(env({ SCHEDULE_OPERATION: 'full', EXPECTED_SERVICE_COMMIT: serviceCommit })),
    { operation: 'full', trigger: 'release-qualify', expected_service_commit: serviceCommit, dispatched_by: key });
  // No payload restates the worker slot offset: the E2E workflow's reviewed default
  // is `0`, which every one of these triggers requires.
  for (const payload of [schedulePayload(env()), schedulePayload(env({ SCHEDULE_OPERATION: 'smoke' })),
    schedulePayload(env({ SCHEDULE_OPERATION: 'full', EXPECTED_SERVICE_COMMIT: serviceCommit }))]) {
    assert.equal(Object.hasOwn(payload, 'worker_slot_offset'), false);
  }
});

test('the dispatch sends the payload once and exposes the created run to the observation', async () => {
  await withOutput(async output => {
    const gh = fakeGh();
    const result = await dispatchScheduledQualification({ env: env({ GITHUB_OUTPUT: output }),
      run: gh.run, out: gh.out });
    assert.equal(result.dispatched, true);
    assert.equal(result.run_id, 4242);
    assert.equal(result.run_url, createdUrl);
    const post = gh.calls.find(args => args.includes('--method'));
    assert.equal(post[3], 'repos/anywear-ai/AnyWear-E2E/actions/workflows/beta-qualification.yml/dispatches');
    assert.deepEqual(inputFields(post), schedulePayload(env()));
    assert.equal(await readFile(output, 'utf8'), `run_url=${createdUrl}\nrun_id=4242\nreceipt=created\n`);
    assert.match(gh.text(), /Dispatched qualification reconcile\/scheduled/);
  });
});

test('a re-run whose key is already in an active run name dispatches nothing', async () => {
  await withOutput(async output => {
    const existingUrl = 'https://github.com/anywear-ai/AnyWear-E2E/actions/runs/999';
    const gh = fakeGh({ in_progress: [{ id: 999, html_url: existingUrl,
      display_title: 'Beta qualification: reconcile · scheduled · - · by ' + key }] });
    const result = await dispatchScheduledQualification({ env: env({ GITHUB_OUTPUT: output }),
      run: gh.run, out: gh.out });
    assert.equal(result.dispatched, false);
    assert.equal(result.run_id, 999);
    assert.equal(gh.calls.some(args => args.includes('--method')), false);
    assert.equal(await readFile(output, 'utf8'), `run_url=${existingUrl}\nrun_id=999\nreceipt=adopted\n`);
  });
});

test('the dispatch refuses a missing token, a closed scope and an invalid operation before any call', async () => {
  for (const [overrides, expectation] of [
    [{ GH_TOKEN: '' }, /write-scoped AnyWear-E2E App token/],
    [{ GITHUB_REF: 'refs/heads/feature' }, /requires reviewed main/],
    [{ ENABLE_BETA_MUTATION: 'false' }, /requires the stage switch open/],
    [{ SCHEDULE_OPERATION: 'deploy' }, /requires one of reconcile, smoke, full/],
    [{ SCHEDULE_OPERATION: 'smoke', EXPECTED_SERVICE_COMMIT: serviceCommit }, /Only full accepts an expected commit/],
    [{ SCHEDULE_OPERATION: 'full' }, /expected_service_commit for a full qualification/],
  ]) {
    const gh = fakeGh();
    await assert.rejects(dispatchScheduledQualification({ env: env(overrides), run: gh.run, out: gh.out }),
      expectation, JSON.stringify(overrides));
    assert.deepEqual(gh.calls, [], `${JSON.stringify(overrides)}: no GitHub call precedes the refusal`);
  }
});

const withOutput = async body => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anywear-scheduled-qualification-'));
  try {
    return await body(path.join(directory, 'output'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
