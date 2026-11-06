import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { canonicalJson, contentHash, sha256 } from '../../scripts/lib/json-contract.mjs';
import { stageContractSchemaHash } from '../../lib/contracts.mjs';
import { validateProductionContext, readReviewedRelease, assertTrustedQualificationMetadata, assertStableRelease,
  assertQualifiedRelease, verifyProductionRecord, resolveProductionInputs } from '../../scripts/production-preflight.mjs';
import { assertProductionExecutorReady, buildProductionPromotionPlan, verifyPromotionDigest, verifyPromotionScan } from '../../scripts/promote-production.mjs';

const execute = promisify(execFile);
const now = Date.parse('2026-10-08T01:00:00Z');
const infraSha = '5'.repeat(40); const e2eSha = '6'.repeat(40); const serviceSha = '1'.repeat(40);
const imageDigest = `sha256:${'4'.repeat(64)}`;
const run = { id: 77, run_attempt: 2, head_sha: e2eSha, head_branch: 'main', path: '.github/workflows/beta-qualification.yml',
  repository: { full_name: 'anywear-ai/AnyWear-E2E' }, head_repository: { full_name: 'anywear-ai/AnyWear-E2E' },
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_started_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-08T00:30:00Z' };
const artifact = { id: 78, expired: false, name: 'beta-qualification-77-2', workflow_run: { id: 77, head_sha: e2eSha },
  created_at: '2026-10-08T00:20:00Z', expires_at: '2099-01-01T00:00:00Z' };
const stable = { id: 79, tag_name: 'v1.2.3', draft: false, prerelease: false, immutable: true };
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/production.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'ap-east-1', PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-infra-deploy-role',
  QUALIFICATION_RUN_ID: '77', QUALIFICATION_RUN_ATTEMPT: '2', QUALIFICATION_ARTIFACT_ID: '78', QUALIFICATION_E2E_SHA: e2eSha,
  QUALIFICATION_RECORD_SHA256: '7'.repeat(64), STABLE_RELEASE_ID: '79', SERVICE_RELEASE_ID: '76',
  SERVICE_SOURCE_SHA: serviceSha, SERVICE_IMAGE_DIGEST: imageDigest };
const release = () => readReviewedRelease(env);

const clientSha = '2'.repeat(40);
const clientVersion = 7; const minimumClientVersion = 5;
const clientDomain = 'd111111abcdef8.cloudfront.net'; const clientUrl = `https://${clientDomain}`;
const serviceUrl = 'https://api.beta.anywear.example';
const platformInputs = [{ parameter: '/anywear/beta/vpc_id', version: '2', value_sha256: 'd'.repeat(64) }];

// One independent authenticated read of the deployed system. v3 carries the live
// Client/Service identity plus the platform content discovered through the
// platform's public APIs (#228): every `AnyWear*` stack in the two observation
// regions, the stage-contract inputs, the `beta-anywear-*` Lambdas and queues
// and the Client distribution domain. This replaces the v2 `deployment.record`
// chain: it proves the deployed content, not the Infra commit.
function observedPlatform() {
  return { stacks: [
    { name: 'AnyWearBillingStack-beta', region: 'us-east-1', template_sha256: 'f'.repeat(64) },
    { name: 'AnyWearFoundationStack', region: 'ap-east-1', template_sha256: 'f'.repeat(64) },
    { name: 'AnyWearPlatformStack-beta', region: 'ap-east-1', template_sha256: 'f'.repeat(64) },
  ], inputs: structuredClone(platformInputs), schema_sha256: stageContractSchemaHash(platformInputs),
  lambdas: [{ name: 'beta-anywear-post-confirmation-sync', code_sha256: `${'B'.repeat(43)}=`, configuration_sha256: '2'.repeat(64) },
    { name: 'beta-anywear-pre-sign-up', code_sha256: `${'A'.repeat(43)}=`, configuration_sha256: '1'.repeat(64) }],
  queues: [{ name: 'beta-anywear-vto', queueVisibilitySeconds: 30, maxReceives: 3 },
    { name: 'beta-anywear-vto-dlq', queueVisibilitySeconds: 30, maxReceives: null }],
  client_domain: clientDomain };
}

function observation(collectedAt) {
  return { collected_at: collectedAt, authenticated: true,
    client: { url: clientUrl, source_commit: clientSha, built_at: '2026-10-01T00:00:00Z' },
    service: { url: serviceUrl, service_commit: serviceSha, image_digest: imageDigest },
    platform: observedPlatform() };
}

// Flat qualification record v3: no `compatibility` pin, no `deployment` records and
// no `revisions.infra`. The consumer's additional cross-binding is asserted here;
// the pinned E2E verifier validates the whole schema, integrity and observations.
function qualificationFixture() {
  const payload = { schema_version: 3, record_type: 'anywear_beta_qualification',
    qualification_id: 'beta-77-2', result: 'passed', operation: 'full', qualified_at: '2026-10-08T00:25:00Z',
    environment: { stage: 'beta', aws_account_id: '650880818323', aws_region: 'ap-east-1', client_url: clientUrl, service_url: serviceUrl },
    expected: { service_commit: serviceSha, client_commit: null, source: 'trigger' },
    revisions: { e2e: { repository: 'anywear-ai/AnyWear-E2E', sha: e2eSha },
      client: { repository: 'anywear-ai/AnyWear-Client', sha: clientSha, client_version: clientVersion },
      service: { repository: 'anywear-ai/AnyWear-Service', sha: serviceSha, image_digest: imageDigest,
        minimum_client_version: minimumClientVersion } },
    service_artifacts: { repository: 'anywear-ai/AnyWear-Service', release_id: 76, tag: `service-artifacts-${serviceSha}`,
      manifest_asset_id: 1, manifest_sha256: 'e'.repeat(64) },
    observations: { before: observation('2026-10-08T00:05:00Z'), after: observation('2026-10-08T00:20:00Z') },
    test: { runner: 'playwright', result: 'passed', selection: { invocation: 'pnpm test:regression', tag: '@regression' },
      scenarios: [{ file: 'tests/wardrobe-lifecycle.spec.ts', outcome: 'passed', collected: 3, skipped: 0 }],
      report_sha256: 'c'.repeat(64) },
    workflow: { repository: 'git-malu/AnyWear-E2E', path: '.github/workflows/beta-qualification.yml',
      ref: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main',
      run_id: 77, run_attempt: 2, run_url: 'https://github.com/git-malu/AnyWear-E2E/actions/runs/77',
      trigger: 'release-qualify', dispatched_by: 'https://github.com/git-malu/AnyWear-Service/actions/runs/80' } };
  return { ...payload, integrity: { algorithm: 'sha256', payload_sha256: sha256(canonicalJson(payload)) } };
}

test('future Production context binds protected source, account, IDs and the reviewed release identity', () => {
  validateProductionContext(env);
  assert.deepEqual(release(), { release_id: 76, source_sha: serviceSha, image_digest: imageDigest });
  for (const patch of [{ GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REF: 'refs/heads/branch' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('production', 'runtime') },
    { PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-github-actions-pipeline-role' },
    { QUALIFICATION_RUN_ATTEMPT: '9007199254740992' },
    { SERVICE_SOURCE_SHA: 'not-a-sha' }, { SERVICE_IMAGE_DIGEST: 'sha256:short' }, { SERVICE_RELEASE_ID: '0' }]) {
    assert.throws(() => validateProductionContext({ ...env, ...patch }));
  }
});

test('trusted qualification rejects rerun mixing, incomplete jobs, old artifact attempts and expiration', () => {
  assertTrustedQualificationMetadata(run, artifact, env, now);
  for (const patch of [{ run_attempt: 1 }, { head_sha: '8'.repeat(40) }, { head_branch: 'pr' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { head_repository: { full_name: 'other/fork' } }]) {
    assert.throws(() => assertTrustedQualificationMetadata({ ...run, ...patch }, artifact, env, now));
  }
  for (const patch of [{ id: 80 }, { expired: true }, { expires_at: 'invalid' }, { expires_at: '2026-10-08T01:00:00Z' },
    { name: 'beta-qualification-77-1' }, { created_at: '2026-10-07T23:59:00Z' }, { created_at: '2026-10-08T00:31:00Z' },
    { workflow_run: { id: 77, head_sha: '8'.repeat(40) } }]) {
    assert.throws(() => assertTrustedQualificationMetadata(run, { ...artifact, ...patch }, env, now));
  }
});

test('stable release cannot be an artifact prerelease, moved tag, unsealed release or off-main source', () => {
  const commit = { type: 'commit', sha: serviceSha };
  const main = { status: 'ahead', merge_base_commit: { sha: serviceSha } };
  assertStableRelease(stable, commit, main, release(), env);
  for (const patch of [{ immutable: false }, { prerelease: true }, { draft: true }, { id: 80 },
    { tag_name: `service-artifacts-${serviceSha}` }, { tag_name: 'v01.2.3' }]) {
    assert.throws(() => assertStableRelease({ ...stable, ...patch }, commit, main, release(), env));
  }
  assert.throws(() => assertStableRelease(stable, { ...commit, sha: infraSha }, main, release(), env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, merge_base_commit: { sha: infraSha } }, release(), env));
  assert.throws(() => assertStableRelease(stable, commit, { ...main, status: 'diverged' }, release(), env));
});

test('authenticated input resolver keeps metadata outside the download directory and rejects an unsealed release', async () => {
  const calls = []; const saved = new Map();
  const io = { async api(endpoint) {
    calls.push(endpoint);
    if (endpoint.includes('/actions/runs/')) return run;
    if (endpoint.includes('/actions/artifacts/')) return artifact;
    if (endpoint.includes('/releases/')) return stable;
    if (endpoint.includes('/git/ref/')) return { object: { type: 'tag', sha: '8'.repeat(40) } };
    if (endpoint.includes('/git/tags/')) return { object: { type: 'commit', sha: serviceSha } };
    if (endpoint.includes('/compare/')) return { status: 'identical', merge_base_commit: { sha: serviceSha } };
    assert.fail('Unexpected GitHub endpoint');
  }, async mkdir() {}, async writeFile(file, value) { saved.set(file, value); } };
  await resolveProductionInputs(env, io);
  assert.deepEqual([...saved.keys()], ['.qualification/trusted/run.json', '.qualification/trusted/artifact.json', '.qualification/trusted/stable-release.json']);
  assert.ok(calls.includes('repos/anywear-ai/AnyWear-E2E/actions/runs/77/attempts/2'));
  await assert.rejects(resolveProductionInputs(env, { ...io, async api(endpoint) {
    return endpoint.includes('/releases/') ? { ...stable, prerelease: true } : io.api(endpoint);
  } }), /sealed stable/);
});

test('qualification v3 binds the reviewed release identity and the independent observation', () => {
  assert.equal(assertQualifiedRelease(qualificationFixture(), release(), env), imageDigest);
  const rejections = [
    ['v2 schema', r => r.schema_version = 2, /flat qualification record v3/],
    ['payload envelope', r => r.payload = {}, /flat qualification record v3/],
    ['v1 schema', r => r.schema_version = 1, /flat qualification record v3/],
    ['missing expected', r => delete r.expected, /Invalid qualification record fields/],
    ['extra member', r => r.unexpected = true, /Invalid qualification record fields/],
    ['removed compatibility member', r => r.compatibility = {}, /Invalid qualification record fields/],
    ['removed deployment member', r => r.deployment = {}, /Invalid qualification record fields/],
    ['revisions.infra present', r => r.revisions.infra = { repository: 'git-malu/AnyWear-Infra', sha: infraSha },
      /Invalid qualification revisions fields/],
    ['another Service source', r => r.revisions.service.sha = '9'.repeat(40), /identity differs from promotion/],
    ['another image digest', r => r.revisions.service.image_digest = `sha256:${'9'.repeat(64)}`, /identity differs from promotion/],
    ['another Service repository', r => r.revisions.service.repository = 'anywear-ai/AnyWear-E2E', /identity differs from promotion/],
    ['another release id', r => r.service_artifacts.release_id = 75, /artifact identity differs/],
    ['another release tag', r => r.service_artifacts.tag = `service-artifacts-${'9'.repeat(40)}`, /artifact identity differs/],
    ['another artifact repository', r => r.service_artifacts.repository = 'anywear-ai/AnyWear-E2E', /artifact identity differs/],
    ['Client below the enforced floor', r => r.revisions.service.minimum_client_version = clientVersion + 1, /below the minimum/],
    ['another Client commit', r => r.revisions.client.sha = '9'.repeat(40), /differs from the recorded revisions/],
    ['another expected Service commit', r => r.expected.service_commit = '9'.repeat(40), /differs from the recorded revisions/],
    ['another observed Service commit', r => {
      r.observations.before.service.service_commit = '9'.repeat(40);
      r.observations.after.service.service_commit = '9'.repeat(40);
    }, /differs from the recorded revisions/],
    ['another observed Client commit', r => {
      r.observations.before.client.source_commit = '9'.repeat(40);
      r.observations.after.client.source_commit = '9'.repeat(40);
    }, /differs from the recorded revisions/],
    ['observation changed during the suite', r => r.observations.before.platform.queues[0].maxReceives = 4, /different system before and after/],
    ['missing platform observation', r => delete r.observations.after.platform, /Invalid after observation fields/],
    ['missing authenticated mark', r => delete r.observations.after.authenticated, /Invalid after observation fields/],
    ['non-boolean authenticated mark', r => r.observations.after.authenticated = 'true', /not an authenticated read/],
    ['empty stack set', r => r.observations.after.platform.stacks = [], /at least one discovered AnyWear stack/],
    ['unsorted stacks', r => r.observations.after.platform.stacks.reverse(), /observed stacks must be sorted/],
    ['duplicate stack rows', r => r.observations.after.platform.stacks
      .push(structuredClone(r.observations.after.platform.stacks[0])), /name each stack once/],
    ['non-AnyWear stack name', r => r.observations.after.platform.stacks[0].name = 'ForeignStack', /observed stack name/],
    ['foreign stack region', r => r.observations.after.platform.stacks[0].region = 'eu-west-1', /observation region/],
    ['empty Lambda set', r => r.observations.after.platform.lambdas = [], /at least one discovered Lambda/],
    ['non-prefix Lambda name', r => r.observations.after.platform.lambdas[0].name = 'service-function', /observed Lambda name/],
    ['unsorted Lambdas', r => r.observations.after.platform.lambdas.reverse(), /observed Lambdas must be sorted/],
    ['empty queue set', r => r.observations.after.platform.queues = [], /at least one discovered queue/],
    ['non-prefix queue name', r => r.observations.after.platform.queues[0].name = 'other-queue', /observed queue name/],
    ['invalid queue max receives', r => r.observations.after.platform.queues[0].maxReceives = '3', /observed queue max receives/],
    ['unrecomputed schema hash', r => r.observations.after.platform.schema_sha256 = '9'.repeat(64), /schema hash differs/],
    ['non-CloudFront Client domain', r => r.observations.after.platform.client_domain = 'example.com', /Client distribution domain/],
    ['another E2E run', r => r.workflow.run_id = 80, /another E2E run\/attempt/],
  ];
  for (const [label, mutate, pattern] of rejections) {
    const value = structuredClone(qualificationFixture()); mutate(value);
    assert.throws(() => assertQualifiedRelease(value, release(), env), pattern, label);
  }
});

test('consumer invokes the fixed verifier with authenticated run/attempt/artifact/exact bytes and requires affirmative verification', async () => {
  const record = qualificationFixture(); const recordBytes = Buffer.from(canonicalJson(record));
  const actualEnv = { ...env, QUALIFICATION_RECORD_SHA256: sha256(recordBytes) }; let calls = 0;
  const verifier = (actual, options) => {
    calls++; assert.deepEqual(actual, record); assert.equal(options.recordBytes, recordBytes);
    assert.equal(options.trustedRun, run); assert.equal(options.trustedArtifact, artifact);
    assert.deepEqual(options.expected, { run_id: 77, run_attempt: 2, artifact_id: 78, record_sha256: sha256(recordBytes), e2e_sha: e2eSha });
    return true;
  };
  const input = { recordBytes, run, artifact, verifier, env: actualEnv, now };
  await verifyProductionRecord(input); assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, recordBytes: Buffer.concat([recordBytes, Buffer.from('\n')]) }), /exact-byte/);
  assert.equal(calls, 1);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => false }), /affirm acceptance/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: () => { throw new Error('E2E observations mismatch'); } }), /observations mismatch/);
  await assert.rejects(verifyProductionRecord({ ...input, verifier: undefined }), /unavailable/);
});

test('future plan preserves all OCI manifests, digest identity, explicit schema operation and compute-only rollback without being executable', () => {
  const plan = buildProductionPromotionPlan({ release: release(), qualification: qualificationFixture(), stableRelease: stable, env });
  assert.equal(plan.executable, false); assert.equal(plan.image.digest, imageDigest);
  assert.deepEqual(plan.copy.args.slice(0, 3), ['copy', '--all', '--preserve-digests']);
  assert.equal(plan.copy.args[3], `docker://650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${imageDigest}`);
  assert.match(plan.copy.args[4], /^docker:\/\/123456789012\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/prod-anywear-service:/);
  assert.match(plan.schema.migration, /separate explicit reviewed forward migration/);
  assert.match(plan.schema.rollback, /Workload image only/);
  assert.equal(plan.service_sha, serviceSha);
  assert.equal(verifyPromotionDigest(imageDigest, imageDigest), true);
  assert.throws(() => verifyPromotionDigest(`sha256:${'8'.repeat(64)}`, imageDigest), /differs/);
});

test('scan guard binds repository+digest, completes after copy, blocks critical and requires exact high approval', () => {
  const uri = '123456789012.dkr.ecr.ap-east-1.amazonaws.com/prod-anywear-service';
  const scan = { registryId: '123456789012', repositoryName: 'prod-anywear-service', imageId: { imageDigest },
    imageScanStatus: { status: 'COMPLETE' }, imageScanFindings: { imageScanCompletedAt: '2026-10-08T00:45:00Z',
      vulnerabilitySourceUpdatedAt: '2026-10-08T00:40:00Z', findingSeverityCounts: { HIGH: 0, CRITICAL: 0, MEDIUM: 2 } } };
  const options = { expectedDigest: imageDigest, expectedRepositoryUri: uri, notBefore: Date.parse('2026-10-08T00:35:00Z'), env, now };
  verifyPromotionScan(scan, options);
  for (const mutate of [s => s.registryId = '650880818323', s => s.imageId.imageDigest = `sha256:${'8'.repeat(64)}`,
    s => s.imageScanStatus.status = 'IN_PROGRESS', s => s.imageScanFindings.imageScanCompletedAt = '2026-10-08T00:30:00Z',
    s => s.imageScanFindings.findingSeverityCounts.CRITICAL = 1, s => s.imageScanFindings.findingSeverityCounts.UNDEFINED = 1,
    s => s.imageScanFindings.findingSeverityCounts.HIGH = -1, s => s.imageScanFindings.findingSeverityCounts.OTHER = 1]) {
    const value = structuredClone(scan); mutate(value); assert.throws(() => verifyPromotionScan(value, options));
  }
  const high = structuredClone(scan); high.imageScanFindings.findingSeverityCounts.HIGH = 1;
  assert.throws(() => verifyPromotionScan(high, options));
  const approval = { repository_uri: uri, image_digest: imageDigest, scan_sha256: contentHash(high), finding_counts: high.imageScanFindings.findingSeverityCounts,
    infra_sha: infraSha };
  const approved = { ...options, highApproval: approval, env: { ...env, PROD_SCAN_APPROVAL_SHA256: contentHash(approval) } };
  verifyPromotionScan(high, approved);
  assert.throws(() => verifyPromotionScan(high, { ...approved, highApproval: { ...approval, infra_sha: '8'.repeat(40) } }));
});

test('Production remains source-disabled before AWS credentials even when readiness variables are enabled', async () => {
  assert.throws(() => assertProductionExecutorReady(), /Production execution remains disabled/);
  await assert.rejects(execute(process.execPath, ['scripts/promote-production.mjs'], {
    env: { ...process.env, ...env, PROD_PROMOTION_READY: 'true' }, timeout: 10_000,
  }), error => error.code === 1 && /Production execution remains disabled/.test(error.stderr));
  const workflow = await readFile(new URL('../../.github/workflows/production.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('run: node scripts/promote-production.mjs') < workflow.indexOf('actions/create-github-app-token'));
  assert.equal(/configure-aws-credentials|id-token:\s*write/.test(workflow), false);
  const job = workflow.slice(workflow.indexOf('  promotion:'));
  const condition = job.match(/^\s*if: (.*)$/m);
  assert.ok(condition, 'Production job keeps an explicit source condition');
  assert.equal(/\bvars\./.test(condition[1]), false, 'No repository variable may gate the Production job');
  assert.equal(/^\s*environment:/m.test(job), false, 'An unregistered protected environment must not be materialised');
  const steps = [...job.matchAll(/^\s*run: (.+)$/gm)].map((match) => match[1].trim());
  assert.equal(steps[0], 'node scripts/promote-production.mjs', 'The source blocker stays the first executed step');
});
