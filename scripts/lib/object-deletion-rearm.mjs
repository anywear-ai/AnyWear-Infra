import { canonicalJson } from './json-contract.mjs';
import { workloadRevision } from './workload-revision.mjs';
import { assertRuntimeReady, describeStack, runtimeStack } from './one-writer.mjs';

// Issue #321: `rearm-object-deletion` is the operator's one supported repair for an
// `abandoned` object-deletion manifest. It runs one drain pass on the existing
// lifecycle task role from the immutable Service image the Runtime stack reports:
//
//   node dist/ops/object-deletion-rearm.js '{"manifest_id":"<uuid>","expected_generation":<int>}'
//
// The operation takes no Service artifact identity (only `deploy-platform`,
// `deploy-runtime`, `restore-release` and `migrate` do), so the image is the one
// the deployed release already names. The two inputs are the values the worker's
// `Object deletion manifest standing state` line reports for the oldest abandoned
// row, and the Service fences the repair on the generation the operator read.
//
// `last_rearmed_by` is `<GITHUB_ACTOR>/<GITHUB_RUN_ID>`: the one-shot task script
// passes both names in the task definition's environment for this action, so the
// Service can attribute the repair to the reviewed dispatch rather than to an
// anonymous task. A hand-run task that supplies neither still falls back to the
// Service's own `unknown-actor`/`unknown-run`, so the column is never empty.
export const REARM_OBJECT_DELETION = 'rearm-object-deletion';

/** The Service entry point the reviewed registration admits, relative to the image root. */
export const REARM_COMMAND = 'dist/ops/object-deletion-rearm.js';

/** A manifest id as the ledger stores it: a lowercase RFC 4122 UUID. */
const MANIFEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A positive decimal integer; the Service's fence compares it to `lease_generation`. */
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/;

/**
 * Read and validate the two dispatch inputs, or `null` when neither is supplied.
 *
 * The workflow passes both as empty defaults on every operation, so empty means
 * absence. A present-but-malformed pair fails here, in the credential-free
 * preflight, before any task is registered. The UUID is lowercased so the payload
 * the allow-list compares and the payload the task registers are the same bytes.
 */
export function rearmRequest(env = process.env) {
  const manifestId = env.OBJECT_DELETION_MANIFEST_ID ?? '';
  const expectedGeneration = env.OBJECT_DELETION_EXPECTED_GENERATION ?? '';
  if (manifestId === '' && expectedGeneration === '') return null;
  if (typeof manifestId !== 'string' || !MANIFEST_ID.test(manifestId)) {
    throw new Error('OBJECT_DELETION_MANIFEST_ID must be the manifest UUID from the standing-state line');
  }
  const generation = Number(expectedGeneration);
  if (typeof expectedGeneration !== 'string' || !POSITIVE_INTEGER.test(expectedGeneration)
    || !Number.isSafeInteger(generation)) {
    throw new Error('OBJECT_DELETION_EXPECTED_GENERATION must be a positive integer (the row\'s lease_generation)');
  }
  return Object.freeze({ manifest_id: manifestId.toLowerCase(), expected_generation: generation });
}

/** The required form: `rearm-object-deletion` never runs without both inputs. */
export function requireRearmRequest(env = process.env) {
  const request = rearmRequest(env);
  if (!request) {
    throw new Error('rearm-object-deletion requires OBJECT_DELETION_MANIFEST_ID and OBJECT_DELETION_EXPECTED_GENERATION');
  }
  return request;
}

/** The one positional argument the Service command parses, canonicalised once. */
export function rearmRequestArgument(env = process.env) {
  return canonicalJson(requireRearmRequest(env));
}

/**
 * The exact container command the operation is allowed to register. The
 * operation boundary and the actual-command identity check both compare against
 * this one builder, so a reordering, an extra flag or a second payload is refused
 * rather than merely unobserved.
 */
export function rearmCommand(env = process.env) {
  return ['node', REARM_COMMAND, rearmRequestArgument(env)];
}

/**
 * Run the operation: prove Beta is running, take the image identity the Runtime
 * stack already reports, and dispatch the fenced repair as the one-shot. The
 * Service command's exit code is the result — `0` reports `rearmed` or
 * `absent_discarded`, `2` is a bad argument, `3`–`6` are the fenced refusals and
 * `1` is unexpected — and `oneShot` turns every non-zero exit into a failed run,
 * so a refused repair can never read as success.
 */
export async function runObjectDeletionRearm(io, env = process.env) {
  const request = requireRearmRequest(env);
  const platform = await describeStack(io, 'AnyWearPlatformStack-beta');
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(platform?.StackStatus)) {
    throw new Error('Stable Beta Base stack required for rearm-object-deletion');
  }
  const runtime = await describeStack(io, runtimeStack);
  assertRuntimeReady(runtime, 'rearm-object-deletion');
  const revision = workloadRevision(runtime);
  await io.oneShot('lifecycle', revision, REARM_OBJECT_DELETION, canonicalJson(request));
  process.stdout.write(`${JSON.stringify({ operation: REARM_OBJECT_DELETION, manifest_id: request.manifest_id,
    expected_generation: request.expected_generation, dispatched: true })}\n`);
}
