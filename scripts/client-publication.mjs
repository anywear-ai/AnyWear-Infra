import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { parseJson, matches, exact, sha256, integer, SHA } from './lib/json-contract.mjs';
import { account, region } from './lib/deployment-contract.mjs';
import { cleanAwsEnvironment, validateOperationInputs } from './runtime-operation.mjs';
import { assertAwsAllowed, sessionPolicy } from './lib/operation-boundaries.mjs';
import {
  CLIENT_ARTIFACT_NAME, CLIENT_BUNDLE_MANIFEST, CLIENT_BUILD_METADATA, CLIENT_BUCKET,
  CLIENT_DIST_DIRECTORY, CLIENT_DOWNLOAD_DIRECTORY, CLIENT_INTERFACE_KEYS, CLIENT_INTERFACE_OUTPUTS,
  CLIENT_INTERFACE_PARAMETERS, CLIENT_PLATFORM_STACK, CLIENT_PUBLICATION_RECORD_PATH,
  CLIENT_PUBLICATION_RECORD_SCHEMA_VERSION, CLIENT_PUBLICATION_ROLE_ARN, CLIENT_REF, CLIENT_REPOSITORY,
  CLIENT_REPOSITORY_ID,
  CLIENT_WORKFLOW_PATH, CLOUDFRONT_DISTRIBUTION_ID, CLOUDFRONT_INVALIDATION_ID,
  clientInvalidationArguments, clientSyncArguments,
} from './lib/client-interface.mjs';

// Issue #344: the Client publication, in two modes.
//
// `verify` runs in `mutate.yml`'s credential-free `verify` job. It proves over the
// REST API that the run the dispatch names is a successful `release.yml` run of
// AnyWear-Client on `main` with its `build` and `verify` jobs both successful,
// downloads the `client-dist` artifact through the REST artifact endpoint, extracts
// it, recomputes the SHA-256 of `dist/bundle-manifest.json` and requires it to equal
// the dispatched `client_bundle_digest`, then writes the verified tree to the
// transport directory `mutate.yml` uploads as `client-publish-bytes-<run>-<attempt>`.
//
// `publish` runs in the `deploy` job, the only job holding an AWS credential. Every
// AWS call is checked against `assertAwsAllowed` before it is made. It re-hashes the
// travelled tree, proves the publication identity, assumes
// `beta-client-publish-role` under a session policy that carries only the three
// reads, resolves the live Beta interface from the Platform stack outputs and the
// two Cognito SSM parameters, refuses a mismatch before the first S3 write, then
// assumes the same role a second time under a session narrowed to the resolved
// bucket and distribution, runs `s3 sync --delete` and the CloudFront
// invalidation, and writes the one publication record the job uploads.
//
// Two assumptions of one role are what IAM forces: a session policy cannot name a
// bucket or a distribution whose id is only known after the live read. The first is
// read-only; the second is the publication.
const execute = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const GH_OPTIONS = { timeout: 60_000, maxBuffer: MAX_BUFFER };

const restPath = suffix => `repos/${CLIENT_REPOSITORY}/${suffix}`;
const clientRunUrl = id => `https://github.com/${CLIENT_REPOSITORY}/actions/runs/${id}`;

/** One REST read through the App installation token the job minted. */
async function readApi({ run, token }, endpoint) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('A read-only AnyWear-Client App token is required to read the Client publisher run');
  }
  const env = { ...process.env, GH_TOKEN: token, GH_TELEMETRY: 'disabled' };
  return parseJson((await run('gh', ['api', endpoint], { env, ...GH_OPTIONS })).stdout);
}

/**
 * Prove the Client publisher run: the repository id (immutable across the owner
 * transfer), the workflow path, the branch, a successful conclusion, the attempt
 * the dispatch named, and the two jobs that build and verify the bundle. Nothing
 * about the artifact is read before this succeeds.
 */
export function assertPublisherRun(publisherRun, { client_run_id: runId, client_run_attempt: attempt }) {
  if (!publisherRun || typeof publisherRun !== 'object' || Array.isArray(publisherRun)) {
    throw new Error('The Client publisher run response is malformed');
  }
  if (publisherRun.repository?.id !== CLIENT_REPOSITORY_ID) {
    throw new Error(`Client run ${runId} belongs to repository id ${String(publisherRun.repository?.id)}, not ${CLIENT_REPOSITORY_ID}`);
  }
  if (publisherRun.path !== CLIENT_WORKFLOW_PATH) {
    throw new Error(`Client run ${runId} ran ${String(publisherRun.path)}, not ${CLIENT_WORKFLOW_PATH}`);
  }
  if (publisherRun.head_branch !== CLIENT_REF) {
    throw new Error(`Client run ${runId} ran on ${String(publisherRun.head_branch)}, not ${CLIENT_REF}`);
  }
  if (publisherRun.run_attempt !== attempt) {
    throw new Error(`Client run ${runId} is attempt ${String(publisherRun.run_attempt)}, not the dispatched attempt ${attempt}`);
  }
  if (publisherRun.status !== 'completed' || publisherRun.conclusion !== 'success') {
    throw new Error(`Client run ${runId} is ${String(publisherRun.status)}/${String(publisherRun.conclusion)}, not a completed success`);
  }
  return matches(publisherRun.head_sha, SHA, `Client run ${runId} source commit`);
}

/** Both publisher jobs that produce and verify the bundle must have succeeded. */
export function assertPublisherJobs(jobs, runId) {
  if (!Array.isArray(jobs)) throw new Error(`The Client run ${runId} job list is malformed`);
  const conclusionOf = name => jobs.find(job => job?.name === name)?.conclusion;
  for (const name of ['build', 'verify']) {
    if (conclusionOf(name) !== 'success') {
      throw new Error(`Client run ${runId} job ${name} is ${String(conclusionOf(name) ?? 'absent')}, not a success`);
    }
  }
}

/** The one unexpired `client-dist` artifact the run published. */
export function findClientDistArtifact(artifacts, runId) {
  if (!Array.isArray(artifacts)) throw new Error(`The Client run ${runId} artifact list is malformed`);
  const matchesNamed = artifacts.filter(artifact => artifact?.name === CLIENT_ARTIFACT_NAME);
  if (matchesNamed.length !== 1) {
    throw new Error(`Client run ${runId} published ${matchesNamed.length} ${CLIENT_ARTIFACT_NAME} artifact(s), not one`);
  }
  const [artifact] = matchesNamed;
  if (artifact.expired !== false) throw new Error(`Client run ${runId} ${CLIENT_ARTIFACT_NAME} artifact is expired or unstated`);
  if (artifact.workflow_run?.id !== undefined && artifact.workflow_run.id !== runId) {
    throw new Error(`Client artifact ${String(artifact.id)} belongs to run ${String(artifact.workflow_run.id)}, not ${runId}`);
  }
  return { id: integer(artifact.id, 'Client artifact id'), size: artifact.size_in_bytes };
}

// A minimal ZIP reader for the REST artifact endpoint: the endpoint answers a ZIP
// archive and this repository carries no archive dependency. It reads the central
// directory, admits only stored and deflated entries, refuses any unsafe entry name
// and verifies each entry's CRC and size, so a truncated or rewritten download
// cannot become the published tree.
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_DIRECTORY = 0x06054b50;

function unsafeEntryName(name) {
  const normalized = name.replaceAll('\\', '/');
  return normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some(part => part === '..');
}

export function readZipEntries(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let end = -1;
  for (let index = buffer.length - 22; index >= 0 && index >= buffer.length - 22 - 0xffff; index--) {
    if (buffer.readUInt32LE(index) === ZIP_END_OF_DIRECTORY) { end = index; break; }
  }
  if (end < 0) throw new Error('The downloaded artifact is not a ZIP archive: no end-of-directory record');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = [];
  for (let index = 0; index < entries; index++) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) {
      throw new Error(`The ZIP archive central directory record ${index} is malformed`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error(`The ZIP archive entry ${name} uses a ZIP64 record, which is not supported`);
    }
    if (unsafeEntryName(name)) throw new Error(`The ZIP archive carries an unsafe entry name '${name}'`);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw new Error(`The ZIP archive local header for ${name} is malformed`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : undefined;
    if (data === undefined) throw new Error(`The ZIP archive entry ${name} uses unsupported method ${method}`);
    if (data.length !== uncompressedSize) throw new Error(`The ZIP archive entry ${name} has the wrong uncompressed size`);
    if (typeof crc32 === 'function' && crc32(data) !== expectedCrc) {
      throw new Error(`The ZIP archive entry ${name} does not match its CRC`);
    }
    files.push({ name: name.replaceAll('\\', '/'), data });
  }
  if (files.length === 0) throw new Error('The downloaded artifact is an empty ZIP archive');
  return files;
}

/** Extract the archive under one directory, creating each parent directory. */
export async function extractZip(bytes, directory) {
  await rm(directory, { recursive: true, force: true });
  const files = readZipEntries(bytes);
  for (const file of files) {
    const destination = path.join(directory, ...file.name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.data);
  }
  return files.map(file => file.name);
}

const isFile = async (file) => {
  try {
    return (await readdir(path.dirname(file))).includes(path.basename(file));
  } catch {
    return false;
  }
};

/**
 * The `client-dist` artifact's root depends on the Client's upload search path, so
 * the manifest is either at `bundle-manifest.json` or at `dist/bundle-manifest.json`
 * inside the archive. Exactly one of the two is the tree; it is copied to
 * `CLIENT_DIST_DIRECTORY`, which is what the transport artifact uploads and what
 * `s3 sync` writes to the bucket root.
 */
export async function normalizeBundleTree(download = CLIENT_DOWNLOAD_DIRECTORY, destination = CLIENT_DIST_DIRECTORY) {
  const candidates = [];
  if (await isFile(path.join(download, 'dist', CLIENT_BUNDLE_MANIFEST))) candidates.push(path.join(download, 'dist'));
  if (await isFile(path.join(download, CLIENT_BUNDLE_MANIFEST))) candidates.push(download);
  if (candidates.length !== 1) {
    throw new Error(`The downloaded ${CLIENT_ARTIFACT_NAME} artifact carries ${candidates.length} bundle roots, not one`);
  }
  const [tree] = candidates;
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(tree, destination, { recursive: true });
  for (const name of [CLIENT_BUNDLE_MANIFEST, CLIENT_BUILD_METADATA]) {
    if (!await isFile(path.join(destination, name))) {
      throw new Error(`The downloaded ${CLIENT_ARTIFACT_NAME} artifact carries no ${name}`);
    }
  }
  return destination;
}

/** The digest the dispatch names: the SHA-256 of the manifest's bytes. */
export async function bundleManifestDigest(directory = CLIENT_DIST_DIRECTORY) {
  const bytes = await readFile(path.join(directory, CLIENT_BUNDLE_MANIFEST));
  return sha256(bytes);
}

/**
 * The bundle's own record of what it was built from and for: the Client source
 * commit, the schema of that record and the three interface values. The three are
 * what the live interface must match before any byte is written.
 */
export async function readBuildMetadata(directory = CLIENT_DIST_DIRECTORY) {
  const metadata = parseJson(await readFile(path.join(directory, CLIENT_BUILD_METADATA)));
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('The bundle build-metadata.json is not an object');
  }
  if (metadata.component !== 'AnyWear-Client') {
    throw new Error(`The bundle build-metadata.json names component ${String(metadata.component)}, not AnyWear-Client`);
  }
  matches(metadata.source_commit, SHA, 'bundle source commit');
  integer(metadata.schema_version, 'bundle build-metadata schema version');
  for (const key of CLIENT_INTERFACE_KEYS) {
    if (typeof metadata.interface?.[key] !== 'string' || metadata.interface[key] === '') {
      throw new Error(`The bundle build-metadata.json carries no interface.${key}`);
    }
  }
  return { source_commit: metadata.source_commit, build_metadata_schema_version: metadata.schema_version,
    interface: Object.fromEntries(CLIENT_INTERFACE_KEYS.map(key => [key, metadata.interface[key]])) };
}

async function writeOutput(env, values) {
  if (typeof env.GITHUB_OUTPUT !== 'string' || env.GITHUB_OUTPUT === '') return;
  await appendFile(env.GITHUB_OUTPUT, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
}

/**
 * `verify` mode. Proves the Client publisher run, downloads and extracts the
 * `client-dist` artifact, recomputes the manifest digest and writes the verified
 * tree for the transport upload. It holds an App token narrowed to a read of the
 * Client repository and no AWS credential of any kind.
 */
export async function verifyClientBundle({ env = process.env, run = execute, request = fetch,
  directory = CLIENT_DOWNLOAD_DIRECTORY, tree = CLIENT_DIST_DIRECTORY, out = process.stdout } = {}) {
  const inputs = validateOperationInputs(env);
  if (inputs.operation !== 'publish-client') {
    throw new Error(`The Client publication verifies only publish-client, not ${inputs.operation}`);
  }
  const { client_run_id: runId, client_run_attempt: attempt, client_bundle_digest: digest } = inputs.client_publication;
  const token = env.GH_TOKEN;
  const publisherRun = await readApi({ run, token }, restPath(`actions/runs/${runId}`));
  const headSha = assertPublisherRun(publisherRun, inputs.client_publication);
  const jobs = await readApi({ run, token }, restPath(`actions/runs/${runId}/jobs`));
  assertPublisherJobs(jobs?.jobs, runId);
  const artifacts = await readApi({ run, token }, restPath(`actions/runs/${runId}/artifacts`));
  const artifact = findClientDistArtifact(artifacts?.artifacts, runId);
  out.write(`Client publisher run ${clientRunUrl(runId)} attempt ${attempt} is ${CLIENT_WORKFLOW_PATH} on ${CLIENT_REF}:`
    + ` ${String(publisherRun.conclusion)}, jobs build and verify succeeded, source ${headSha}.\n`);

  const zipUrl = `https://api.github.com/repos/${CLIENT_REPOSITORY}/actions/artifacts/${artifact.id}/zip`;
  const response = await request(zipUrl, { headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
  }, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`The Client ${CLIENT_ARTIFACT_NAME} artifact ${artifact.id} download answered ${response.status}`);
  const names = await extractZip(Buffer.from(await response.arrayBuffer()), directory);
  out.write(`Downloaded ${CLIENT_ARTIFACT_NAME} artifact ${artifact.id} and extracted ${names.length} file(s).\n`);

  const bundleTree = await normalizeBundleTree(directory, tree);
  const observed = await bundleManifestDigest(bundleTree);
  if (observed !== digest) {
    throw new Error(`The bundle manifest digest ${observed} is not the dispatched client_bundle_digest ${digest}`);
  }
  const metadata = await readBuildMetadata(bundleTree);
  if (metadata.source_commit !== headSha) {
    throw new Error(`The bundle was built from ${metadata.source_commit}, not the publisher run's source ${headSha}`);
  }
  out.write(`${CLIENT_BUNDLE_MANIFEST} sha256 ${observed} equals the dispatched client_bundle_digest ${digest}.\n`);
  out.write(`The bundle names Client source ${metadata.source_commit}, which is the publisher run's head sha.\n`);
  out.write(`Wrote the verified ${CLIENT_ARTIFACT_NAME} tree to ${bundleTree} for the transport artifact.\n`);
  await writeOutput(env, { client_bundle_digest: observed, client_source_commit: metadata.source_commit });
  return { digest: observed, source_commit: metadata.source_commit, run_url: clientRunUrl(runId), files: names.length };
}

/**
 * Assume `beta-client-publish-role` under one inline session policy. The role ARN
 * is the reviewed workflow literal; the session name says which half of the
 * publication this is, so an operator reading CloudTrail sees the resolution read
 * apart from the write.
 */
export async function assumeClientSession({ env = process.env, policy, requestToken = fetch,
  run = execute, sessionMarker } = {}) {
  if (env.CLIENT_PUBLISH_ROLE_ARN !== CLIENT_PUBLICATION_ROLE_ARN) {
    throw new Error('The dedicated Beta Client publish role is not configured');
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error('Protected GitHub OIDC executor required');
  }
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com')) {
    throw new Error('Unexpected OIDC request endpoint');
  }
  request.searchParams.set('audience', 'sts.amazonaws.com');
  const response = await requestToken(request, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('OIDC token retrieval failed');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || !token) throw new Error('OIDC token missing');
  const sessionName = `client-publish-${sessionMarker === undefined ? '' : `${sessionMarker}-`}`
    + `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  let assumed;
  try {
    assumed = parseJson((await run('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', CLIENT_PUBLICATION_ROLE_ARN,
      '--role-session-name', sessionName, '--web-identity-token', token, '--policy', policy,
      '--duration-seconds', '3600', '--output', 'json'],
    { env: cleanAwsEnvironment(env), timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
  } catch {
    // The failed call's arguments carry the OIDC token; keep them out of the log.
    throw new Error('Dedicated restricted STS assumption failed for the Client publish role');
  }
  if (assumed.AssumedRoleUser?.Arn !== `arn:aws:sts::${account}:assumed-role/beta-client-publish-role/${sessionName}`) {
    throw new Error('Dedicated assumed Client publish principal mismatch');
  }
  const credentials = assumed.Credentials;
  return { ...cleanAwsEnvironment(env), AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: region, AWS_DEFAULT_REGION: region };
}

/**
 * One AWS call under the client-publish session. The allow-list is asked first,
 * with the live interface the run resolved, so a call the session cannot make is
 * refused before the CLI starts.
 */
function clientAws({ env, credentials, run, resources, out }) {
  return async (args) => {
    assertAwsAllowed(env, args, 'operation', 'client-publish', resources);
    const result = await run('aws', [...args, '--region', region, '--output', 'json'],
      { env: credentials, timeout: 600_000, maxBuffer: MAX_BUFFER });
    const stdout = String(result.stdout ?? '').trim();
    if (stdout) out.write(`${args.slice(0, 2).join(' ')}: ${stdout.split('\n').slice(-1)[0].slice(0, 400)}\n`);
    return stdout ? parseJson(stdout) : {};
  };
}

/**
 * Resolve the live Beta interface: the three Platform-stack outputs and the two
 * Cognito parameters. The stack is read by name and the outputs are required by
 * name, so a renamed output is a refusal naming it rather than a silent empty
 * value.
 */
export async function resolveLiveInterface(aws) {
  const identity = await aws(['sts', 'get-caller-identity']);
  if (identity?.Account !== account) throw new Error(`The Client publish session is in account ${String(identity?.Account)}, not ${account}`);
  if (typeof identity.Arn !== 'string' || !/^arn:aws:sts::650880818323:assumed-role\/beta-client-publish-role\//.test(identity.Arn)) {
    throw new Error('The Client publish session is not the dedicated publish role');
  }
  const described = await aws(['cloudformation', 'describe-stacks', '--stack-name', CLIENT_PLATFORM_STACK]);
  const outputs = described?.Stacks?.[0]?.Outputs;
  if (!Array.isArray(outputs)) throw new Error(`${CLIENT_PLATFORM_STACK} carries no outputs`);
  const output = key => {
    const value = outputs.find(entry => entry?.OutputKey === key)?.OutputValue;
    if (typeof value !== 'string' || value === '') throw new Error(`${CLIENT_PLATFORM_STACK} has no ${key} output`);
    return value;
  };
  // The interface the bundle must match is read first, then the two resources the
  // publication writes: a refused interface never needs the bucket or the
  // distribution to be named.
  const apiBaseUrl = output(CLIENT_INTERFACE_OUTPUTS.api_base_url);
  const parameters = {};
  for (const [name, parameter] of Object.entries(CLIENT_INTERFACE_PARAMETERS)) {
    const value = (await aws(['ssm', 'get-parameter', '--name', parameter]))?.Parameter?.Value;
    if (typeof value !== 'string' || value === '') throw new Error(`SSM parameter ${parameter} is absent, so the live ${name} is unknown`);
    parameters[name] = value;
  }
  const bucket = output(CLIENT_INTERFACE_OUTPUTS.bucket);
  // An S3 call must name a bucket in the form this account deploys; a value that
  // cannot be one is refused here rather than by the CLI on the write.
  if (!CLIENT_BUCKET.test(bucket)) throw new Error(`${CLIENT_PLATFORM_STACK} ${CLIENT_INTERFACE_OUTPUTS.bucket} '${bucket}' is not a bucket name`);
  const distributionId = output(CLIENT_INTERFACE_OUTPUTS.distribution_id);
  if (!CLOUDFRONT_DISTRIBUTION_ID.test(distributionId)) {
    throw new Error(`${CLIENT_PLATFORM_STACK} ${CLIENT_INTERFACE_OUTPUTS.distribution_id} '${distributionId}' is not a distribution id`);
  }
  return { api_base_url: apiBaseUrl, ...parameters, bucket, distribution_id: distributionId };
}

/**
 * Refuse a live interface that differs from the interface the bundle was built
 * for, naming the key and both values. This runs before the first `s3 sync`, so a
 * mismatched build never reaches the bucket.
 */
export function assertInterfaceMatches(built, live) {
  for (const key of CLIENT_INTERFACE_KEYS) {
    if (built[key] !== live[key]) {
      throw new Error(`The live Beta interface differs from the built bundle for ${key}: the bundle was built for '${built[key]}',`
        + ` Beta serves '${live[key]}'; no asset was written`);
    }
  }
  return true;
}

/**
 * The one `publication-record.json` this run writes (issue #344 v2). It names the
 * Client run whose bytes were copied, in `publisher`, and this Infra run in
 * `run_id`/`run_attempt`; `operation` states which Infra operation performed the
 * write. The Client run's identity is never promoted to this record's own run
 * identity, so a reader can tell the copier from the copier's source.
 */
export function publicationRecord({ env = process.env, digest, source, buildMetadataSchemaVersion, live,
  invalidationId, publishedAt }) {
  return {
    schema_version: CLIENT_PUBLICATION_RECORD_SCHEMA_VERSION,
    component: 'AnyWear-Client',
    source_commit: source,
    publisher: {
      repository: CLIENT_REPOSITORY,
      run_id: Number(env.CLIENT_RUN_ID),
      run_attempt: Number(env.CLIENT_RUN_ATTEMPT),
      bundle_manifest_sha256: digest,
      build_metadata_schema_version: buildMetadataSchemaVersion,
    },
    // The Infra run that performed the publication, not the Client run above.
    run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    operation: env.INFRA_OPERATION,
    bucket: live.bucket,
    distribution_id: live.distribution_id,
    invalidation_id: invalidationId,
    interface: Object.fromEntries(CLIENT_INTERFACE_KEYS.map(key => [key, live[key]])),
    published_at: publishedAt,
  };
}

/**
 * `publish` mode. Re-hashes the travelled tree, proves the publication identity,
 * resolves and matches the live interface, performs the two writes under the
 * narrowed session and writes the publication record.
 */
export async function publishClientBundle({ env = process.env, run = execute, requestToken = fetch,
  now = () => new Date(), out = process.stdout, directory = CLIENT_DIST_DIRECTORY,
  recordPath = CLIENT_PUBLICATION_RECORD_PATH } = {}) {
  const inputs = validateOperationInputs(env);
  if (inputs.operation !== 'publish-client') {
    throw new Error(`The Client publication publishes only publish-client, not ${inputs.operation}`);
  }
  const { client_bundle_digest: digest } = inputs.client_publication;
  // The transported bytes are hashed once here, against the digest the dispatch
  // named and the digest the verify job computed over the same bytes.
  const observed = await bundleManifestDigest(directory);
  if (observed !== digest) {
    throw new Error(`The travelled bundle manifest digest ${observed} is not the dispatched client_bundle_digest ${digest}`);
  }
  const verified = env.VERIFIED_CLIENT_BUNDLE_DIGEST ?? '';
  if (verified !== '' && verified !== observed) {
    throw new Error(`The travelled bundle manifest digest ${observed} is not the digest the verify job published ${verified}`);
  }
  out.write(`${CLIENT_BUNDLE_MANIFEST} sha256 ${observed} equals the dispatched client_bundle_digest ${digest}`
    + `${verified === '' ? '' : ` and the verify job's ${verified}`}.\n`);
  const metadata = await readBuildMetadata(directory);

  // Phase one: the read-only resolution session.
  const resolution = await assumeClientSession({ env, requestToken, run, policy: sessionPolicy('client-publish', env) });
  const resolveAws = clientAws({ env, credentials: resolution, run, resources: undefined, out });
  const live = await resolveLiveInterface(resolveAws);
  out.write(`Live Beta interface: ${CLIENT_INTERFACE_KEYS.map(key => `${key}=${live[key]}`).join(', ')};`
    + ` bucket ${live.bucket}; distribution ${live.distribution_id}.\n`);
  assertInterfaceMatches(metadata.interface, live);

  // Phase two: the publication session, narrowed to the resources just resolved.
  const publication = await assumeClientSession({ env, requestToken, run, sessionMarker: 'publish',
    policy: sessionPolicy('client-publish', env, 'operation', live) });
  const publishAws = clientAws({ env, credentials: publication, run, resources: live, out });
  await publishAws(clientSyncArguments(live.bucket));
  const invalidation = await publishAws(clientInvalidationArguments(live.distribution_id));
  const invalidationId = invalidation?.Invalidation?.Id;
  if (typeof invalidationId !== 'string' || !CLOUDFRONT_INVALIDATION_ID.test(invalidationId)) {
    throw new Error('The CloudFront invalidation response names no invalidation id');
  }
  out.write(`Synced ${directory} to s3://${live.bucket} with --delete and invalidated`
    + ` ${live.distribution_id} for /* as ${invalidationId}.\n`);

  const record = publicationRecord({ env, digest: observed, source: metadata.source_commit,
    buildMetadataSchemaVersion: metadata.build_metadata_schema_version, live,
    invalidationId, publishedAt: now().toISOString() });
  exact(record, ['schema_version', 'component', 'source_commit', 'publisher', 'run_id', 'run_attempt', 'operation',
    'bucket', 'distribution_id', 'invalidation_id', 'interface', 'published_at'], 'publication record');
  exact(record.publisher, ['repository', 'run_id', 'run_attempt', 'bundle_manifest_sha256',
    'build_metadata_schema_version'], 'publication record publisher');
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  out.write(`Wrote ${recordPath} for Client source ${record.source_commit}`
    + ` (publisher run ${record.publisher.run_id}/${record.publisher.run_attempt},`
    + ` digest ${record.publisher.bundle_manifest_sha256}; Infra run ${record.run_id}/${record.run_attempt}).\n`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'verify') await verifyClientBundle();
  else if (mode === 'publish') await publishClientBundle();
  else throw new Error(`Unknown client-publication mode '${String(mode)}': expected verify or publish`);
}
