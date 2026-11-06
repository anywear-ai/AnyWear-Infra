import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha256 } from '../../scripts/lib/json-contract.mjs';
import { STAGE_BASE_ASSETS } from '../../scripts/lib/release-inputs.mjs';

// The deploy job's pre-credential byte and identity proof (#207). It runs as its
// own step, before `runtime-operation.mjs`, so these tests execute the real script
// in a child process and assert it exits non-zero on a corrupted byte without any
// credential path being reached. A fake OIDC endpoint and token are in the
// environment for every case: the only failure that may be reported is the byte
// or digest one, never an OIDC error.
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const script = path.join(root, 'scripts', 'prove-release-bytes.mjs');
// The script reads the module-level directory the workflow downloads into.
const selected = path.join(root, '.service-artifacts', 'selected');
const serviceCommit = 'b'.repeat(40);
const releaseTag = `service-artifacts-${serviceCommit}`;

const env = (overrides = {}) => ({
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
  GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '321', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'deploy-platform', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: releaseTag, SERVICE_COMMIT: serviceCommit,
  // A credential endpoint that must never be consulted on this path.
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'must-not-be-used',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
  ...overrides,
});

// Lay down exactly the three stage-base bytes plus a valid runtime policy. The
// published digest set is computed from the files, the way the verify job's
// `release_assets` output would be.
async function travelled() {
  await rm(selected, { recursive: true, force: true });
  await mkdir(selected, { recursive: true });
  await copyFile(path.join(root, 'test', 'fixtures', 'placeholder.zip'), path.join(selected, 'pre-sign-up.zip'));
  await copyFile(path.join(root, 'test', 'fixtures', 'placeholder.zip'), path.join(selected, 'post-confirmation.zip'));
  await copyFile(path.join(root, 'test', 'fixtures', 'runtime-policy.json'), path.join(selected, 'runtime-policy.json'));
  const assets = {};
  for (const name of STAGE_BASE_ASSETS) {
    assets[name] = `sha256:${sha256(await readFile(path.join(selected, name)))}`;
  }
  return assets;
}

// #243: the migration consumes exactly `service-schema.json`, so that is all the
// verify job downloads and all the deploy job may find in the travelled directory.
async function travelledSchema() {
  await rm(selected, { recursive: true, force: true });
  await mkdir(selected, { recursive: true });
  const name = 'service-schema.json';
  await copyFile(path.join(root, 'test', 'fixtures', 'schema-boundary', 'schema-asset.json'), path.join(selected, name));
  return { [name]: `sha256:${sha256(await readFile(path.join(selected, name)))}` };
}

async function run(extraEnv) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [script], {
      cwd: root, env: env(extraEnv), timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test.after(async () => {
  await rm(selected, { recursive: true, force: true });
});

test('the proof accepts the exact travelled set and prints each published digest', async () => {
  const assets = await travelled();
  const result = await run({ VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.equal(result.code, 0, result.stderr);
  for (const name of STAGE_BASE_ASSETS) {
    assert.match(result.stdout, new RegExp(`${name} ${assets[name]} matches the published digest`));
  }
  assert.match(result.stdout, /deploy-platform consumes anywear-ai\/AnyWear-Service/);
});

test('a corrupted travelled byte fails closed before any credential', async () => {
  const assets = await travelled();
  // Replace one byte of one file after the digest set was computed: the published
  // digest no longer matches what travelled.
  const bytes = await readFile(path.join(selected, 'runtime-policy.json'));
  await writeFile(path.join(selected, 'runtime-policy.json'), Buffer.concat([bytes, Buffer.from(' ')]));
  const result = await run({ VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Travelled release asset runtime-policy\.json differs from its published digest/);
});

test('a missing, malformed or different digest set fails closed', async () => {
  const assets = await travelled();
  const cases = [
    ['absent', undefined, /published no release digest for this dispatch/],
    ['empty', '', /published no release digest for this dispatch/],
    ['not JSON', 'not-json', /not valid JSON/],
    ['not a map', '[]', /not an asset map/],
    ['one asset missing', JSON.stringify({ ...assets, 'pre-sign-up.zip': undefined }), /Invalid travelled release assets fields/],
    ['an extra asset', JSON.stringify({ ...assets, 'service-schema.json': `sha256:${'d'.repeat(64)}` }), /Invalid travelled release assets fields/],
    ['a malformed digest', JSON.stringify({ ...assets, 'runtime-policy.json': 'sha256:abc' }), /Invalid travelled release asset runtime-policy\.json/],
  ];
  for (const [label, value, pattern] of cases) {
    const result = await run({ VERIFIED_RELEASE_ASSETS: value });
    assert.notEqual(result.code, 0, label);
    assert.match(result.stderr, pattern, label);
  }
});

test('an operation that consumes no release requires an empty asset set', async () => {
  await travelled();
  const nonRelease = { INFRA_OPERATION: 'deploy-foundation', SERVICE_ARTIFACT_TAG: '', SERVICE_COMMIT: '' };
  const empty = await run({ ...nonRelease, VERIFIED_RELEASE_ASSETS: '{}' });
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /consumes no Service release/);
  const carried = await run({ ...nonRelease, VERIFIED_RELEASE_ASSETS: JSON.stringify({ 'service-schema.json': `sha256:${'d'.repeat(64)}` }) });
  assert.notEqual(carried.code, 0);
  assert.match(carried.stderr, /Invalid travelled release assets fields/);
});

// #243: `migrate` takes the release identity and runs the sealed artifact's
// migration, so it travels exactly `service-schema.json` and strictly loads it.
// The summary line must not claim a deploy the operation does not perform.
test('migrate proves only the schema asset and claims no deploy', async () => {
  const assets = await travelledSchema();
  const result = await run({ INFRA_OPERATION: 'migrate', VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout,
    new RegExp(`service-schema\\.json ${assets['service-schema.json']} matches the published digest`));
  assert.match(result.stdout, /mutate\.yml migrate consumes anywear-ai\/AnyWear-Service/);
  assert.equal(/deploys/.test(result.stdout), false, 'migrate runs a one-shot and deploys nothing');
});

test('migrate refuses a digest mismatch, a widened travelled set and a missing file', async () => {
  const assets = await travelledSchema();

  // A changed byte after the digest set was computed.
  const bytes = await readFile(path.join(selected, 'service-schema.json'));
  await writeFile(path.join(selected, 'service-schema.json'), Buffer.concat([bytes, Buffer.from(' ')]));
  const tampered = await run({ INFRA_OPERATION: 'migrate', VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.stderr, /Travelled release asset service-schema\.json differs from its published digest/);

  // A published set widened with a stage-base asset the migration never consumes.
  await travelledSchema();
  const widened = await run({ INFRA_OPERATION: 'migrate',
    VERIFIED_RELEASE_ASSETS: JSON.stringify({ ...assets, 'pre-sign-up.zip': `sha256:${'d'.repeat(64)}` }) });
  assert.notEqual(widened.code, 0);
  assert.match(widened.stderr, /Invalid travelled release assets fields/);

  // A travelled directory carrying a second file as well.
  await travelledSchema();
  await copyFile(path.join(root, 'test', 'fixtures', 'placeholder.zip'), path.join(selected, 'pre-sign-up.zip'));
  const widenedDirectory = await run({ INFRA_OPERATION: 'migrate', VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.notEqual(widenedDirectory.code, 0);
  assert.match(widenedDirectory.stderr, /The travelled release directory holds \[pre-sign-up\.zip, service-schema\.json\], not exactly \[service-schema\.json\]/);

  // The published asset that did not travel.
  await rm(selected, { recursive: true, force: true });
  await mkdir(selected, { recursive: true });
  const missing = await run({ INFRA_OPERATION: 'migrate', VERIFIED_RELEASE_ASSETS: JSON.stringify(assets) });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Travelled release asset service-schema\.json is missing from/);
});
