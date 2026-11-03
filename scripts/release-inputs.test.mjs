import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_ASSET_NAMES,
  RELEASE_IDENTITY_OPERATIONS,
  RUNTIME_RELEASE_ASSETS,
  STAGE_BASE_ASSETS,
  SERVICE_REPOSITORY,
  assertSelectedReleaseBytes,
  releaseAssetsFor,
  runVerifyInputs,
  validateReleaseInput,
} from './release-inputs.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { parseJson, sha256 } from './json-contract.mjs';

// #193: the Service release is four assets with no manifest, and its identity is
// the release API's own statement (tag to commit, `draft`, `immutable`, a digest
// per asset). #194 makes the consumed set operation-dependent: the verify job
// downloads what the dispatched operation consumes — the three stage-base names
// for `deploy-platform`/`restore-release`, only `service-schema.json` for
// `deploy-runtime` — and the deploy job hashes those travelled files exactly once
// before it requests a credential. #243 gives `migrate` the same identity and the
// same consumed set, so a migration runs the reviewed release instead of reading
// an image out of a deployed stack.
const root = path.resolve(import.meta.dirname, '..');
const serviceCommit = '1'.repeat(40);
const releaseTag = `service-artifacts-${serviceCommit}`;
const releaseOperations = ['deploy-platform', 'deploy-runtime', 'restore-release', 'migrate'];
const selectedDirectory = path.join(root, '.service-artifacts', 'selected');
const otherOperations = ['deploy-foundation', 'deploy-billing', 'admission-status', 'add-testers',
  'set-testers', 'observe', 'state', 'verify', 'deploy-workload'];
// The one refusal text, derived from the frozen list rather than retyped, so a
// future release-taking operation cannot leave this assertion stale.
const releaseIdentityMessage = `Only ${[...RELEASE_IDENTITY_OPERATIONS].join(', ')} take a Service artifact identity`;

const releaseEnv = (operation) => ({ INFRA_OPERATION: operation, SERVICE_ARTIFACT_TAG: releaseTag,
  SERVICE_COMMIT: serviceCommit });

const directories = [];
async function temporary(prefix, child) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return child ? path.join(directory, child) : directory;
}
test.after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

// The fixture directory holds the same `placeholder.zip` and policy bytes the
// pre-#193 fixture produced, so the recorded Lambda asset identities are stable,
// plus the committed schema asset so a `deploy-runtime` download has real bytes.
const schemaAssetBytes = await readFile(new URL('../test/fixtures/schema-boundary/schema-asset.json', import.meta.url));
async function newFixture() {
  const directory = await temporary('infra-release-fixture-');
  await createTestInputs(directory);
  await writeFile(path.join(directory, 'service-schema.json'), schemaAssetBytes);
  return directory;
}
async function fixtureDigests(directory) {
  const digests = {};
  for (const name of RELEASE_ASSET_NAMES) digests[name] = `sha256:${sha256(await readFile(path.join(directory, name)))}`;
  return digests;
}

// The exact `gh` surface the verify path uses: the release REST read, the tag ref
// REST read (plus any annotated-tag deref) and one download of the consumed
// patterns. The download copies the fixture bytes only for a requested pattern.
async function releaseMock(fixture, { mutateRelease = release => release, mutateAssets = assets => assets,
  refObject = { type: 'commit', sha: serviceCommit }, tagDerefs = {}, tamper } = {}) {
  const digests = await fixtureDigests(fixture);
  const calls = [];
  const release = mutateRelease({ id: 407218593, tag_name: releaseTag, target_commitish: 'main', draft: false,
    immutable: true,
    assets: mutateAssets(RELEASE_ASSET_NAMES.map((name, index) => ({ id: 5000 + index, name, state: 'uploaded',
      size: 1024, digest: digests[name] }))) });
  const run = async (command, args, options) => {
    calls.push([command, [...args], options]);
    assert.equal(command, 'gh');
    assert.equal(options.env.GH_TOKEN, 'read-only-token');
    if (args[0] === 'api') {
      if (args[1] === `repos/${SERVICE_REPOSITORY}/releases/tags/${releaseTag}`) return { stdout: JSON.stringify(release) };
      if (args[1] === `repos/${SERVICE_REPOSITORY}/git/ref/tags/${releaseTag}`) {
        return { stdout: JSON.stringify({ ref: `refs/tags/${releaseTag}`, object: refObject }) };
      }
      const deref = args[1].match(new RegExp(`^repos/${SERVICE_REPOSITORY}/git/tags/([a-f0-9]{40})$`));
      if (deref && tagDerefs[deref[1]]) return { stdout: JSON.stringify(tagDerefs[deref[1]]) };
      throw new Error(`Unexpected gh api endpoint ${args[1]}`);
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const directory = args[args.indexOf('--dir') + 1];
      await mkdir(directory, { recursive: true });
      const patterns = args.flatMap((arg, index) => arg === '--pattern' ? [args[index + 1]] : []);
      for (const name of patterns) {
        if (name === 'service-artifacts.json') throw new Error('the retired legacy manifest must never be downloaded');
        await copyFile(path.join(fixture, name), path.join(directory, name));
      }
      if (tamper) await writeFile(path.join(directory, tamper), 'tampered bytes');
      return { stdout: '' };
    }
    throw new Error(`Unexpected gh invocation ${args.join(' ')}`);
  };
  return { calls, run, digests, release };
}

// #243: the four release-taking operations, `migrate` included, take the same
// explicit identity, and a missing half fails closed before any credential.
test('every release operation takes the reviewed Service artifact identity', () => {
  for (const operation of releaseOperations) {
    // The restore branch is the regression: this call threw on the pre-fix source.
    assert.deepEqual(validateReleaseInput(releaseEnv(operation)), { releaseTag, serviceCommit });
    assert.deepEqual(validateReleaseInput(releaseEnv(operation), operation), { releaseTag, serviceCommit });
  }
  // The reviewed identity is explicit: a missing or malformed half fails closed.
  for (const operation of releaseOperations) {
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_COMMIT: serviceCommit }),
      new RegExp(`${operation} requires the explicit Service release tag`));
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_ARTIFACT_TAG: releaseTag }),
      /Invalid Service release source commit/);
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_ARTIFACT_TAG: releaseTag,
      SERVICE_COMMIT: 'a'.repeat(39) }), /Invalid Service release source commit/);
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_ARTIFACT_TAG: 'bad tag',
      SERVICE_COMMIT: serviceCommit }), /requires the explicit Service release tag/);
    // A restore dispatch with no release identity is a failure, not a null gate.
    assert.throws(() => validateReleaseInput({ INFRA_OPERATION: operation }), /requires the explicit Service release tag/);
  }
  // #243: the migrate dispatch in particular has no fallback image, so a missing
  // identity is the named refusal the operator acts on.
  assert.throws(() => validateReleaseInput({ INFRA_OPERATION: 'migrate' }),
    /^Error: migrate requires the explicit Service release tag$/);
  assert.throws(() => validateReleaseInput({ INFRA_OPERATION: 'migrate', SERVICE_ARTIFACT_TAG: releaseTag }),
    /^Error: Invalid Service release source commit$/);
});

test('the frozen asset constants are the four published names and the per-operation consumed sets', async () => {
  const module = await import('./release-inputs.mjs');
  assert.deepEqual([...RELEASE_ASSET_NAMES], ['pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json',
    'service-schema.json']);
  assert.deepEqual([...STAGE_BASE_ASSETS], ['pre-sign-up.zip', 'post-confirmation.zip', 'runtime-policy.json']);
  assert.deepEqual([...RUNTIME_RELEASE_ASSETS], ['service-schema.json']);
  assert.ok(RELEASE_ASSET_NAMES.every(name => typeof name === 'string'));
  assert.equal(Object.isFrozen(RELEASE_ASSET_NAMES), true);
  assert.equal(Object.isFrozen(STAGE_BASE_ASSETS), true);
  assert.equal(Object.isFrozen(RUNTIME_RELEASE_ASSETS), true);
  // #194/#243: the consumed set follows the operation. A stage-base deploy never
  // asks for the schema asset; the Runtime deploy and the migration ask only for
  // it.
  assert.deepEqual(releaseAssetsFor('deploy-runtime'), RUNTIME_RELEASE_ASSETS);
  assert.deepEqual(releaseAssetsFor('migrate'), RUNTIME_RELEASE_ASSETS);
  assert.deepEqual([...releaseAssetsFor('migrate')], ['service-schema.json']);
  assert.deepEqual(releaseAssetsFor('deploy-platform'), STAGE_BASE_ASSETS);
  assert.deepEqual(releaseAssetsFor('restore-release'), STAGE_BASE_ASSETS);
  for (const operation of otherOperations) {
    assert.throws(() => releaseAssetsFor(operation), /consumes no Service release assets/, operation);
  }
  // One frozen four-operation list is the single source the refusal text, the
  // consumed-set lookup and the workflow `if:` gates agree with.
  assert.deepEqual([...module.RELEASE_IDENTITY_OPERATIONS], releaseOperations);
  assert.deepEqual([...RELEASE_IDENTITY_OPERATIONS], releaseOperations);
  assert.equal(Object.isFrozen(RELEASE_IDENTITY_OPERATIONS), true);
  assert.equal(module.SELECTED_RELEASE_DIRECTORY, selectedDirectory);
});

test('every other operation still rejects a supplied release identity and takes none', () => {
  // The refusal is derived from the frozen list, so it names all four operations.
  assert.equal(releaseIdentityMessage,
    'Only deploy-platform, deploy-runtime, restore-release, migrate take a Service artifact identity');
  for (const operation of releaseOperations) assert.ok(releaseIdentityMessage.includes(operation), operation);
  for (const operation of otherOperations) {
    const rejects = fn => assert.throws(fn, (error) => {
      assert.equal(error.message, releaseIdentityMessage);
      return true;
    });
    rejects(() => validateReleaseInput(releaseEnv(operation)));
    rejects(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_ARTIFACT_TAG: releaseTag }));
    rejects(() => validateReleaseInput({ INFRA_OPERATION: operation, SERVICE_COMMIT: serviceCommit }));
    assert.equal(validateReleaseInput({ INFRA_OPERATION: operation }), null, operation);
  }
});

test('restore-release reads the release identity over REST and downloads exactly the three consumed assets', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run, digests } = await releaseMock(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
    directory: selected });

  // #207: the verify job returns the release identity and the published digest
  // set and writes no record file; `release{id, tag, source_sha}` is the identity
  // the deploy job re-derives from its own inputs, and the three published digests
  // are what its byte proof compares the travelled files against.
  assert.deepEqual(record.release, { id: 407218593, tag: releaseTag, source_sha: serviceCommit });
  assert.deepEqual(record.assets, Object.fromEntries(STAGE_BASE_ASSETS.map(name => [name, digests[name]])));
  for (const name of STAGE_BASE_ASSETS) assert.match(record.assets[name], /^sha256:[a-f0-9]{64}$/);

  // Only the three consumed release bytes are in the directory the CDK deploy
  // consumes; there is no record file, no schema asset and no legacy manifest.
  assert.deepEqual((await readdir(selected)).sort(), ['post-confirmation.zip', 'pre-sign-up.zip',
    'runtime-policy.json']);

  // Two REST reads (release, tag ref) and one download call naming exactly the
  // three consumed patterns. The manifest is neither requested nor fetched.
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1][0], 'api');
  assert.equal(calls[0][1][1], `repos/${SERVICE_REPOSITORY}/releases/tags/${releaseTag}`);
  assert.equal(calls[1][1][0], 'api');
  assert.equal(calls[1][1][1], `repos/${SERVICE_REPOSITORY}/git/ref/tags/${releaseTag}`);
  assert.equal(calls[2][1][0], 'release');
  assert.equal(calls[2][1][1], 'download');
  assert.deepEqual(calls[2][1].flatMap((arg, index) => arg === '--pattern' ? [calls[2][1][index + 1]] : []),
    [...STAGE_BASE_ASSETS]);
  assert.deepEqual(calls[2][1].slice(calls[2][1].indexOf('--dir'), calls[2][1].indexOf('--dir') + 2),
    ['--dir', selected]);
  assert.equal(calls.some(([, args]) => args.includes('service-artifacts.json')), false);
});

test('deploy-platform reads the same release identity and downloads the same three assets', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run, digests } = await releaseMock(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run, token: 'read-only-token',
    directory: selected });
  assert.deepEqual(record.release, { id: 407218593, tag: releaseTag, source_sha: serviceCommit });
  assert.deepEqual(record.assets, Object.fromEntries(STAGE_BASE_ASSETS.map(name => [name, digests[name]])));
  for (const name of STAGE_BASE_ASSETS) {
    assert.ok((await readFile(path.join(selected, name))).length > 0, name);
  }
  assert.deepEqual(Object.keys(record.assets), [...STAGE_BASE_ASSETS]);
  assert.equal(calls.filter(([, args]) => args[0] === 'release' && args[1] === 'download').length, 1);
});

test('deploy-runtime downloads only the schema asset and the deploy job re-hashes that one file', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run, digests } = await releaseMock(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-runtime'), run, token: 'read-only-token',
    directory: selected });
  // The record binds exactly the operation's consumed set (#194), not the
  // publisher's four names and not the stage-base three.
  assert.deepEqual(record.release, { id: 407218593, tag: releaseTag, source_sha: serviceCommit });
  assert.deepEqual(record.assets, { 'service-schema.json': digests['service-schema.json'] });
  assert.deepEqual(Object.keys(record.assets), ['service-schema.json']);
  // Only the schema asset travelled; two REST reads and one download naming
  // exactly that pattern. Nothing else is written into the byte directory.
  assert.deepEqual((await readdir(selected)).sort(), ['service-schema.json']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2][1].flatMap((arg, index) => arg === '--pattern' ? [calls[2][1][index + 1]] : []),
    ['service-schema.json']);

  // The deploy-side proof re-hashes the one travelled file and refuses drift.
  assert.deepEqual(await assertSelectedReleaseBytes(record.assets, selected, RUNTIME_RELEASE_ASSETS), record.assets);
  // A stage-base proof over the same bytes refuses the wrong asset set.
  await assert.rejects(assertSelectedReleaseBytes(record.assets, selected, STAGE_BASE_ASSETS),
    /Invalid travelled release assets fields/);
});

test('a pre-change five-asset release stays selectable: the legacy manifest is ignored', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { calls, run, digests } = await releaseMock(fixture, {
    // A release published before #193 carries the manifest as an extra asset.
    mutateAssets: assets => [...assets, { id: 4099, name: 'service-artifacts.json', state: 'uploaded', size: 4096,
      digest: `sha256:${'d'.repeat(64)}` }],
  });
  const record = await runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
    directory: selected });
  // The extra asset is ignored: the record names only the three consumed names and
  // the download never requested the manifest.
  assert.deepEqual(record.assets, Object.fromEntries(STAGE_BASE_ASSETS.map(name => [name, digests[name]])));
  assert.equal((await readdir(selected)).includes('service-artifacts.json'), false);
  assert.equal(calls.some(([, args]) => args.includes('service-artifacts.json')), false);
});

test('the verify job records the published digest while the deploy job proves the travelled bytes once', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  // A tampered download is still bound to the digest the release published: the
  // verify job trusts that statement and does not hash the bytes.
  const { run, digests } = await releaseMock(fixture, { tamper: 'pre-sign-up.zip' });
  const record = await runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
    directory: selected });
  assert.equal(record.assets['pre-sign-up.zip'], digests['pre-sign-up.zip']);
  // The deploy job's one re-hash refuses the tampered file before any credential.
  await assert.rejects(assertSelectedReleaseBytes(record.assets, selected),
    /Travelled release asset pre-sign-up.zip differs from its published digest/);
});

test('the deploy-side check proves all three travelled bytes and their exact names', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const { run, digests } = await releaseMock(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run, token: 'read-only-token',
    directory: selected });
  const assets = Object.fromEntries(STAGE_BASE_ASSETS.map(name => [name, digests[name]]));
  assert.deepEqual(await assertSelectedReleaseBytes(assets, selected), assets);

  // A missing file, a changed digest and an incomplete asset map all fail closed.
  const missing = await temporary('infra-release-missing-');
  await assert.rejects(assertSelectedReleaseBytes(assets, missing), /is missing from/);
  await assert.rejects(assertSelectedReleaseBytes({ ...assets, 'runtime-policy.json': `sha256:${'e'.repeat(64)}` }, selected),
    /runtime-policy.json differs from its published digest/);
  await assert.rejects(assertSelectedReleaseBytes({ 'pre-sign-up.zip': digests['pre-sign-up.zip'] }, selected),
    /Invalid travelled release assets fields/);
  await assert.rejects(assertSelectedReleaseBytes({ ...assets, 'service-artifacts.json': `sha256:${'d'.repeat(64)}` }, selected),
    /Invalid travelled release assets fields/);
  await assert.rejects(assertSelectedReleaseBytes({ ...assets, 'pre-sign-up.zip': 'abc' }, selected),
    /Invalid travelled release asset pre-sign-up.zip/);
  // The record's own contract stays the three consumed names.
  assert.deepEqual(Object.keys(record.assets), [...STAGE_BASE_ASSETS]);
});

test('an annotated tag dereferences to its commit and a chain deeper than four refuses', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const tagSha = '2'.repeat(40);
  const annotated = await releaseMock(fixture, { refObject: { type: 'tag', sha: tagSha },
    tagDerefs: { [tagSha]: { object: { type: 'commit', sha: serviceCommit } } } });
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run: annotated.run,
    token: 'read-only-token', directory: selected });
  assert.equal(record.release.source_sha, serviceCommit);
  assert.equal(annotated.calls.filter(([, args]) => args[0] === 'api').length, 3);

  // A self-referential annotated tag never terminates within the bound.
  const loop = '3'.repeat(40);
  const deep = await releaseMock(fixture, { refObject: { type: 'tag', sha: loop },
    tagDerefs: { [loop]: { object: { type: 'tag', sha: loop } } } });
  await assert.rejects(runVerifyInputs({ env: releaseEnv('deploy-platform'), run: deep.run,
    token: 'read-only-token', directory: selected }), /annotated-tag chain deeper than 4/);
  assert.equal(deep.calls.some(([, args]) => args[0] === 'release'), false);

  // A chain that ends in a non-commit refuses too.
  const tree = await releaseMock(fixture, { refObject: { type: 'tag', sha: loop },
    tagDerefs: { [loop]: { object: { type: 'tree', sha: serviceCommit } } } });
  await assert.rejects(runVerifyInputs({ env: releaseEnv('deploy-platform'), run: tree.run,
    token: 'read-only-token', directory: selected }), /does not resolve to a commit/);
});

test('requires the numeric REST release id, not a GraphQL node id', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const stringId = await releaseMock(fixture, { mutateRelease: release => ({ ...release, id: 'RE_kwDORQyzo84Y1D8V' }) });
  await assert.rejects(runVerifyInputs({ env: releaseEnv('deploy-platform'), run: stringId.run,
    token: 'read-only-token', directory: selected }), /Invalid release ID/);
  assert.equal(stringId.calls.some(([, args]) => args[0] === 'release'), false);

  const { run } = await releaseMock(fixture);
  const record = await runVerifyInputs({ env: releaseEnv('deploy-platform'), run, token: 'read-only-token',
    directory: selected });
  assert.equal(record.release.id, 407218593);
  assert.equal(Number.isSafeInteger(record.release.id), true);
});

test('the release identity refusal matrix fails before any download', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const cases = [
    ['a draft release', { mutateRelease: release => ({ ...release, draft: true }) }, /is a draft/],
    ['a mutable release', { mutateRelease: release => ({ ...release, immutable: false }) }, /is not immutable/],
    ['a release that omits immutability', { mutateRelease: release => { const { immutable, ...rest } = release; return rest; } },
      /is not immutable/],
    ['a release that names another tag', { mutateRelease: release => ({ ...release, tag_name: 'service-artifacts-deadbeef' }) },
      /names service-artifacts-deadbeef/],
    ['a missing consumed asset', { mutateAssets: assets => assets.filter(asset => asset.name !== 'pre-sign-up.zip') },
      /lacks pre-sign-up.zip; observed .*post-confirmation\.zip/],
    ['a duplicated consumed asset', { mutateAssets: assets => [...assets, assets.find(asset => asset.name === 'runtime-policy.json')] },
      /duplicates runtime-policy.json/],
    ['an unuploaded asset', { mutateAssets: assets => assets.map(asset => asset.name === 'post-confirmation.zip'
      ? { ...asset, state: 'delisted' } : asset) }, /post-confirmation.zip is delisted, not uploaded/],
    ['an empty asset', { mutateAssets: assets => assets.map(asset => asset.name === 'runtime-policy.json'
      ? { ...asset, size: 0 } : asset) }, /runtime-policy.json is empty/],
    ['a missing digest', { mutateAssets: assets => assets.map(asset => asset.name === 'pre-sign-up.zip'
      ? { ...asset, digest: null } : asset) }, /pre-sign-up.zip has no sha256 digest \(absent\)/],
    ['a malformed digest', { mutateAssets: assets => assets.map(asset => asset.name === 'post-confirmation.zip'
      ? { ...asset, digest: 'md5:abc' } : asset) }, /post-confirmation.zip has no sha256 digest \(md5:abc\)/],
  ];
  for (const [label, options, pattern] of cases) {
    const { calls, run } = await releaseMock(fixture, options);
    await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
      directory: selected }), pattern, label);
    assert.equal(calls.some(([, args]) => args[0] === 'release' && args[1] === 'download'), false, label);
  }
});

test('a tag that resolves to another commit is refused and names both commits', async () => {
  const fixture = await newFixture();
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  const other = '9'.repeat(40);
  const { calls, run } = await releaseMock(fixture, { refObject: { type: 'commit', sha: other } });
  await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'), run, token: 'read-only-token',
    directory: selected }), new RegExp(`resolves to ${other}, not the reviewed commit ${serviceCommit}`));
  assert.equal(calls.some(([, args]) => args[0] === 'release' && args[1] === 'download'), false);
  // A tag ref that names another tag (or several refs) cannot state a commit.
  const wrongRef = await releaseMock(fixture);
  const response = { ref: 'refs/tags/somewhere-else', object: { type: 'commit', sha: serviceCommit } };
  await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'),
    run: async (command, args, options) => {
      if (args[0] === 'api' && args[1].includes('/git/ref/')) return { stdout: JSON.stringify(response) };
      return wrongRef.run(command, args, options);
    }, token: 'read-only-token', directory: selected }), /did not resolve to exactly one tag ref/);
});

test('fails closed without an identity or a read-only Service token', async () => {
  const selected = await temporary('infra-release-selected-', path.join('.service-artifacts', 'selected'));
  let invoked = false;
  const forbidden = async () => { invoked = true; throw new Error('must not read a release without an identity'); };
  await assert.rejects(runVerifyInputs({ env: { INFRA_OPERATION: 'restore-release' }, run: forbidden,
    token: 'read-only-token', directory: selected }), /requires the explicit Service release tag/);
  await assert.rejects(runVerifyInputs({ env: { INFRA_OPERATION: 'restore-release', SERVICE_ARTIFACT_TAG: releaseTag },
    run: forbidden, token: 'read-only-token', directory: selected }), /Invalid Service release source commit/);
  assert.equal(invoked, false);

  const fixture = await newFixture();
  const { run } = await releaseMock(fixture);
  await assert.rejects(runVerifyInputs({ env: releaseEnv('restore-release'), run, directory: selected }),
    /A read-only Service token is required/);
});
