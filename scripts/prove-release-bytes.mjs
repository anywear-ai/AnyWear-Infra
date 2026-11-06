import { readdir } from 'node:fs/promises';
import { parseJson, exact, matches, DIGEST } from './lib/json-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';
import { operationBoundary } from './lib/operation-boundaries.mjs';
import { validateReleaseInput, SELECTED_RELEASE_DIRECTORY,
  assertSelectedReleaseBytes, releaseAssetsFor } from './lib/release-inputs.mjs';
import { SERVICE_REPOSITORY } from './lib/deployment-contract.mjs';
import { loadLocalArtifactInputs } from './local-artifact-inputs.mjs';
import { loadSchemaAsset } from './lib/schema-asset.mjs';

// The pre-credential byte and identity proof (#207).
//
// The `verify` job proved the release identity over the Releases API and published
// two things: the release BYTES as the `service-release-bytes-<run>-<attempt>`
// transport artifact, and the PUBLISHED DIGEST SET as its `release_assets` output.
// This module is the deploy job's half, and it runs as its own step BEFORE
// `runtime-operation.mjs` -- so before the first OIDC token request:
//
//   1. re-derive this dispatch from its own inputs (validateOperationInputs,
//      operationBoundary, validateReleaseInput), never from a travelled file;
//   2. require `release_assets` to be present and to be exactly
//      `releaseAssetsFor(operation)` -- a missing, replayed or widened set fails
//      closed;
//   3. require the travelled directory to hold exactly those files and hash each
//      one once against the published digest;
//   4. strictly load the schema asset (`deploy-runtime`, `migrate`) or the
//      runtime policy (stage-base), so the CDK deploy cannot be the first reader
//      of unreadable bytes.
//
// There is no record, no `.sha256` companion and no cross-run handoff: the bytes
// and the digest set travel inside this run, and GitHub's `needs` edge binds them
// to the dispatch.
const env = process.env;
validateOperationInputs(env);
const boundary = operationBoundary(env);
const expectedRelease = validateReleaseInput(env);

function parseDigestOutput(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('The verify job published no release digest for this dispatch');
  }
  let value;
  try { value = parseJson(raw); }
  catch { throw new Error('The verify job release digest output is not valid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The verify job release digest output is not an asset map');
  }
  return value;
}

const assets = parseDigestOutput(env.VERIFIED_RELEASE_ASSETS);

if (!expectedRelease) {
  // A non-release operation consumes no bytes: the published set must be empty.
  exact(assets, [], 'travelled release assets');
  process.stdout.write(`${boundary.workflow} ${env.INFRA_OPERATION} consumes no Service release; no bytes travelled.\n`);
} else {
  const assetNames = releaseAssetsFor(env.INFRA_OPERATION);
  exact(assets, [...assetNames], 'travelled release assets');
  for (const name of assetNames) matches(assets[name], DIGEST, `travelled release asset ${name}`);
  await assertSelectedReleaseBytes(assets, SELECTED_RELEASE_DIRECTORY, assetNames);
  const travelled = (await readdir(SELECTED_RELEASE_DIRECTORY)).sort();
  const expected = [...assetNames].sort();
  if (JSON.stringify(travelled) !== JSON.stringify(expected)) {
    throw new Error(`The travelled release directory holds [${travelled.join(', ')}], not exactly [${expected.join(', ')}]`);
  }
  if (env.INFRA_OPERATION === 'deploy-runtime' || env.INFRA_OPERATION === 'migrate') {
    // The schema asset is the Runtime deploy's and the migration's only Service
    // input. Strict content validation happens here, before the restricted
    // session, so the schema-boundary gate or the task launch cannot be the first
    // consumer of an unreadable asset.
    await loadSchemaAsset(SELECTED_RELEASE_DIRECTORY);
  } else {
    // The same strict loader CDK uses, so the downloaded policy bytes are proven
    // parseable before the restricted session is requested.
    loadLocalArtifactInputs(SELECTED_RELEASE_DIRECTORY);
  }
  for (const name of assetNames) {
    process.stdout.write(`${name} ${assets[name]} matches the published digest\n`);
  }
  // "consumes", not "deploys": `migrate` takes the same identity and runs a
  // one-shot without deploying anything.
  process.stdout.write(`${boundary.workflow} ${env.INFRA_OPERATION} consumes ${SERVICE_REPOSITORY} `
    + `${expectedRelease.releaseTag}@${expectedRelease.serviceCommit} with ${assetNames.length} proven asset(s).\n`);
}
