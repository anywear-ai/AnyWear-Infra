import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { completedWithoutSuccess, isNotFoundRunRead, readCreatedRunById, RunReadError,
  RUN_READ_ATTEMPTS, RUN_READ_WAIT_MS, runReadWaits } from '../../scripts/lib/created-run-read.mjs';

// #354: the only by-id read of a freshly created Actions run. The schedule is
// pinned as literals because it is a contract with the operator: five reads, four
// doubling waits, 15 seconds in total, no wait above eight seconds. The retry is
// `404`-only, the identity check is by id, and every failure is a `RunReadError`
// that names the run and the reads that were made.
const repository = 'anywear-ai/AnyWear-E2E';
const runId = 4242;
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
const label = 'the dispatched qualification run';
const modulePath = path.join(import.meta.dirname, '..', '..', 'scripts', 'lib', 'created-run-read.mjs');
const moduleText = readFileSync(modulePath, 'utf8');

const notFound = () => {
  const error = new Error('Command failed: gh api repos/anywear-ai/AnyWear-E2E/actions/runs/4242');
  error.stdout = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/actions/workflow-runs","status":"404"}';
  return error;
};
const clock = () => {
  let current = 1_700_000_000_000;
  const waits = [];
  return { waits, now: () => current, wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; } };
};
const sink = () => {
  const lines = [];
  return { lines, log: line => lines.push(line) };
};

function fakeRead(sequence) {
  const calls = [];
  let index = 0;
  const read = async requestPath => {
    calls.push(requestPath);
    const entry = sequence[Math.min(index++, sequence.length - 1)];
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { calls, read };
}

test('the wait schedule is five reads and four doubling waits totalling 15000 ms', () => {
  assert.equal(RUN_READ_ATTEMPTS, 5);
  assert.equal(RUN_READ_WAIT_MS, 1_000);
  assert.deepEqual(runReadWaits(), [1000, 2000, 4000, 8000]);
  assert.equal(Object.isFrozen(runReadWaits()), true, 'the schedule is frozen');
  assert.equal(runReadWaits().reduce((total, value) => total + value, 0), 15000);
  assert.ok(runReadWaits().every(milliseconds => milliseconds <= 8000), 'no wait exceeds 8000 ms');
  // The construction is the module's: the total is derived, never a second literal.
  assert.match(moduleText, /baseMs \* 2 \*\* index/);
  assert.deepEqual(runReadWaits({ attempts: 3, baseMs: 10 }), [10, 20]);
  assert.deepEqual(runReadWaits({ attempts: 1 }), [], 'no wait trails the last possible read');
});

test('the 404 recogniser reads message, stderr and stdout', () => {
  assert.equal(isNotFoundRunRead(notFound()), true);
  assert.equal(isNotFoundRunRead(Object.assign(new Error('boom'), { stderr: 'gh: Not Found (HTTP 404)' })), true);
  assert.equal(isNotFoundRunRead(new Error('gh: HTTP 502 Bad Gateway')), false);
  assert.equal(isNotFoundRunRead(new Error('gh: HTTP 401 Bad credentials')), false);
  assert.equal(isNotFoundRunRead(undefined), false);
});

test('only a run completed without success trips the terminal predicate', () => {
  assert.equal(completedWithoutSuccess({ status: 'completed', conclusion: 'failure' }), true);
  assert.equal(completedWithoutSuccess({ status: 'completed', conclusion: 'cancelled' }), true);
  assert.equal(completedWithoutSuccess({ status: 'completed', conclusion: 'success' }), false);
  assert.equal(completedWithoutSuccess({ status: 'in_progress', conclusion: null }), false);
  assert.equal(completedWithoutSuccess({ status: 'queued' }), false);
  assert.equal(completedWithoutSuccess(null), false);
});

test('a first read that answers 404 is retried against the same id and succeeds', async () => {
  const time = clock();
  const log = sink();
  const read = fakeRead([notFound(), { id: runId, status: 'in_progress' }]);
  const body = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: log.log, now: time.now });
  assert.equal(body.status, 'in_progress');
  assert.deepEqual(read.calls, [
    'repos/anywear-ai/AnyWear-E2E/actions/runs/4242',
    'repos/anywear-ai/AnyWear-E2E/actions/runs/4242',
  ], 'the retry requests the same by-id path, and only that path');
  assert.deepEqual(time.waits, [1000], 'the wait is the first entry of the schedule');
  assert.deepEqual(log.lines, [
    `the by-id read of ${label} ${runUrl} answered 404 on attempt 1/5; retrying in 1000 ms`,
    `${label} ${runUrl} is run 4242 (read attempt 2/5)`,
  ], 'the module owns both lines, with the unified attempt shape');
});

test('every read answering 404 fails after five reads over 15000 ms of waits', async () => {
  const time = clock();
  const log = sink();
  const read = fakeRead([notFound()]);
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: log.log, now: time.now }).then(() => undefined, error => error);
  assert.ok(failure instanceof RunReadError, 'the failure carries the module error shape');
  assert.equal(failure.code, 'not-readable');
  assert.equal(failure.runId, runId);
  assert.equal(failure.runUrl, runUrl);
  assert.equal(failure.attempts, 5);
  assert.equal(failure.reads, 5);
  assert.equal(failure.waitsMs, 15000);
  assert.equal(time.waits.reduce((total, value) => total + value, 0), 15000);
  assert.deepEqual(time.waits, [1000, 2000, 4000, 8000]);
  assert.equal(read.calls.length, 5, 'five reads and no more, all of the same id');
  assert.ok(failure.message.includes(runUrl), 'the failure names the run');
  assert.ok(failure.message.includes('5 reads over 15000 ms'), 'the failure names the reads');
  assert.equal(log.lines.length, 4, 'a retry line follows each of the first four reads, never the fifth');
  log.lines.forEach((line, index) => {
    assert.equal(line, `the by-id read of ${label} ${runUrl} answered 404 on attempt ${index + 1}/5;`
      + ` retrying in ${[1000, 2000, 4000, 8000][index]} ms`);
  });
});

test('a read failure other than 404 is terminal on the read that produced it', async () => {
  const time = clock();
  const log = sink();
  const gateway = Object.assign(new Error('gh: HTTP 502 Bad Gateway'), { stderr: 'gh: HTTP 502 Bad Gateway\n' });
  const read = fakeRead([gateway]);
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: log.log, now: time.now }).then(() => undefined, error => error);
  assert.equal(failure.code, 'read-failed');
  assert.equal(failure.reads, 1, 'a non-404 failure consumes no retry');
  assert.equal(failure.cause, gateway, 'the underlying error is carried verbatim');
  assert.ok(failure.message.includes(runUrl));
  assert.ok(failure.message.includes('HTTP 502'));
  assert.equal(read.calls.length, 1);
  assert.deepEqual(time.waits, []);
  assert.deepEqual(log.lines, []);
});

test('a 200 naming another id is terminal and names both ids', async () => {
  const read = fakeRead([{ id: 999 }]);
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: async () => undefined, log: () => undefined }).then(() => undefined, error => error);
  assert.equal(failure.code, 'id-mismatch');
  assert.equal(failure.reads, 1, 'an identity mismatch consumes no retry');
  assert.ok(failure.message.includes('999'), 'the answered id is named');
  assert.ok(failure.message.includes(String(runId)), 'the dispatched id is named');
  assert.equal(read.calls.length, 1);
});

test('a body that is not a run is terminal without consuming a retry', async () => {
  for (const body of [null, 'not a run', 7]) {
    const read = fakeRead([body]);
    const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
      wait: async () => undefined, log: () => undefined }).then(() => undefined, error => error);
    assert.equal(failure.code, 'read-failed', String(body));
    assert.equal(failure.reads, 1, `${String(body)} consumes no retry`);
    assert.equal(read.calls.length, 1);
  }
});

test('a required successful run is rejected at once when it already concluded otherwise', async () => {
  const read = fakeRead([{ id: runId, status: 'completed', conclusion: 'cancelled' }]);
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: async () => undefined, log: () => undefined }).then(() => undefined, error => error);
  assert.equal(failure.code, 'terminal-non-success');
  assert.equal(failure.conclusion, 'cancelled');
  assert.equal(failure.reads, 1);
  assert.ok(failure.message.includes('conclusion cancelled'));
  // The observation accepts the same body: it must report the verdict, not reject it.
  const accepted = fakeRead([{ id: runId, status: 'completed', conclusion: 'failure' }]);
  const body = await readCreatedRunById({ read: accepted.read, repository, runId, runUrl, label,
    wait: async () => undefined, log: () => undefined, requireSuccess: false });
  assert.equal(body.conclusion, 'failure');
});

test('a deadline that has already arrived starts no read', async () => {
  const read = fakeRead([{ id: runId }]);
  const time = clock();
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: () => undefined, now: time.now, deadlineAtMs: time.now() }).then(() => undefined, error => error);
  assert.equal(failure.code, 'deadline-reached');
  assert.equal(failure.reads, 0);
  assert.equal(read.calls.length, 0, 'no read starts at or past the deadline');
  assert.deepEqual(time.waits, []);
});

test('a deadline with no room for the next wait ends the sequence before the wait', async () => {
  const time = clock();
  const read = fakeRead([notFound()]);
  const failure = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: () => undefined, now: time.now, deadlineAtMs: time.now() + 500 })
    .then(() => undefined, error => error);
  assert.equal(failure.code, 'deadline-reached');
  assert.equal(failure.reads, 1, 'the read that answered 404 was taken');
  assert.equal(read.calls.length, 1);
  assert.deepEqual(time.waits, [], 'a wait that would end past the deadline is not waited');
});

test('a deadline that leaves room keeps the retry inside the hold', async () => {
  const time = clock();
  const read = fakeRead([notFound(), { id: runId, status: 'in_progress' }]);
  const body = await readCreatedRunById({ read: read.read, repository, runId, runUrl, label,
    wait: time.wait, log: () => undefined, now: time.now, deadlineAtMs: time.now() + 60_000 });
  assert.equal(body.status, 'in_progress');
  assert.deepEqual(time.waits, [1000]);
});

test('the module has no dependencies, no environment, no filesystem and no main guard', async () => {
  assert.equal(/\bimport\b/.test(moduleText), false, 'the module imports nothing');
  assert.equal(/process\.env/.test(moduleText), false, 'the module reads no environment');
  assert.equal(/readFile/.test(moduleText), false, 'the module touches no filesystem');
  assert.equal(/process\.argv\[1\]/.test(moduleText), false, 'the module carries no main guard');
  // The entry-manifest rules are the other half: it must load standalone.
  const loaded = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof loaded.readCreatedRunById, 'function');
  assert.equal(loaded.RUN_READ_ATTEMPTS, 5);
  assert.deepEqual([...loaded.runReadWaits()], [1000, 2000, 4000, 8000]);
});
