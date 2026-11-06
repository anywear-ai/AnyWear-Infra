import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as contracts from '../../lib/contracts.mjs';

const root = new URL('../..', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const exists = name => existsSync(fileURLToPath(new URL(name, root)));

// The contract is ordinary repository source now, not a published artifact. It
// has no build step and no runtime dependency: the CDK app, the operation
// scripts and these tests load the plain ESM file directly, and `aws-cdk-lib`
// must stay out so plain Node scripts can keep importing it.
const source = read('lib/contracts.mjs');

test('the contract is dependency-free ESM that reads only Node built-ins', () => {
  assert.ok(!/from\s+['"]aws-cdk-lib['"]/.test(source), 'The contract must not import aws-cdk-lib');
  assert.ok(!/require\(\s*['"]aws-cdk-lib['"]\s*\)/.test(source), 'The contract must not require aws-cdk-lib');
  assert.ok(!/from\s+['"]constructs['"]/.test(source), 'The contract must not import constructs');
  assert.ok(source.includes("from 'node:crypto'"), 'The contract may only use Node built-ins');
});

// Issue #207: the operation/deployment record chain is retired. The contract
// keeps the stage, stack, normalisation, task-definition and bake-control surface
// the CDK application and workflows consume, and drops exactly the record and
// record-gate surface. A stale import on either side fails here.
const REMOVED_EXPORTS = Object.freeze([
  'DEPLOYMENT_RECORD_MEMBERS', 'DEPLOYMENT_PRODUCER_FIELDS', 'DEPLOYMENT_STACK_FIELDS',
  'DEPLOYMENT_INPUT_FIELDS', 'SERVICE_OBSERVED_FIELDS', 'SERVICE_ECS_IDENTITY_FIELDS',
  'SERVICE_DEPLOYMENT_RECORD_MEMBERS', 'SERVICE_DEPLOYMENT_RECORD_SCHEMA',
  'validateServiceDeploymentRecord', 'validateServiceStacks',
  'SERVICE_SCHEMA_BOUNDARY_FIELDS', 'SCHEMA_BOUNDARY_ASSET_FIELDS',
  'SCHEMA_BOUNDARY_APPLIED_FIELDS', 'SCHEMA_BOUNDARY_COMPARISON_FIELDS',
  'SCHEMA_BOUNDARY_READER_FIELDS', 'SCHEMA_BOUNDARY_READER_SOURCES', 'SCHEMA_BOUNDARY_RESULTS',
  'schemaBoundaryPrefixHash', 'validateSchemaBoundary',
  'DEPLOYMENT_GATE_FIELDS', 'DEPLOYMENT_GATE_PROBE_FIELDS', 'DEPLOYMENT_GATE_SIGNAL_FIELDS',
  'DEPLOYMENT_GATE_RESULTS', 'DEPLOYMENT_GATE_STATES', 'DEPLOYMENT_GATE_ALARM_STATES',
  'validateDeploymentGate',
]);

const KEPT_EXPORTS = Object.freeze([
  'STAGE_CONTRACT_STAGE', 'STAGE_CONTRACT_PARAMETERS', 'STAGE_CONTRACT_CONDITIONAL_PARAMETERS',
  'STAGE_CONTRACT_READ_PARAMETERS', 'stageParameters', 'validateStageInputs', 'stageContractSchemaHash',
  'INFRA_REPOSITORY', 'SERVICE_REPOSITORY', 'platformStackName', 'runtimeStackName',
  'SERVICE_RUNTIME_STACK', 'DEPLOYED_TEMPLATE_NORMALISATION', 'normaliseDeployedTemplate',
  'canonicalDeployedTemplateHash', 'stableTaskDefinition', 'taskDefinitionContentHash',
  'DEPLOYMENT_GATE_NAME_SUFFIX', 'DEPLOYMENT_GATE_DURATION_SECONDS',
  'DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS', 'DEPLOYMENT_GATE_REQUEST_FLOOR',
  'DEPLOYMENT_GATE_MAX_PROBES', 'DEPLOYMENT_GATE_SIGNAL_NAMES', 'DEPLOYMENT_GATE_THRESHOLDS',
  'DEPLOYMENT_GATE_COMPARISONS', 'DEPLOYMENT_SQS_DEPTH_ATTRIBUTES', 'deploymentBakeName',
  'runtimeStageFromStack', 'deploymentAlarmName', 'deploymentAlarmNames', 'deploymentQueueNames',
]);

test('every removed record/gate export is undefined and every kept export is present', () => {
  for (const name of REMOVED_EXPORTS) {
    assert.equal(contracts[name], undefined, `${name} must not be exported after #207`);
  }
  for (const name of KEPT_EXPORTS) {
    assert.notEqual(contracts[name], undefined, `${name} must stay exported`);
  }
  assert.deepEqual(Object.keys(contracts).sort(), [...KEPT_EXPORTS].sort());
  assert.equal(contracts.DEPLOYMENT_GATE_DURATION_SECONDS, 300);
  assert.equal(contracts.DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS, 15);
  assert.equal(contracts.DEPLOYMENT_GATE_MAX_PROBES, 20);
  assert.equal(contracts.DEPLOYMENT_GATE_REQUEST_FLOOR, 15);
  assert.equal(contracts.STAGE_CONTRACT_PARAMETERS.length, 35);
  assert.equal(contracts.STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, 1);
  assert.equal(contracts.STAGE_CONTRACT_READ_PARAMETERS.length, 36);
});

// Census guard for the retirement: the contract is a directory of ordinary
// source, so no in-repo package boundary, no `file:` dependency and no
// package-directory test glob may return. A reintroduced `packages/` manifest or
// `file:` specifier fails here by name.
test('the retirement leaves no in-repo package boundary behind', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['aws-cdk-lib', 'constructs']);
  for (const [name, specifier] of Object.entries(manifest.dependencies)) {
    assert.equal(String(specifier).startsWith('file:'), false, `${name} must not be a file: dependency`);
  }
  assert.equal(manifest.scripts['test:contracts'],
    'node --test test/scripts/*.test.mjs test/contracts/*.test.mjs .github/scripts/*.test.mjs');
  assert.equal(exists('packages'), false, 'the retired in-repo package directory must not return');
});
