// The one implementation of "read a run this process just created by id" (#354).
//
// A `404` from the runs API for a run that already exists is gradual consistency,
// not absence: the read happens right after the dispatch that created the run.
// This module owns the API path, the bounded retry, the identity check and the
// failure message, so every workflow script that reads such a run follows one
// policy, and `test/scripts/created-run-read-census.test.mjs` fails a script that
// spells the path itself.
//
// The file has no dependencies, reads no environment and touches no filesystem:
// the two hand-off jobs that vendor these exact bytes run no dependency install,
// so it must load standalone. Its bytes are pinned by a SHA-256 digest in the
// census test named above.
export const RUN_READ_ATTEMPTS = 5;
export const RUN_READ_WAIT_MS = 1_000;

/**
 * The wait after read `k` is `runReadWaits()[k - 1]`; no wait trails the last
 * read. The schedule's total is derived from this array wherever it is reported,
 * never written as a second literal.
 */
export function runReadWaits({ attempts = RUN_READ_ATTEMPTS, baseMs = RUN_READ_WAIT_MS } = {}) {
  return Object.freeze(Array.from({ length: Math.max(attempts - 1, 0) }, (_, index) => baseMs * 2 ** index));
}

/**
 * A read that answered `Not Found`. `promisify(execFile)` rejects with the `gh`
 * body on `stdout`, and the status can arrive in any of the three fields, so all
 * of them are read.
 */
export function isNotFoundRunRead(error) {
  return /(?:\b404\b|Not Found)/i.test(
    `${error?.message ?? ''} ${error?.stderr ?? ''} ${error?.stdout ?? ''}`);
}

/** A run the API has already finished without succeeding; no retry can change it. */
export function completedWithoutSuccess(body) {
  return body?.status === 'completed' && body.conclusion !== 'success';
}

/**
 * The one failure shape: a code, the run, the reads that were made, the schedule's
 * total wait and the underlying cause. `code` is `not-readable` (every bounded read
 * answered `404`), `read-failed` (a terminal failure or a body that is not a run),
 * `id-mismatch` (a `200` naming another id), `deadline-reached` (the caller's
 * deadline arrived first) or `terminal-non-success` (the caller required success
 * and the run had already concluded otherwise).
 */
export class RunReadError extends Error {
  constructor({ code, message, runId, runUrl, attempts, reads, waitsMs, elapsedMs, conclusion, cause }) {
    super(message);
    this.name = 'RunReadError';
    this.code = code;
    this.runId = runId;
    this.runUrl = runUrl;
    this.attempts = attempts;
    this.reads = reads;
    this.waitsMs = waitsMs;
    this.elapsedMs = elapsedMs;
    this.conclusion = conclusion;
    this.cause = cause;
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const noLog = () => undefined;
const readNoun = count => `${count} read${count === 1 ? '' : 's'}`;
const firstLine = text => String(text ?? '').split('\n')[0];

/**
 * Read the created run by its own id, retrying only a `404` — five reads in total
 * against the same id, with a doubling wait between reads (15 seconds), because a
 * run the API has not made readable yet answers `404` and becomes readable moments
 * later. Any other read failure is terminal on the read that produced it, and so
 * is a body that is not a run or a `200` naming another id: waiting cannot change
 * them, so they consume no retry. A run the caller required to have succeeded but
 * that already concluded otherwise is rejected at once. `deadlineAtMs` bounds an
 * observation read: no read starts and no wait ends past that instant, and
 * reaching it raises the distinct `deadline-reached` code. The dispatch itself is
 * never repeated here: this module only reads.
 *
 * `read` is `async path => parsed body` and rejects on any transport or parse
 * failure; `log` receives each attempt line without a trailing newline.
 */
export async function readCreatedRunById({
  read, repository, runId, runUrl, label,
  attempts = RUN_READ_ATTEMPTS, baseMs = RUN_READ_WAIT_MS,
  wait = sleep, log = noLog, now = Date.now,
  requireSuccess = true,
  deadlineAtMs,
} = {}) {
  const path = `repos/${repository}/actions/runs/${runId}`;
  const waits = runReadWaits({ attempts, baseMs });
  const waitsMs = waits.reduce((total, milliseconds) => total + milliseconds, 0);
  const startedAt = now();
  let reads = 0;
  const failure = (code, message, extra = {}) => new RunReadError({
    code, message, runId, runUrl, attempts, reads, waitsMs,
    elapsedMs: now() - startedAt, ...extra,
  });
  const deadlineReached = taken => failure('deadline-reached',
    `${label} ${runUrl} was not read before the hold deadline (${readNoun(taken)} over ${waitsMs} ms of waits)`,
    { cause: new Error('the hold deadline was reached') });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (deadlineAtMs !== undefined && now() >= deadlineAtMs) throw deadlineReached(reads);
    let body;
    try {
      body = await read(path);
      reads += 1;
    } catch (error) {
      reads += 1;
      if (!isNotFoundRunRead(error)) {
        throw failure('read-failed', `${label} ${runUrl} could not be read: ${firstLine(error?.message ?? error)}`
          + ` (${readNoun(reads)} over ${waitsMs} ms of waits)`, { cause: error });
      }
      if (attempt >= attempts) break;
      const scheduled = waits[attempt - 1];
      if (deadlineAtMs !== undefined && now() + scheduled > deadlineAtMs) throw deadlineReached(reads);
      log(`the by-id read of ${label} ${runUrl} answered 404 on attempt ${attempt}/${attempts};`
        + ` retrying in ${scheduled} ms`);
      await wait(scheduled);
      continue;
    }
    if (body === null || typeof body !== 'object') {
      throw failure('read-failed', `${label} ${runUrl} was answered by a body that is not a run`
        + ` (${readNoun(reads)} over ${waitsMs} ms of waits); waiting cannot change that`,
      { cause: new Error(`the read body is ${body === null ? 'null' : typeof body}`) });
    }
    if (body.id !== runId) {
      throw failure('id-mismatch', `${label} ${runUrl} was not returned by id: the run API answered run`
        + ` ${String(body.id)}, not the dispatched run ${runId}`
        + ` (${readNoun(reads)} over ${waitsMs} ms of waits)`,
      { cause: new Error(`the run API answered run ${String(body.id)}, not run ${runId}`) });
    }
    if (requireSuccess && completedWithoutSuccess(body)) {
      const conclusion = typeof body.conclusion === 'string' && body.conclusion !== '' ? body.conclusion : 'unknown';
      throw failure('terminal-non-success', `${label} ${runUrl} had already completed with conclusion ${conclusion};`
        + ' the dispatch was accepted once and not repeated, so the hand-off cannot report success',
      { conclusion, cause: new Error(`the run had already completed with conclusion ${conclusion}`) });
    }
    log(`${label} ${runUrl} is run ${runId} (read attempt ${attempt}/${attempts})`);
    return body;
  }
  throw failure('not-readable', `${label} ${runUrl} was not readable after ${attempts} reads over ${waitsMs} ms,`
    + ' every read answering 404; the dispatch was accepted once and not repeated,'
    + ' so the run was dropped or not accepted',
  { cause: new Error('every read answering 404') });
}
