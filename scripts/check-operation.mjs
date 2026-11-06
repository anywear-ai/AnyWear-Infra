import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOperationInputs } from './runtime-operation.mjs';
import { validateReleaseInput } from './lib/release-inputs.mjs';
import { changedStackNames } from './lib/operation-stacks.mjs';
import { createTestInputs } from './create-test-inputs.mjs';
import { platformStackName, platformStackStage, recoveryFailureMessage, recoveryViolations, synthStage } from './lib/recovery-contract.mjs';
import { PHASE, synthesizeRuntimeTemplate } from './lib/runtime-deploy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Database recovery targets are a deployment precondition, so a Platform
// operation proves them from local source before anything requests credentials.
// The sealed Service artifact is not downloaded in this job; the synthesis
// therefore uses the local release-directory fixture. It is a scratch fixture for
// stack-shape checks only and is never uploaded as deployable bytes.
export async function assertDatabaseRecoveryPrecondition(env = process.env) {
  const stage = changedStackNames(env.INFRA_OPERATION).map(platformStackStage).find(Boolean);
  if (!stage) return;
  const stackName = platformStackName(stage);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'anywear-database-recovery-'));
  try {
    const artifactDirectory = path.join(scratch, 'service-artifacts');
    await createTestInputs(artifactDirectory);
    const directory = path.join(scratch, 'cdk.out');
    const files = synthStage({ repository: root, directory, stage,
      inputs: { identityPhase: env.INFRA_IDENTITY_PHASE, ecrImageRetention: env.INFRA_RETENTION_PROTECTION === 'true',
        legacyRoleSource: 'external', artifactDirectory } });
    const templateFile = `${stackName}.template.json`;
    if (!files.includes(templateFile)) throw new Error(`Synthesis did not produce ${templateFile} for stage ${stage}`);
    const violations = recoveryViolations(JSON.parse(await readFile(path.join(directory, templateFile), 'utf8')), { stage });
    if (violations.length) throw new Error(recoveryFailureMessage(violations, { stage, stackName }));
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// Issue #195: a Runtime deploy proves the synthesized template identity before
// any credential. The synthesis runs the one Infra app in `deployScope=runtime`,
// normalises the result and compares it with the recorded `roles-added` baseline
// hash, so a source or context drift fails in the credential-free preflight.
export async function assertRuntimeIdentityPrecondition(env = process.env) {
  if (env.INFRA_OPERATION !== 'deploy-runtime') return;
  const synthesized = await synthesizeRuntimeTemplate(env);
  if (synthesized.normalised_sha256 !== synthesized.expected) {
    throw new Error(`The synthesized Runtime template is not the recorded ${PHASE} identity`);
  }
  process.stdout.write(`Runtime ${PHASE} identity ${synthesized.normalised_sha256}\n`);
}

validateOperationInputs();
validateReleaseInput();
await assertDatabaseRecoveryPrecondition();
await assertRuntimeIdentityPrecondition();
