import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseJson, contentHash, exact, matches, HASH, SHA, DIGEST } from './lib/json-contract.mjs';
import { region } from './lib/deployment-contract.mjs';
import { validateOperationInputs } from './runtime-operation.mjs';

const execute = promisify(execFile);

// The operator CLI's own AWS seam. It runs under the operator's already-assumed
// session and is unrelated to the four pre-credential controls: the retention
// check is an explicitly authorized Deployment-stage read/verification action
// (see the cutover-and-recovery runbook), and it assumes no role itself.
const operatorIo = () => ({
  async aws(args, awsRegion = region) {
    const result = await execute('aws', [...args, '--region', awsRegion, '--output', 'json'], { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim() ? parseJson(result.stdout) : {};
  },
});

export function verifyRetentionPolicy(policy, expectedPolicyHash) {
  exact(policy, ['rules'], 'ECR lifecycle policy');
  if (policy.rules?.length !== 2) throw new Error('Expected two priority-ordered ECR lifecycle rules');
  const [protectedRule, generalRule] = [...policy.rules].sort((a, b) => a.rulePriority - b.rulePriority);
  for (const rule of [protectedRule, generalRule]) {
    if (!rule || Object.keys(rule).some(key => !['rulePriority', 'description', 'selection', 'action'].includes(key))) throw new Error('Unknown ECR policy rule field');
    exact(rule.action, ['type'], 'ECR action'); if (rule.action.type !== 'expire') throw new Error('Unsupported ECR action');
  }
  exact(protectedRule.selection, ['tagStatus', 'tagPrefixList', 'countType', 'countNumber'], 'protected selection');
  exact(generalRule.selection, ['tagStatus', 'countType', 'countNumber'], 'general selection');
  if (protectedRule.rulePriority !== 1 || protectedRule.selection.tagStatus !== 'tagged'
    || JSON.stringify(protectedRule.selection.tagPrefixList) !== '["protected-service-"]'
    || protectedRule.selection.countType !== 'imageCountMoreThan' || protectedRule.selection.countNumber !== 1000
    || generalRule.rulePriority !== 2 || generalRule.selection.tagStatus !== 'any'
    || generalRule.selection.countType !== 'imageCountMoreThan' || generalRule.selection.countNumber !== 30) throw new Error('ECR protection rule is not the reviewed Beta policy');
  const hash = contentHash(policy);
  if (expectedPolicyHash !== undefined) { matches(expectedPolicyHash, HASH, 'reviewed policy hash'); if (hash !== expectedPolicyHash) throw new Error('Effective ECR lifecycle policy changed'); }
  return hash;
}
export function verifyProtectedImages(images, required, maximum = 256) {
  if (!Array.isArray(images) || images.length > 4096 || !Array.isArray(required) || required.length < 1 || required.length > 256) throw new Error('ECR image inventory/protection bound invalid');
  const protectedImages = images.filter(image => image.imageTags?.some(tag => tag.startsWith('protected-service-')));
  if (new Set(protectedImages.map(image => image.imageDigest)).size > maximum) throw new Error('Protected ECR inventory exceeds reviewed safety bound');
  for (const item of required) {
    exact(item, ['service_sha', 'digest'], 'protected digest'); matches(item.service_sha, SHA, 'protected source'); matches(item.digest, DIGEST, 'protected digest');
    const actual = images.filter(image => image.imageDigest === item.digest);
    if (actual.length !== 1 || !actual[0].imageTags?.includes(`protected-service-${item.service_sha}`)) throw new Error('Selected or rollback digest lacks exact protected tag');
  }
  return protectedImages.length;
}
export function verifyLifecyclePreview(preview, required) {
  if (preview.status !== 'COMPLETE' || !Array.isArray(preview.previewResults)) throw new Error('ECR lifecycle preview did not complete');
  const digests = new Set(required.map(item => item.digest));
  if (preview.previewResults.some(result => digests.has(result.imageDigest) && result.action?.type === 'EXPIRE')) throw new Error('Selected or rollback digest would expire');
  return true;
}
export async function checkRetention({ required, expectedPolicyHash, io = operatorIo(), env = process.env }) {
  const gate = async () => { validateOperationInputs(env); };
  await gate();
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== '650880818323') throw new Error('Unexpected retention account');
  const repository = 'beta-anywear-service';
  const policy = parseJson((await io.aws(['ecr', 'get-lifecycle-policy', '--repository-name', repository])).lifecyclePolicyText);
  const hash = verifyRetentionPolicy(policy, expectedPolicyHash);
  const images = (await io.aws(['ecr', 'describe-images', '--repository-name', repository])).imageDetails;
  const count = verifyProtectedImages(images, required);
  await gate(); await io.aws(['ecr', 'start-lifecycle-policy-preview', '--repository-name', repository]);
  let preview;
  for (let attempt = 0; attempt < 30; attempt++) {
    preview = await io.aws(['ecr', 'get-lifecycle-policy-preview', '--repository-name', repository]);
    if (preview.status === 'COMPLETE') break;
    if (preview.status !== 'IN_PROGRESS') throw new Error('Lifecycle preview failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  verifyLifecyclePreview(preview, required);
  if (verifyRetentionPolicy(parseJson((await io.aws(['ecr', 'get-lifecycle-policy', '--repository-name', repository])).lifecyclePolicyText)) !== hash) throw new Error('Lifecycle policy changed during preview');
  return { schema_version: 1, record_type: 'anywear_ecr_retention', policy_sha256: hash, protected_image_count: count, protected_inventory_limit: 256,
    required, preview_status: preview.status, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT), source_sha: env.GITHUB_SHA };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = parseJson(await readFile(process.argv[2]));
  console.log(JSON.stringify(await checkRetention({ required, expectedPolicyHash: process.env.ECR_RETENTION_VERIFIED_POLICY_SHA256 })));
}
