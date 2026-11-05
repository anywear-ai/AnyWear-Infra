import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, sha256, exact, matches, integer, DIGEST, SHA } from './json-contract.mjs';
import { SCHEMA_ASSET_NAME } from './schema-asset.mjs';

// The reviewed Service artifact identity that replaces the committed `selection`:
// the tag names one sealed artifact; the commit names the Service source it was
// built from. Both are explicit dispatch inputs. The release itself states the
// identity a manifest used to carry: tag to commit, immutability and a digest per
// asset, all read from the documented REST representation.
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
export const SERVICE_REPOSITORY = 'anywear-ai/AnyWear-Service';
// The four files a post-#193 Service release publishes. Publication requires
// exactly this set; a consumer requires only the names it consumes and ignores
// extras, so a pre-change five-asset release stays deployable and restorable.
export const RELEASE_ASSET_NAMES = Object.freeze(['pre-sign-up.zip', 'post-confirmation.zip',
  'runtime-policy.json', 'service-schema.json']);
// The three this repository's stage base consumes. `service-schema.json` belongs
// to the Service runtime: `deploy-platform`/`restore-release` never download it.
export const STAGE_BASE_ASSETS = Object.freeze(['pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json']);
// The one asset `deploy-runtime` and `migrate` consume: the sealed artifact's schema
// boundary, which the deploy job re-hashes and strictly validates before any
// credential; `deploy-runtime`'s gate then compares it against the live applied
// journal before any stack mutation, and `migrate` runs the release it names.
export const RUNTIME_RELEASE_ASSETS = Object.freeze([SCHEMA_ASSET_NAME]);
// The one directory the CDK stage-base deploy consumes and the Runtime deploy
// reads the travelled schema asset from. The verify job downloads the operation's
// consumed set into it and the deploy job re-hashes those bytes before any
// credential, so both sides name the same bytes.
export const SELECTED_RELEASE_DIRECTORY = path.join(root, '.service-artifacts', 'selected');
// Four operations take one reviewed artifact identity. `deploy-platform` and
// `restore-release` deploy the stage base, which consumes the Service-built Lambda
// bundles and runtime policy; `deploy-runtime` and `migrate` consume the sealed
// release's schema asset (its tag, commit and ECR image are resolved separately
// from the same identity), and `migrate` runs that release as a one-shot instead
// of deploying a stack. A release identity supplied to any other operation is
// rejected instead of silently ignored.
export const RELEASE_IDENTITY_OPERATIONS = Object.freeze(['deploy-platform', 'deploy-runtime', 'restore-release',
  'migrate']);
const GH_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// An annotated tag names a tag object that names the commit. The bound keeps a
// malformed or cyclic chain from issuing unbounded REST reads.
const MAX_TAG_DEPTH = 4;

/**
 * The release assets one operation consumes. Every other operation takes no
 * release at all, so an unknown operation is a caller error, never an empty set.
 */
export function releaseAssetsFor(operation) {
  if (operation === 'deploy-runtime' || operation === 'migrate') return RUNTIME_RELEASE_ASSETS;
  if (operation === 'deploy-platform' || operation === 'restore-release') return STAGE_BASE_ASSETS;
  throw new Error(`Operation ${operation} consumes no Service release assets`);
}

// One reviewed input per release-taking operation: the stage-base deploy path
// takes Service-built Lambda assets, `deploy-runtime` and `migrate` take the
// schema asset, and every other operation takes none and rejects a supplied
// release identity.
export function validateReleaseInput(env = process.env, operation = env.INFRA_OPERATION) {
  const releaseTag = env.SERVICE_ARTIFACT_TAG ?? '';
  const serviceCommit = env.SERVICE_COMMIT ?? '';
  if (!RELEASE_IDENTITY_OPERATIONS.includes(operation)) {
    // The refusal is derived from the one frozen list, so a new release-taking
    // operation can never leave this message claiming an older set.
    if (releaseTag || serviceCommit) {
      throw new Error(`Only ${RELEASE_IDENTITY_OPERATIONS.join(', ')} take a Service artifact identity`);
    }
    return null;
  }
  if (!GH_TAG.test(releaseTag)) throw new Error(`${operation} requires the explicit Service release tag`);
  matches(serviceCommit, SHA, 'Service release source commit');
  return { releaseTag, serviceCommit };
}

const releaseApiPath = releaseTag => `repos/${SERVICE_REPOSITORY}/releases/tags/${encodeURIComponent(releaseTag)}`;
const tagRefApiPath = releaseTag => `repos/${SERVICE_REPOSITORY}/git/ref/tags/${encodeURIComponent(releaseTag)}`;
const tagApiPath = sha => `repos/${SERVICE_REPOSITORY}/git/tags/${sha}`;
// The release API's documented representation is the authority: `immutable` and
// each asset's `sha256:<hex>` digest come from REST, never from a manifest. Only
// the names this operation consumes are required; any other published asset (a
// pre-change release's legacy manifest, or the schema asset for a stage-base
// operation) is ignored.
export function assertPublishedRelease(release, releaseTag, assetNames = STAGE_BASE_ASSETS) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('Invalid Service release response');
  integer(release.id, 'release ID');
  if (release.tag_name !== releaseTag) throw new Error(`Service release response names ${release.tag_name}, not ${releaseTag}`);
  if (release.draft !== false) throw new Error(`Service release ${releaseTag} is a draft`);
  // A missing `immutable` is not `true`: an older API or a mutable release refuses.
  if (release.immutable !== true) throw new Error(`Service release ${releaseTag} is not immutable`);
  if (!Array.isArray(release.assets)) throw new Error('Service release response carries no assets');
  const published = new Map();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string') throw new Error('Service release carries a malformed asset');
    const entries = published.get(asset.name) ?? [];
    entries.push(asset);
    published.set(asset.name, entries);
  }
  const observed = [...published.keys()].sort().join(', ') || 'no assets';
  const assets = {};
  for (const name of assetNames) {
    const entries = published.get(name) ?? [];
    if (entries.length === 0) throw new Error(`Service release ${releaseTag} lacks ${name}; observed ${observed}`);
    if (entries.length > 1) throw new Error(`Service release ${releaseTag} duplicates ${name}; observed ${observed}`);
    const [asset] = entries;
    if (asset.state !== 'uploaded') throw new Error(`Service release asset ${name} is ${asset.state ?? 'unstated'}, not uploaded`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`Service release asset ${name} is empty`);
    if (typeof asset.digest !== 'string' || !DIGEST.test(asset.digest)) {
      throw new Error(`Service release asset ${name} has no sha256 digest (${asset.digest ?? 'absent'})`);
    }
    assets[name] = asset.digest;
  }
  return { id: release.id, assets };
}

// Resolve the tag through the ref API to the commit it names. A lightweight tag
// names the commit directly; an annotated tag is dereferenced at most four times.
export async function resolveTagCommit(releaseTag, api) {
  const response = await api(tagRefApiPath(releaseTag));
  const refs = Array.isArray(response) ? response : [response];
  if (refs.length !== 1 || refs[0]?.ref !== `refs/tags/${releaseTag}`) {
    throw new Error(`Service tag ${releaseTag} did not resolve to exactly one tag ref`);
  }
  let target = refs[0].object;
  for (let depth = 0; target?.type === 'tag'; depth++) {
    if (depth >= MAX_TAG_DEPTH) throw new Error(`Service tag ${releaseTag} is an annotated-tag chain deeper than ${MAX_TAG_DEPTH}`);
    matches(target.sha, SHA, `Service tag ${releaseTag} object`);
    target = (await api(tagApiPath(target.sha))).object;
  }
  if (target?.type !== 'commit') throw new Error(`Service tag ${releaseTag} does not resolve to a commit`);
  return matches(target.sha, SHA, `Service tag ${releaseTag} commit`);
}

// Download only the assets this operation consumes, after proving the release
// identity through the API. The bytes are not hashed here: the deploy job hashes
// each consumed byte exactly once against the published digest before it requests
// a credential. Since #207 nothing is written into the byte directory except the
// release's own bytes: the digest set crosses as the `release_assets` job output,
// and the retired `release-inputs.json` v2 record is gone.
export async function downloadReleaseInputs({ releaseTag, serviceCommit, directory = SELECTED_RELEASE_DIRECTORY,
  token, run = execute, assetNames = STAGE_BASE_ASSETS }) {
  if (typeof token !== 'string' || !token) throw new Error('A read-only Service token is required to read the Service release');
  await mkdir(directory, { recursive: true });
  const env = { ...process.env, GH_TOKEN: token, GH_TELEMETRY: 'disabled' };
  const api = async endpoint => parseJson((await run('gh', ['api', endpoint],
    { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const { id, assets } = assertPublishedRelease(await api(releaseApiPath(releaseTag)), releaseTag, assetNames);
  const sourceSha = await resolveTagCommit(releaseTag, api);
  if (sourceSha !== serviceCommit) {
    throw new Error(`Service tag ${releaseTag} resolves to ${sourceSha}, not the reviewed commit ${serviceCommit}`);
  }
  await run('gh', ['release', 'download', releaseTag, '--repo', SERVICE_REPOSITORY, '--dir', directory, '--clobber',
    ...[...assetNames].flatMap(name => ['--pattern', name])], { env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  return { release: { id, tag: releaseTag, source_sha: sourceSha }, assets };
}

// Deploy-side proof. The verify job's artifact travelled between jobs, so the
// deploy job hashes each consumed file exactly once here, against the digests the
// release published, before the restricted session is requested.
export async function assertSelectedReleaseBytes(assets, directory = SELECTED_RELEASE_DIRECTORY,
  assetNames = STAGE_BASE_ASSETS) {
  exact(assets, [...assetNames], 'travelled release assets');
  for (const name of assetNames) {
    matches(assets[name], DIGEST, `travelled release asset ${name}`);
    let bytes;
    try { bytes = await readFile(path.join(directory, name)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Travelled release asset ${name} is missing from ${directory}`);
      throw error;
    }
    const digest = `sha256:${sha256(bytes)}`;
    if (digest !== assets[name]) throw new Error(`Travelled release asset ${name} differs from its published digest`);
  }
  return assets;
}

export async function runVerifyInputs({ env = process.env, run = execute, token = env.GH_TOKEN,
  directory = SELECTED_RELEASE_DIRECTORY } = {}) {
  const release = validateReleaseInput(env);
  if (!release) return null;
  // Since #194 the verify job also downloads `deploy-runtime`'s schema asset, so
  // the operation's consumed set is what travels and what the deploy job proves.
  return downloadReleaseInputs({ ...release, token, run, directory,
    assetNames: releaseAssetsFor(env.INFRA_OPERATION) });
}
