import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_DISTRIBUTION,
  BASE_STACK,
  DESTINATION_LOGICAL_ID,
  MOVED_OUTPUTS,
  SOURCE_LOGICAL_ID,
  WORKLOAD_STACK,
  assertRefactorEligibility,
  assertTemplateSurfaceUnchanged,
  buildRefactorTemplates,
  preMoveWorkloadUpdate,
  validateApiDistributionDomain,
  runStage,
  parseArguments,
  preMoveTemplateKey,
  templateObjectUrl,
  templateTimestamp,
  validateReadback,
  validateRefactorPreview,
  validateResourceMappings,
  validateTemplateBucket,
  workloadParameterArguments,
  workloadParameterKeys,
} from '../../scripts/migrate-beta-split.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`../../test/fixtures/beta-split/${name}`, import.meta.url), 'utf8'));
const liveWorkload = () => fixture('workload-live.template.json');
const liveBase = () => fixture('base-live.template.json');
const baseSynth = () => fixture('base-synth.template.json');
const distributionType = () => fixture('distribution-type.json');
const origin = 'beta-anywear-api-0123456789.ap-east-1.elb.amazonaws.com';
const distributionDomain = 'd111111abcdef8.cloudfront.net';
const verificationLogicalId = 'CleanupOperationVerificationTaskDefinition2283B142';
const verificationValuePath = `/Resources/${verificationLogicalId}/Properties/ContainerDefinitions/0/Environment/13/Value`;
const retainedPaths = [
  `/Resources/${SOURCE_LOGICAL_ID}/DeletionPolicy`,
  `/Resources/${SOURCE_LOGICAL_ID}/UpdateReplacePolicy`,
];
const distribution = template => template.Resources[SOURCE_LOGICAL_ID];
const preMovedWorkload = () => preMoveWorkloadUpdate(liveWorkload(), {
  apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
}).template;
const cleanPreview = () => ({
  describe: { StackRefactorId: 're-1111', Description: 'beta API distribution move', Status: 'CREATE_COMPLETE',
    ExecutionStatus: 'AVAILABLE', StatusReason: null, UnsupportedResources: [], Conflicts: [] },
  actions: { StackRefactorActions: [{ Action: 'MOVE', Entity: 'RESOURCE', PhysicalResourceId: 'E3U35871TUO53L',
    Description: 'Move resource to its destination stack',
    ResourceMapping: {
      Source: { StackName: WORKLOAD_STACK, LogicalResourceId: SOURCE_LOGICAL_ID },
      Destination: { StackName: BASE_STACK, LogicalResourceId: DESTINATION_LOGICAL_ID },
    } }] },
  resourceMappings: buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: liveBase(), baseSynth: baseSynth() }).resourceMappings,
});

test('(a) the pre-move update rewrites the literal origin, the verify URL and the distribution DependsOn', () => {
  const before = liveWorkload();
  const plan = preMoveWorkloadUpdate(before, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain });
  assert.deepEqual(plan.origin.from, { 'Fn::GetAtt': ['ComputeRuntimeLoadBalancerABD1175B', 'DNSName'] });
  assert.equal(plan.origin.to, origin);
  assert.equal(distribution(plan.template).Properties.DistributionConfig.Origins[0].DomainName, origin);
  assert.equal(distribution(plan.template).DependsOn, undefined);
  assert.deepEqual(plan.removedDependsOn, ['ComputeRuntimeLoadBalancerABD1175B', 'ComputeRuntimeApiServiceD2475D0A']);
  assert.deepEqual(plan.changes.sort(), [
    `/Resources/${SOURCE_LOGICAL_ID}/DependsOn`,
    `/Resources/${SOURCE_LOGICAL_ID}/Properties/DistributionConfig/Origins/0/DomainName`,
    verificationValuePath,
    ...retainedPaths,
  ].sort());
  assert.equal(distribution(plan.template).DeletionPolicy, 'Retain');
  assert.equal(distribution(plan.template).UpdateReplacePolicy, 'Retain');
  // The verification value is the literal CloudFront URL at the same index and
  // the entry name is unchanged.
  const environment = plan.template.Resources[verificationLogicalId]
    .Properties.ContainerDefinitions[0].Environment;
  assert.equal(environment.length, 14);
  assert.equal(environment[13].Name, 'VERIFY_API_URL');
  assert.equal(environment[13].Value, `https://${distributionDomain}`);
  assert.deepEqual(plan.verifyUrl.from,
    { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [SOURCE_LOGICAL_ID, 'DomainName'] }]] });
  assert.equal(plan.verifyUrl.resource, verificationLogicalId);
  assert.equal(plan.verifyUrl.index, 13);
  // Everything else, including the two outputs and all other environment entries,
  // stays byte-identical.
  const after = structuredClone(plan.template);
  delete after.Resources[SOURCE_LOGICAL_ID].Properties.DistributionConfig.Origins[0].DomainName;
  delete after.Resources[SOURCE_LOGICAL_ID].DependsOn;
  delete after.Resources[SOURCE_LOGICAL_ID].DeletionPolicy;
  delete after.Resources[SOURCE_LOGICAL_ID].UpdateReplacePolicy;
  delete after.Resources[verificationLogicalId].Properties.ContainerDefinitions[0].Environment[13].Value;
  const original = structuredClone(before);
  delete original.Resources[SOURCE_LOGICAL_ID].Properties.DistributionConfig.Origins[0].DomainName;
  delete original.Resources[SOURCE_LOGICAL_ID].DependsOn;
  delete original.Resources[verificationLogicalId].Properties.ContainerDefinitions[0].Environment[13].Value;
  assert.deepEqual(after, original);
  for (const output of MOVED_OUTPUTS) assert.ok(after.Outputs[output]);
});

test('(a) the pre-move update is idempotent on an already-literal origin and refuses a bad origin', () => {
  const already = liveWorkload();
  distribution(already).Properties.DistributionConfig.Origins[0].DomainName = origin;
  delete distribution(already).DependsOn;
  const plan = preMoveWorkloadUpdate(already, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain });
  assert.deepEqual(plan.changes.sort(), [verificationValuePath, ...retainedPaths].sort());
  assert.equal(distribution(plan.template).DeletionPolicy, 'Retain');
  assert.equal(distribution(plan.template).UpdateReplacePolicy, 'Retain');
  assert.throws(() => preMoveWorkloadUpdate(liveWorkload(), { apiDistributionDomain: distributionDomain }),
    /requires the live ApiLoadBalancerDnsName/);
  assert.throws(() => preMoveWorkloadUpdate(already, { apiLoadBalancerDnsName: 'other.example.com', apiDistributionDomain: distributionDomain }),
    /neither the expected GetAtt nor the recorded literal/);
  const external = liveWorkload();
  distribution(external).Properties.DistributionConfig.Origins[0].DomainName = { 'Fn::GetAtt': ['ForeignKeyABCD1234', 'DNSName'] };
  assert.throws(() => preMoveWorkloadUpdate(external, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain }),
    /does not name a same-stack load balancer/);
});

test('(a) the pre-move update refuses a missing, duplicate or foreign verify-url and validates the domain', () => {
  const environmentOf = template => template.Resources[verificationLogicalId]
    .Properties.ContainerDefinitions[0].Environment;
  const update = (mutate) => {
    const template = liveWorkload();
    mutate(template);
    return preMoveWorkloadUpdate(template, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain });
  };
  // Missing entry.
  assert.throws(() => update((template) => {
    template.Resources[verificationLogicalId].Properties.ContainerDefinitions[0].Environment =
      environmentOf(template).filter((entry) => entry.Name !== 'VERIFY_API_URL');
  }), /exactly one VERIFY_API_URL entry; got 0/);
  // Duplicate entry.
  assert.throws(() => update((template) => {
    environmentOf(template).push({ Name: 'VERIFY_API_URL', Value: `https://${distributionDomain}` });
  }), /exactly one VERIFY_API_URL entry; got 2/);
  // A wrong literal or foreign value is not the expected reference. The exact
  // recorded literal URL is accepted as already rewritten (idempotency).
  for (const value of ['https://other.cloudfront.net', { 'Fn::GetAtt': ['ForeignKeyABCD1234', 'DomainName'] },
    { 'Fn::Join': ['', ['http://', { 'Fn::GetAtt': [SOURCE_LOGICAL_ID, 'DomainName'] }]] }]) {
    assert.throws(() => update((template) => { environmentOf(template)[13].Value = value; }),
      /neither the expected https:\/\/ \+ distribution GetAtt reference nor the recorded literal URL/);
  }
  // A second verification task definition is refused.
  assert.throws(() => update((template) => {
    template.Resources.CleanupOperationVerificationTaskDefinitionFFFF =
      structuredClone(template.Resources[verificationLogicalId]);
  }), /exactly one CleanupOperationVerificationTaskDefinition resource/);
  // CloudFront-domain input: no scheme/path, lowercase only, required.
  for (const value of [undefined, '', `https://${distributionDomain}`, `${distributionDomain}/path`,
    'D111.CLOUDFRONT.NET', 'd111111abcdef8.example.com']) {
    assert.throws(() => preMoveWorkloadUpdate(liveWorkload(),
      { apiLoadBalancerDnsName: origin, apiDistributionDomain: value }), /--api-distribution-domain/);
  }
  assert.equal(validateApiDistributionDomain(distributionDomain), distributionDomain);
});

test('(a) the pre-move update refuses any remaining distribution reference in resources', () => {
  const foreign = liveWorkload();
  foreign.Resources.ComputeRuntimeApiServiceD2475D0A.Properties.Environment = [
    { Name: 'FOREIGN_REFERENCE', Value: { 'Fn::GetAtt': [SOURCE_LOGICAL_ID, 'DomainName'] } },
  ];
  assert.throws(() => preMoveWorkloadUpdate(foreign, {
    apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
  }), new RegExp(`The pre-move Workload template still references ${SOURCE_LOGICAL_ID} outside the moved outputs at `
    + '/Resources/ComputeRuntimeApiServiceD2475D0A/Properties/Environment/0/Value'));
  // The normal fixture still produces exactly the origin + verify changes.
  const normal = liveWorkload();
  delete distribution(normal).DependsOn;
  const plan = preMoveWorkloadUpdate(normal, {
    apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
  });
  assert.deepEqual(plan.changes.sort(), [
    `/Resources/${SOURCE_LOGICAL_ID}/Properties/DistributionConfig/Origins/0/DomainName`,
    verificationValuePath,
    ...retainedPaths,
  ].sort());
  assert.deepEqual(plan.removedDependsOn, []);
});

test('(a) the pre-move update makes exactly the origin and verify-URL changes when DependsOn is absent', () => {
  const template = liveWorkload();
  delete distribution(template).DependsOn;
  const plan = preMoveWorkloadUpdate(template, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain });
  assert.deepEqual(plan.changes.sort(), [
    `/Resources/${SOURCE_LOGICAL_ID}/Properties/DistributionConfig/Origins/0/DomainName`,
    verificationValuePath,
    ...retainedPaths,
  ].sort());
  assert.deepEqual(plan.removedDependsOn, []);
  assert.equal(distribution(plan.template).DependsOn, undefined);
});

test('(a) the current post-Stage-A live shape plans exactly the two Retain attributes', () => {
  const current = liveWorkload();
  distribution(current).Properties.DistributionConfig.Origins[0].DomainName = origin;
  current.Resources[verificationLogicalId].Properties.ContainerDefinitions[0].Environment[13].Value =
    `https://${distributionDomain}`;
  delete distribution(current).DependsOn;
  assert.equal(distribution(current).DeletionPolicy, undefined);
  assert.equal(distribution(current).UpdateReplacePolicy, undefined);
  const plan = preMoveWorkloadUpdate(current, { apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain });
  assert.deepEqual(plan.changes.sort(), [...retainedPaths].sort());
  assert.equal(distribution(plan.template).DeletionPolicy, 'Retain');
  assert.equal(distribution(plan.template).UpdateReplacePolicy, 'Retain');
  assert.equal(distribution(plan.template).Properties.DistributionConfig.Origins[0].DomainName, origin);
  assert.equal(plan.template.Resources[verificationLogicalId].Properties.ContainerDefinitions[0].Environment[13].Value,
    `https://${distributionDomain}`);
});

test('(a) the Retain attributes are idempotent and any other value refuses', () => {
  const first = preMoveWorkloadUpdate(liveWorkload(), {
    apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
  });
  const second = preMoveWorkloadUpdate(first.template, {
    apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
  });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(distribution(second.template), distribution(first.template));
  for (const [attribute, value] of [['DeletionPolicy', 'Delete'], ['UpdateReplacePolicy', 'Snapshot']]) {
    const bad = liveWorkload();
    distribution(bad)[attribute] = value;
    assert.throws(() => preMoveWorkloadUpdate(bad, {
      apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
    }), new RegExp(`${attribute} is ${value}, not Retain`));
  }
  // One already-Retain attribute plus one absent: only the absent path changes.
  const partial = liveWorkload();
  distribution(partial).DeletionPolicy = 'Retain';
  const plan = preMoveWorkloadUpdate(partial, {
    apiLoadBalancerDnsName: origin, apiDistributionDomain: distributionDomain,
  });
  assert.ok(plan.changes.includes(`/Resources/${SOURCE_LOGICAL_ID}/UpdateReplacePolicy`));
  assert.equal(plan.changes.includes(`/Resources/${SOURCE_LOGICAL_ID}/DeletionPolicy`), false);
});

test('(b) the refactor source has no distribution GetAtt and refuses any remaining reference', () => {
  const templates = buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: liveBase(), baseSynth: baseSynth() });
  assert.equal(JSON.stringify(templates.source).includes(SOURCE_LOGICAL_ID), false);
  // A foreign reference anywhere in the source refuses before create-stack-refactor.
  const foreign = preMovedWorkload();
  foreign.Resources.ComputeRuntimeApiServiceD2475D0A.Properties.Environment = [
    { Name: 'WRONG_REFERENCE', Value: { 'Fn::GetAtt': [SOURCE_LOGICAL_ID, 'DomainName'] } },
  ];
  assert.throws(() => buildRefactorTemplates({ liveWorkload: foreign, liveBase: liveBase(), baseSynth: baseSynth() }),
    /still references .* outside the moved outputs/);
  // An unrewritten verify URL is the same dangling-reference class.
  assert.throws(() => buildRefactorTemplates({ liveWorkload: liveWorkload(), liveBase: liveBase(), baseSynth: baseSynth() }),
    /still references .* outside the moved outputs/);
});

test('(b) the refactor source loses the distribution and both outputs; the target gains exactly them', () => {
  const templates = buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: liveBase(), baseSynth: baseSynth() });
  // Source: only the distribution and its two outputs are removed.
  assert.equal(templates.source.Resources[SOURCE_LOGICAL_ID], undefined);
  for (const output of MOVED_OUTPUTS) assert.equal(templates.source.Outputs[output], undefined);
  assert.deepEqual(templates.source.Outputs.ApiLoadBalancerDnsName, liveWorkload().Outputs.ApiLoadBalancerDnsName);
  assert.deepEqual(templates.source.Resources.ComputeRuntimeLoadBalancerABD1175B,
    liveWorkload().Resources.ComputeRuntimeLoadBalancerABD1175B);
  assert.deepEqual(templates.source.Parameters, liveWorkload().Parameters);
  assert.deepEqual(templates.source.Conditions, liveWorkload().Conditions);
  assert.deepEqual(templates.source.Mappings, liveWorkload().Mappings);
  // Target: the live Base resources are untouched; the distribution and the two
  // outputs are adopted from Base's same-HEAD synthesis.
  assert.deepEqual(templates.target.Resources.AnyWearWardrobeBucket61DCC096,
    liveBase().Resources.AnyWearWardrobeBucket61DCC096);
  assert.deepEqual(templates.target.Resources[DESTINATION_LOGICAL_ID], baseSynth().Resources[DESTINATION_LOGICAL_ID]);
  for (const output of MOVED_OUTPUTS) assert.deepEqual(templates.target.Outputs[output], baseSynth().Outputs[output]);
  assert.deepEqual(templates.target.Parameters ?? {}, liveBase().Parameters ?? {});
  assert.deepEqual(templates.target.Conditions ?? {}, liveBase().Conditions ?? {});
  assert.deepEqual(templates.target.Mappings ?? {}, liveBase().Mappings ?? {});
  // The moved resource has the same configuration; only the destination logical
  // ID (and the Retain attributes asserted by synthesis) differ.
  assert.deepEqual(templates.target.Resources[DESTINATION_LOGICAL_ID].Properties,
    distribution(preMovedWorkload()).Properties);
  assert.equal(templates.target.Resources[DESTINATION_LOGICAL_ID].UpdateReplacePolicy, 'Retain');
  // The one mapping's destination is the CDK-pinned logical ID.
  assert.equal(templates.resourceMappings.length, 1);
  assert.deepEqual(validateResourceMappings(templates.resourceMappings),
    templates.resourceMappings[0]);
  assert.equal(templates.resourceMappings[0].Destination.LogicalResourceId, API_DISTRIBUTION.logicalId);
  assert.equal(templates.resourceMappings[0].Source.StackName, WORKLOAD_STACK);
  assert.equal(templates.resourceMappings[0].Destination.StackName, BASE_STACK);
});

test('(b) the refactor refuses an already-moved Base, a changed parameter/condition/mapping surface or a foreign mapping', () => {
  const already = baseSynth();
  assert.throws(() => buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: already, baseSynth: baseSynth() }),
    /already contains/);
  for (const section of ['Parameters', 'Conditions', 'Mappings']) {
    const live = liveWorkload();
    const refactored = structuredClone(live);
    refactored[section] = { ...(refactored[section] ?? {}), Tampered: { Type: 'String', Default: 'x' } };
    assert.throws(() => assertTemplateSurfaceUnchanged(live, refactored, WORKLOAD_STACK), new RegExp(`${section} differs`));
  }
  const templates = buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: liveBase(), baseSynth: baseSynth() });
  for (const target of [
    { ...templates.resourceMappings[0], Destination: { StackName: BASE_STACK, LogicalResourceId: 'OtherLogicalId' } },
    { ...templates.resourceMappings[0], Destination: { StackName: 'AnyWearOtherStack', LogicalResourceId: DESTINATION_LOGICAL_ID } },
  ]) assert.throws(() => validateResourceMappings([target]), /differs|CDK-pinned/);
  assert.throws(() => validateResourceMappings([]), /Exactly one resource mapping/);
});

test('(b) a clean preview is exactly one MOVE of the API distribution', () => {
  const preview = cleanPreview();
  const result = validateRefactorPreview(preview);
  assert.equal(result.clean, true);
  assert.equal(result.action.Action, 'MOVE');
  assert.equal(result.mapping.Destination.LogicalResourceId, API_DISTRIBUTION.logicalId);
});

test('(b) the live stack-ARN mapping form and bare names both validate', () => {
  const sourceArn = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/3b3fc840-1111-4111-8111-111111111111';
  const destinationArn = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearPlatformStack-beta/e1f46de0-2222-4222-8222-222222222222';
  const arnPreview = cleanPreview();
  arnPreview.actions.StackRefactorActions[0].ResourceMapping.Source.StackName = sourceArn;
  arnPreview.actions.StackRefactorActions[0].ResourceMapping.Destination.StackName = destinationArn;
  assert.equal(validateRefactorPreview(arnPreview).clean, true);
  // The recorded clean shape with bare names still passes.
  assert.equal(validateRefactorPreview(cleanPreview()).clean, true);

  // Wrong stack name in ARN or bare form refuses.
  for (const [side, wrong] of [['Source', sourceArn.replace('AnyWearWorkloadStack-beta', 'AnyWearOtherStack-beta')],
    ['Destination', destinationArn.replace('AnyWearPlatformStack-beta', 'AnyWearOtherStack-beta')]]) {
    const preview = cleanPreview();
    preview.actions.StackRefactorActions[0].ResourceMapping[side].StackName = wrong;
    assert.throws(() => validateRefactorPreview(preview), new RegExp(`${side} mapping does not match`));
  }
  for (const [side, wrong] of [['Source', 'AnyWearOtherStack-beta'], ['Destination', 'AnyWearOtherStack-beta']]) {
    const preview = cleanPreview();
    preview.actions.StackRefactorActions[0].ResourceMapping[side].StackName = wrong;
    assert.throws(() => validateRefactorPreview(preview), new RegExp(`${side} mapping does not match`));
  }
  // Wrong logical ID in ARN form refuses on either side.
  for (const side of ['Source', 'Destination']) {
    const preview = arnPreview;
    const changed = structuredClone(preview);
    changed.actions.StackRefactorActions[0].ResourceMapping[side].LogicalResourceId = 'OtherDistribution';
    assert.throws(() => validateRefactorPreview(changed), new RegExp(`${side} mapping does not match`));
  }
  // A malformed/foreign ARN is never treated as a bare name.
  for (const foreign of [
    sourceArn.replace('ap-east-1', 'us-east-1'),
    sourceArn.replace('650880818323', '111111111111'),
    destinationArn.replace(/\/[0-9a-f-]{36}$/, ''),
    destinationArn.replace(/\/[0-9a-f-]{36}$/, '/not-a-uuid'),
  ]) {
    const preview = cleanPreview();
    preview.actions.StackRefactorActions[0].ResourceMapping.Source.StackName = foreign;
    assert.throws(() => validateRefactorPreview(preview), /malformed or foreign/);
  }
});

test('(b) a second action, a configuration change, a CREATE/DELETE or an ineligible preview is refused', () => {
  const second = cleanPreview();
  second.actions.StackRefactorActions.push({ ...cleanPreview().actions.StackRefactorActions[0],
    PhysicalResourceId: 'E3OTHERDISTRIB' });
  assert.throws(() => validateRefactorPreview(second), /exactly one action/);

  for (const Action of ['UPDATE', 'CREATE', 'DELETE']) {
    const changed = cleanPreview();
    changed.actions.StackRefactorActions[0].Action = Action;
    assert.throws(() => validateRefactorPreview(changed), new RegExp(`is not the single MOVE`));
  }
  const unsupported = cleanPreview();
  unsupported.describe.UnsupportedResources = ['AWS::CloudFront::Distribution'];
  assert.throws(() => validateRefactorPreview(unsupported), /unsupported resource/);
  const conflict = cleanPreview();
  conflict.describe.Conflicts = ['stack policy differs'];
  assert.throws(() => validateRefactorPreview(conflict), /conflict/);
  const incomplete = cleanPreview();
  incomplete.describe.Status = 'CREATE_IN_PROGRESS';
  assert.throws(() => validateRefactorPreview(incomplete), /not complete: CREATE_IN_PROGRESS/);
  const notAvailable = cleanPreview();
  notAvailable.describe.ExecutionStatus = 'EXECUTE_IN_PROGRESS';
  assert.throws(() => validateRefactorPreview(notAvailable), /not available/);
  const reason = cleanPreview();
  reason.describe.StatusReason = 'blocked';
  assert.throws(() => validateRefactorPreview(reason), /status reason/);
  const wrongEntity = cleanPreview();
  wrongEntity.actions.StackRefactorActions[0].Entity = 'STACK';
  assert.throws(() => validateRefactorPreview(wrongEntity), /not a RESOURCE action/);
  const wrongPhysical = cleanPreview();
  wrongPhysical.actions.StackRefactorActions[0].PhysicalResourceId = 'E3FOREIGNDIST';
  assert.throws(() => validateRefactorPreview(wrongPhysical), /is not the reviewed distribution/);
  for (const side of ['Source', 'Destination']) {
    for (const field of ['StackName', 'LogicalResourceId']) {
      const wrong = cleanPreview();
      wrong.actions.StackRefactorActions[0].ResourceMapping[side][field] = 'OtherValue';
      assert.throws(() => validateRefactorPreview(wrong), new RegExp(`${side} mapping does not match`));
    }
  }
  const wrongMapping = cleanPreview();
  wrongMapping.resourceMappings[0].Destination.LogicalResourceId = 'OtherLogicalId';
  assert.throws(() => validateRefactorPreview(wrongMapping), /differs|CDK-pinned/);
});

test('eligibility requires FULLY_MUTABLE, no stack policy and no stack-varying pseudo parameter', () => {
  const base = { distributionType: distributionType(), workloadStackPolicy: undefined, baseStackPolicy: undefined,
    workloadTemplate: liveWorkload() };
  assert.equal(assertRefactorEligibility(base), true);
  for (const distributionTypeOverride of [{ ProvisioningType: 'IMMUTABLE' }, { ProvisioningType: 'PARTIAL_UPDATE' }, undefined]) {
    assert.throws(() => assertRefactorEligibility({ ...base, distributionType: distributionTypeOverride }),
      /not FULLY_MUTABLE/);
  }
  assert.throws(() => assertRefactorEligibility({ ...base, workloadStackPolicy: { Statement: [] } }), /stack policy/);
  assert.throws(() => assertRefactorEligibility({ ...base, baseStackPolicy: { Statement: [] } }), /stack policy/);
  const pseudo = liveWorkload();
  pseudo.Resources[SOURCE_LOGICAL_ID].Properties.DistributionConfig.Comment = { Ref: 'AWS::StackName' };
  assert.throws(() => assertRefactorEligibility({ ...base, workloadTemplate: pseudo }), /stack-varying pseudo parameter/);
});

test('(c) the readback requires the same physical distribution, domain and Deployed status', () => {
  const before = { PhysicalResourceId: 'E2ABCDEFGHIJKL' };
  const after = { PhysicalResourceId: 'E2ABCDEFGHIJKL', StackName: BASE_STACK };
  const cloudfront = { Id: 'E2ABCDEFGHIJKL', DomainName: 'd111111abcdef8.cloudfront.net', Status: 'Deployed' };
  assert.deepEqual(validateReadback({ before, after, distribution: cloudfront }),
    { physicalId: 'E2ABCDEFGHIJKL', domain: 'd111111abcdef8.cloudfront.net', status: 'Deployed' });
  assert.throws(() => validateReadback({ before, after: { ...after, PhysicalResourceId: 'E2CHANGED' }, distribution: cloudfront }),
    /changed physical ID/);
  assert.throws(() => validateReadback({ before, after: { ...after, StackName: WORKLOAD_STACK }, distribution: cloudfront }),
    /not in the Base stack/);
  assert.throws(() => validateReadback({ before, after, distribution: { ...cloudfront, Status: 'InProgress' } }),
    /not Deployed/);
});

test('the pre-move apply uploads the template and applies it by URL with every live parameter', async () => {
  const liveKeys = ['ServiceImageDigest', 'ServiceCommitSha', 'VlmConfigArn', 'CloudFrontPrefixListId'];
  const expectedArguments = liveKeys.map((key) => `ParameterKey=${key},UsePreviousValue=true`);
  const bucket = 'cdk-hnb659fds-assets-650880818323-ap-east-1';
  const key = 'migrations/166/pre-move-20261019T130000Z.template.json';
  const templateUrl = `https://${bucket}.s3.ap-east-1.amazonaws.com/${key}`;
  const liveDescribe = { Stacks: [{ StackName: WORKLOAD_STACK,
    Parameters: liveKeys.map((ParameterKey) => ({ ParameterKey, ParameterValue: `value-${ParameterKey}` })) }] };
  const runApply = async (options) => {
    const calls = [];
    const run = async (command, args) => {
      assert.equal(command, 'aws');
      calls.push([...args]);
      if (args[1] === 'describe-stacks') return JSON.stringify(liveDescribe);
      if (args[1] === 'cp') return '';
      if (args[1] === 'update-stack') return '{}';
      if (args[1] === 'wait') return '{}';
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    };
    const result = await runStage({ stage: 'pre-move', apply: true,
      'workload-template': fixturePath('workload-live.template.json'),
      'api-load-balancer-dns-name': origin, 'api-distribution-domain': distributionDomain,
      'template-bucket': bucket, 'template-region': 'ap-east-1', ...options },
    { run, now: () => new Date('2026-10-19T13:00:00.000Z') });
    return { calls, result };
  };

  // Automatic live read: describe, upload, update-by-URL, wait.
  const automatic = await runApply({});
  assert.equal(automatic.result.applied, true);
  assert.deepEqual(automatic.result.parameters, liveKeys);
  assert.equal(automatic.result.templateBucket, bucket);
  assert.equal(automatic.result.templateKey, key);
  assert.equal(automatic.result.templateUrl, templateUrl);
  const automaticSequence = automatic.calls.map((args) => args[1]);
  assert.deepEqual(automaticSequence, ['describe-stacks', 'cp', 'update-stack', 'wait']);
  const upload = automatic.calls.find((args) => args[1] === 'cp');
  assert.deepEqual(upload.slice(0, 2), ['s3', 'cp']);
  assert.match(upload[2], /workload-pre-move\.template\.json$/);
  assert.equal(upload[3], `s3://${bucket}/${key}`);
  const update = automatic.calls.find((args) => args[1] === 'update-stack');
  assert.ok(update.includes('--template-url'));
  assert.equal(update[update.indexOf('--template-url') + 1], templateUrl);
  assert.equal(update.includes('--template-body'), false);
  assert.ok(update.includes('CAPABILITY_NAMED_IAM'));
  assert.deepEqual(update.slice(update.indexOf('--parameters') + 1), expectedArguments);

  // Recorded fixture input: no live read; upload then update-by-URL.
  const recorded = await runApply({ 'workload-parameters': writeTemp(liveDescribe) });
  assert.deepEqual(recorded.calls.map((args) => args[1]), ['cp', 'update-stack', 'wait']);
  const recordedUpdate = recorded.calls.find((args) => args[1] === 'update-stack');
  assert.equal(recordedUpdate[recordedUpdate.indexOf('--template-url') + 1], templateUrl);
  assert.equal(recordedUpdate.includes('--template-body'), false);
  assert.deepEqual(recordedUpdate.slice(recordedUpdate.indexOf('--parameters') + 1), expectedArguments);
  // A plain array of keys is an accepted recorded form.
  assert.deepEqual(workloadParameterKeys(liveKeys), liveKeys);
  assert.deepEqual(workloadParameterArguments(liveKeys), expectedArguments);

  // Missing/empty/malformed live parameters refuse before upload/update.
  for (const source of [{ Stacks: [{ Parameters: [] }] }, {}, { Stacks: [] }, []]) {
    const calls = [];
    const run = async (command, args) => {
      calls.push([...args]);
      if (args[1] === 'describe-stacks') return JSON.stringify(source);
      if (args[1] === 'cp' || args[1] === 'update-stack' || args[1] === 'wait') return '{}';
      throw new Error(`Unexpected AWS call ${args.join(' ')}`);
    };
    await assert.rejects(runStage({ stage: 'pre-move', apply: true,
      'workload-template': fixturePath('workload-live.template.json'),
      'api-load-balancer-dns-name': origin, 'api-distribution-domain': distributionDomain,
      'template-bucket': bucket }, { run }),
    /requires the live Workload stack parameters/);
    assert.equal(calls.some((args) => args[1] === 'cp' || args[1] === 'update-stack'), false);
  }
  assert.throws(() => workloadParameterKeys({ Stacks: [{ Parameters: [{ ParameterKey: '' }] }] }), /Invalid live Workload parameter key/);
  assert.throws(() => workloadParameterKeys([{ ParameterKey: 'A' }, { ParameterKey: 'A' }]), /Duplicate live Workload parameter key/);
});

test('the pre-move template location is deterministic and refuses a bad bucket before any AWS call', async () => {
  const date = new Date('2026-10-19T13:00:00.000Z');
  assert.equal(templateTimestamp(date), '20261019T130000Z');
  assert.equal(preMoveTemplateKey(date), 'migrations/166/pre-move-20261019T130000Z.template.json');
  assert.equal(templateObjectUrl('cdk-hnb659fds-assets-650880818323-ap-east-1', 'ap-east-1', preMoveTemplateKey(date)),
    'https://cdk-hnb659fds-assets-650880818323-ap-east-1.s3.ap-east-1.amazonaws.com/migrations/166/pre-move-20261019T130000Z.template.json');
  // Each key segment is encoded, `/` separators are kept.
  assert.equal(templateObjectUrl('anywear-bucket', 'ap-east-1', 'migrations/166/a b+c.template.json'),
    'https://anywear-bucket.s3.ap-east-1.amazonaws.com/migrations/166/a%20b%2Bc.template.json');
  for (const bucket of ['abc', 'anywear-template-bucket', 'a-b.c-d']) assert.equal(validateTemplateBucket(bucket), bucket);
  for (const bucket of ['', 'ab', 'A-BUCKET', '-bucket', 'bucket-', 'a..b', '192.168.0.1', `${'a'.repeat(64)}`, 42, null]) {
    assert.throws(() => validateTemplateBucket(bucket), /valid S3 bucket name/, JSON.stringify(bucket));
  }

  // Missing/empty/invalid bucket refuses before describe-stacks, upload or update.
  for (const bucket of [undefined, '', 'Invalid_Bucket']) {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return '{}'; };
    const options = { stage: 'pre-move', apply: true,
      'workload-template': fixturePath('workload-live.template.json'),
      'api-load-balancer-dns-name': origin, 'api-distribution-domain': distributionDomain,
      ...(bucket === undefined ? {} : { 'template-bucket': bucket }) };
    await assert.rejects(runStage(options, { run }), /valid S3 bucket name/);
    assert.deepEqual(calls, []);
  }
});

test('the pre-move apply refuses a missing distribution domain before any AWS call', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push([command, ...args]); return '{}'; };
  await assert.rejects(runStage({ stage: 'pre-move', apply: true,
    'workload-template': fixturePath('workload-live.template.json'),
    'api-load-balancer-dns-name': origin,
    'template-bucket': 'cdk-hnb659fds-assets-650880818323-ap-east-1' }, { run }),
  /--api-distribution-domain/);
  assert.deepEqual(calls, []);
});

test('the CLI parser requires values for --output and --template-bucket', () => {
  const parsed = parseArguments(['--stage', 'pre-move', '--output', 'plan.json',
    '--template-bucket', 'anywear-template-bucket', '--template-region', 'ap-east-1']);
  assert.equal(parsed.output, 'plan.json');
  assert.equal(parsed['template-bucket'], 'anywear-template-bucket');
  assert.equal(parsed['template-region'], 'ap-east-1');
  assert.throws(() => parseArguments(['--stage', 'pre-move', '--output']), /requires a value/);
  assert.throws(() => parseArguments(['--stage', 'pre-move', '--template-bucket']), /requires a value/);
});

test('the preview apply uploads both refactor templates and sends TemplateURL definitions', async () => {
  const expected = buildRefactorTemplates({ liveWorkload: preMovedWorkload(), liveBase: liveBase(), baseSynth: baseSynth() });
  const preview = cleanPreview();
  const bucket = 'cdk-hnb659fds-assets-650880818323-ap-east-1';
  const timestamp = '20261019T130000Z';
  const sourceKey = `migrations/166/preview-${timestamp}.template.json`;
  const targetKey = `migrations/166/preview-${timestamp}-base.template.json`;
  const sourceUrl = `https://${bucket}.s3.ap-east-1.amazonaws.com/${sourceKey}`;
  const targetUrl = `https://${bucket}.s3.ap-east-1.amazonaws.com/${targetKey}`;
  const calls = [];
  let inputFile;
  const uploads = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[1] === 'cp') {
      uploads.push({ file: args[2], object: args[3] });
      return '';
    }
    if (args[1] === 'create-stack-refactor') {
      assert.ok(args.includes('--cli-input-json'));
      const value = args[args.indexOf('--cli-input-json') + 1];
      assert.match(value, /^file:\/\//);
      inputFile = value.slice('file://'.length);
      return JSON.stringify({ StackRefactorId: 're-1111' });
    }
    if (args[1] === 'describe-stack-refactor') return JSON.stringify(preview.describe);
    if (args[1] === 'list-stack-refactor-actions') return JSON.stringify(preview.actions);
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  const result = await runStage({
    stage: 'preview', apply: true,
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
    'template-bucket': bucket, 'template-region': 'ap-east-1',
  }, { run, now: () => new Date('2026-10-19T13:00:00.000Z'),
    sleep: async () => { throw new Error('an AVAILABLE preview must not sleep'); } });
  assert.equal(result.applied, true);
  assert.equal(result.templateBucket, bucket);
  assert.equal(result.sourceTemplateKey, sourceKey);
  assert.equal(result.targetTemplateKey, targetKey);
  assert.equal(result.sourceTemplateUrl, sourceUrl);
  assert.equal(result.targetTemplateUrl, targetUrl);
  // Two uploads first, in source then target order, then create/describe/list.
  assert.deepEqual(calls.map((args) => args[1]),
    ['cp', 'cp', 'create-stack-refactor', 'describe-stack-refactor', 'list-stack-refactor-actions']);
  assert.deepEqual(uploads.map((upload) => upload.object), [`s3://${bucket}/${sourceKey}`, `s3://${bucket}/${targetKey}`]);
  assert.match(uploads[0].file, /workload-preview\.template\.json$/);
  assert.match(uploads[1].file, /base-preview\.template\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(uploads[0].file, 'utf8')), expected.source);
  assert.deepEqual(JSON.parse(readFileSync(uploads[1].file, 'utf8')), expected.target);
  assert.equal(calls[2][0], 'cloudformation');
  assert.equal(calls[2][1], 'create-stack-refactor');
  assert.ok(inputFile, 'the CLI input file was written');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  assert.equal(input.StackDefinitions.length, 2);
  assert.equal(input.StackDefinitions[0].StackName, WORKLOAD_STACK);
  assert.equal(input.StackDefinitions[1].StackName, BASE_STACK);
  assert.equal(input.StackDefinitions[0].TemplateURL, sourceUrl);
  assert.equal(input.StackDefinitions[1].TemplateURL, targetUrl);
  for (const definition of input.StackDefinitions) assert.equal(Object.hasOwn(definition, 'TemplateBody'), false);
  assert.deepEqual(input.ResourceMappings, expected.resourceMappings);
  assert.deepEqual(result.clean.clean, true);
});

test('the preview apply refuses a missing or invalid template bucket before any AWS call', async () => {
  for (const bucket of [undefined, '', 'Invalid_Bucket']) {
    const calls = [];
    const run = async (command, args) => { calls.push([command, ...args]); return '{}'; };
    const options = { stage: 'preview', apply: true,
      'workload-template': writeTemp(preMovedWorkload()),
      'base-template': fixturePath('base-live.template.json'),
      'base-synth-template': fixturePath('base-synth.template.json'),
      'distribution-type': fixturePath('distribution-type.json'),
      ...(bucket === undefined ? {} : { 'template-bucket': bucket }) };
    await assert.rejects(runStage(options, { run }), /valid S3 bucket name/);
    assert.deepEqual(calls, []);
  }
});

test('the preview polls CREATE_IN_PROGRESS to AVAILABLE before listing actions', async () => {
  const preview = cleanPreview();
  const calls = [];
  const sleeps = [];
  let describes = 0;
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[1] === 'cp') return '';
    if (args[1] === 'create-stack-refactor') return JSON.stringify({ StackRefactorId: 're-1111' });
    if (args[1] === 'describe-stack-refactor') {
      describes += 1;
      return JSON.stringify(describes === 1
        ? { ...preview.describe, Status: 'CREATE_IN_PROGRESS', ExecutionStatus: 'UNAVAILABLE', StatusReason: null }
        : preview.describe);
    }
    if (args[1] === 'list-stack-refactor-actions') return JSON.stringify(preview.actions);
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  const result = await runStage({ stage: 'preview', apply: true,
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
    'template-bucket': 'cdk-hnb659fds-assets-650880818323-ap-east-1', 'template-region': 'ap-east-1',
  }, { run, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(result.clean.clean, true);
  assert.deepEqual(calls.map((args) => args[1]),
    ['cp', 'cp', 'create-stack-refactor', 'describe-stack-refactor', 'describe-stack-refactor', 'list-stack-refactor-actions']);
  assert.equal(calls.filter((args) => args[1] === 'describe-stack-refactor').length, 2);
  assert.deepEqual(sleeps, [10_000]);
  // Actions are read only after the terminal describe.
  const describeIndexes = calls.map((args, index) => args[1] === 'describe-stack-refactor' ? index : -1).filter((index) => index >= 0);
  const listIndex = calls.findIndex((args) => args[1] === 'list-stack-refactor-actions');
  assert.ok(listIndex > describeIndexes.at(-1));
});

test('the preview refuses CREATE_FAILED without listing actions or sleeping', async () => {
  const calls = [];
  const sleeps = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[1] === 'cp') return '';
    if (args[1] === 'create-stack-refactor') return JSON.stringify({ StackRefactorId: 're-1111' });
    if (args[1] === 'describe-stack-refactor') {
      return JSON.stringify({ ...cleanPreview().describe, Status: 'CREATE_FAILED',
        ExecutionStatus: 'UNAVAILABLE', StatusReason: 'conflict' });
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  await assert.rejects(runStage({ stage: 'preview', apply: true,
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
    'template-bucket': 'cdk-hnb659fds-assets-650880818323-ap-east-1',
  }, { run, sleep: async (ms) => { sleeps.push(ms); } }), /Refactor preview ended CREATE_FAILED: conflict/);
  assert.deepEqual(sleeps, []);
  assert.equal(calls.some((args) => args[1] === 'list-stack-refactor-actions'), false);
});

test('the preview times out with a clear error and never lists actions', async () => {
  const calls = [];
  const sleeps = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[1] === 'cp') return '';
    if (args[1] === 'create-stack-refactor') return JSON.stringify({ StackRefactorId: 're-1111' });
    if (args[1] === 'describe-stack-refactor') {
      return JSON.stringify({ ...cleanPreview().describe, Status: 'CREATE_IN_PROGRESS',
        ExecutionStatus: 'UNAVAILABLE', StatusReason: null });
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  await assert.rejects(runStage({ stage: 'preview', apply: true,
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
    'template-bucket': 'cdk-hnb659fds-assets-650880818323-ap-east-1',
  }, { run, sleep: async (ms) => { sleeps.push(ms); } }),
  /did not reach CREATE_COMPLETE within 300 seconds \(last status CREATE_IN_PROGRESS\)/);
  assert.equal(calls.filter((args) => args[1] === 'describe-stack-refactor').length, 30);
  assert.equal(sleeps.length, 29);
  assert.equal(calls.some((args) => args[1] === 'list-stack-refactor-actions'), false);
});

test('the preview refuses CREATE_COMPLETE without AVAILABLE and never lists actions', async () => {
  const calls = [];
  const sleeps = [];
  const run = async (command, args) => {
    assert.equal(command, 'aws');
    calls.push([...args]);
    if (args[1] === 'cp') return '';
    if (args[1] === 'create-stack-refactor') return JSON.stringify({ StackRefactorId: 're-1111' });
    if (args[1] === 'describe-stack-refactor') {
      return JSON.stringify({ ...cleanPreview().describe, ExecutionStatus: 'UNAVAILABLE', StatusReason: 'validating' });
    }
    throw new Error(`Unexpected AWS call ${args.join(' ')}`);
  };
  await assert.rejects(runStage({ stage: 'preview', apply: true,
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
    'template-bucket': 'cdk-hnb659fds-assets-650880818323-ap-east-1',
  }, { run, sleep: async (ms) => { sleeps.push(ms); } }),
  /Refactor preview CREATE_COMPLETE is not AVAILABLE: UNAVAILABLE \(validating\)/);
  assert.deepEqual(sleeps, []);
  assert.equal(calls.some((args) => args[1] === 'list-stack-refactor-actions'), false);
});

test('every stage defaults to validation-only and never calls AWS without --apply', async () => {
  const failIfCalled = async () => { throw new Error('AWS was called in a validation-only run'); };
  const preMove = await runStage({ stage: 'pre-move', 'workload-template': fixturePath('workload-live.template.json'),
    'api-load-balancer-dns-name': origin, 'api-distribution-domain': distributionDomain }, { run: failIfCalled });
  assert.equal(preMove.applied, false);

  const preview = await runStage({
    stage: 'preview',
    // Stage (b) reads the live Workload template after stage (a) has applied the
    // literal-origin update, so the validation-only fixture carries that shape.
    'workload-template': writeTemp(preMovedWorkload()),
    'base-template': fixturePath('base-live.template.json'),
    'base-synth-template': fixturePath('base-synth.template.json'),
    'distribution-type': fixturePath('distribution-type.json'),
  }, { run: failIfCalled });
  assert.equal(preview.applied, false);
  assert.equal(preview.resourceMappings.length, 1);

  const execute = await runStage({
    stage: 'execute',
    describe: writeTemp(cleanPreview().describe),
    actions: writeTemp(cleanPreview().actions),
    'resource-mappings': writeTemp(cleanPreview().resourceMappings),
  }, { run: failIfCalled });
  assert.equal(execute.applied, false);
  assert.equal(execute.clean.clean, true);
});

function fixturePath(name) {
  return fileURLToPath(new URL(`../../test/fixtures/beta-split/${name}`, import.meta.url));
}
function writeTemp(value) {
  const directory = mkdtempSync(path.join(tmpdir(), 'anywear-beta-split-test-'));
  const file = path.join(directory, 'value.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}
