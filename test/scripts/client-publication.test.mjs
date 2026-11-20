import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertInterfaceMatches, assertPublisherJobs, assertPublisherRun, bundleManifestDigest,
  extractZip, findClientDistArtifact, normalizeBundleTree, publicationRecord, publishClientBundle,
  readBuildMetadata, readZipEntries, resolveLiveInterface, verifyClientBundle,
} from '../../scripts/client-publication.mjs';
import { CLIENT_DIST_DIRECTORY, CLIENT_PUBLICATION_ROLE_ARN, clientInvalidationArguments,
  clientSyncArguments } from '../../scripts/lib/client-interface.mjs';
import { sha256 } from '../../scripts/lib/json-contract.mjs';

// Issue #344: the Client publication. `verify` proves the Client publisher run and
// the bytes over REST; `publish` resolves and matches the live interface and then
// performs exactly two writes under the narrowed session. Every fake here records
// what was called, so the tests prove the order and the refusals, not only the
// happy path.
const runId = '40123456789';
const attempt = '2';
const clientSource = 'c'.repeat(40);
const bucket = 'anywear-beta-client-bucket';
const distributionId = 'E1ABC2DEF3GHIJ';
const invalidationId = 'I2J3K4L5M6N7';
const interfaceValues = {
  api_base_url: 'https://d111111abcdef8.cloudfront.net',
  cognito_user_pool_id: 'ap-east-1_pool',
  cognito_client_id: 'client-id-value',
};
const buildMetadata = JSON.stringify({ schema_version: 3, component: 'AnyWear-Client',
  source_commit: clientSource, client_version: 7, interface: interfaceValues });
const manifest = JSON.stringify({ files: ['index.html'] });
const digest = sha256(Buffer.from(manifest));

// A stored/deflated ZIP writer, so the reader is exercised against a real archive
// rather than a mock. `method` 0 is stored and 8 is deflated.
function buildZip(files, { method = 0, crc } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name, 'utf8');
    const body = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc === undefined ? crc32(data) : crc;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, body);
    central.push(record, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const zipBytes = (files = { 'index.html': '<html></html>', 'bundle-manifest.json': manifest,
  'build-metadata.json': buildMetadata }, options = undefined) => buildZip(files, options);

const withTemporary = async body => {
  const root = await mkdtemp(path.join(tmpdir(), 'anywear-client-publication-'));
  try {
    return await body({ root, directory: path.join(root, 'download'), tree: path.join(root, 'dist'),
      record: path.join(root, 'publication', 'publication-record.json'),
      output: path.join(root, 'output'), summary: path.join(root, 'summary.md') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: 'anywear-ai/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'anywear-ai/AnyWear-Infra/.github/workflows/mutate.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', ENABLE_BETA_MUTATION: 'true',
  INFRA_OPERATION: 'publish-client', INFRA_IDENTITY_PHASE: 'retired', INFRA_RETENTION_PROTECTION: 'true',
  SERVICE_ARTIFACT_TAG: '', SERVICE_COMMIT: '', TESTER_EMAILS: '[]',
  DELIVERY_TRIGGER: 'publish', DISPATCHED_BY: 'https://github.com/anywear-ai/AnyWear-Client/actions/runs/40123456790',
  CLIENT_RUN_ID: runId, CLIENT_RUN_ATTEMPT: attempt, CLIENT_BUNDLE_DIGEST: digest,
  CLIENT_PUBLISH_ROLE_ARN: CLIENT_PUBLICATION_ROLE_ARN,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/oidc?x=1',
  ...overrides,
});

// The normal publication path: the Client `handoff` job dispatches this Infra run
// and polls the Infra `deploy` job before it can finish, so while `verify` runs the
// publisher run is `in_progress` with a null conclusion. Infra run 44741083609
// refused Client run 44739908276 because the old proof demanded `completed/success`;
// that is the defect this fixture encodes.
const publisherRun = (overrides = {}) => ({ id: Number(runId), repository: { id: 1176104200 },
  path: '.github/workflows/release.yml', head_branch: 'main', head_sha: clientSource,
  status: 'in_progress', conclusion: null, run_attempt: Number(attempt), ...overrides });
const completedPublisherRun = (overrides = {}) => publisherRun({ status: 'completed', conclusion: 'success', ...overrides });
// The REST jobs API reports each job's `name:` display name, never its workflow key.
// These two are AnyWear-Client/.github/workflows/release.yml's `build` and `verify`
// names; Infra run 44743538352 refused Client run 44743036410 with "job build is
// absent" because the fixtures (and the proof) used the bare keys.
const BUILD_JOB = 'Build the reviewed Beta web client';
const VERIFY_JOB = 'Verify the built Beta web client';
const bundleJobs = (overrides = {}) => [{ name: BUILD_JOB, conclusion: 'success' },
  { name: VERIFY_JOB, conclusion: 'success', ...overrides }];

// A fake `gh api` for the three REST reads the verify mode makes.
function fakeGh({ run: runBody = publisherRun(), jobs, artifacts } = {}) {
  const calls = [];
  const run = async (command, args) => {
    assert.equal(command, 'gh');
    calls.push([...args]);
    const endpoint = args[1];
    if (endpoint === `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}`) {
      return { stdout: JSON.stringify(runBody), stderr: '' };
    }
    if (endpoint === `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}/jobs`) {
      return { stdout: JSON.stringify({ jobs: jobs ?? bundleJobs() }), stderr: '' };
    }
    if (endpoint === `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}/artifacts`) {
      return { stdout: JSON.stringify({ artifacts: artifacts ?? [
        { id: 9001, name: 'client-dist', expired: false, size_in_bytes: 128,
          workflow_run: { id: Number(runId) } }] }), stderr: '' };
    }
    throw new Error(`unexpected gh api ${endpoint}`);
  };
  return { calls, run };
}

const downloadResponse = (bytes = zipBytes(), status = 200) => async (url, options) => {
  assert.match(url, /^https:\/\/api\.github\.com\/repos\/anywear-ai\/AnyWear-Client\/actions\/artifacts\/9001\/zip$/);
  assert.equal(options.headers.Authorization, 'Bearer ghs_client_read');
  return { ok: status === 200, status, arrayBuffer: async () => bytes };
};

const sink = () => {
  const chunks = [];
  return { out: { write: chunk => chunks.push(chunk) }, text: () => chunks.join('') };
};

test('verify proves the publisher run, downloads the artifact and recomputes the manifest digest', async () => {
  await withTemporary(async ({ directory, tree, output }) => {
    const gh = fakeGh();
    const streams = sink();
    const result = await verifyClientBundle({ env: env({ GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output }),
      run: gh.run, request: downloadResponse(), directory, tree, out: streams.out });
    assert.equal(result.digest, digest);
    assert.equal(result.source_commit, clientSource);
    assert.equal(result.run_url, `https://github.com/anywear-ai/AnyWear-Client/actions/runs/${runId}`);
    // The three REST reads, in the order the proof needs them.
    assert.deepEqual(gh.calls.map(args => args[1]), [
      `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}`,
      `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}/jobs`,
      `repos/anywear-ai/AnyWear-Client/actions/runs/${runId}/artifacts`,
    ]);
    // The verified tree is the bundle root, and the step outputs carry the digest.
    assert.equal(await readFile(path.join(tree, 'bundle-manifest.json'), 'utf8'), manifest);
    assert.equal(await readFile(path.join(tree, 'index.html'), 'utf8'), '<html></html>');
    assert.equal(await readFile(output, 'utf8'),
      `client_bundle_digest=${digest}\nclient_source_commit=${clientSource}\n`);
    assert.match(streams.text(), new RegExp(`${digest} equals the dispatched client_bundle_digest`));
    // The success line states what was actually proved, by the display names the
    // job proof matched.
    assert.match(streams.text(), /in progress, jobs 'Build the reviewed Beta web client' and 'Verify the built Beta web client' succeeded/);
  });
});

// The two accepted states, and the refusal for every other one.
test('the publisher run is accepted in progress or completed success, and refused otherwise', async () => {
  const verify = async ({ gh, directory, tree, output }) =>
    verifyClientBundle({ env: env({ GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output }),
      run: gh.run, request: downloadResponse(), directory, tree, out: sink().out });
  // (1) in progress with both bundle jobs successful — the normal path, recorded
  // from Infra run 44741083609 / Client run 44739908276.
  await withTemporary(async ({ directory, tree, output }) => {
    const result = await verify({ gh: fakeGh({ run: publisherRun() }), directory, tree, output });
    assert.equal(result.digest, digest);
  });
  // (2) completed success.
  await withTemporary(async ({ directory, tree, output }) => {
    const result = await verify({ gh: fakeGh({ run: completedPublisherRun() }), directory, tree, output });
    assert.equal(result.digest, digest);
  });
  // (3) every other state is refused, naming the status, the conclusion and both
  // job conclusions.
  for (const [label, runBody, expectation] of [
    ['completed failure', completedPublisherRun({ conclusion: 'failure' }),
      /is completed\/failure with Build the reviewed Beta web client success, Verify the built Beta web client success, not a completed success/],
    ['completed cancelled', completedPublisherRun({ conclusion: 'cancelled' }),
      /is completed\/cancelled with Build the reviewed Beta web client success, Verify the built Beta web client success, not a completed success/],
    ['completed without a conclusion', publisherRun({ status: 'completed', conclusion: null }),
      /is completed\/null with Build the reviewed Beta web client success, Verify the built Beta web client success, not a completed success/],
    ['queued', publisherRun({ status: 'queued' }),
      /is queued\/null with Build the reviewed Beta web client success, Verify the built Beta web client success, not in progress with both bundle jobs successful or a completed success/],
    ['requested', publisherRun({ status: 'requested' }),
      /is requested\/null with Build the reviewed Beta web client success, Verify the built Beta web client success, not in progress/],
    ['waiting', publisherRun({ status: 'waiting' }),
      /is waiting\/null with Build the reviewed Beta web client success, Verify the built Beta web client success, not in progress/],
    ['pending', publisherRun({ status: 'pending' }),
      /is pending\/null with Build the reviewed Beta web client success, Verify the built Beta web client success, not in progress/],
    ['in progress carrying a conclusion', publisherRun({ conclusion: 'success' }),
      /is in_progress\/success with Build the reviewed Beta web client success, Verify the built Beta web client success, not in progress/],
  ]) {
    await withTemporary(async ({ directory, tree, output }) => {
      await assert.rejects(verify({ gh: fakeGh({ run: runBody }), directory, tree, output }), expectation, label);
    });
  }
  // (4) in progress with a bundle job that did not succeed is refused by the job
  // proof, which names the expected display name and the run state.
  for (const [label, jobs, expectation] of [
    ['verify failed', [{ name: BUILD_JOB, conclusion: 'success' }, { name: VERIFY_JOB, conclusion: 'failure' }],
      /job 'Verify the built Beta web client' is failure, not a success \(run in_progress\/null\)/],
    ['verify absent', [{ name: BUILD_JOB, conclusion: 'success' }],
      /job 'Verify the built Beta web client' is absent, not a success \(run in_progress\/null\)/],
    ['build failed', [{ name: BUILD_JOB, conclusion: 'failure' }, { name: VERIFY_JOB, conclusion: 'success' }],
      /job 'Build the reviewed Beta web client' is failure, not a success \(run in_progress\/null\)/],
    // The defect this branch fixes: a job list carrying the workflow keys and not
    // the display names is refused, and the refusal names the expected display name.
    ['bare workflow keys', [{ name: 'build', conclusion: 'success' }, { name: 'verify', conclusion: 'success' }],
      /job 'Build the reviewed Beta web client' is absent, not a success \(run in_progress\/null\)/],
    ['only the build job by key', [{ name: 'build', conclusion: 'success' }, { name: VERIFY_JOB, conclusion: 'success' }],
      /job 'Build the reviewed Beta web client' is absent, not a success/],
  ]) {
    await withTemporary(async ({ directory, tree, output }) => {
      await assert.rejects(verify({ gh: fakeGh({ jobs }), directory, tree, output }), expectation, label);
    });
  }
});

test('verify accepts a bundle nested under dist/ and normalises it to the transport tree', async () => {
  await withTemporary(async ({ directory, tree, output }) => {
    const zip = zipBytes({ 'dist/index.html': '<html></html>', 'dist/bundle-manifest.json': manifest,
      'dist/build-metadata.json': buildMetadata });
    const result = await verifyClientBundle({ env: env({ GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output }),
      run: fakeGh().run, request: downloadResponse(zip), directory, tree, out: sink().out });
    assert.equal(result.digest, digest);
    assert.equal(await readFile(path.join(tree, 'bundle-manifest.json'), 'utf8'), manifest);
    assert.equal(await readFile(path.join(tree, 'index.html'), 'utf8'), '<html></html>');
  });
});

test('verify refuses a run that is not the Client publisher it names', async () => {
  const verify = async ({ gh, env: overrides = {}, request = downloadResponse(), tree, directory, output } = {}) =>
    verifyClientBundle({ env: env({ GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output, ...overrides }),
      run: gh.run, request, directory, tree, out: sink().out });
  for (const [label, runBody, expectation] of [
    ['repository', publisherRun({ repository: { id: 1 } }), /belongs to repository id 1, not 1176104200/],
    ['workflow path', publisherRun({ path: '.github/workflows/check.yml' }), /ran .*check\.yml, not .github\/workflows\/release\.yml/],
    ['branch', publisherRun({ head_branch: 'feature' }), /ran on feature, not main/],
    ['attempt', publisherRun({ run_attempt: 1 }), /is attempt 1, not the dispatched attempt 2/],
    ['head sha', publisherRun({ head_sha: 'short' }), /source commit/],
  ]) {
    await withTemporary(async ({ directory, tree, output }) => {
      await assert.rejects(verify({ gh: fakeGh({ run: runBody }), directory, tree, output }), expectation, label);
    });
  }
});

test('verify refuses a missing, expired or duplicated client-dist artifact', async () => {
  const verify = async (artifacts, { directory, tree, output }) => verifyClientBundle({ env: env({
    GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output }), run: fakeGh({ artifacts }).run,
  request: downloadResponse(), directory, tree, out: sink().out });
  for (const [artifacts, expectation] of [
    [[], /published 0 client-dist artifact\(s\), not one/],
    [[{ id: 1, name: 'client-dist', expired: false }, { id: 2, name: 'client-dist', expired: false }],
      /published 2 client-dist artifact\(s\), not one/],
    [[{ id: 1, name: 'other', expired: false }], /published 0 client-dist artifact\(s\), not one/],
    [[{ id: 1, name: 'client-dist', expired: true }], /is expired or unstated/],
    [[{ id: 1, name: 'client-dist', expired: false, workflow_run: { id: 1 } }], /belongs to run 1, not 40123456789/],
  ]) {
    await withTemporary(async ({ directory, tree, output }) => {
      await assert.rejects(verify(artifacts, { directory, tree, output }), expectation);
    });
  }
});

test('verify refuses a digest that is not the dispatched one, or a bundle from another source', async () => {
  await withTemporary(async ({ directory, tree, output }) => {
    const envFor = overrides => env({ GH_TOKEN: 'ghs_client_read', GITHUB_OUTPUT: output, ...overrides });
    // The download answered a different manifest than the dispatch named.
    await assert.rejects(verifyClientBundle({ env: envFor(), run: fakeGh().run,
      request: downloadResponse(zipBytes({ 'bundle-manifest.json': '{"files":[]}',
        'build-metadata.json': buildMetadata })), directory, tree, out: sink().out }),
    /is not the dispatched client_bundle_digest/);
    // The bundle names a source commit that is not the run's head sha.
    await assert.rejects(verifyClientBundle({ env: envFor(), run: fakeGh().run,
      request: downloadResponse(zipBytes({ 'bundle-manifest.json': manifest,
        'build-metadata.json': JSON.stringify({ schema_version: 3, component: 'AnyWear-Client',
          source_commit: 'e'.repeat(40), interface: interfaceValues }) })), directory, tree, out: sink().out }),
    /was built from e{40}, not the publisher run's source c{40}/);
    // A failed download is a refusal.
    await assert.rejects(verifyClientBundle({ env: envFor(), run: fakeGh().run,
      request: downloadResponse(zipBytes(), 500), directory, tree, out: sink().out }),
    /download answered 500/);
  });
});

test('the ZIP reader refuses an unsafe name, a ZIP64 record and a CRC mismatch', () => {
  assert.deepEqual(readZipEntries(zipBytes({ 'a.txt': 'a' })).map(file => file.name), ['a.txt']);
  for (const name of ['../escape.txt', '/absolute.txt', 'dir/../../escape.txt', 'C:/windows.txt']) {
    assert.throws(() => readZipEntries(zipBytes({ [name]: 'x' })), /unsafe entry name/, name);
  }
  assert.throws(() => readZipEntries(Buffer.from('not a zip')), /no end-of-directory record/);
  assert.throws(() => readZipEntries(zipBytes({ 'a.txt': 'a' }, { crc: 1 })), /does not match its CRC/);
  // Deflated entries are inflated; the reader carries both admitted methods.
  assert.deepEqual(readZipEntries(buildZip({ 'a.txt': 'hello hello hello' }, { method: 8 }))
    .map(file => file.data.toString()), ['hello hello hello']);
  // A ZIP64 marker in a central record is refused rather than misread.
  const zip64 = zipBytes({ 'a.txt': 'a' });
  const central = zip64.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0, 'the fixture carries a central directory record');
  zip64.writeUInt32LE(0xffffffff, central + 24);
  assert.throws(() => readZipEntries(zip64), /ZIP64 record/);
});

test('the bundle tree must carry exactly one bundle root with both required files', async () => {
  await withTemporary(async ({ root, tree }) => {
    await mkdir(path.join(root, 'empty'), { recursive: true });
    await assert.rejects(normalizeBundleTree(path.join(root, 'empty'), tree), /carries 0 bundle roots, not one/);
    for (const where of ['', 'dist']) {
      const directory = path.join(root, `partial-${where === '' ? 'root' : where}`);
      await mkdir(path.join(directory, where), { recursive: true });
      await writeFile(path.join(directory, where, 'bundle-manifest.json'), manifest);
      await assert.rejects(normalizeBundleTree(directory, tree), /carries no build-metadata\.json/);
    }
    // Both roots present is ambiguous, so it is refused rather than guessed.
    const ambiguous = path.join(root, 'ambiguous');
    await mkdir(path.join(ambiguous, 'dist'), { recursive: true });
    for (const file of ['bundle-manifest.json', 'build-metadata.json']) {
      await writeFile(path.join(ambiguous, file), manifest);
      await writeFile(path.join(ambiguous, 'dist', file), manifest);
    }
    await assert.rejects(normalizeBundleTree(ambiguous, tree), /carries 2 bundle roots, not one/);
  });
});

test('the publisher proof and the artifact lookup are also unit-checkable', () => {
  const expected = { client_run_id: runId, client_run_attempt: Number(attempt) };
  // The normal path: in progress, both bundle jobs done.
  assert.equal(assertPublisherRun(publisherRun(), expected, bundleJobs()), clientSource);
  // A completed success is equally accepted.
  assert.equal(assertPublisherRun(completedPublisherRun(), expected, bundleJobs()), clientSource);
  assert.doesNotThrow(() => assertPublisherJobs(bundleJobs(), runId));
  assert.throws(() => assertPublisherJobs(null, runId), /artifact list is malformed|job list is malformed/);
  assert.deepEqual(findClientDistArtifact([{ id: 9001, name: 'client-dist', expired: false }], runId),
    { id: 9001, size: undefined });
  assert.throws(() => findClientDistArtifact(null, runId), /artifact list is malformed/);
});

// ---------------------------------------------------------------------------
// publish mode
// ---------------------------------------------------------------------------

const oidcRequest = async (url, options) => {
  assert.equal(String(url), 'https://pipelines.actions.githubusercontent.com/oidc?x=1&audience=sts.amazonaws.com');
  assert.equal(options.headers.Authorization, 'Bearer oidc-token');
  return { ok: true, json: async () => ({ value: 'signed-oidc-token' }) };
};

// A fake `aws` that answers the two assumptions, the three reads and the two
// writes, and records every call so a test can prove what was and was not issued.
function fakeAws({ outputs = { ApiBaseUrl: interfaceValues.api_base_url, ClientBucketName: bucket,
  ClientDistributionId: distributionId },
parameters = { '/anywear/beta/cognito_user_pool_id': interfaceValues.cognito_user_pool_id,
  '/anywear/beta/cognito_client_id': interfaceValues.cognito_client_id },
invalidation = invalidationId, account: sessionAccount = '650880818323', sessionArn } = {}) {
  const calls = [];
  let session = '';
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[0] === 'sts' && args[1] === 'assume-role-with-web-identity') {
      session = args[args.indexOf('--role-session-name') + 1];
      return { stdout: JSON.stringify({ AssumedRoleUser: {
        Arn: sessionArn ?? `arn:aws:sts::650880818323:assumed-role/beta-client-publish-role/${session}` },
      Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } }), stderr: '' };
    }
    if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
      return { stdout: JSON.stringify({ Account: sessionAccount,
        Arn: `arn:aws:sts::650880818323:assumed-role/beta-client-publish-role/${session}` }), stderr: '' };
    }
    if (args[0] === 'cloudformation' && args[1] === 'describe-stacks') {
      return { stdout: JSON.stringify({ Stacks: [{ Outputs: Object.entries(outputs)
        .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }), stderr: '' };
    }
    if (args[0] === 'ssm' && args[1] === 'get-parameter') {
      const name = args[args.indexOf('--name') + 1];
      if (!(name in parameters)) throw new Error(`no parameter ${name}`);
      return { stdout: JSON.stringify({ Parameter: { Value: parameters[name] } }), stderr: '' };
    }
    if (args[0] === 's3' && args[1] === 'sync') return { stdout: '', stderr: '' };
    if (args[0] === 'cloudfront' && args[1] === 'create-invalidation') {
      return { stdout: JSON.stringify({ Invalidation: { Id: invalidation } }), stderr: '' };
    }
    throw new Error(`unexpected aws ${args.join(' ')}`);
  };
  return { calls, run, writes: () => calls.filter(args => ['s3', 'cloudfront'].includes(args[0])) };
}

const prepareTree = async tree => {
  await mkdir(tree, { recursive: true });
  await writeFile(path.join(tree, 'bundle-manifest.json'), manifest);
  await writeFile(path.join(tree, 'build-metadata.json'), buildMetadata);
  await writeFile(path.join(tree, 'index.html'), '<html></html>');
  return tree;
};

const publish = async ({ aws, env: overrides = {}, directory, recordPath, out = sink().out, now } = {}) =>
  publishClientBundle({ env: env(overrides), run: aws.run, requestToken: oidcRequest, directory, recordPath,
    out, now: now ?? (() => new Date('2026-11-20T00:00:00.000Z')) });

test('publish resolves the live interface, refuses nothing, and performs exactly the two writes', async () => {
  await withTemporary(async ({ tree, record }) => {
    await prepareTree(tree);
    const aws = fakeAws();
    const result = await publish({ aws, directory: tree, recordPath: record });
    assert.equal(result.publisher.bundle_manifest_sha256, digest);
    assert.equal(result.invalidation_id, invalidationId);
    assert.equal(result.operation, 'publish-client');
    // Two assumptions of the one role: the read-only resolution and the narrowed
    // publication. The first carries only the three reads.
    const assumptions = aws.calls.filter(args => args[1] === 'assume-role-with-web-identity');
    assert.equal(assumptions.length, 2);
    assert.deepEqual(JSON.parse(assumptions[0][assumptions[0].indexOf('--policy') + 1]).Statement
      .flatMap(statement => [statement.Action].flat()).sort(),
    ['cloudformation:DescribeStacks', 'ssm:GetParameter', 'sts:GetCallerIdentity']);
    assert.match(JSON.stringify(JSON.parse(assumptions[1][assumptions[1].indexOf('--policy') + 1])), /"s3:PutObject"/);
    // The reads precede the first write; the two writes are the exact vectors, and
    // the only tokens appended after the allow-list check are the CLI's region and
    // output flags.
    const invoked = args => args.slice(0, args.length - 4);
    assert.deepEqual(aws.writes().map(args => args.slice(0, 2).join(' ')), ['s3 sync', 'cloudfront create-invalidation']);
    assert.deepEqual(invoked(aws.writes()[0]), clientSyncArguments(bucket));
    assert.deepEqual(invoked(aws.writes()[1]), clientInvalidationArguments(distributionId));
    for (const args of aws.writes()) {
      assert.deepEqual(args.slice(-4), ['--region', 'ap-east-1', '--output', 'json']);
    }
    assert.ok(aws.calls.indexOf(aws.writes()[0]) > aws.calls.findIndex(args => args[1] === 'describe-stacks'));
    // The one publication record, in the v2 contract: the Client run is named in
    // `publisher`, and `run_id`/`run_attempt` are this Infra run.
    const written = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(path.basename(record), 'publication-record.json');
    assert.deepEqual(written, {
      schema_version: 2,
      component: 'AnyWear-Client',
      source_commit: clientSource,
      publisher: {
        repository: 'anywear-ai/AnyWear-Client',
        run_id: Number(runId),
        run_attempt: Number(attempt),
        bundle_manifest_sha256: digest,
        build_metadata_schema_version: 3,
      },
      run_id: 77,
      run_attempt: 1,
      operation: 'publish-client',
      bucket,
      distribution_id: distributionId,
      invalidation_id: invalidationId,
      interface: interfaceValues,
      published_at: '2026-11-20T00:00:00.000Z',
    });
    assert.deepEqual(Object.keys(written), ['schema_version', 'component', 'source_commit', 'publisher', 'run_id',
      'run_attempt', 'operation', 'bucket', 'distribution_id', 'invalidation_id', 'interface', 'published_at']);
  });
});

test('publish refuses a live interface that differs from the built one before the first write', async () => {
  for (const [key, liveValue] of [['api_base_url', 'https://other.example'],
    ['cognito_user_pool_id', 'ap-east-1_other'], ['cognito_client_id', 'other-client-id']]) {
    await withTemporary(async ({ tree, record }) => {
      await prepareTree(tree);
      const aws = fakeAws({ parameters: {
        '/anywear/beta/cognito_user_pool_id': key === 'cognito_user_pool_id' ? liveValue : interfaceValues.cognito_user_pool_id,
        '/anywear/beta/cognito_client_id': key === 'cognito_client_id' ? liveValue : interfaceValues.cognito_client_id,
      }, outputs: { ApiBaseUrl: key === 'api_base_url' ? liveValue : interfaceValues.api_base_url,
        ClientBucketName: bucket, ClientDistributionId: distributionId } });
      await assert.rejects(publish({ aws, directory: tree, recordPath: record }),
        new RegExp(`differs from the built bundle for ${key}: the bundle was built for`));
      assert.deepEqual(aws.writes(), [], `${key}: no S3 or CloudFront call preceded the refusal`);
    });
  }
  // The comparison itself names the key and both values.
  assert.throws(() => assertInterfaceMatches(interfaceValues, { ...interfaceValues, cognito_client_id: 'other' }),
    /for cognito_client_id: the bundle was built for 'client-id-value', Beta serves 'other'/);
});

test('publish refuses a travelled digest that differs from the dispatch or the verify output', async () => {
  await withTemporary(async ({ tree, record }) => {
    await prepareTree(tree);
    const aws = fakeAws();
    await assert.rejects(publish({ aws, env: { CLIENT_BUNDLE_DIGEST: 'f'.repeat(64) }, directory: tree, recordPath: record }),
      /is not the dispatched client_bundle_digest/);
    await assert.rejects(publish({ aws, env: { VERIFIED_CLIENT_BUNDLE_DIGEST: 'f'.repeat(64) },
      directory: tree, recordPath: record }), /is not the digest the verify job published/);
    assert.deepEqual(aws.calls, [], 'no AWS call precedes the byte refusal');
  });
});

test('publish refuses a session that is not the dedicated role, and an invalidated nothing', async () => {
  await withTemporary(async ({ tree, record }) => {
    await prepareTree(tree);
    // The workflow literal must be the reviewed role ARN.
    await assert.rejects(publish({ aws: fakeAws(), env: { CLIENT_PUBLISH_ROLE_ARN: 'arn:aws:iam::650880818323:role/other' },
      directory: tree, recordPath: record }), /dedicated Beta Client publish role is not configured/);
    // The assumed principal must be that role's session.
    await assert.rejects(publish({ aws: fakeAws({ sessionArn: 'arn:aws:sts::650880818323:assumed-role/beta-infra-deploy-role/x' }),
      directory: tree, recordPath: record }), /assumed Client publish principal mismatch/);
    // An invalidation without an id never becomes a record.
    await assert.rejects(publish({ aws: fakeAws({ invalidation: '' }), directory: tree, recordPath: record }),
      /names no invalidation id/);
    // A wrong account or a non-CLIENT distribution id is refused in the resolution.
    await assert.rejects(publish({ aws: fakeAws({ account: '111111111111' }), directory: tree, recordPath: record }),
      /is in account 111111111111/);
    await assert.rejects(publish({ aws: fakeAws({ outputs: { ApiBaseUrl: interfaceValues.api_base_url,
      ClientBucketName: bucket, ClientDistributionId: 'not a distribution' } }), directory: tree, recordPath: record }),
    /is not a distribution id/);
    await assert.rejects(publish({ aws: fakeAws({ outputs: { ApiBaseUrl: interfaceValues.api_base_url,
      ClientBucketName: 'NOT_A_BUCKET', ClientDistributionId: distributionId } }), directory: tree, recordPath: record }),
    /is not a bucket name/);
    await assert.rejects(publish({ aws: fakeAws({ outputs: { ApiBaseUrl: interfaceValues.api_base_url,
      ClientDistributionId: distributionId } }), directory: tree, recordPath: record }),
    /has no ClientBucketName output/);
  });
});

test('the resolution and the record builders are unit-checkable', async () => {
  const session = { Account: '650880818323', Arn: 'arn:aws:sts::650880818323:assumed-role/beta-client-publish-role/x' };
  // The v2 record: `publisher` names the Client run, `run_id`/`run_attempt` name
  // this Infra run, and `operation` names the write.
  assert.deepEqual(publicationRecord({ env: env(), digest, source: clientSource,
    buildMetadataSchemaVersion: 3,
    live: { ...interfaceValues, bucket, distribution_id: distributionId }, invalidationId,
    publishedAt: '2026-11-20T00:00:00.000Z' }),
  { schema_version: 2, component: 'AnyWear-Client', source_commit: clientSource,
    publisher: { repository: 'anywear-ai/AnyWear-Client', run_id: Number(runId), run_attempt: Number(attempt),
      bundle_manifest_sha256: digest, build_metadata_schema_version: 3 },
    run_id: 77, run_attempt: 1, operation: 'publish-client', bucket,
    distribution_id: distributionId, invalidation_id: invalidationId, interface: interfaceValues,
    published_at: '2026-11-20T00:00:00.000Z' });
  // A stack with no outputs, and a parameter that is absent, are named refusals.
  const empty = async args => {
    if (args[1] === 'get-caller-identity') return session;
    if (args[1] === 'get-parameter') return { Parameter: { Value: 'x' } };
    return { Stacks: [{ Outputs: [] }] };
  };
  await assert.rejects(resolveLiveInterface(empty), /AnyWearPlatformStack-beta has no ApiBaseUrl output/);
  const missingParameter = async args => {
    if (args[1] === 'get-caller-identity') return session;
    if (args[1] === 'describe-stacks') return { Stacks: [{ Outputs: [
      { OutputKey: 'ApiBaseUrl', OutputValue: interfaceValues.api_base_url },
      { OutputKey: 'ClientBucketName', OutputValue: bucket },
      { OutputKey: 'ClientDistributionId', OutputValue: distributionId }] }] };
    return { Parameter: {} };
  };
  await assert.rejects(resolveLiveInterface(missingParameter),
    /SSM parameter \/anywear\/beta\/cognito_user_pool_id is absent/);
  const notTheRole = async args => (args[1] === 'get-caller-identity'
    ? { ...session, Arn: 'arn:aws:sts::650880818323:assumed-role/beta-infra-deploy-role/x' } : {});
  await assert.rejects(resolveLiveInterface(notTheRole), /is not the dedicated publish role/);
  // The metadata reader is the one place the bundle's interface is parsed.
  await withTemporary(async ({ tree }) => {
    await prepareTree(tree);
    assert.deepEqual(await readBuildMetadata(tree),
      { source_commit: clientSource, build_metadata_schema_version: 3, interface: interfaceValues });
    assert.equal(await bundleManifestDigest(tree), digest);
    await assert.rejects(readBuildMetadata(path.join(tree, 'missing')), /ENOENT/);
    assert.equal(CLIENT_DIST_DIRECTORY.endsWith(path.join('.client-artifacts', 'dist')), true);
    // A malformed or partial build metadata is named.
    await writeFile(path.join(tree, 'build-metadata.json'), JSON.stringify({ schema_version: 3,
      component: 'AnyWear-Other', source_commit: clientSource, interface: interfaceValues }));
    await assert.rejects(readBuildMetadata(tree), /names component AnyWear-Other/);
    await writeFile(path.join(tree, 'build-metadata.json'), JSON.stringify({ schema_version: 3,
      component: 'AnyWear-Client', source_commit: clientSource,
      interface: { api_base_url: interfaceValues.api_base_url } }));
    await assert.rejects(readBuildMetadata(tree), /carries no interface\.cognito_user_pool_id/);
    // A build-metadata record with no usable schema version cannot be pinned in the
    // publication record.
    await writeFile(path.join(tree, 'build-metadata.json'), JSON.stringify({ component: 'AnyWear-Client',
      source_commit: clientSource, interface: interfaceValues }));
    await assert.rejects(readBuildMetadata(tree), /build-metadata schema version/);
    assert.equal(typeof extractZip, 'function');
  });
});
