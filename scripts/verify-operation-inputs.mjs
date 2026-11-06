import { appendFile } from 'node:fs/promises';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './lib/operation-boundaries.mjs';
import { runVerifyInputs } from './lib/release-inputs.mjs';

// The `verify` job completes every immutable-input check before any job acquires
// AWS credentials, and publishes exactly what it proved (#207):
//
//   * the Service-published release BYTES travel as the
//     `service-release-bytes-<run_id>-<run_attempt>` transport artifact, whose only
//     content is `.service-artifacts/selected/`;
//   * the PUBLISHED DIGEST SET travels as this step's `release_assets` output, a
//     one-line JSON object of `asset name -> sha256:<hex>` produced from the
//     Releases API response and nothing else.
//
// Neither is a record: no schema, no producer identity, no verdict, no `.sha256`
// companion. The deploy job binds them to its own dispatch inputs, re-hashes each
// travelled byte against the published digest, and only then requests an OIDC
// token. An operation that consumes no release publishes an empty asset set, and
// the deploy job fails closed if its output carries anything else.
const MAX_RELEASE_ASSETS_BYTES = 2048;

const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const release = await runVerifyInputs({ env });
const assets = release?.assets ?? {};
const encoded = JSON.stringify(assets);
if (Buffer.byteLength(encoded, 'utf8') > MAX_RELEASE_ASSETS_BYTES) {
  throw new Error(`The release asset digest set is larger than ${MAX_RELEASE_ASSETS_BYTES} bytes`);
}
if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `release_assets=${encoded}\n`);
const digests = Object.entries(assets).map(([name, digest]) => `${name} ${digest}`).join(', ');
process.stdout.write(`Verified ${boundary.workflow} ${env.INFRA_OPERATION}`
  + (release ? ` release ${release.release.tag}@${release.release.source_sha}; published ${digests}` : ' with no Service release')
  + '\n');
