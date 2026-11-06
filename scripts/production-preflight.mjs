import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseJson, sha256, HASH, SHA, DIGEST, canonicalJson, exact, matches, integer } from './lib/json-contract.mjs';
import { stageContractSchemaHash, validateStageInputs } from '../lib/contracts.mjs';

const execute = promisify(execFile);
// Issue #266: the durable owner is the `anywear-ai` organization, so a machine
// reference (an API path, a record field or a verifier origin) names the new
// owner; the old name keeps resolving through GitHub's transfer redirect. The
// current run's own repository is matched by its immutable numeric id below.
const E2E = 'anywear-ai/AnyWear-E2E';
const SERVICE = 'anywear-ai/AnyWear-Service';
const CLIENT = 'anywear-ai/AnyWear-Client';
const QUALIFICATION_WORKFLOW = '.github/workflows/beta-qualification.yml';
export const PRODUCTION_WORKFLOW = '.github/workflows/production.yml';

// Production is not onboarded. Its source blocker is `promote-production.mjs`; the
// preflight below stays source-reviewed but no longer reads a committed selection:
// the reviewed Service release identity is explicit (`SERVICE_RELEASE_ID`,
// `SERVICE_SOURCE_SHA`, `SERVICE_IMAGE_DIGEST`), exactly like the Beta release path.
// Nothing below executes a Production mutation: the workflow is `workflow_call`-only
// and the source blocker fails before any credential even when an activation
// variable changes.
export function validateProductionContext(env = process.env) {
  // Issue #266: the repository numeric id is the durable identity across a
  // transfer, and the workflow ref is compared against this run's own full
  // name, so the guard passes under either owner without naming one.
  if (env.GITHUB_REPOSITORY_ID !== '1409047265' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/${PRODUCTION_WORKFLOW}@refs/heads/main`) {
    throw new Error('Protected Production activation remains closed');
  }
  matches(env.GITHUB_SHA, SHA, 'Production source');
  matches(env.AWS_ACCOUNT_ID, /^[0-9]{12}$/, 'Production account');
  if (env.AWS_ACCOUNT_ID === '650880818323' || env.AWS_REGION !== 'ap-east-1') throw new Error('Production requires its separate reviewed account and ap-east-1 region');
  if (env.PROD_DEPLOY_ROLE_ARN !== `arn:aws:iam::${env.AWS_ACCOUNT_ID}:role/prod-infra-deploy-role`) {
    throw new Error('Dedicated Production role required; no shared-role fallback');
  }
  for (const field of ['QUALIFICATION_RUN_ID', 'QUALIFICATION_RUN_ATTEMPT', 'QUALIFICATION_ARTIFACT_ID', 'SERVICE_RELEASE_ID']) {
    matches(env[field], /^[1-9][0-9]*$/, field); integer(Number(env[field]), field);
  }
  matches(env.QUALIFICATION_RECORD_SHA256, HASH, 'qualification byte hash'); matches(env.QUALIFICATION_E2E_SHA, SHA, 'qualified E2E');
  matches(env.SERVICE_SOURCE_SHA, SHA, 'reviewed Service source');
  matches(env.SERVICE_IMAGE_DIGEST, DIGEST, 'reviewed Service image digest');
}

export function readReviewedRelease(env = process.env) {
  validateProductionContext(env);
  return { release_id: Number(env.SERVICE_RELEASE_ID), source_sha: env.SERVICE_SOURCE_SHA, image_digest: env.SERVICE_IMAGE_DIGEST };
}

export function assertTrustedQualificationMetadata(run, artifact, env = process.env, now = Date.now()) {
  if (run.id !== Number(env.QUALIFICATION_RUN_ID) || run.run_attempt !== Number(env.QUALIFICATION_RUN_ATTEMPT) || run.head_sha !== env.QUALIFICATION_E2E_SHA
    || run.repository?.full_name !== E2E || run.head_repository?.full_name !== E2E || run.head_branch !== 'main'
    || run.path !== QUALIFICATION_WORKFLOW || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Trusted completed-success E2E qualification required');
  }
  if (artifact.id !== Number(env.QUALIFICATION_ARTIFACT_ID) || artifact.expired !== false || artifact.name !== `beta-qualification-${run.id}-${run.run_attempt}`
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= now) throw new Error('Exact qualification artifact unavailable');
  const start = Date.parse(run.run_started_at); const end = Date.parse(run.updated_at); const created = Date.parse(artifact.created_at);
  if (![start, end, created].every(Number.isFinite) || start > end || created < start || created > end) {
    throw new Error('Qualification artifact does not belong to the trusted attempt interval');
  }
}

export function assertStableRelease(stable, commit, mainComparison, release, env = process.env) {
  if (stable.id !== Number(env.STABLE_RELEASE_ID) || stable.draft !== false || stable.prerelease !== false || stable.immutable !== true
    || !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stable.tag_name ?? '')) {
    throw new Error('Production requires a sealed stable vMAJOR.MINOR.PATCH Service release');
  }
  if (commit?.type !== 'commit' || commit.sha !== release.source_sha) throw new Error('Stable release does not represent qualified image source');
  if (!['identical', 'ahead'].includes(mainComparison.status) || mainComparison.merge_base_commit?.sha !== release.source_sha) {
    throw new Error('Stable source is not in reviewed Service main history');
  }
}

// Schema v3 of the Beta qualification record: flat, self-contained, and written
// only by the E2E `full` operation. It removes the `compatibility` pin and the
// two downloaded deployment records (`deployment`) that v2 embedded.
const QUALIFICATION_MEMBERS = Object.freeze(['schema_version', 'record_type', 'qualification_id', 'result', 'operation',
  'qualified_at', 'environment', 'expected', 'revisions', 'service_artifacts', 'observations', 'test', 'workflow', 'integrity']);
const OBSERVATION_MEMBERS = Object.freeze(['collected_at', 'client', 'service', 'platform', 'authenticated']);
const OBSERVATION_CLIENT_MEMBERS = Object.freeze(['url', 'source_commit', 'built_at']);
const OBSERVATION_SERVICE_MEMBERS = Object.freeze(['url', 'service_commit', 'image_digest']);
const OBSERVATION_PLATFORM_MEMBERS = Object.freeze(
  ['stacks', 'inputs', 'schema_sha256', 'lambdas', 'queues', 'client_domain']);
const OBSERVATION_STACK_MEMBERS = Object.freeze(['name', 'region', 'template_sha256']);
// Issue #228: the E2E observer discovers the deployed surface through the
// platform's public list/describe APIs, so the observed platform follows the
// discovered grammars instead of the configured stack table. The reviewed
// entry points are the `AnyWear` stack prefix, the `beta-anywear-` Lambda and
// queue prefixes and the two observation regions; a rename away from a prefix
// leaves the sealed set, and the Infra change review remains the naming
// authority.
const OBSERVATION_REGIONS = Object.freeze(['ap-east-1', 'us-east-1']);

function httpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url;
}

// One independent read of the deployed system, made by the qualification run with
// its own Beta credentials. It replaces the v2 `deployment.record` chain: it proves
// the deployed content (templates, stage inputs, Lambdas, queues, Client domain),
// not which Infra commit deployed the platform.
function assertObservation(observation, phase) {
  exact(observation, OBSERVATION_MEMBERS, `${phase} observation`);
  if (!Number.isFinite(Date.parse(observation.collected_at))) throw new Error(`${phase} observation time is invalid`);
  if (observation.authenticated !== true) throw new Error(`${phase} observation is not an authenticated read`);
  exact(observation.client, OBSERVATION_CLIENT_MEMBERS, `${phase} observed Client`);
  matches(observation.client.source_commit, SHA, `${phase} observed Client commit`);
  if (!Number.isFinite(Date.parse(observation.client.built_at))) throw new Error(`${phase} observed Client build time is invalid`);
  const clientUrl = httpsUrl(observation.client.url, `${phase} observed Client URL`);
  exact(observation.service, OBSERVATION_SERVICE_MEMBERS, `${phase} observed Service`);
  matches(observation.service.service_commit, SHA, `${phase} observed Service commit`);
  matches(observation.service.image_digest, DIGEST, `${phase} observed Service image digest`);
  httpsUrl(observation.service.url, `${phase} observed Service URL`);
  const platform = exact(observation.platform, OBSERVATION_PLATFORM_MEMBERS, `${phase} observed platform`);
  if (!Array.isArray(platform.stacks) || platform.stacks.length === 0) {
    throw new Error(`${phase} observed platform must list at least one discovered AnyWear stack`);
  }
  const stackNames = new Set();
  let previousStack;
  for (const row of platform.stacks) {
    exact(row, OBSERVATION_STACK_MEMBERS, `${phase} observed stack`);
    matches(row.name, /^AnyWear/, `${phase} observed stack name`);
    if (!OBSERVATION_REGIONS.includes(row.region)) throw new Error(`${phase} observed stack region must be an observation region`);
    matches(row.template_sha256, HASH, `${phase} observed stack template hash`);
    if (stackNames.has(row.name)) throw new Error(`${phase} observed stacks must name each stack once`);
    stackNames.add(row.name);
    if (previousStack !== undefined && !(previousStack < row.name)) throw new Error(`${phase} observed stacks must be sorted`);
    previousStack = row.name;
  }
  validateStageInputs(platform.inputs);
  if (platform.schema_sha256 !== stageContractSchemaHash(platform.inputs)) {
    throw new Error(`${phase} observed schema hash differs from its stage inputs`);
  }
  if (!Array.isArray(platform.lambdas) || platform.lambdas.length === 0) {
    throw new Error(`${phase} observed platform must list at least one discovered Lambda`);
  }
  const lambdaNames = new Set();
  let previousLambda;
  for (const lambda of platform.lambdas) {
    exact(lambda, ['name', 'code_sha256', 'configuration_sha256'], `${phase} observed Lambda identity`);
    matches(lambda.name, /^beta-anywear-/, `${phase} observed Lambda name`);
    matches(lambda.code_sha256, /^[A-Za-z0-9+/]{43}=$/, `${phase} observed Lambda code hash`);
    matches(lambda.configuration_sha256, HASH, `${phase} observed Lambda configuration hash`);
    if (lambdaNames.has(lambda.name)) throw new Error(`${phase} observed Lambdas must name each function once`);
    lambdaNames.add(lambda.name);
    if (previousLambda !== undefined && !(previousLambda < lambda.name)) throw new Error(`${phase} observed Lambdas must be sorted`);
    previousLambda = lambda.name;
  }
  if (!Array.isArray(platform.queues) || platform.queues.length === 0) {
    throw new Error(`${phase} observed platform must list at least one discovered queue`);
  }
  const queueNames = new Set();
  let previousQueue;
  for (const queue of platform.queues) {
    exact(queue, ['name', 'queueVisibilitySeconds', 'maxReceives'], `${phase} observed queue identity`);
    matches(queue.name, /^beta-anywear-/, `${phase} observed queue name`);
    integer(queue.queueVisibilitySeconds, `${phase} observed queue visibility`, 0);
    if (queue.maxReceives !== null) integer(queue.maxReceives, `${phase} observed queue max receives`, 0);
    if (queueNames.has(queue.name)) throw new Error(`${phase} observed queues must name each queue once`);
    queueNames.add(queue.name);
    if (previousQueue !== undefined && !(previousQueue < queue.name)) throw new Error(`${phase} observed queues must be sorted`);
    previousQueue = queue.name;
  }
  matches(platform.client_domain, /^[a-z0-9]+\.cloudfront\.net$/, `${phase} observed Client distribution domain`);
  if (clientUrl.host !== platform.client_domain) {
    throw new Error(`${phase} observed Client URL and distribution domain disagree`);
  }
  return observation;
}

const observedIdentity = observation => ({
  client: { url: observation.client.url, source_commit: observation.client.source_commit },
  service: observation.service,
  platform: observation.platform,
});

// The qualification record binds the reviewed release identity. v3 carries it in
// `revisions.service` and `service_artifacts`; the independent observation under
// `observations.after` states what was tested. `revisions.infra` does not exist:
// Infra source lineage belongs to the deployment records (#181), so nothing here
// compares the qualification to `GITHUB_SHA`. Production remains closed by the
// source blocker in `promote-production.mjs`; no accepted record can execute it.
export function assertQualifiedRelease(record, release, env = process.env) {
  readReviewedRelease(env);
  if (record?.schema_version !== 3 || record.record_type !== 'anywear_beta_qualification' || record.payload !== undefined) {
    throw new Error('Production requires a flat qualification record v3; v2/v1 and payload envelopes are not inputs');
  }
  exact(record, QUALIFICATION_MEMBERS, 'qualification record');
  if (record.result !== 'passed' || record.operation !== 'full') throw new Error('Qualification record is not a passed full run');
  if (!Number.isFinite(Date.parse(record.qualified_at))) throw new Error('Qualification record time is invalid');
  if (record.environment?.stage !== 'beta' || record.environment.aws_account_id !== '650880818323'
    || record.environment.aws_region !== 'ap-east-1') throw new Error('Qualification record describes another stage/account/region');
  exact(record.expected, ['service_commit', 'client_commit', 'source'], 'qualification expectation');
  matches(record.expected.service_commit, SHA, 'expected Service commit');
  if (record.expected.client_commit !== null) matches(record.expected.client_commit, SHA, 'expected Client commit');
  if (!['trigger', 'live'].includes(record.expected.source)) throw new Error('Qualification expectation source must be trigger or live');
  if (record.workflow?.run_id !== Number(env.QUALIFICATION_RUN_ID) || record.workflow.run_attempt !== Number(env.QUALIFICATION_RUN_ATTEMPT)) {
    throw new Error('Qualification record describes another E2E run/attempt than the reviewed metadata');
  }
  exact(record.revisions, ['e2e', 'client', 'service'], 'qualification revisions');
  exact(record.revisions.e2e, ['repository', 'sha'], 'e2e revision');
  exact(record.revisions.client, ['repository', 'sha', 'client_version'], 'client revision');
  exact(record.revisions.service, ['repository', 'sha', 'image_digest', 'minimum_client_version'], 'service revision');
  if (record.revisions.e2e.repository !== E2E || record.revisions.e2e.sha !== env.QUALIFICATION_E2E_SHA) {
    throw new Error('Qualified E2E revision differs from the authenticated E2E source');
  }
  matches(record.revisions.e2e.sha, SHA, 'qualified E2E commit');
  if (record.revisions.client.repository !== CLIENT) throw new Error('Qualified Client repository differs from the reviewed Client');
  matches(record.revisions.client.sha, SHA, 'qualified Client commit');
  integer(record.revisions.client.client_version, 'qualified Client version', 0);
  if (record.revisions.service.repository !== SERVICE || record.revisions.service.sha !== release.source_sha
    || record.revisions.service.image_digest !== release.image_digest) {
    throw new Error('Qualified Service/release/image identity differs from promotion');
  }
  integer(record.revisions.service.minimum_client_version, 'qualified minimum Client version', 0);
  if (record.revisions.client.client_version < record.revisions.service.minimum_client_version) {
    throw new Error('Qualified Client version is below the minimum Client version the qualified Service enforces');
  }
  exact(record.service_artifacts, ['repository', 'release_id', 'tag', 'manifest_asset_id', 'manifest_sha256'], 'Service artifacts');
  if (record.service_artifacts.repository !== SERVICE || record.service_artifacts.release_id !== release.release_id
    || record.service_artifacts.tag !== `service-artifacts-${release.source_sha}`) {
    throw new Error('Qualified Service artifact identity differs from the reviewed release');
  }
  integer(record.service_artifacts.manifest_asset_id, 'qualified manifest asset');
  matches(record.service_artifacts.manifest_sha256, HASH, 'qualified manifest hash');
  exact(record.observations, ['before', 'after'], 'qualification observations');
  assertObservation(record.observations.before, 'before');
  const after = assertObservation(record.observations.after, 'after');
  if (canonicalJson(observedIdentity(record.observations.before)) !== canonicalJson(observedIdentity(after))) {
    throw new Error('Qualification observed a different system before and after the suite');
  }
  if (after.client.source_commit !== record.revisions.client.sha
    || after.service.service_commit !== record.revisions.service.sha
    || after.service.image_digest !== record.revisions.service.image_digest
    || record.expected.service_commit !== record.revisions.service.sha
    || (record.expected.client_commit !== null && record.expected.client_commit !== record.revisions.client.sha)
    || record.environment.client_url !== after.client.url || record.environment.service_url !== after.service.url) {
    throw new Error('Qualified observation identity differs from the recorded revisions and expectation');
  }
  return release.image_digest;
}

export async function resolveProductionInputs(env = process.env, io = {}) {
  const release = readReviewedRelease(env);
  const artifactIo = io.api && io.verifyStableRelease ? undefined : await liveArtifactIo();
  const get = io.api ?? artifactIo.api;
  const run = await get(`repos/${E2E}/actions/runs/${env.QUALIFICATION_RUN_ID}/attempts/${env.QUALIFICATION_RUN_ATTEMPT}`);
  const artifact = await get(`repos/${E2E}/actions/artifacts/${env.QUALIFICATION_ARTIFACT_ID}`);
  assertTrustedQualificationMetadata(run, artifact, env);
  const stable = await get(`repos/${SERVICE}/releases/${env.SERVICE_RELEASE_ID}`);
  // Check tag syntax before incorporating it in a GitHub API path.
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stable.tag_name ?? '')) throw new Error('Stable semantic release tag required');
  let commit = (await get(`repos/${SERVICE}/git/ref/tags/${stable.tag_name}`)).object;
  if (commit?.type === 'tag') commit = (await get(`repos/${SERVICE}/git/tags/${commit.sha}`)).object;
  const comparison = await get(`repos/${SERVICE}/compare/${release.source_sha}...main`);
  assertStableRelease(stable, commit, comparison, release, env);
  // The download uses a separate child directory so artifact contents cannot overwrite API metadata.
  await (io.mkdir ?? mkdir)('.qualification/trusted', { recursive: true });
  const put = io.writeFile ?? writeFile;
  await put('.qualification/trusted/run.json', canonicalJson(run)); await put('.qualification/trusted/artifact.json', canonicalJson(artifact));
  await put('.qualification/trusted/stable-release.json', canonicalJson(stable));
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `e2e_sha=${run.head_sha}\n`);
  return { release, run, artifact, stable };
}

export async function verifyProductionRecord({ recordBytes, run, artifact, verifier, env = process.env, now = Date.now() }) {
  validateProductionContext(env);
  const release = readReviewedRelease(env); const record = parseJson(recordBytes);
  assertTrustedQualificationMetadata(run, artifact, env, now);
  if (sha256(recordBytes) !== env.QUALIFICATION_RECORD_SHA256) throw new Error('Pinned qualification exact-byte checksum mismatch');
  assertQualifiedRelease(record, release, env);
  if (typeof verifier !== 'function') throw new Error('Pinned E2E v3 qualification verifier unavailable');
  const accepted = await verifier(record, { trustedRun: run, trustedArtifact: artifact, recordBytes, now, expected: {
    run_id: Number(env.QUALIFICATION_RUN_ID), run_attempt: Number(env.QUALIFICATION_RUN_ATTEMPT), artifact_id: Number(env.QUALIFICATION_ARTIFACT_ID),
    record_sha256: env.QUALIFICATION_RECORD_SHA256, e2e_sha: env.QUALIFICATION_E2E_SHA } });
  if (accepted !== true) throw new Error('Pinned E2E qualification verifier did not affirm acceptance');
  return { release, record };
}

export async function verifyProductionQualification(env = process.env) {
  const release = readReviewedRelease(env);
  const verifierRoot = path.resolve('.qualification-verifier');
  const checkout = (await execute('git', ['-C', verifierRoot, 'rev-parse', 'HEAD'], { timeout: 30_000 })).stdout.trim();
  const origin = (await execute('git', ['-C', verifierRoot, 'remote', 'get-url', 'origin'], { timeout: 30_000 })).stdout.trim();
  if (checkout !== env.QUALIFICATION_E2E_SHA || origin !== `https://github.com/${E2E}` && origin !== `https://github.com/${E2E}.git`) {
    throw new Error('Qualification verifier checkout differs from authenticated E2E source');
  }
  const helper = await import(pathToFileURL(path.join(verifierRoot, 'scripts/qualification-record.mjs')));
  const { release: verified } = await verifyProductionRecord({ env,
    recordBytes: await readFile('.qualification/download/qualification-record.json'),
    run: parseJson(await readFile('.qualification/trusted/run.json')), artifact: parseJson(await readFile('.qualification/trusted/artifact.json')),
    verifier: helper.verifyQualificationForPromotion });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `image_digest=${verified.image_digest}\nservice_sha=${verified.source_sha}\n`);
  return { release, imageDigest: release.image_digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'resolve') await resolveProductionInputs();
  else if (process.argv[2] === 'verify') await verifyProductionQualification();
  else throw new Error('Production preflight requires resolve or verify');
}

export async function liveArtifactIo() {
  // Both callers run in a job that already holds the read-only Service/E2E App
  // token. This path reads the reviewed release identity; it never re-verifies
  // another repository's native release or seals an artifact.
  const env = { ...process.env, GH_TELEMETRY: 'disabled' };
  return {
    async api(pathname) {
      return parseJson((await execute('gh', ['api', pathname], { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout);
    },
    async attestation() { throw new Error('Native release attestation is not part of the reviewed release identity'); },
  };
}
