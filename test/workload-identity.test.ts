import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { App, type Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { stageParameters } from '../lib/contracts.mjs';
import {
  PLATFORM_REFERENCES,
  PLATFORM_REGION,
  REUSED_PARAMETER_NAMES,
  STAGE_CONTRACT_PARAMETER_NAMES,
  STAGE_CONTRACT_SURFACE_HASH,
  platformInputs,
  platformParameterName,
  type IdentityPhase,
  type Stage,
} from '../lib/platform-inputs';
import { RuntimeStack } from '../lib/runtime-stack';

const infraRoot = path.resolve(__dirname, '..');
const baselines = path.join(infraRoot, 'test', 'baselines');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

const VARIANTS = [
  { name: 'beta-active', stage: 'beta' as Stage, stackName: 'AnyWearRuntimeStack-beta' },
  { name: 'prod-active', stage: 'prod' as Stage, stackName: 'AnyWearRuntimeStack-prod' },
];
const PHASES = ['legacy', 'roles-added', 'retired'] as const;

const CONTRACT_DEFAULT = /^\/anywear\/([a-z]+)\/([a-z0-9_]+)$/;

const references = Object.entries(PLATFORM_REFERENCES).map(([key, reference]) => ({
  key,
  output: 'output' in reference ? reference.output : undefined,
  parameter: reference.parameter,
  index: 'index' in reference ? reference.index : undefined,
  publication: 'publication' in reference ? reference.publication : undefined,
}));
const baseReads = references.filter((entry) => entry.output !== undefined && entry.publication === undefined);
const extensionReads = references.filter((entry) => entry.publication !== undefined);
const convertedReads = [...baseReads, ...extensionReads];
const unique = (values: string[]) => [...new Set(values)].sort();
const legacyTemplateParameters = (stage: Stage): string[] => unique([
  ...baseReads.map((entry) => entry.parameter),
  ...extensionReads.filter((entry) => entry.publication === 'always').map((entry) => entry.parameter),
  'service_repository_uri',
  'api_base_url',
]).filter((parameter) => stage === 'beta' || parameter !== 'operations_topic_arn');
const cleanupParameterNames = (): string[] => unique(extensionReads
  .filter((entry) => entry.publication === 'non-legacy').map((entry) => entry.parameter));
const identityPhaseParameters = (stage: Stage, phase: IdentityPhase): string[] => unique([
  ...legacyTemplateParameters(stage),
  ...(phase === 'legacy' ? [] : cleanupParameterNames()),
]);

function templateFor(variant: (typeof VARIANTS)[number], identityPhase: IdentityPhase): any {
  // The recorded baseline was synthesized with the reviewed cdk.json context;
  // using it here keeps the jest identity comparable to it.
  const app = new App({ context: JSON.parse(readFileSync(path.join(infraRoot, 'cdk.json'), 'utf8')).context });
  const stack = new RuntimeStack(app, variant.stackName, {
    stage: variant.stage,
    env: { account: '650880818323', region: PLATFORM_REGION },
    platform: (scope: Stack) => platformInputs(scope, {
      stage: variant.stage,
      identityPhase,
    }),
  });
  return Template.fromStack(stack).toJSON();
}

type WeakRead = { StackName: string; Region: string; OutputName: string };
function weakReads(value: unknown, found: WeakRead[] = []): WeakRead[] {
  if (Array.isArray(value)) {
    for (const entry of value) weakReads(entry, found);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const reference = record['Fn::GetStackOutput'] as WeakRead | undefined;
    if (reference) found.push(reference);
    for (const entry of Object.values(record)) weakReads(entry, found);
  }
  return found;
}
const weakOutputNames = (value: unknown) => [...new Set(weakReads(value).map((read) => read.OutputName))].sort();

function baselineTemplate(variant: (typeof VARIANTS)[number]): any {
  return JSON.parse(readFileSync(path.join(baselines, variant.name, `${variant.stackName}.template.json`), 'utf8'));
}
const baselineNames = (variant: (typeof VARIANTS)[number]) => [...new Set(weakReads(baselineTemplate(variant))
  .map((read) => read.OutputName))].sort();
const sorted = (values: Iterable<string>) => [...values].sort();

function ssmParameters(template: any): Array<[string, { Type: string; Default: string }]> {
  return Object.entries(template.Parameters ?? {})
    .filter(([, parameter]) => /^\/anywear\//.test((parameter as { Default?: string }).Default ?? '')) as Array<
      [string, { Type: string; Default: string }]>;
}

/** Assert the complete stage-base SSM parameter set and that no weak read remains. */
function assertStageParameters(template: any, stage: Stage, expected: string[]): void {
  const byName = new Map(ssmParameters(template).map(([logicalId, parameter]) => {
    const match = CONTRACT_DEFAULT.exec(parameter.Default);
    if (!match) throw new Error(`unexpected SSM parameter default ${parameter.Default}`);
    return [match[2], { logicalId, parameter }];
  }));
  const expectedNames = sorted([...expected, 'qweather_api_host']);
  if (JSON.stringify(sorted(byName.keys())) !== JSON.stringify(expectedNames)) {
    throw new Error(`stage parameter set drift: ${JSON.stringify(sorted(byName.keys()))}`);
  }
  // The value kind comes from the pinned package for the 36 stage definitions;
  // the four reused names are plain String parameters.
  const packageKinds = new Map(stageParameters().map((definition) => [definition.name, definition.kind]));
  for (const parameter of expectedNames) {
    const entry = byName.get(parameter)!;
    const kind = packageKinds.get(parameter) ?? 'String';
    if (entry.parameter.Type !== (kind === 'List'
      ? 'AWS::SSM::Parameter::Value<List<String>>' : 'AWS::SSM::Parameter::Value<String>')) {
      throw new Error(`unexpected parameter type for ${parameter}: ${entry.parameter.Type}`);
    }
    if (entry.parameter.Default !== platformParameterName(stage, parameter)) {
      throw new Error(`unexpected default for ${parameter}: ${entry.parameter.Default}`);
    }
  }
  for (const parameter of ['vlm_config_arn', 'cloudfront_prefix_list_id']) {
    if (byName.has(parameter)) throw new Error(`${parameter} must stay a retained String parameter`);
  }
  // Every value is a stage-base parameter: no weak cross-stack read survives.
  if (weakReads(template).length !== 0) throw new Error(`weak read remains: ${JSON.stringify(weakOutputNames(template))}`);
  if (JSON.stringify(template).includes('Fn::ImportValue')) throw new Error('Fn::ImportValue must not appear');
}

test('the recorded cdk context hash and app entry bind the recorded baseline', () => {
  const provenance = JSON.parse(readFileSync(path.join(baselines, 'provenance.json'), 'utf8')).runtime_identity;
  expect(provenance.record_type).toBe('anywear_service_runtime_template_identity');
  expect(provenance.repository).toBe('git-malu/AnyWear-Service');
  expect(provenance.issue).toBe(195);
  expect(provenance.cdk_version).toBe('2.272.0');
  expect(provenance.source_sha).toBe('4f2ba555ec293771551c0d23266af7038d95383e');
  expect(Object.keys(provenance.templates).sort()).toEqual(VARIANTS
    .map((variant) => `${variant.name}/${variant.stackName}.template.json`).sort());
  for (const [file, hash] of Object.entries(provenance.templates)) {
    expect(sha256(readFileSync(path.join(baselines, file)))).toBe(hash);
  }
  expect(sha256(readFileSync(path.join(infraRoot, 'cdk.json')))).toBe(provenance.cdk_context_sha256);
  // Issue #195: the Runtime identity records the declared normalisation and the
  // three per-phase hashes; the Workload move anchor stays in the Service history
  // and is not duplicated here.
  expect(provenance.normalisation.length).toBe(4);
  // Issue #220 re-recorded the Runtime identity for the deployed age-alarm
  // calibration, and issue #321 re-recorded it for the two object-deletion worker
  // alarms and their filters; the retired phase stays equal to roles-added.
  expect(provenance.identity_phases.legacy).toBe('b15d6e6e31fde8efbea7e88e4a731a1209864cd2aeb2502bf43e7059c4b28853');
  expect(provenance.identity_phases['roles-added']).toBe('b2756dff8de9661afbbaa306d5b2a0f32bf92da9acc9d34178ec8d7acd9681b1');
  expect(provenance.identity_phases.retired).toBe(provenance.identity_phases['roles-added']);
  const cdkJson = readFileSync(path.join(infraRoot, 'cdk.json'));
  const config = JSON.parse(cdkJson.toString('utf8'));
  expect(config.app).toBe('npx ts-node --prefer-ts-exts bin/infra.ts');
  expect(readFileSync(path.join(infraRoot, 'bin', 'infra.ts'), 'utf8')).toContain("deployScope === 'runtime'");
  expect(JSON.parse(readFileSync(path.join(infraRoot, 'package.json'), 'utf8')).dependencies['aws-cdk-lib']).toBe('2.272.0');
});

test('the recorded worker task role carries exactly the task-protection grant, and no other policy does', () => {
  const provenance = JSON.parse(readFileSync(path.join(baselines, 'provenance.json'), 'utf8')).runtime_identity;
  const protection = provenance.protection_extension;
  expect(protection).toBeDefined();
  expect(protection.issue).toBe(170);
  expect(protection.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(protection.source_branch).toBe('issue/170-task-protection');
  expect(protection.changed_policy_logical_id).toBe('ComputeRuntimeWorkerTaskRoleDefaultPolicyD3D4D309');
  expect(protection.actions).toEqual(['ecs:GetTaskProtection', 'ecs:UpdateTaskProtection']);
  expect(provenance.source_sha).toBe('4f2ba555ec293771551c0d23266af7038d95383e');

  for (const variant of VARIANTS) {
    const baselineFile = `${variant.name}/${variant.stackName}.template.json`;
    // The provenance hash binds the exact bytes this test reads.
    expect(sha256(readFileSync(path.join(baselines, baselineFile))))
      .toBe(provenance.templates[baselineFile]);
    const recorded = JSON.parse(readFileSync(path.join(baselines, baselineFile), 'utf8'));
    const policy = recorded.Resources[protection.changed_policy_logical_id];
    expect(policy.Type).toBe('AWS::IAM::Policy');
    expect(policy.Properties.Roles).toEqual([{ Ref: 'ComputeRuntimeWorkerTaskRole66813EBC' }]);
    const statements = policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>;
    const holders = statements.filter((statement) => (statement.Action ?? []).some(
      (action: string) => protection.actions.includes(action),
    ));
    expect(holders).toHaveLength(1);
    const [grant] = holders;
    expect(grant.Action).toEqual(['ecs:GetTaskProtection', 'ecs:UpdateTaskProtection']);
    expect(grant.Effect).toBe('Allow');
    // Stack.formatArn renders the SSM-backed cluster name into the task ARN scope.
    expect(Array.isArray(grant.Resource)).toBe(false);
    const join = (grant.Resource as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
    expect(join[0]).toBe('');
    const [prefix, reference, suffix] = join[1] as [string, { Ref: string }, string];
    expect(prefix).toBe(`arn:aws:ecs:${provenance.application_region}:${provenance.aws_account}:task/`);
    expect(recorded.Parameters[reference.Ref].Default).toBe(`/anywear/${variant.stage}/ecs_cluster_name`);
    expect(suffix).toBe('/*');
    // The grant is on the worker task role only: no other IAM policy carries it.
    const otherHolders = Object.entries(recorded.Resources)
      .filter(([logicalId, resource]) => (resource as { Type?: string }).Type === 'AWS::IAM::Policy'
        && logicalId !== protection.changed_policy_logical_id)
      .filter(([, resource]) => JSON.stringify(resource).match(/ecs:(Get|Update)TaskProtection/));
    expect(otherHolders).toEqual([]);
    // The current source synthesizes exactly the recorded bytes.
    expect(templateFor(variant, 'legacy')).toEqual(recorded);
  }
});

test('the stage-contract surface is the pinned package surface', () => {
  // The package's 36 typed definitions (35 unconditional + the conditional
  // cleanup role) plus the four reused names. `stageContractSchemaHash` over the
  // package's absolute names pins the name surface, so a package edit that
  // renames, removes or reorders a definition fails here before synthesis.
  expect(stageParameters()).toHaveLength(36);
  expect(STAGE_CONTRACT_PARAMETER_NAMES).toHaveLength(40);
  expect(new Set(STAGE_CONTRACT_PARAMETER_NAMES).size).toBe(40);
  expect(STAGE_CONTRACT_SURFACE_HASH).toBe('7748c2bb252fe992a76801074909ee21a996b07fed90340d608df9866fe0da69');
  for (const definition of stageParameters()) {
    expect(STAGE_CONTRACT_PARAMETER_NAMES).toContain(definition.name);
  }
  for (const reused of REUSED_PARAMETER_NAMES) expect(STAGE_CONTRACT_PARAMETER_NAMES).toContain(reused);
});

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s synthesizes the recorded Runtime stack identity',
  (name, variant) => {
    const legacy = templateFor(variant, 'legacy');
    expect(legacy.Description).toBeUndefined();
    expect(legacy.Rules).toHaveProperty('CheckBootstrapVersion');
    assertStageParameters(legacy, variant.stage, legacyTemplateParameters(variant.stage));
    expect(legacy).toEqual(baselineTemplate(variant));
    for (const logicalId of ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId',
      'BootstrapVersion']) {
      expect(legacy.Parameters).toHaveProperty(logicalId);
    }
    if (variant.stage === 'beta') {
      expect(legacy.Parameters).toHaveProperty('BetaApiSizingProfile');
      // Issue #183 removed the retired sizing-telemetry switch; the retained API
      // sizing profile and its condition stay.
      expect(legacy.Parameters).not.toHaveProperty('BetaSizingTelemetry');
      expect(legacy.Conditions.BetaApiS2).toEqual({ 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] });
    }
    expect(legacy.Parameters.CloudFrontPrefixListId.AllowedPattern).toBe('^pl-[a-z0-9]+$');
    expect(legacy.Parameters.ServiceImageDigest.AllowedPattern).toBe('^sha256:[a-f0-9]{64}$');
    expect(legacy.Parameters.ServiceCommitSha.AllowedPattern).toBe('^[a-f0-9]{40}$');

    // The Runtime stack owns no distribution and no activation flag: the API
    // CloudFront distribution is Infra Base's, and run state is the stack's
    // existence rather than an output.
    expect(Object.keys(legacy.Outputs).sort()).toEqual(['ApiLoadBalancerDnsName', 'ApiServiceName',
      'ServiceRepositoryUri', 'WorkerServiceName'].sort());
    expect(legacy.Outputs.BetaActive).toBeUndefined();
    expect(legacy.Outputs.ApiBaseUrl).toBeUndefined();
    expect(legacy.Outputs.ApiDistributionDomainName).toBeUndefined();
    for (const obsolete of ['ComputeRuntimeApiDistribution5788DFE7', 'ComputeRuntimeMaintenanceOriginF7D74A6C',
      'ComputeRuntimeMaintenanceResponseF200BB8A']) {
      expect(legacy.Resources).not.toHaveProperty(obsolete);
    }
    expect(Object.keys(legacy.Resources).filter((id) => id.startsWith('CleanupOperation'))).toEqual([]);

    for (const logicalId of ['ComputeRuntimeApiTaskDefinition99E11C46', 'ComputeRuntimeApiServiceD2475D0A',
      'ComputeRuntimeWorkerTaskDefinitionFDF37699', 'ComputeRuntimeLoadBalancerABD1175B',
      'ComputeRuntimeCloudFrontOriginIngress3B8D6D63']) {
      expect(legacy.Resources).toHaveProperty(logicalId);
    }
  },
);

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))(
  '%s adds exactly the cleanup contract values at the identity phases',
  (name, variant) => {
    for (const identityPhase of ['roles-added', 'retired'] as const) {
      const template = templateFor(variant, identityPhase);
      assertStageParameters(template, variant.stage, identityPhaseParameters(variant.stage, identityPhase));
      expect(weakOutputNames(template)).toEqual([]);
      if (variant.stage === 'beta') {
        expect(Object.keys(template.Resources)).toEqual(expect.arrayContaining(
          ['CleanupOperationVerificationTaskDefinition2283B142',
            'CleanupOperationCleanupTaskDefinitionA07FB696', 'CleanupOperationStateMachine7A35FF20',
            'CleanupOperationStateMachineVersionEE8B7AAD']));
        expect(template.Resources).toHaveProperty('ComputeRuntimeApiTaskDefinition99E11C46');
        expect(template.Outputs).toHaveProperty('CleanupOperationCleanupStateMachineArn3993CAF0');
      } else {
        expect(Object.keys(template.Resources).filter((id) => id.startsWith('CleanupOperation'))).toEqual([]);
      }
    }
  },
);

test('the Beta cleanup capability is deleted with the Runtime stack, not retained', () => {
  // A stop deletes the Runtime stack and a start recreates the fixed
  // `beta-anywear-tester-cleanup` name. Retaining the state machine, its
  // immutable version or the one-shot task definitions would fail the start
  // with `State machine already exists` or leave stale task definitions behind.
  for (const identityPhase of ['roles-added', 'retired'] as const) {
    const template = templateFor(VARIANTS[0], identityPhase);
    for (const logicalId of ['CleanupOperationVerificationTaskDefinition2283B142',
      'CleanupOperationCleanupTaskDefinitionA07FB696', 'CleanupOperationStateMachine7A35FF20',
      'CleanupOperationStateMachineVersionEE8B7AAD']) {
      const resource = template.Resources[logicalId];
      expect(resource).toBeDefined();
      expect(resource.DeletionPolicy).not.toBe('Retain');
      expect(resource.UpdateReplacePolicy).not.toBe('Retain');
    }
    // CDK emits the state machine's explicit deletion policy; the version and
    // both task definitions are deleted by CloudFormation's default.
    expect(template.Resources.CleanupOperationStateMachine7A35FF20.DeletionPolicy).toBe('Delete');
    for (const logicalId of ['CleanupOperationVerificationTaskDefinition2283B142',
      'CleanupOperationCleanupTaskDefinitionA07FB696', 'CleanupOperationStateMachineVersionEE8B7AAD']) {
      expect(template.Resources[logicalId].DeletionPolicy).toBeUndefined();
      expect(template.Resources[logicalId].UpdateReplacePolicy).toBeUndefined();
    }
  }
  // Production synthesizes no cleanup capability at all.
  for (const identityPhase of ['roles-added', 'retired'] as const) {
    expect(Object.keys(templateFor(VARIANTS[1], identityPhase).Resources)
      .filter((id) => id.startsWith('CleanupOperation'))).toEqual([]);
  }
});

test('every variant and identity phase resolves the stage base without a weak read', () => {
  const covered = new Set<string>();
  for (const entry of convertedReads) if (entry.output !== undefined) covered.add(entry.output);
  for (const variant of VARIANTS) {
    expect(baselineNames(variant).filter((entry) => !covered.has(entry))).toEqual([]);
  }
  // This is the required zero-weak-read acceptance: both variants at all three
  // identity phases contain no Fn::GetStackOutput.
  for (const variant of VARIANTS) {
    for (const phase of PHASES) {
      expect(weakReads(templateFor(variant, phase))).toEqual([]);
    }
  }
  // The old same-app reference silently lost the late ALB->API rule and the
  // one-shot execution policy; the imported Base values must not recreate
  // either as a new Runtime resource.
  const resources = JSON.stringify(templateFor(VARIANTS[0], 'legacy').Resources);
  expect(resources).not.toContain('Load balancer to target');
  expect(resources).not.toContain('PolicyAnyWearRuntimeStackbetaPlatformOneShotExecutionRole');
});
