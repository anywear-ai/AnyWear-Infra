import { readAdmissionState, testerAllowlistHash } from './admission-state.mjs';
import { retainedBetaSizingProfile } from './beta-sizing-profile.mjs';
import { runtimeStack, describeStack } from './one-writer.mjs';

// The allowlist is the only admission value left to observe: a count and a hash,
// never addresses. There is no mode record to report.
function admissionEvidence(admission) {
  const testers = admission?.tester_emails;
  return { tester_count: Array.isArray(testers) ? testers.length : 'unavailable',
    tester_allowlist_hash: Array.isArray(testers) ? testerAllowlistHash(testers) : 'unavailable' };
}

// This reports infrastructure/SSM state only; it cannot establish DB/schema
// equality. The result is a run fact printed to the step log, not a record (#207).
export async function observeBetaState(io) {
  const stacks = [];
  const state = { stacks, qualification: 'not-applicable' };
  try {
  const baseName = 'AnyWearPlatformStack-beta';
  const base = await describeStack(io, baseName);
  if (base?.StackName !== baseName || typeof base.StackStatus !== 'string') throw new Error('Beta state stack identity unavailable');
  stacks.push({ stack_name: baseName, status: base.StackStatus });
  // Issue #166: run state is one fact — whether the Runtime stack exists. The
  // absent stack is CloudFormation's own "does not exist" answer, observed as the
  // stopped state here instead of failing the read-only state operation.
  const runtime = await describeStack(io, runtimeStack);
  if (runtime === undefined) {
    stacks.push({ stack_name: runtimeStack, status: 'ABSENT', runtime_exists: false });
  } else {
    if (runtime.StackName !== runtimeStack || typeof runtime.StackStatus !== 'string') {
      throw new Error('Beta state stack identity unavailable');
    }
    stacks.push({ stack_name: runtimeStack, status: runtime.StackStatus, runtime_exists: true });
    const parameters = Object.fromEntries((runtime.Parameters ?? []).map(row => [row.ParameterKey, row.ParameterValue]));
    state.beta_sizing = { beta_api_sizing_profile: retainedBetaSizingProfile(parameters),
      runtime_verification: 'not-applicable' };
  }
  state.admission = admissionEvidence(await readAdmissionState(io));
  return state;
  } catch (cause) {
    // A failed allowlist read is reported as unavailable, never as an empty list.
    state.admission = admissionEvidence(undefined);
    const error = new Error('Complete Beta state observation unavailable', { cause });
    error.observedState = state;
    throw error;
  }
}
