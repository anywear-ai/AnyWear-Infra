import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { contentHash } from '../../scripts/lib/json-contract.mjs';
import { validateProductionContext, readReviewedRelease, assertGateRun, assertStableGateIdentity,
  assertStableRelease, resolveProductionInputs, E2E_GATE_WORKFLOW,
  E2E_GATE_RUN_NAME_PREFIX } from '../../scripts/production-preflight.mjs';
import { assertProductionExecutorReady, buildProductionPromotionPlan, verifyPromotionDigest,
  verifyPromotionScan } from '../../scripts/promote-production.mjs';

const execute = promisify(execFile);
const now = Date.parse('2026-10-08T01:00:00Z');
const infraSha = '5'.repeat(40); const e2eSha = '6'.repeat(40); const serviceSha = '1'.repeat(40);
const imageDigest = `sha256:${'4'.repeat(64)}`;
const gateTitle = `Beta E2E gate: full · deploy-gate · ${serviceSha}`
  + ' · by https://github.com/anywear-ai/AnyWear-Infra/actions/runs/80';
const run = { id: 77, run_attempt: 2, head_sha: e2eSha, head_branch: 'main', path: E2E_GATE_WORKFLOW,
  display_title: gateTitle, repository: { full_name: 'anywear-ai/AnyWear-E2E' },
  head_repository: { full_name: 'anywear-ai/AnyWear-E2E' }, event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success' };
const stable = { id: 79, tag_name: 'v1.2.3', draft: false, prerelease: false, immutable: true };
const env = { GITHUB_REPOSITORY: 'git-malu/AnyWear-Infra', GITHUB_REPOSITORY_ID: '1409047265',
  GITHUB_SHA: infraSha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-Infra/.github/workflows/production.yml@refs/heads/main',
  AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'ap-east-1',
  PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-infra-deploy-role',
  E2E_GATE_RUN_ID: '77', E2E_GATE_RUN_ATTEMPT: '2', STABLE_RELEASE_ID: '79', SERVICE_RELEASE_ID: '76',
  SERVICE_SOURCE_SHA: serviceSha, SERVICE_IMAGE_DIGEST: imageDigest };
const release = () => readReviewedRelease(env);

test('future Production context binds protected source, account, IDs and the reviewed release identity', () => {
  validateProductionContext(env);
  assert.deepEqual(release(), { release_id: 76, source_sha: serviceSha, image_digest: imageDigest });
  for (const patch of [{ GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REF: 'refs/heads/branch' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('production', 'runtime') },
    { PROD_DEPLOY_ROLE_ARN: 'arn:aws:iam::123456789012:role/prod-github-actions-pipeline-role' },
    { E2E_GATE_RUN_ID: '0' }, { E2E_GATE_RUN_ATTEMPT: '9007199254740992' },
    { SERVICE_SOURCE_SHA: 'not-a-sha' }, { SERVICE_IMAGE_DIGEST: 'sha256:short' }, { SERVICE_RELEASE_ID: '0' }]) {
    assert.throws(() => validateProductionContext({ ...env, ...patch }));
  }
  // The deleted ledger variables cannot stand in for the gate run identity.
  for (const [deleted, replacement] of [['QUALIFICATION_RUN_ID', 'E2E_GATE_RUN_ID'],
    ['QUALIFICATION_RUN_ATTEMPT', 'E2E_GATE_RUN_ATTEMPT']]) {
    const withoutNewName = { ...env, [replacement]: undefined, [deleted]: deleted === 'QUALIFICATION_RUN_ID' ? '77' : '2' };
    assert.throws(() => validateProductionContext(withoutNewName), /Invalid E2E_GATE_RUN/,
      `${deleted} must not stand in for ${replacement}`);
  }
});

test('the gate run must be the completed full success this promotion dispatched and holds', () => {
  assertGateRun(run, release(), env);
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress' },
    { status: 'queued' }, { path: '.github/workflows/other.yml' }, { head_branch: 'release' },
    { id: 80 }, { run_attempt: 1 }, { repository: { full_name: 'other/fork' } },
    { head_repository: { full_name: 'other/fork' } }, { event: 'push' }, { event: 'schedule' }]) {
    assert.throws(() => assertGateRun({ ...run, ...patch }, release(), env),
      /completed successful AnyWear-E2E `full` gate run/,
      JSON.stringify(patch));
  }
  for (const patch of [null, {}, { ...run, display_title: 'Some other run' },
    { ...run, display_title: `Beta E2E gate: full · deploy-gate · ${'9'.repeat(40)} · by x` }]) {
    assert.throws(() => assertGateRun(patch, release(), env), /does not name the promoted Service commit|`full` gate run/);
  }
});

test('the gate run observed the same live identity before and after and it is the promoted release', () => {
  const before = { service_commit: serviceSha, image_digest: imageDigest };
  const after = { service_commit: serviceSha, image_digest: imageDigest };
  assert.deepEqual(assertStableGateIdentity(before, after, release()), after);
  // Any difference between the two reads is a failed gate, never a promotion.
  assert.throws(() => assertStableGateIdentity({ ...before, image_digest: `sha256:${'8'.repeat(64)}` },
    after, release()), /different live identity before and after/);
  // Equal readings that are not the reviewed release are refused too.
  assert.throws(() => assertStableGateIdentity({ ...before, service_commit: '9'.repeat(40) },
    { ...after, service_commit: '9'.repeat(40) }, release()), /differs from the promoted release/);
  assert.throws(() => assertStableGateIdentity({ service_commit: serviceSha, image_digest: 'sha256:short' },
    after, release()), /live Service image digest/);
  assert.throws(() => assertStableGateIdentity(undefined, after, release()), /before live identity is missing/);
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

test('authenticated resolver reads the gate run and the stable release, and no gate artifact', async () => {
  const calls = [];
  const io = { async api(endpoint) {
    calls.push(endpoint);
    if (endpoint.includes('/actions/runs/')) return run;
    if (endpoint.endsWith('/releases/76')) return stable;
    if (endpoint.includes('/git/ref/')) return { object: { type: 'tag', sha: '8'.repeat(40) } };
    if (endpoint.includes('/git/tags/')) return { object: { type: 'commit', sha: serviceSha } };
    if (endpoint.includes('/compare/')) return { status: 'identical', merge_base_commit: { sha: serviceSha } };
    assert.fail(`Unexpected GitHub endpoint ${endpoint}`);
  } };
  const resolved = await resolveProductionInputs(env, io);
  assert.equal(resolved.run, run);
  assert.equal(resolved.stable, stable);
  assert.ok(calls.includes('repos/anywear-ai/AnyWear-E2E/actions/runs/77/attempts/2'));
  // The gate run object is the whole verdict: no artifact list, no artifact or
  // verifier read, and no second-repository checkout path.
  assert.equal(calls.some(endpoint => endpoint.includes('/artifacts')), false);
  assert.equal(calls.some(endpoint => endpoint.includes('.qualification')), false);
  await assert.rejects(resolveProductionInputs(env, { ...io, async api(endpoint) {
    return endpoint.endsWith('/releases/76') ? { ...stable, prerelease: true } : io.api(endpoint);
  } }), /sealed stable/);
});

test('future plan preserves all OCI manifests, digest identity, explicit schema operation and compute-only rollback without being executable', () => {
  const plan = buildProductionPromotionPlan({ release: release(), stableRelease: stable, env });
  assert.equal(plan.executable, false); assert.equal(plan.image.digest, imageDigest);
  // The plan names the one held gate run instead of a retained record.
  assert.deepEqual(plan.gate_run, { run_id: 77, run_attempt: 2 });
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
  // #358: the promotion reads the gate run this run dispatched and holds, and it
  // reads no retained record, artifact or AnyWear-E2E checkout.
  assert.match(workflow, /E2E_GATE_RUN_ID:/);
  assert.match(workflow, /E2E_GATE_RUN_ATTEMPT:/);
  assert.equal(/PROD_QUALIFICATION_|QUALIFICATION_ARTIFACT_ID|QUALIFICATION_RECORD_SHA256|QUALIFICATION_E2E_SHA/.test(workflow), false);
  assert.equal(workflow.includes('.qualification-verifier'), false);
  assert.equal(workflow.includes('.qualification/download'), false);
  assert.equal(/repository: \$\{\{ github\.repository_owner \}\}\/AnyWear-E2E/.test(workflow), false,
    'no AnyWear-E2E checkout remains');
  const job = workflow.slice(workflow.indexOf('  promotion:'));
  const condition = job.match(/^\s*if: (.*)$/m);
  assert.ok(condition, 'Production job keeps an explicit source condition');
  assert.equal(/\bvars\./.test(condition[1]), false, 'No repository variable may gate the Production job');
  assert.equal(/^\s*environment:/m.test(job), false, 'An unregistered protected environment must not be materialised');
  const steps = [...job.matchAll(/^\s*run: (.+)$/gm)].map((match) => match[1].trim());
  assert.equal(steps[0], 'node scripts/promote-production.mjs', 'The source blocker stays the first executed step');
});
