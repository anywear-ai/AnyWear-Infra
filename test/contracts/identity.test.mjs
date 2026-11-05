import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as contracts from '../../lib/contracts.mjs';
import {
  DEPLOYED_TEMPLATE_NORMALISATION,
  DEPLOYMENT_GATE_DURATION_SECONDS,
  DEPLOYMENT_GATE_MAX_PROBES,
  DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS,
  DEPLOYMENT_GATE_REQUEST_FLOOR,
  DEPLOYMENT_GATE_THRESHOLDS,
  INFRA_REPOSITORY,
  SERVICE_REPOSITORY,
  SERVICE_RUNTIME_STACK,
  STAGE_CONTRACT_CONDITIONAL_PARAMETERS,
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_READ_PARAMETERS,
  canonicalDeployedTemplateHash,
  normaliseDeployedTemplate,
  platformStackName,
  runtimeStackName,
  runtimeStageFromStack,
  stableTaskDefinition,
  taskDefinitionContentHash,
} from '../../lib/contracts.mjs';
import {
  ABSENT_NAMES,
  applyRewrites,
  buildFixture,
  canonical,
  exportSurface,
  measure,
  readFixture,
  reverseRewrites,
  rewritesFor,
  sha256,
} from '../support/contracts-identity.mjs';
import * as stages from '../../scripts/stage-contract-parameters.mjs';
import * as recovery from '../../scripts/recovery-contract.mjs';

// ---------------------------------------------------------------------------
// Producer identity
//
// The retired package's 0.7.0 bytes are the anchor: every shipped value is
// compared with the committed fixture, and the committed module bytes are proved
// to be the producer bytes with the declared comment rewrites applied. The two
// rev-parse numbers are different objects on purpose — `producer_ref` is the
// annotated tag object and `producer_commit` is the commit it peels to.
const fixture = readFixture();

// The reviewed producer digests and byte lengths. They are written twice on
// purpose: the fixture records them for review, and this anchor makes a
// regenerated fixture with different bytes fail here.
const PRODUCER_SHA256 = Object.freeze({
  'lib/contracts.mjs': '67b573fbbc7333d2f7fdc02e64bdca23591fc2d089de732827bcffa3dbb63588',
  'lib/contracts.d.mts': '464bb24e2f6ce8d7a108a6f20997f3172211d11bed24da9af99e8ab5119cf2fc',
});
const PRODUCER_BYTES = Object.freeze({ 'lib/contracts.mjs': 22563, 'lib/contracts.d.mts': 7190 });

const SERVICE_RUNTIME_STACK_SHA256 = '8bdda1ade3d5e9671f1ca22b73df71439ab175630017933f96465630812937e0';
const THRESHOLDS_SHA256 = '7c6d52fad83db2c1488fde80f9a7d9c875a4f11c727332faec3e4d0a74e6f58e';

test('the fixture records the annotated tag object and the peeled commit', () => {
  assert.match(fixture.producer_ref, /^[a-f0-9]{40}$/);
  assert.equal(fixture.producer_ref_kind, 'annotated tag object');
  assert.match(fixture.producer_commit, /^[a-f0-9]{40}$/);
  assert.equal(fixture.producer_commit_kind, 'peeled commit');
  assert.notEqual(fixture.producer_ref, fixture.producer_commit);
  assert.deepEqual(Object.keys(fixture.producer_paths).sort(), Object.keys(PRODUCER_SHA256).sort());
  assert.deepEqual(Object.keys(fixture.producer_sha256).sort(), Object.keys(PRODUCER_SHA256).sort());
  assert.deepEqual(Object.keys(fixture.producer_bytes).sort(), Object.keys(PRODUCER_SHA256).sort());
});

test('the committed files reverse to the recorded producer bytes', () => {
  assert.deepEqual(fixture.producer_sha256, PRODUCER_SHA256);
  assert.deepEqual(fixture.producer_bytes, PRODUCER_BYTES);
  for (const [file, digest] of Object.entries(PRODUCER_SHA256)) {
    const rewrites = rewritesFor(fixture, file);
    assert.ok(rewrites.length > 0, `${file} must have declared rewrites`);
    const destination = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const { from, to } of rewrites) {
      assert.equal(destination.includes(from), false, `${file} still carries the rewritten producer bytes`);
      assert.equal(destination.split(to).length - 1, 1, `the ${file} replacement must occur exactly once`);
    }
    const producer = reverseRewrites(destination, rewrites);
    assert.equal(sha256(Buffer.from(producer, 'utf8')), digest, `${file} does not reverse to the producer digest`);
    assert.equal(Buffer.byteLength(producer, 'utf8'), PRODUCER_BYTES[file], `${file} producer length drifted`);
    assert.equal(applyRewrites(producer, rewrites), destination, 'the declared rewrites must be exactly reversible');
  }
});

// ---------------------------------------------------------------------------
// Value surface
test('the shipped module is the whole 31-name value surface', () => {
  const measured = measure(contracts);
  assert.deepEqual(measured.export_names, fixture.export_names);
  assert.deepEqual(measured.constant_names, fixture.constant_names);
  assert.deepEqual(measured.function_names, fixture.function_names);
  assert.equal(fixture.export_names.length, 31);
  assert.equal(fixture.constant_names.length, 17);
  assert.equal(fixture.function_names.length, 14);
  assert.deepEqual(Object.keys(contracts).sort(), fixture.export_names);
  assert.deepEqual(fixture.export_names, [...fixture.export_names].sort());
  assert.equal(new Set(fixture.export_names).size, 31);
  assert.deepEqual([...fixture.constant_names, ...fixture.function_names].sort(), [...fixture.export_names].sort());
  for (const name of fixture.constant_names) assert.notEqual(typeof contracts[name], 'function', name);
  for (const name of fixture.function_names) assert.equal(typeof contracts[name], 'function', name);
  assert.equal(sha256(canonical(exportSurface(contracts))), fixture.canonical_export_sha256);
});

test('the parameter counts, bake constants and canonical value hashes are the recorded ones', () => {
  assert.deepEqual(fixture.counts, { parameters: 35, conditional_parameters: 1, read_parameters: 36 });
  assert.equal(STAGE_CONTRACT_PARAMETERS.length, fixture.counts.parameters);
  assert.equal(STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length, fixture.counts.conditional_parameters);
  assert.equal(STAGE_CONTRACT_READ_PARAMETERS.length, fixture.counts.read_parameters);

  assert.deepEqual(fixture.bake, { duration_seconds: 300, probe_interval_seconds: 15, max_probes: 20, request_floor: 15 });
  assert.equal(DEPLOYMENT_GATE_DURATION_SECONDS, fixture.bake.duration_seconds);
  assert.equal(DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS, fixture.bake.probe_interval_seconds);
  assert.equal(DEPLOYMENT_GATE_MAX_PROBES, fixture.bake.max_probes);
  assert.equal(DEPLOYMENT_GATE_REQUEST_FLOOR, fixture.bake.request_floor);

  assert.equal(sha256(canonical(SERVICE_RUNTIME_STACK)), SERVICE_RUNTIME_STACK_SHA256);
  assert.equal(fixture.service_runtime_stack_sha256, SERVICE_RUNTIME_STACK_SHA256);
  assert.equal(sha256(canonical(DEPLOYMENT_GATE_THRESHOLDS)), THRESHOLDS_SHA256);
  assert.equal(fixture.thresholds_sha256, THRESHOLDS_SHA256);
});

test('the seven retired record/gate names stay undefined', () => {
  assert.deepEqual(fixture.absent_names, [...ABSENT_NAMES]);
  for (const name of fixture.absent_names) {
    assert.equal(Object.hasOwn(contracts, name), false, `${name} must stay absent`);
    assert.equal(contracts[name], undefined, `${name} must stay undefined`);
  }
});

// The operation scripts re-export four names and one stack builder. They must be
// the same objects, not copies, so a change reaches every consumer at once.
test('the operation modules re-export this single source', () => {
  for (const name of ['STAGE_CONTRACT_STAGE', 'STAGE_CONTRACT_PARAMETERS',
    'STAGE_CONTRACT_CONDITIONAL_PARAMETERS', 'STAGE_CONTRACT_READ_PARAMETERS']) {
    assert.equal(stages[name], contracts[name], `${name} is not re-exported from the one source`);
  }
  assert.equal(recovery.platformStackName, contracts.platformStackName);
});

// ---------------------------------------------------------------------------
// Stack identity
test('stack identities are derived from the stage, not duplicated per caller', () => {
  // Issue #266: the durable owner is the `anywear-ai` organization.
  assert.equal(INFRA_REPOSITORY, 'anywear-ai/AnyWear-Infra');
  assert.equal(SERVICE_REPOSITORY, 'anywear-ai/AnyWear-Service');
  assert.equal(platformStackName('dev'), 'AnyWearPlatformStack-dev');
  assert.equal(platformStackName('beta'), 'AnyWearPlatformStack-beta');
  assert.equal(platformStackName('prod'), 'AnyWearPlatformStack-prod');
  assert.equal(runtimeStackName('beta'), 'AnyWearRuntimeStack-beta');
  assert.equal(runtimeStackName('prod'), 'AnyWearRuntimeStack-prod');
  assert.equal(runtimeStageFromStack('AnyWearRuntimeStack-beta'), 'beta');
  assert.throws(() => runtimeStageFromStack('AnyWearPlatformStack-beta'), /Invalid Runtime stack identity/);
  // #195: the producer of the Runtime stack is Infra's single mutation entry.
  assert.deepEqual(SERVICE_RUNTIME_STACK, {
    name: 'AnyWearRuntimeStack-beta',
    region: 'ap-east-1',
    workflow_path: '.github/workflows/mutate.yml',
  });
  assert.ok(Object.isFrozen(SERVICE_RUNTIME_STACK));
});

test('the Service-role naming surface stayed retired with the Foundation roles', () => {
  assert.equal(contracts.serviceDeployRoleName, undefined);
  assert.equal(contracts.serviceDeployCfnRoleName, undefined);
  assert.equal(contracts.serviceTrustSubject, undefined);
});

test('the declared normalisation removes only CDK diagnostics and hashes canonical JSON', () => {
  const deployed = {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: { ServiceImageDigest: { Type: 'String' } },
    Conditions: {
      BetaApiS2: { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] },
      CDKMetadataAvailable: { 'Fn::Or': [{ 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'ap-east-1'] }, true] },
    },
    Resources: {
      ComputeRuntimeApiServiceD2475D0A: { Type: 'AWS::ECS::Service', Metadata: { 'aws:cdk:path': 'ComputeRuntime/ApiService/Resource' } },
      CDKMetadata: { Type: 'AWS::CDK::Metadata', Condition: 'CDKMetadataAvailable',
        Properties: { Analytics: 'v2:deflate64:H4sIAAAAAAAA/...' } },
    },
    Outputs: { ApiServiceName: { Value: { Ref: 'ComputeRuntimeApiServiceD2475D0A' } } },
  };
  const normalised = normaliseDeployedTemplate(deployed);
  assert.deepEqual(Object.keys(normalised.Resources), ['ComputeRuntimeApiServiceD2475D0A']);
  assert.equal(normalised.Resources.ComputeRuntimeApiServiceD2475D0A.Metadata, undefined);
  assert.equal(normalised.Conditions.CDKMetadataAvailable, undefined);
  assert.deepEqual(Object.keys(normalised.Conditions), ['BetaApiS2']);
  assert.equal(normalised.Outputs.ApiServiceName.Value.Ref, 'ComputeRuntimeApiServiceD2475D0A');
  // The input is not mutated.
  assert.ok(deployed.Resources.CDKMetadata);
  assert.equal(normaliseDeployedTemplate(deployed).Resources.CDKMetadata, undefined);
  // A template with no CDK diagnostics normalises to itself, and an empty
  // Conditions member disappears rather than rendering as `{}`.
  const plain = { Resources: { A: { Type: 'AWS::S3::Bucket' } }, Conditions: { CDKMetadataAvailable: { 'Fn::Equals': [1, 1] } } };
  assert.deepEqual(normaliseDeployedTemplate(plain), { Resources: { A: { Type: 'AWS::S3::Bucket' } } });
  // The canonical hash is stable across CDK diagnostics and sensitive to a
  // single cloud-resource change.
  assert.equal(canonicalDeployedTemplateHash(deployed), canonicalDeployedTemplateHash(normaliseDeployedTemplate(deployed)));
  const changed = structuredClone(deployed);
  changed.Resources.ComputeRuntimeApiServiceD2475D0A.Type = 'AWS::ECS::TaskDefinition';
  assert.notEqual(canonicalDeployedTemplateHash(changed), canonicalDeployedTemplateHash(deployed));
  // An undeclared metadata key fails closed instead of being silently dropped.
  const unexpected = structuredClone(deployed);
  unexpected.Resources.ComputeRuntimeApiServiceD2475D0A.Metadata['aws:unreviewed'] = true;
  assert.throws(() => normaliseDeployedTemplate(unexpected), /Unreviewed deployed template metadata/);
  assert.throws(() => normaliseDeployedTemplate(null), /Invalid deployed template/);
  assert.throws(() => normaliseDeployedTemplate({ Resources: { CDKMetadata: { Type: 'AWS::S3::Bucket' } } }),
    /Invalid CDKMetadata resource identity/);
  assert.deepEqual([...DEPLOYED_TEMPLATE_NORMALISATION].length, 4);
});

// The task-definition identity survived #207: the record that consumed it is
// gone, but the deployed-service identity it proves (the normalized content hash)
// is still how a Runtime deploy and its reader compare a task definition.
const apiDefinition = {
  family: 'beta-anywear-api',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-task',
  executionRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-api-execution',
  networkMode: 'awsvpc',
  cpu: '512',
  memory: '1024',
  containerDefinitions: [{
    name: 'ApiContainer',
    image: '650880818323.dkr.ecr.ap-east-1.amazonaws.com/beta-anywear-service@sha256:' + '9'.repeat(64),
    command: ['node', 'dist/index.js'],
    environment: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }],
  }],
};
const workerDefinition = { ...apiDefinition, family: 'beta-anywear-worker',
  taskRoleArn: 'arn:aws:iam::650880818323:role/beta-anywear-worker-task' };

test('stableTaskDefinition is the normalized content identity, not the revision', () => {
  const expected = {
    family: 'beta-anywear-api',
    taskRoleArn: apiDefinition.taskRoleArn,
    executionRoleArn: apiDefinition.executionRoleArn,
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    container: {
      name: 'ApiContainer',
      image: apiDefinition.containerDefinitions[0].image,
      command: ['node', 'dist/index.js'],
      environment: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
    },
  };
  assert.deepEqual(stableTaskDefinition(apiDefinition), expected);
  assert.equal(taskDefinitionContentHash(apiDefinition), sha256(canonical(expected)));
  const reordered = structuredClone(apiDefinition);
  reordered.containerDefinitions[0].environment = [{ name: 'B', value: '2' }, { name: 'A', value: '1' }];
  assert.equal(taskDefinitionContentHash(reordered), taskDefinitionContentHash(apiDefinition));
  assert.notEqual(taskDefinitionContentHash(workerDefinition), taskDefinitionContentHash(apiDefinition));
  const noCommand = structuredClone(apiDefinition);
  delete noCommand.containerDefinitions[0].command;
  assert.deepEqual(stableTaskDefinition(noCommand).container.command, []);
  assert.throws(() => stableTaskDefinition({ family: 'x', containerDefinitions: [] }),
    /Single-container task definition required/);
  assert.throws(() => stableTaskDefinition(null), /Task definition observation unavailable/);
});

// Static provenance is preserved as written and the measured members are
// recomputed from the shipped module, so the committed fixture is reproducible.
test('the fixture is reproducible from the shipped module', () => {
  const fixtureBytes = readFileSync(new URL('../fixtures/contracts-v0.7.0-identity.json', import.meta.url), 'utf8');
  assert.equal(fixtureBytes, `${JSON.stringify(buildFixture(fixture, contracts), null, 2)}\n`);
});
