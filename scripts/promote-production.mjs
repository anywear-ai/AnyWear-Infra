import { pathToFileURL } from 'node:url';
import { canonicalJson, contentHash, matches, HASH, integer } from './lib/json-contract.mjs';
import { validateProductionContext, assertQualifiedRelease } from './production-preflight.mjs';

// #54 implements the v2 consumer; Production execution is not onboarded. These
// are source-reviewed future requirements, not an authorization or AWS executor.
export const PRODUCTION_ONBOARDING_BLOCKERS = Object.freeze([
  'Reviewed cross-account Beta ECR reader and dedicated Production deploy/runtime OIDC principals are not installed.',
  'The authenticated DB verifier and deployment observer currently bind only the Beta account/cluster/workflow; Production contracts and their tests require a separate reviewed change.',
  'Production account resources, selected and rollback retention, scan-on-push, role boundaries, explicit schema operations and recovery evidence are not qualified.',
]);

export function assertProductionExecutorReady() {
  // Environment variables, including PROD_PROMOTION_READY, cannot bypass this
  // source gate. Future activation must replace it through a reviewed PR.
  throw new Error(`Production execution remains disabled: ${PRODUCTION_ONBOARDING_BLOCKERS.join(' ')}`);
}

export function buildProductionPromotionPlan({ release, qualification, stableRelease, env = process.env }) {
  validateProductionContext(env); assertQualifiedRelease(qualification, release, env);
  if (stableRelease.id !== Number(env.STABLE_RELEASE_ID) || stableRelease.immutable !== true || stableRelease.draft !== false
    || stableRelease.prerelease !== false || !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(stableRelease.tag_name ?? '')) {
    throw new Error('Reviewed sealed stable release required for promotion plan');
  }
  const destination = `${env.AWS_ACCOUNT_ID}.dkr.ecr.ap-east-1.amazonaws.com/prod-anywear-service`;
  return {
    schema_version: 1, record_type: 'anywear_future_production_plan', executable: false,
    infra_sha: env.GITHUB_SHA, service_sha: release.source_sha, service_release_id: release.release_id,
    qualification: { run_id: Number(env.QUALIFICATION_RUN_ID), run_attempt: Number(env.QUALIFICATION_RUN_ATTEMPT),
      artifact_id: Number(env.QUALIFICATION_ARTIFACT_ID), record_sha256: env.QUALIFICATION_RECORD_SHA256, e2e_sha: env.QUALIFICATION_E2E_SHA },
    stable_release: { repository: 'anywear-ai/AnyWear-Service', id: stableRelease.id, tag: stableRelease.tag_name },
    image: { source: 'beta-anywear-service', destination, digest: release.image_digest },
    copy: { command: 'skopeo', args: ['copy', '--all', '--preserve-digests',
      `docker://650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@${release.image_digest}`, `docker://${destination}:service-artifacts-${release.source_sha}`] },
    required_before_rollout: ['Authenticate both registry accounts and exact scoped roles.', 'Prove selected and previous rollback digest retention.',
      'Read back destination OCI digest equal to the qualified source digest.', 'Complete both scan-on-push results under the approved scan policy.',
      'Observe actual applied Production DB schema using the selected immutable image and bounded read-only command.'],
    schema: { identity: 'Runtime deployment record; no cross-repository schema pin from Infra',
      migration: 'A separate explicit reviewed forward migration operation; never implicit in promotion.',
      rollback: 'Restore the previous verified Workload image only; retain compatible completed schema extensions.' },
    rollout: 'WorkloadStack only, then actual ECS task digest, health and schema verification; preserve prior compute for rollback.',
    blockers: [...PRODUCTION_ONBOARDING_BLOCKERS],
  };
}

export function verifyPromotionDigest(actualDigest, expectedDigest) {
  matches(expectedDigest, /^sha256:[a-f0-9]{64}$/, 'qualified image digest');
  if (actualDigest !== expectedDigest) throw new Error('Destination OCI digest differs from qualified source; rebuild or digest substitution is forbidden');
  return true;
}

export function verifyPromotionScan(scan, { expectedDigest, expectedRepositoryUri, notBefore, highApproval = null, env = process.env, now = Date.now() }) {
  matches(expectedRepositoryUri, /^[0-9]{12}\.dkr\.ecr\.ap-east-1\.amazonaws\.com\/(?:beta|prod)-anywear-service$/, 'reviewed scan repository');
  const [registry, repository] = expectedRepositoryUri.split('/');
  if (scan.registryId !== registry.split('.')[0] || scan.repositoryName !== repository) throw new Error('Scan result belongs to another registry/repository');
  verifyPromotionDigest(scan.imageId?.imageDigest, expectedDigest);
  if (scan.imageScanStatus?.status !== 'COMPLETE') throw new Error('A completed basic scan-on-push result is required');
  const findings = scan.imageScanFindings; const completed = Date.parse(findings?.imageScanCompletedAt);
  if (!Number.isFinite(notBefore) || !Number.isFinite(completed) || completed < notBefore || completed > now
    || !Number.isFinite(Date.parse(findings?.vulnerabilitySourceUpdatedAt)) || Date.parse(findings.vulnerabilitySourceUpdatedAt) > now) {
    throw new Error('Authenticated completed scan timestamps unavailable');
  }
  const counts = findings?.findingSeverityCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Authenticated basic scan finding counts unavailable');
  for (const [severity, count] of Object.entries(counts)) {
    if (!['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNDEFINED'].includes(severity)) throw new Error('Unknown scan severity');
    integer(count, 'scan finding count', 0);
  }
  if ((counts.CRITICAL ?? 0) > 0 || (counts.UNDEFINED ?? 0) > 0) throw new Error('Critical or unclassified scan findings block promotion');
  if ((counts.HIGH ?? 0) > 0) {
    // Bind any reviewed risk acceptance to the exact scan, image and Infra source.
    matches(env.PROD_SCAN_APPROVAL_SHA256, HASH, 'reviewed scan approval hash');
    const expected = { repository_uri: expectedRepositoryUri, image_digest: expectedDigest, scan_sha256: contentHash(scan), finding_counts: counts, infra_sha: env.GITHUB_SHA };
    if (!highApproval || canonicalJson(highApproval) !== canonicalJson(expected)
      || contentHash(highApproval) !== env.PROD_SCAN_APPROVAL_SHA256) throw new Error('High findings require exact reviewed scan approval evidence');
  }
  return { image_digest: expectedDigest, scan_status: 'COMPLETE', finding_counts: counts, completed_at: findings.imageScanCompletedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) assertProductionExecutorReady();
