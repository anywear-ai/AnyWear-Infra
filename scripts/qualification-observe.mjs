import { pathToFileURL } from 'node:url';
import { observeQualification, recordQualificationOutcome, RUN_READ_ATTEMPTS,
  runReadWaits } from './qualification-dispatch.mjs';

// #338/#354: the deploy chain's hold recorder. It is the `qualify-hold` job's last
// step and runs under `if: always()`, so every deployment run that took the hold
// ends with exactly one outcome line in its step summary and its `outcome` step
// output. The step never changes the `deploy` job's conclusion.
//
// The outcome is one of three values. `qualified` and `unqualified` are verdicts
// the observation formed: the dispatched run concluded success, or it concluded
// otherwise, or the 55-minute hold ceiling fired, or the dispatch receipt proves
// nothing was submitted. `unobserved` means no verdict was formed — the dispatched
// run could not be read, every bounded by-id read answered `404`, a read failed
// another way, or a run may exist that this step cannot name — and the step exits
// non-zero, because an unknown hold is never recorded as a good one.
//
// The record names the run when one was recorded, the reads it made, the wait
// schedule's total and the dispatch receipt, so a reader can tell a slow-visible
// run from a lost one.
const WAITS_MS = runReadWaits().reduce((total, milliseconds) => total + milliseconds, 0);
const READ_FAILURES = Object.freeze(['not-readable', 'read-failed', 'id-mismatch', 'deadline-reached']);
const readFailureOf = error => (READ_FAILURES.includes(error?.code) ? error.code : 'read-failed');
const firstLine = text => String(text ?? '').split('\n')[0];

export async function runQualificationObservation(
  { env = process.env, run, wait, out = process.stdout, now = Date.now } = {}) {
  const runId = env.QUALIFICATION_RUN_ID;
  const runUrl = env.QUALIFICATION_RUN_URL;
  const receipt = typeof env.QUALIFICATION_RECEIPT === 'string' && env.QUALIFICATION_RECEIPT !== ''
    ? env.QUALIFICATION_RECEIPT : undefined;
  // The outcome names the deployed Service commit, which the workflow carries
  // directly and, for a release operation, inside the sealed artifact tag.
  const taggedCommit = typeof env.SERVICE_ARTIFACT_TAG === 'string'
    && /^service-artifacts-[0-9a-f]{40}$/.test(env.SERVICE_ARTIFACT_TAG)
    ? env.SERVICE_ARTIFACT_TAG.slice('service-artifacts-'.length) : undefined;
  const serviceCommit = [env.SERVICE_COMMIT, taggedCommit]
    .find(value => typeof value === 'string' && value !== '');
  const tuple = serviceCommit === undefined ? {} : { service_commit: serviceCommit };
  const recordedRun = {};
  const numericRunId = Number(runId);
  if (Number.isSafeInteger(numericRunId) && numericRunId > 0) recordedRun.run_id = numericRunId;
  if (typeof runUrl === 'string' && runUrl !== '') recordedRun.run_url = runUrl;
  const receiptField = receipt === undefined ? {} : { receipt };
  const noRun = recordedRun.run_id === undefined && recordedRun.run_url === undefined;
  if (noRun) {
    // Only a receipt that proves nothing was submitted keeps the deployment's
    // stated outcome; any other receipt (or none) may name a run this step cannot
    // see, which is exactly what `unobserved` reports.
    if (receipt === 'not_submitted') {
      await recordQualificationOutcome({ env, out, result: { outcome: 'unqualified', ...receiptField,
        reason: 'no dispatched run id or URL was recorded by the dispatch step (receipt: not_submitted),'
          + ' so this deployment names no qualification run', ...tuple } });
      return 0;
    }
    const cause = receipt === undefined
      ? 'no dispatched run id or URL was recorded and the dispatch step wrote no receipt'
      : `the dispatch step recorded receipt ${receipt}, so a run may exist that this step cannot name`;
    await recordQualificationOutcome({ env, out, result: { outcome: 'unobserved', ...recordedRun, ...receiptField,
      reads: 0, attempts: RUN_READ_ATTEMPTS, waits_ms: WAITS_MS, elapsed_ms: 0,
      read_failure: 'read-failed', read_cause: cause,
      reason: 'no dispatched run could be identified, so no qualification verdict was recorded', ...tuple } });
    return 1;
  }
  let result;
  try {
    result = await observeQualification({ env, run, wait, out, now, runId, runUrl });
  } catch (error) {
    await recordQualificationOutcome({ env, out, result: { outcome: 'unobserved', ...recordedRun, ...receiptField,
      reads: Number.isSafeInteger(error?.reads) ? error.reads : 0,
      attempts: Number.isSafeInteger(error?.attempts) ? error.attempts : RUN_READ_ATTEMPTS,
      waits_ms: Number.isSafeInteger(error?.waitsMs) ? error.waitsMs : WAITS_MS,
      elapsed_ms: Number.isSafeInteger(error?.elapsedMs) ? error.elapsedMs : 0,
      read_failure: readFailureOf(error),
      read_cause: firstLine(error?.cause?.message ?? error?.cause ?? error?.message ?? error),
      reason: 'the dispatched qualification could not be read, so no qualification verdict was recorded', ...tuple } });
    return 1;
  }
  await recordQualificationOutcome({ env, out, result: { ...result, ...receiptField, ...tuple } });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runQualificationObservation();
}
