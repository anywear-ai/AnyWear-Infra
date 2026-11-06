import { parseJson, canonicalJson } from './json-contract.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { normalizeTesterEmails, readAdmissionState, testerAllowlistHash } from './admission-state.mjs';
import { parseLifecycleStatus } from './lifecycle-status.mjs';
import { runtimeStack, assertRuntimeReady, describeStack } from './one-writer.mjs';

export { normalizeTesterEmails } from './admission-state.mjs';

// The tester allowlist is the only admission input, and it is read only at
// registration. These operations therefore write one SSM value through the
// deployed Service `set-testers` one-shot and prove the write from the status line
// plus one SSM read-back; there is no admission or lifecycle precondition, and no
// mode snapshot before or after. The one-shot acts on the revision the release
// slice reports; it never selects or re-verifies a Service release.
export async function runTesterAllowlist(action, input, io) {
  if (!['status', 'add', 'set'].includes(action)) throw new Error('Unknown Infra tester action');
  let payload = normalizeTesterEmails(input);
  if (action === 'status' && payload !== '[]') throw new Error('Status does not accept emails');
  const platform = await describeStack(io, 'AnyWearPlatformStack-beta');
  const runtime = await describeStack(io, runtimeStack);
  const stable = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']);
  if (!stable.has(platform?.StackStatus)) throw new Error('Stable Beta Base stack required');
  // Issue #166: Beta runs only when the Runtime stack exists; there is no
  // `BetaActive` output any more. The tester operations act on the revision that
  // stack reports.
  assertRuntimeReady(runtime, 'Tester operations');
  const values = stack => Object.fromEntries((stack.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
  const outputs = values(platform); const publicOutputs = values(runtime);
  if (outputs.EcsClusterName !== 'beta-anywear') throw new Error('Running Beta Base cluster required for tester operations');
  // The public API endpoint is the Base distribution's published URL; the Runtime
  // output is the pre-split fallback while the Service stack still owns the
  // distribution.
  const apiBaseUrl = outputs.ApiBaseUrl ?? publicOutputs.ApiBaseUrl;
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl) throw new Error('Public API endpoint unavailable for tester operations');
  const revision = workloadRevision(runtime);
  await io.aws(['ecs', 'wait', 'services-stable', '--cluster', 'beta-anywear', '--services', 'beta-anywear-api', 'beta-anywear-worker']);
  // The public endpoint must answer for the revision the slice reports before any
  // admission write.
  await io.verifyHealth(apiBaseUrl, revision);
  if (action === 'add') {
    const existing = (await io.aws(['ssm', 'get-parameter', '--name', '/anywear/beta/tester_allowlist'])).Parameter?.Value;
    payload = normalizeTesterEmails(canonicalJson([...parseJson(normalizeTesterEmails(existing)), ...parseJson(payload)]));
  }
  if (action !== 'status') {
    // The deployed Service `set-testers` command owns the list and takes the
    // normalized payload; there is no admission precondition for it to satisfy.
    await io.oneShot('lifecycle', revision, 'set-testers', payload);
  }
  // Both paths end with the same proof: the status line the Service printed and
  // the SSM value this run can read must agree on the count and the hash.
  const status = parseLifecycleStatus(await io.oneShot('lifecycle', revision, 'status'));
  const observed = await readAdmissionState(io);
  const testerCount = observed.tester_emails.length;
  const hash = testerAllowlistHash(observed.tester_emails);
  if (status.tester_count !== testerCount || status.tester_allowlist_hash !== hash) {
    throw new Error('Lifecycle status tester count/hash differs from the SSM allowlist');
  }
  // A write additionally proves it persisted exactly what it asked for, so an
  // unchanged or partially applied write cannot pass as a successful read-back.
  if (action !== 'status' && canonicalJson(observed.tester_emails) !== payload) {
    throw new Error('Tester write did not persist the requested list');
  }
  process.stdout.write(`${JSON.stringify({ operation: action === 'status' ? 'admission-status'
    : action === 'add' ? 'add-testers' : 'set-testers', tester_count: testerCount,
  tester_allowlist_hash: hash, matches: true })}\n`);
}
