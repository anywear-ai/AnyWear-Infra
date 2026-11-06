import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compareLiveFoundation, loadLiveFoundationFixture } from '../../scripts/compare-live-foundation.mjs';

test('explicit live Foundation adds only six roles/three policies and preserves the actual provider', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'infra-live-foundation-'));
  const config = JSON.parse(await readFile('cdk.json', 'utf8'));
  const run = (patch, scope = 'foundation', overrides = {}) => execFileSync(process.execPath, ['bin/infra.js'], { stdio: 'pipe', env: { ...process.env,
    CDK_CONTEXT_JSON: JSON.stringify({ ...config.context, 'aws:cdk:version-reporting': true, identityPhase: 'roles-added', deployScope: scope, ...patch }),
    CDK_OUTDIR: output, CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1', ...overrides }, timeout: 45_000 });
  for (const scope of ['foundation', 'application', 'billing']) {
    for (const value of [undefined, 'unknown']) {
      assert.throws(() => run(value === undefined ? {} : { legacyRoleSource: value }, scope), /Explicit legacyRoleSource/);
    }
  }
  assert.throws(() => run({ legacyRoleSource: 'external' }, 'foundation', { CDK_DEFAULT_ACCOUNT: '111111111111' }), /reviewed account/);
  assert.throws(() => run({ legacyRoleSource: 'external' }, 'foundation', { CDK_DEFAULT_REGION: 'us-east-1' }), /reviewed account/);
  run({ legacyRoleSource: 'external' }, 'billing', { CDK_DEFAULT_REGION: 'us-east-1' });
  assert.throws(() => run({ legacyRoleSource: 'external', 'aws:cdk:enablePathMetadata': false }, 'application'), /artifactDirectory/);
  run({ legacyRoleSource: 'external' });
  const candidate = JSON.parse(await readFile(path.join(output, 'AnyWearFoundationStack.template.json')));
  const { original, additions } = await loadLiveFoundationFixture();
  assert.equal(compareLiveFoundation(original, candidate, additions).candidate_resource_count, 13);
  const invalid = structuredClone(candidate);
  invalid.Resources.LegacyRole = { Type: 'AWS::IAM::Role', Properties: { RoleName: 'prod-github-actions-pipeline-role' } };
  assert.throws(() => compareLiveFoundation(original, invalid, additions), /reviewed 9 additive/);
  const code = structuredClone(candidate);
  code.Resources.CustomAWSCDKOpenIdConnectProviderCustomResourceProviderHandlerF2C543E0.Properties.Code.S3Key = 'other.zip';
  assert.throws(() => compareLiveFoundation(original, code, additions), /drift/);
  const permissions = structuredClone(candidate);
  permissions.Resources.BetaInfraDeployRoleDefaultPolicyE72AFE8E.Properties.PolicyDocument.Statement[0].Resource = '*';
  assert.throws(() => compareLiveFoundation(original, permissions, additions), /drift/);
  const endpoint = structuredClone(candidate); endpoint.Outputs.GitHubOIDCProviderArn.Value = 'other';
  assert.throws(() => compareLiveFoundation(original, endpoint, additions), /drift/);
});
