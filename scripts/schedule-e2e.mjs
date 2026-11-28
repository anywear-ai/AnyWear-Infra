import { pathToFileURL } from 'node:url';
import { matches, SHA } from './lib/json-contract.mjs';
import { dispatchingRunUrl } from './lib/delivery-inputs.mjs';
import { dispatchRun } from './e2e-dispatch.mjs';

// Issue #344: the Infra scheduled entry (`schedule.yml`). The nightly run and a
// manual dispatch reach the same three-operation menu, and every one of them is a
// gate run the Infra run starts and holds to a terminal state:
//
//   reconcile → E2E `reconcile` with `trigger=scheduled`
//   smoke     → E2E `smoke` with `trigger=deploy-smoke`
//   full      → E2E `full` with `trigger=release-gate` and the expected commits
//
// The entry holds `anywear-infra-runtime` for the whole run, mints the existing
// AnyWear-E2E `actions: write` App token and declares no environment, no `id-token`
// and no AWS credential of its own. `reconcile` is what the schedule starts, so the
// nightly window needs no inputs at all.
//
// `validate` is the credential-free preflight: it proves reviewed main, the open
// stage switch and the operation/input scope before the hold job can mint a token.

/** The scheduled entry's operation menu. A value outside it is refused. */
export const SCHEDULE_OPERATIONS = Object.freeze(['reconcile', 'smoke', 'full']);
/** The one E2E trigger each operation maps to (ADR 0033 §8). */
export const SCHEDULE_TRIGGERS = Object.freeze({
  reconcile: 'scheduled', smoke: 'deploy-smoke', full: 'release-gate',
});

/**
 * Validate the entry before any job holds a token: reviewed main, the open stage
 * switch, a menu operation, and the expected-commit scope — `full` requires a
 * 40-hex Service commit, and only `full` accepts either expected commit. Returns
 * the accepted values, so the dispatch and the observation use the same ones.
 */
export function validateScheduleEntry(env = process.env) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('The scheduled entry requires reviewed main');
  if (env.ENABLE_BETA_MUTATION !== 'true') throw new Error('The scheduled entry requires the stage switch open');
  const operation = env.SCHEDULE_OPERATION;
  if (!SCHEDULE_OPERATIONS.includes(operation)) {
    throw new Error(`The scheduled entry requires one of ${SCHEDULE_OPERATIONS.join(', ')} (got '${String(operation)}')`);
  }
  const expectedServiceCommit = env.EXPECTED_SERVICE_COMMIT ?? '';
  const expectedClientCommit = env.EXPECTED_CLIENT_COMMIT ?? '';
  if (operation === 'full') {
    matches(expectedServiceCommit, SHA, 'expected_service_commit for a full gate run');
  } else if (expectedServiceCommit !== '' || expectedClientCommit !== '') {
    throw new Error(`Only full accepts an expected commit; ${operation} names none`);
  }
  if (expectedClientCommit !== '') matches(expectedClientCommit, SHA, 'expected_client_commit');
  return { operation, expected_service_commit: expectedServiceCommit, expected_client_commit: expectedClientCommit,
    dispatched_by: dispatchingRunUrl(env) };
}

/** The `beta-e2e.yml` payload for one menu operation. */
export function schedulePayload(env = process.env) {
  const inputs = validateScheduleEntry(env);
  const payload = { operation: inputs.operation, trigger: SCHEDULE_TRIGGERS[inputs.operation],
    dispatched_by: inputs.dispatched_by };
  // ADR 0033 §8: the expected commits are `full`-only inputs, and `release-gate`
  // requires the Service commit. The worker slot offset keeps its reviewed default
  // (`0`) rather than being restated here.
  if (inputs.operation === 'full') {
    payload.expected_service_commit = inputs.expected_service_commit;
    if (inputs.expected_client_commit !== '') payload.expected_client_commit = inputs.expected_client_commit;
  }
  return payload;
}

/**
 * Dispatch the gate run and expose the created run's id and URL through the
 * step's `GITHUB_OUTPUT`, which the observation step reads. The dispatch is made on
 * every invocation; the by-id verification and the bounded fallback are
 * `e2e-dispatch.mjs`'s, so the scheduled entry and the deploy chain hold their runs
 * the same way.
 */
export async function dispatchScheduledGate({ env = process.env, ...options } = {}) {
  return dispatchRun({ env, ...options, payload: schedulePayload(env) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = process.argv[2];
  if (mode === 'validate') {
    const inputs = validateScheduleEntry();
    process.stdout.write(`Scheduled gate run ${inputs.operation} -> trigger ${SCHEDULE_TRIGGERS[inputs.operation]}`
      + ` by ${inputs.dispatched_by}${inputs.expected_service_commit === '' ? '' : ` for Service commit ${inputs.expected_service_commit}`}`
      + `${inputs.expected_client_commit === '' ? '' : ` and Client commit ${inputs.expected_client_commit}`}.\n`);
  } else if (mode === 'dispatch') {
    await dispatchScheduledGate();
  } else {
    throw new Error(`Unknown schedule-e2e mode '${String(mode)}': expected validate or dispatch`);
  }
}
