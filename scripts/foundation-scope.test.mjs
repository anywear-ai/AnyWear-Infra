import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestInputs } from './create-test-inputs.mjs';

test('actual Foundation-only app needs no artifacts and matches full application at each identity phase', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infra-foundation-scope-'));
  const artifacts = path.join(directory, 'artifacts'); await createTestInputs(artifacts);
  const config = JSON.parse(await readFile('cdk.json', 'utf8'));
  for (const legacyRoleSource of ['cdk', 'external']) for (const phase of ['legacy', 'roles-added', 'retired']) {
    const templates = [];
    for (const scope of ['application', 'foundation']) {
      const output = path.join(directory, phase, scope);
      const context = { ...config.context, stage: 'beta', identityPhase: phase, deployScope: scope, legacyRoleSource,
        ...(scope === 'application' ? { artifactDirectory: artifacts } : {}) };
      execFileSync(process.execPath, ['bin/infra.js'], { stdio: 'pipe', env: { ...process.env, CDK_CONTEXT_JSON: JSON.stringify(context), CDK_OUTDIR: output,
        CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1' }, timeout: 45_000 });
      templates.push(JSON.parse(await readFile(path.join(output, 'AnyWearFoundationStack.template.json'))));
      if (scope === 'foundation') assert.deepEqual((await readdir(output)).filter(file => file.endsWith('.template.json')), ['AnyWearFoundationStack.template.json']);
    }
    assert.deepEqual(templates[0], templates[1], `${legacyRoleSource}/${phase}`);
  }
});
