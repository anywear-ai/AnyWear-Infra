import { pathToFileURL } from 'node:url';
import { observeQualification, recordQualificationOutcome } from './qualification-dispatch.mjs';

// #338: the deploy chain's hold recorder. It is the `qualify-hold` job's last step
// and runs under `if: always()`, so every deployment run that took the hold ends
// with exactly one `qualified` or `unqualified` line in its step summary and its
// `outcome` step output. The step never changes the `deploy` job's conclusion.
//
// The exit code separates the three states. No run id and no run URL means this job
// recorded no dispatched run — a step of the job failed before one existed — so the
// outcome is recorded `unqualified` saying that no qualification run was created and
// no run id or URL was recorded, and the step exits zero because the job is already
// red from the step that failed. A dispatched run that cannot be read is recorded
// `unqualified` naming the unread run and the read cause, and exits non-zero: an
// unknown hold is never recorded as a good one. A terminal non-success run, the
// 55-minute ceiling and `qualified` all record their one outcome and exit zero.
export async function runQualificationObservation(
  { env = process.env, run, wait, out = process.stdout, now = Date.now } = {}) {
  const runId = env.QUALIFICATION_RUN_ID;
  const runUrl = env.QUALIFICATION_RUN_URL;
  // The outcome names the deployed Service commit, which the workflow carries
  // directly and, for a release operation, inside the sealed artifact tag.
  const taggedCommit = typeof env.SERVICE_ARTIFACT_TAG === 'string'
    && /^service-artifacts-[0-9a-f]{40}$/.test(env.SERVICE_ARTIFACT_TAG)
    ? env.SERVICE_ARTIFACT_TAG.slice('service-artifacts-'.length) : undefined;
  const serviceCommit = [env.SERVICE_COMMIT, taggedCommit]
    .find(value => typeof value === 'string' && value !== '');
  const tuple = serviceCommit === undefined ? {} : { service_commit: serviceCommit };
  if ((typeof runId !== 'string' || runId === '') && (typeof runUrl !== 'string' || runUrl === '')) {
    await recordQualificationOutcome({ env, out, result: { outcome: 'unqualified',
      reason: 'no qualification run was created and no dispatched run id or URL was recorded, so the deployed tuple carries no qualification record', ...tuple } });
    return 0;
  }
  let result;
  try {
    result = await observeQualification({ env, run, wait, out, now, runId, runUrl });
  } catch (error) {
    const named = typeof runUrl === 'string' && runUrl !== '' ? runUrl : `run ${runId}`;
    await recordQualificationOutcome({ env, out, result: { outcome: 'unqualified',
      run_url: typeof runUrl === 'string' && runUrl !== '' ? runUrl : undefined,
      reason: `the dispatched qualification ${named} could not be read, so the deployed tuple carries no qualification record:`
        + ` ${error?.message ?? error}`, ...tuple } });
    return 1;
  }
  await recordQualificationOutcome({ env, out, result: { ...result, ...tuple } });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runQualificationObservation();
}
