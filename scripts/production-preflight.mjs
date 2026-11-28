import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseJson, canonicalJson, SHA, DIGEST, matches, integer } from './lib/json-contract.mjs';

const execute = promisify(execFile);
// Issue #266: the durable owner is the `anywear-ai` organization, so a machine
// reference (an API path or a record field) names the new owner; the old name keeps
// resolving through GitHub's transfer redirect. The current run's own repository is
// matched by its immutable numeric id below.
const E2E = 'anywear-ai/AnyWear-E2E';
const SERVICE = 'anywear-ai/AnyWear-Service';
export const PRODUCTION_WORKFLOW = '.github/workflows/production.yml';
// Issue #358 step 4: the promotion gate is one AnyWear-E2E run, not a retained
// record. These two strings are the cross-repository contract the promotion reads:
// the workflow file the gate writes its runs under, and the run-name prefix of the
// `full` operation. The run's own `display_title` must additionally name the
// promoted Service commit, because the run name is where a `full` gate states what
// it measured.
export const E2E_GATE_WORKFLOW = '.github/workflows/beta-e2e.yml';
export const E2E_GATE_RUN_NAME_PREFIX = 'Beta E2E gate: full';

// Production is not onboarded. Its source blocker is `promote-production.mjs`; the
// preflight below stays source-reviewed and reads the reviewed Service release
// identity explicitly (`SERVICE_RELEASE_ID`, `SERVICE_SOURCE_SHA`,
// `SERVICE_IMAGE_DIGEST`), exactly like the Beta release path. The gate run is the
// one the promotion dispatched and holds inside `anywear-infra-runtime`: its id and
// attempt are injected (`E2E_GATE_RUN_ID`/`E2E_GATE_RUN_ATTEMPT`) so the unit tests
// can feed a concrete run; a future entry gets them from its own
// `return_run_details: true` dispatch response, never from an operator. Nothing below
// executes a Production mutation: the workflow is `workflow_call`-only and the source
// blocker fails before any credential even when an activation variable changes.
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
  for (const field of ['E2E_GATE_RUN_ID', 'E2E_GATE_RUN_ATTEMPT', 'SERVICE_RELEASE_ID']) {
    matches(env[field], /^[1-9][0-9]*$/, field); integer(Number(env[field]), field);
  }
  matches(env.SERVICE_SOURCE_SHA, SHA, 'reviewed Service source');
  matches(env.SERVICE_IMAGE_DIGEST, DIGEST, 'reviewed Service image digest');
}

export function readReviewedRelease(env = process.env) {
  validateProductionContext(env);
  return { release_id: Number(env.SERVICE_RELEASE_ID), source_sha: env.SERVICE_SOURCE_SHA, image_digest: env.SERVICE_IMAGE_DIGEST };
}

// The gate run this promotion dispatched and holds: the injected id and attempt,
// this repository, this workflow file, the reviewed branch, a completed success of
// the `full` operation and a run name naming the promoted Service commit. A run that
// differs in any of those is a different gate, so the promotion refuses it.
export function assertGateRun(run, release, env = process.env) {
  if (run === null || typeof run !== 'object'
    || run.id !== Number(env.E2E_GATE_RUN_ID) || run.run_attempt !== Number(env.E2E_GATE_RUN_ATTEMPT)
    || run.repository?.full_name !== E2E || run.head_repository?.full_name !== E2E
    || run.path !== E2E_GATE_WORKFLOW || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('A completed successful AnyWear-E2E `full` gate run of the promoted Service commit is required');
  }
  if (typeof run.display_title !== 'string' || !run.display_title.startsWith(E2E_GATE_RUN_NAME_PREFIX)
    || !run.display_title.includes(release.source_sha)) {
    throw new Error('The gate run does not name the promoted Service commit');
  }
  return run;
}

// The gate run's own `full` job re-reads the live identity before and after the
// suite and fails the run on any difference, so a `success` conclusion already
// carries this equality. It is also asserted here directly, over the two readings a
// future promotion entry takes around the run it holds: the identity must be the
// same on both sides and must be the reviewed release being promoted. A reading is
// `{ service_commit, image_digest }` as the gate's live identity block states them.
export function assertStableGateIdentity(before, after, release) {
  const identity = (value, label) => {
    if (value === null || typeof value !== 'object') throw new Error(`The gate run's ${label} live identity is missing`);
    return { service_commit: matches(value.service_commit, SHA, `${label} live Service commit`),
      image_digest: matches(value.image_digest, DIGEST, `${label} live Service image digest`) };
  };
  const beforeIdentity = identity(before, 'before');
  const afterIdentity = identity(after, 'after');
  if (canonicalJson(beforeIdentity) !== canonicalJson(afterIdentity)) {
    throw new Error('The gate run observed a different live identity before and after the suite');
  }
  if (afterIdentity.service_commit !== release.source_sha || afterIdentity.image_digest !== release.image_digest) {
    throw new Error('The gate run observed a live identity that differs from the promoted release');
  }
  return afterIdentity;
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

/**
 * Read the two GitHub facts the future promotion needs before any credential: the
 * gate run this promotion dispatched and holds, and the sealed stable Service
 * release the promoted source resolves to. It writes the reviewed image digest and
 * Service commit to the step output, which the future `skopeo copy` consumes; it
 * reads nothing from AnyWear-E2E's files or artifacts, so no second-repository
 * checkout is needed.
 */
export async function resolveProductionInputs(env = process.env, io = {}) {
  const release = readReviewedRelease(env);
  const get = io.api ?? (await liveArtifactIo()).api;
  const run = await get(`repos/${E2E}/actions/runs/${env.E2E_GATE_RUN_ID}/attempts/${env.E2E_GATE_RUN_ATTEMPT}`);
  assertGateRun(run, release, env);
  const stable = await get(`repos/${SERVICE}/releases/${env.SERVICE_RELEASE_ID}`);
  // Check tag syntax before incorporating it in a GitHub API path.
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stable.tag_name ?? '')) throw new Error('Stable semantic release tag required');
  let commit = (await get(`repos/${SERVICE}/git/ref/tags/${stable.tag_name}`)).object;
  if (commit?.type === 'tag') commit = (await get(`repos/${SERVICE}/git/tags/${commit.sha}`)).object;
  const comparison = await get(`repos/${SERVICE}/compare/${release.source_sha}...main`);
  assertStableRelease(stable, commit, comparison, release, env);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `image_digest=${release.image_digest}\nservice_sha=${release.source_sha}\n`);
  return { release, run, stable };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'resolve') await resolveProductionInputs();
  else throw new Error('Production preflight requires resolve');
}

export async function liveArtifactIo() {
  // The caller runs in a job that already holds the read-only Service/E2E App
  // token. This path reads the reviewed release identity and the gate run; it never
  // re-verifies another repository's native release or seals an artifact.
  const env = { ...process.env, GH_TELEMETRY: 'disabled' };
  return {
    async api(pathname) {
      return parseJson((await execute('gh', ['api', pathname], { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout);
    },
    async attestation() { throw new Error('Native release attestation is not part of the reviewed release identity'); },
  };
}
