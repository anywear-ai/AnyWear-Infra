#!/usr/bin/env node
// Issue #166 one-time Beta stack migration: Platform/Workload -> Base/Egress/Runtime.
//
// This operation is NEVER automatic. It has three separately authorized stages:
//
//   (a) pre-move  — rewrite the live Workload distribution origin from a
//                   same-stack `Fn::GetAtt` to the literal ALB DNS name the stack
//                   already resolves, rewrite the cleanup verification task
//                   definition's `VERIFY_API_URL` to the literal distribution URL,
//                   and remove the distribution's `DependsOn` residue on
//                   resources that stay behind. This is a minimal in-place
//                   `update-stack` delta: the distribution ID and its
//                   `*.cloudfront.net` domain are preserved.
//   (b) preview   — read both live templates, build the Workload source and Base
//                   target, and call `create-stack-refactor`. Creation validates
//                   and produces the preview; it mutates no resource. Require
//                   exactly one MOVE and no CREATE/DELETE/UPDATE.
//   (c) execute   — only on a clean preview; execute the refactor, read the
//                   distribution ID/domain/status back, and leave deleting the
//                   old Workload stack as a separate explicit step.
//
// Without `--apply`, every stage only reads/validates/builds and prints the plan:
// the default mode executes nothing. The pure functions below are the reviewed
// contract and are unit-tested against recorded-shape fixtures; no test or
// validation-only run calls AWS.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { BASE_STACK } from './lib/deployment-contract.mjs';

export const API_DISTRIBUTION = Object.freeze(JSON.parse(
  readFileSync(new URL('../lib/api-distribution.json', import.meta.url), 'utf8')));
export const WORKLOAD_STACK = API_DISTRIBUTION.sourceStack;
export const SOURCE_LOGICAL_ID = API_DISTRIBUTION.sourceLogicalId;
export const DESTINATION_LOGICAL_ID = API_DISTRIBUTION.logicalId;
export const MOVED_OUTPUTS = Object.freeze(['ApiDistributionDomainName', 'ApiBaseUrl']);
export const REFACTOR_ACTION = Object.freeze({ action: 'MOVE', entity: 'RESOURCE', resourceType: 'AWS::CloudFront::Distribution' });
export const STAGES = Object.freeze(['pre-move', 'preview', 'execute']);
// `create-stack-refactor` returns CREATE_IN_PROGRESS; validation finishes later.
export const REFACTOR_PREVIEW_INTERVAL_MS = 10_000;
export const REFACTOR_PREVIEW_MAX_ATTEMPTS = 30;

const clone = value => structuredClone(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};
const same = (left, right, label) => {
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) throw new Error(`${label} differs`);
};
const differences = (before, after, at = '') => {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) => differences(before[index], after[index], `${at}/${index}`)).flat();
  }
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      differences(before[key], after[key], `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: at, before, after }];
};

const distributionResource = (template, logicalId, stack) => {
  const resource = template?.Resources?.[logicalId];
  if (!resource || resource.Type !== 'AWS::CloudFront::Distribution') {
    throw new Error(`${stack} does not contain the expected CloudFront distribution ${logicalId}`);
  }
  return resource;
};

const originDomainName = resource => resource?.Properties?.DistributionConfig?.Origins?.[0]?.DomainName;

const API_DISTRIBUTION_DOMAIN = /^[a-z0-9]+\.cloudfront\.net$/;
export function validateApiDistributionDomain(value) {
  if (typeof value !== 'string' || !API_DISTRIBUTION_DOMAIN.test(value)) {
    throw new Error('--api-distribution-domain must be a CloudFront domain such as d111111abcdef8.cloudfront.net (no scheme or path)');
  }
  return value;
}

// A moved distribution may not remain referenced anywhere in the refactor
// source outside its own resource and the two outputs removed with it. Stage A
// rewrites the one known `VERIFY_API_URL` reference; this guard fails closed for
// any other (or unrewritten) `Fn::GetAtt` before `create-stack-refactor`.
const distributionReferences = (value, at = '') => {
  if (Array.isArray(value)) return value.flatMap((item, index) => distributionReferences(item, `${at}/${index}`));
  if (value && typeof value === 'object') {
    if (Array.isArray(value['Fn::GetAtt']) && value['Fn::GetAtt'][0] === SOURCE_LOGICAL_ID) return [at];
    return Object.entries(value).flatMap(([key, child]) => distributionReferences(child, `${at}/${key}`));
  }
  return [];
};

// (a) The pre-move Workload update. The permitted changes are the first origin's
// `DomainName` (GetAtt -> live literal), the cleanup verification task
// definition's `VERIFY_API_URL` value (distribution GetAtt -> literal URL),
// removal of the distribution's `DependsOn` entries, and adding the `Retain`
// deletion/update-replacement attributes the Base-pinned destination carries.
// Outputs, parameters, conditions and every other resource stay byte-identical,
// so the stack keeps serving. The verify-URL rewrite is the option-1 plan bridge:
// without it the refactor source would keep a dangling reference after the
// distribution moves. Stage A may already be applied, so already-literal origin
// and verify values are accepted without a change; any other value still refuses.
export function preMoveWorkloadUpdate(liveWorkload, { apiLoadBalancerDnsName, apiDistributionDomain } = {}) {
  if (typeof apiLoadBalancerDnsName !== 'string' || !apiLoadBalancerDnsName) {
    throw new Error('The pre-move update requires the live ApiLoadBalancerDnsName value');
  }
  validateApiDistributionDomain(apiDistributionDomain);
  const source = clone(liveWorkload);
  const resource = distributionResource(source, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  const domain = originDomainName(resource);
  const getAtt = domain?.['Fn::GetAtt'];
  if (getAtt) {
    if (getAtt.length !== 2 || getAtt[1] !== 'DNSName') throw new Error('Unexpected live distribution origin reference');
    const target = source.Resources[getAtt[0]];
    if (target?.Type !== 'AWS::ElasticLoadBalancingV2::LoadBalancer') {
      throw new Error('The live distribution origin does not name a same-stack load balancer');
    }
    resource.Properties.DistributionConfig.Origins[0].DomainName = apiLoadBalancerDnsName;
  } else if (domain !== apiLoadBalancerDnsName) {
    throw new Error('The live distribution origin is neither the expected GetAtt nor the recorded literal ALB DNS name');
  }
  // The MOVE compares source and destination resource properties/attributes, so
  // the Workload distribution must carry the same Retain policies as the
  // Base-pinned destination. Absent attributes are added; an existing Retain is
  // left alone; any other value refuses.
  const retainPaths = [];
  for (const attribute of ['DeletionPolicy', 'UpdateReplacePolicy']) {
    if (resource[attribute] === undefined) {
      resource[attribute] = 'Retain';
      retainPaths.push(`/Resources/${SOURCE_LOGICAL_ID}/${attribute}`);
    } else if (resource[attribute] !== 'Retain') {
      throw new Error(`The live Workload distribution ${attribute} is ${resource[attribute]}, not Retain`);
    }
  }
  // Exactly one cleanup verification task definition and exactly one
  // VERIFY_API_URL entry; the live value must be the expected distribution
  // GetAtt or the already-rewritten literal URL.
  const verificationIds = Object.keys(source.Resources ?? {})
    .filter((id) => id.startsWith('CleanupOperationVerificationTaskDefinition'));
  if (verificationIds.length !== 1) {
    throw new Error('The pre-move update requires exactly one CleanupOperationVerificationTaskDefinition resource');
  }
  const verificationId = verificationIds[0];
  const verification = source.Resources[verificationId];
  if (verification.Type !== 'AWS::ECS::TaskDefinition') {
    throw new Error(`${verificationId} is not an ECS task definition`);
  }
  const environment = verification.Properties?.ContainerDefinitions?.[0]?.Environment;
  if (!Array.isArray(environment)) {
    throw new Error('The cleanup verification task definition has no first-container environment');
  }
  const entries = environment.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry?.Name === 'VERIFY_API_URL');
  if (entries.length !== 1) {
    throw new Error(`The cleanup verification task definition must have exactly one VERIFY_API_URL entry; got ${entries.length}`);
  }
  const [{ entry: verifyEntry, index: verifyIndex }] = entries;
  const parts = verifyEntry.Value?.['Fn::Join'];
  const expectedReference = { 'Fn::GetAtt': [SOURCE_LOGICAL_ID, 'DomainName'] };
  const literalVerifyUrl = `https://${apiDistributionDomain}`;
  const expectedJoin = Array.isArray(parts) && parts[0] === '' && Array.isArray(parts[1])
    && parts[1].length === 2 && parts[1][0] === 'https://'
    && JSON.stringify(canonical(parts[1][1])) === JSON.stringify(canonical(expectedReference));
  if (!expectedJoin && verifyEntry.Value !== literalVerifyUrl) {
    throw new Error('The live VERIFY_API_URL is neither the expected https:// + distribution GetAtt reference nor the recorded literal URL');
  }
  const previousVerifyValue = clone(verifyEntry.Value);
  if (expectedJoin) verifyEntry.Value = literalVerifyUrl;
  const removedDependsOn = [];
  if (resource.DependsOn !== undefined) {
    if (!Array.isArray(resource.DependsOn)) throw new Error('Unreviewed DependsOn shape on the live distribution');
    for (const dependency of resource.DependsOn) {
      if (!source.Resources[dependency]) throw new Error(`DependsOn names an unknown resource ${dependency}`);
      removedDependsOn.push(dependency);
    }
    delete resource.DependsOn;
  }
  // The moved outputs legitimately reference the distribution until the refactor,
  // so scan only the resources: any other remaining `Fn::GetAtt` would dangle
  // once the distribution moves. Refuse here, before the plan is returned.
  const resourceReferences = distributionReferences(source.Resources);
  if (resourceReferences.length) {
    throw new Error(`The pre-move Workload template still references ${SOURCE_LOGICAL_ID} outside the moved outputs at /Resources${resourceReferences[0]}`);
  }
  const verifyPath = `/Resources/${verificationId}/Properties/ContainerDefinitions/0/Environment/${verifyIndex}/Value`;
  const allowedPaths = [
    ...(getAtt ? [`/Resources/${SOURCE_LOGICAL_ID}/Properties/DistributionConfig/Origins/0/DomainName`] : []),
    ...(expectedJoin ? [verifyPath] : []),
    ...retainPaths,
    ...(removedDependsOn.length ? [`/Resources/${SOURCE_LOGICAL_ID}/DependsOn`] : []),
  ];
  const changes = differences(liveWorkload, source);
  const unexpected = changes.filter(change => !allowedPaths.includes(change.path));
  if (unexpected.length) throw new Error(`The pre-move update changed unexpected template paths: ${unexpected.map(change => change.path).join(', ')}`);
  // Outputs stay in the source until the refactor moves them.
  for (const output of MOVED_OUTPUTS) {
    if (!source.Outputs?.[output]) throw new Error(`The pre-move Workload template must keep its ${output} output`);
  }
  return { template: source, changes: changes.map(change => change.path), removedDependsOn,
    origin: { from: getAtt ? { 'Fn::GetAtt': getAtt } : domain, to: apiLoadBalancerDnsName },
    verifyUrl: { resource: verificationId, index: verifyIndex, from: previousVerifyValue, to: verifyEntry.Value },
    retained: retainPaths };
}

// The refactor is only eligible when every documented condition holds.
export function assertRefactorEligibility({ distributionType, workloadStackPolicy, baseStackPolicy, workloadTemplate }) {
  if (distributionType?.ProvisioningType !== 'FULLY_MUTABLE') {
    throw new Error(`AWS::CloudFront::Distribution is not FULLY_MUTABLE: ${distributionType?.ProvisioningType ?? 'unavailable'}`);
  }
  for (const [stack, policy] of [[WORKLOAD_STACK, workloadStackPolicy], [BASE_STACK, baseStackPolicy]]) {
    if (policy !== undefined && policy !== null) throw new Error(`Refactor is not allowed with a stack policy on ${stack}`);
  }
  const serialized = JSON.stringify(workloadTemplate);
  for (const pseudo of ['AWS::StackName', 'AWS::StackId']) {
    if (serialized.includes(pseudo)) throw new Error(`The Workload distribution references stack-varying pseudo parameter ${pseudo}`);
  }
  return true;
}

// Parameters, conditions, mappings and rules must not change in either refactor
// template relative to that stack's live template. CloudFormation rejects such a
// refactor, so the operation refuses before calling create-stack-refactor.
export function assertTemplateSurfaceUnchanged(live, refactored, stack) {
  for (const section of ['Parameters', 'Conditions', 'Mappings', 'Rules']) {
    same(live?.[section] ?? {}, refactored?.[section] ?? {}, `${stack} ${section}`);
  }
  return true;
}

// (b) Build the two refactor templates. The source is the live Workload template
// minus the distribution and its two outputs. The target is the live Base
// template plus exactly the distribution and outputs from Base's same-HEAD
// synthesis with `-c apiOriginDomainName=<live ALB DNS>`; never Base's full
// post-split synthesis, whose other changes belong to the next normal deploy.
export function buildRefactorTemplates({ liveWorkload, liveBase, baseSynth }) {
  const source = clone(liveWorkload);
  distributionResource(source, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  delete source.Resources[SOURCE_LOGICAL_ID];
  for (const output of MOVED_OUTPUTS) {
    if (!source.Outputs?.[output]) throw new Error(`The Workload template has no ${output} output to move`);
    delete source.Outputs[output];
  }
  if (Object.keys(source.Outputs ?? {}).length === 0) delete source.Outputs;
  const sourceChanges = differences(liveWorkload, source).map(change => change.path);
  const allowedSource = [`/Resources/${SOURCE_LOGICAL_ID}`, ...MOVED_OUTPUTS.map(output => `/Outputs/${output}`)];
  const unexpectedSource = sourceChanges.filter(change => !allowedSource.includes(change));
  if (unexpectedSource.length) throw new Error(`The refactor source changed unexpected paths: ${unexpectedSource.join(', ')}`);
  const remaining = distributionReferences(source);
  if (remaining.length) {
    throw new Error(`The refactor source still references ${SOURCE_LOGICAL_ID} outside the moved outputs at ${remaining[0]}`);
  }

  const movedDistribution = distributionResource(baseSynth, DESTINATION_LOGICAL_ID, `${BASE_STACK} synthesis`);
  const target = clone(liveBase);
  if (target.Resources?.[DESTINATION_LOGICAL_ID]) throw new Error(`${BASE_STACK} already contains ${DESTINATION_LOGICAL_ID}`);
  target.Resources[DESTINATION_LOGICAL_ID] = clone(movedDistribution);
  target.Outputs = { ...(target.Outputs ?? {}) };
  for (const output of MOVED_OUTPUTS) {
    const fromSynth = baseSynth.Outputs?.[output];
    if (!fromSynth) throw new Error(`${BASE_STACK} synthesis has no ${output} output to move`);
    target.Outputs[output] = clone(fromSynth);
  }
  const targetChanges = differences(liveBase, target).map(change => change.path);
  const allowedTarget = [`/Resources/${DESTINATION_LOGICAL_ID}`, ...MOVED_OUTPUTS.map(output => `/Outputs/${output}`)];
  const unexpectedTarget = targetChanges.filter(change => !allowedTarget.includes(change));
  if (unexpectedTarget.length) throw new Error(`The refactor target changed unexpected paths: ${unexpectedTarget.join(', ')}`);

  // The moved resource must carry the same configuration; only the destination
  // logical ID may differ. `UpdateReplacePolicy`/`DeletionPolicy` are resource
  // attributes, not configuration, and are asserted separately by synthesis.
  const liveDistribution = distributionResource(liveWorkload, SOURCE_LOGICAL_ID, WORKLOAD_STACK);
  same(liveDistribution.Type, movedDistribution.Type, 'Moved distribution type');
  same(liveDistribution.Properties, movedDistribution.Properties, 'Moved distribution configuration');

  assertTemplateSurfaceUnchanged(liveWorkload, source, WORKLOAD_STACK);
  assertTemplateSurfaceUnchanged(liveBase, target, BASE_STACK);
  return { source, target, sourceChanges, targetChanges,
    resourceMappings: [{
      Source: { StackName: WORKLOAD_STACK, LogicalResourceId: SOURCE_LOGICAL_ID },
      Destination: { StackName: BASE_STACK, LogicalResourceId: DESTINATION_LOGICAL_ID },
    }] };
}

// The migration mapping destination is the CDK constant Base pins, never a
// caller-chosen logical ID.
export function validateResourceMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length !== 1) throw new Error('Exactly one resource mapping is required');
  const [mapping] = mappings;
  same(mapping, {
    Source: { StackName: WORKLOAD_STACK, LogicalResourceId: SOURCE_LOGICAL_ID },
    Destination: { StackName: BASE_STACK, LogicalResourceId: DESTINATION_LOGICAL_ID },
  }, 'Resource mapping');
  if (mapping.Destination.LogicalResourceId !== API_DISTRIBUTION.logicalId) {
    throw new Error('The mapping destination is not the CDK-pinned distribution logical ID');
  }
  return mapping;
}

// The live action's `ResourceMapping` stack identifier is a full stack ARN, not a
// bare name: `arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`.
// Accept that exact shape (reviewed account/region, UUID suffix) or a bare stack
// name; a malformed or foreign ARN is refused rather than treated as a name.
const STACK_ARN = /^arn:aws:cloudformation:ap-east-1:650880818323:stack\/([A-Za-z0-9-]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const normalizeStackIdentifier = (value) => {
  if (typeof value !== 'string' || !value) throw new Error('Refactor preview stack identifier is missing');
  if (value.startsWith('arn:')) {
    const match = STACK_ARN.exec(value);
    if (!match) throw new Error(`Refactor preview stack ARN is malformed or foreign: ${value}`);
    return match[1];
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value)) throw new Error(`Refactor preview stack name is malformed: ${value}`);
  return value;
};

// (b) Validate the recorded preview. A clean preview is exactly one resource
// MOVE of the API distribution with no configuration change and no CREATE,
// DELETE or UPDATE. Anything else aborts before execution.
export function validateRefactorPreview({ describe, actions: previewActions, resourceMappings }) {
  if (!describe || typeof describe !== 'object') throw new Error('Refactor preview description is required');
  // `Status` is the lifecycle field on the live API; older recorded previews may
  // omit it, in which case `ExecutionStatus` remains the authoritative check.
  if (describe.Status !== undefined && describe.Status !== 'CREATE_COMPLETE') {
    throw new Error(`Refactor preview is not complete: ${describe.Status}`);
  }
  if (describe.ExecutionStatus !== 'AVAILABLE') throw new Error(`Refactor preview is not available: ${describe.ExecutionStatus ?? 'unavailable'}`);
  if (describe.StatusReason !== null && describe.StatusReason !== undefined) throw new Error('Refactor preview reports a status reason');
  if ((describe.UnsupportedResources ?? []).length) throw new Error('Refactor preview reports an unsupported resource');
  if ((describe.Conflicts ?? []).length) throw new Error('Refactor preview reports a conflict');
  const mapping = validateResourceMappings(resourceMappings);
  const list = previewActions?.StackRefactorActions;
  if (!Array.isArray(list) || list.length !== 1) {
    throw new Error(`Refactor preview must contain exactly one action; got ${Array.isArray(list) ? list.length : 'none'}`);
  }
  const [action] = list;
  if (action.Action !== REFACTOR_ACTION.action) throw new Error(`Refactor preview action ${action.Action} is not the single MOVE`);
  if (action.Entity !== REFACTOR_ACTION.entity) throw new Error('Refactor preview action is not a RESOURCE action');
  // The live action has no resource-type field; it identifies the moved resource
  // by physical ID and carries the explicit source/destination mapping.
  if (action.PhysicalResourceId !== API_DISTRIBUTION.physicalId) {
    throw new Error(`Refactor preview physical resource ${action.PhysicalResourceId ?? 'missing'} is not the reviewed distribution ${API_DISTRIBUTION.physicalId}`);
  }
  for (const side of ['Source', 'Destination']) {
    const observed = action.ResourceMapping?.[side];
    const expected = mapping[side];
    if (normalizeStackIdentifier(observed?.StackName) !== expected.StackName
      || observed?.LogicalResourceId !== expected.LogicalResourceId) {
      throw new Error(`Refactor preview ${side} mapping does not match ${expected.StackName}/${expected.LogicalResourceId}`);
    }
  }
  return { clean: true, action, mapping };
}

// (c) Post-execution readback: the same physical distribution must exist in the
// Base stack with its domain preserved and a `Deployed` status.
export function validateReadback({ before, after, distribution }) {
  if (!before?.PhysicalResourceId || !after?.PhysicalResourceId) throw new Error('Distribution physical ID unavailable before or after the move');
  if (before.PhysicalResourceId !== after.PhysicalResourceId) throw new Error('The moved distribution changed physical ID');
  if (after.StackName !== BASE_STACK) throw new Error('The moved distribution is not in the Base stack');
  if (distribution?.Status !== 'Deployed') throw new Error(`The moved distribution is not Deployed: ${distribution?.Status ?? 'unavailable'}`);
  if (distribution.Id !== before.PhysicalResourceId) throw new Error('CloudFront distribution ID differs after the move');
  return { physicalId: before.PhysicalResourceId, domain: distribution.DomainName, status: distribution.Status };
}

// The live Workload template has four parameters without defaults
// (`ServiceImageDigest`, `ServiceCommitSha`, `VlmConfigArn`,
// `CloudFrontPrefixListId`). An `update-stack` that omits `--parameters` fails
// them with "Parameters must have values", so the apply path never invents
// values: it reads the live stack's parameter keys and passes
// `UsePreviousValue=true` for each. A caller may supply the recorded
// `describe-stacks` JSON (or a plain array of keys) instead of the live read.
export function workloadParameterKeys(source) {
  const rows = Array.isArray(source) ? source : source?.Stacks?.[0]?.Parameters;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The pre-move update requires the live Workload stack parameters; none were returned');
  }
  const keys = rows.map((row) => (typeof row === 'string' ? row : row?.ParameterKey));
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9]+$/.test(key)) {
      throw new Error(`Invalid live Workload parameter key: ${JSON.stringify(key)}`);
    }
  }
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate live Workload parameter key');
  return keys;
}

export function workloadParameterArguments(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('The pre-move update requires at least one live Workload parameter key');
  }
  return keys.map((key) => `ParameterKey=${key},UsePreviousValue=true`);
}

// `update-stack --template-body` sends the template inline and CloudFormation
// caps `TemplateBody` at 51,200 bytes; the live Workload template is far larger,
// so the pre-move delta is uploaded to S3 and applied with `--template-url`
// (1 MB limit). The object is kept after the update as evidence.
const TEMPLATE_PREFIX = 'migrations/166';
export const DEFAULT_TEMPLATE_REGION = 'ap-east-1';
const S3_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IP_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const TEMPLATE_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

export function validateTemplateBucket(bucket) {
  if (typeof bucket !== 'string' || bucket.length < 3 || bucket.length > 63
    || !S3_BUCKET.test(bucket) || bucket.includes('..') || IP_LIKE.test(bucket)) {
    throw new Error('--template-bucket must be a valid S3 bucket name (3-63 lowercase letters, digits, dots or hyphens)');
  }
  return bucket;
}

export function validateTemplateRegion(region) {
  if (typeof region !== 'string' || !TEMPLATE_REGION.test(region)) {
    throw new Error('--template-region must be an AWS region such as ap-east-1');
  }
  return region;
}

// `20261019T130000Z` from a fixed Date, so the key is deterministic in tests.
export function templateTimestamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}T${iso.slice(11, 19).replaceAll(':', '')}Z`;
}

export function preMoveTemplateKey(date = new Date()) {
  return `${TEMPLATE_PREFIX}/pre-move-${templateTimestamp(date)}.template.json`;
}

// Encode each key segment but keep the `/` separators.
export function templateObjectUrl(bucket, region, key) {
  validateTemplateBucket(bucket);
  validateTemplateRegion(region);
  const encoded = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${encoded}`;
}

// CLI -----------------------------------------------------------------------
const OPTIONS = Object.freeze({
  '--stage': true, '--workload-template': true, '--base-template': true, '--base-synth-template': true,
  '--api-load-balancer-dns-name': true, '--api-distribution-domain': true,
  '--distribution-type': true, '--workload-stack-policy': true,
  '--base-stack-policy': true, '--describe': true, '--actions': true, '--resource-mappings': true,
  '--workload-parameters': true, '--template-bucket': true, '--template-region': true,
  '--output': true, '--apply': false,
});

export function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!Object.hasOwn(OPTIONS, name)) throw new Error(`Unknown migration argument ${name}`);
    if (OPTIONS[name] === false) { options[name.slice(2)] = true; continue; }
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value) throw new Error(`Migration argument ${name} requires a value`);
    options[name.slice(2)] = value;
    index += 1;
  }
  if (!STAGES.includes(options.stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  return options;
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const readOptionalJson = file => (file ? readJson(file) : undefined);

async function runAws(args, { run = defaultRun } = {}) {
  const stdout = await run('aws', args);
  return stdout.trim() ? JSON.parse(stdout) : {};
}

async function defaultRun(command, args) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(command, args, { maxBuffer: 10 * 1024 * 1024, timeout: 600_000 });
  return result.stdout;
}

// Runs one explicitly selected stage. Validation-only unless `--apply` is given.
// This is the only place that can call AWS, and it never does so implicitly.
export async function runStage(options, { run = defaultRun, now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const stage = options.stage;
  if (stage === 'pre-move') {
    const plan = preMoveWorkloadUpdate(readJson(options['workload-template']), {
      apiLoadBalancerDnsName: options['api-load-balancer-dns-name'],
      apiDistributionDomain: options['api-distribution-domain'],
    });
    if (!options.apply) return { stage, applied: false, ...plan };
    // Refuse an unusable template bucket before any AWS call (including the live
    // parameter read), so a typo cannot consume credentials or touch S3/CFN.
    const templateBucket = validateTemplateBucket(options['template-bucket']);
    const templateRegion = validateTemplateRegion(options['template-region']
      || process.env.AWS_REGION || DEFAULT_TEMPLATE_REGION);
    const templateKey = preMoveTemplateKey(now());
    const templateUrl = templateObjectUrl(templateBucket, templateRegion, templateKey);
    // Read the live parameter keys, then apply the delta with
    // `UsePreviousValue=true` for every one. Never synthesize a value: the sealed
    // Service release and reviewed constants stay exactly as the stack has them.
    const liveParameters = options['workload-parameters']
      ? readJson(options['workload-parameters'])
      : await runAws(['cloudformation', 'describe-stacks', '--stack-name', WORKLOAD_STACK], { run });
    const parameterKeys = workloadParameterKeys(liveParameters);
    // Write the delta locally, upload it, and apply it by URL. `TemplateBody` is
    // capped at 51,200 bytes and the live Workload template is much larger.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(path.join(tmpdir(), 'anywear-beta-split-'));
    const templateFile = path.join(directory, 'workload-pre-move.template.json');
    await writeFile(templateFile, `${JSON.stringify(plan.template, null, 2)}\n`);
    const object = `s3://${templateBucket}/${templateKey}`;
    try {
      await run('aws', ['s3', 'cp', templateFile, object]);
    } catch (error) {
      throw new Error(`Pre-move template upload to ${object} failed; nothing was updated`, { cause: error });
    }
    await runAws(['cloudformation', 'update-stack', '--stack-name', WORKLOAD_STACK,
      '--template-url', templateUrl, '--capabilities', 'CAPABILITY_NAMED_IAM',
      '--parameters', ...workloadParameterArguments(parameterKeys)], { run });
    await runAws(['cloudformation', 'wait', 'stack-update-complete', '--stack-name', WORKLOAD_STACK], { run });
    return { stage, applied: true, changes: plan.changes, removedDependsOn: plan.removedDependsOn,
      parameters: parameterKeys, templateBucket, templateKey, templateUrl };
  }
  if (stage === 'preview') {
    const liveWorkload = readJson(options['workload-template']);
    const liveBase = readJson(options['base-template']);
    assertRefactorEligibility({ distributionType: readOptionalJson(options['distribution-type']),
      workloadStackPolicy: options['workload-stack-policy'] === undefined ? undefined : readOptionalJson(options['workload-stack-policy']),
      baseStackPolicy: options['base-stack-policy'] === undefined ? undefined : readOptionalJson(options['base-stack-policy']),
      workloadTemplate: liveWorkload });
    const templates = buildRefactorTemplates({ liveWorkload, liveBase,
      baseSynth: readJson(options['base-synth-template']) });
    validateResourceMappings(templates.resourceMappings);
    if (!options.apply) return { stage, applied: false, ...templates };
    // `StackDefinition.TemplateBody` is capped at 51,200 bytes as well, and the
    // serialized source/target are ~66 KB/~96 KB, so both definitions travel by
    // S3 URL (the `TemplateURL` field is only length-bounded at 5,120). Validate
    // the bucket/region before any AWS call; validation-only needs neither.
    const templateBucket = validateTemplateBucket(options['template-bucket']);
    const templateRegion = validateTemplateRegion(options['template-region']
      || process.env.AWS_REGION || DEFAULT_TEMPLATE_REGION);
    const timestamp = templateTimestamp(now());
    const sourceTemplateKey = `${TEMPLATE_PREFIX}/preview-${timestamp}.template.json`;
    const targetTemplateKey = `${TEMPLATE_PREFIX}/preview-${timestamp}-base.template.json`;
    const sourceTemplateUrl = templateObjectUrl(templateBucket, templateRegion, sourceTemplateKey);
    const targetTemplateUrl = templateObjectUrl(templateBucket, templateRegion, targetTemplateKey);
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const directory = await mkdtemp(path.join(tmpdir(), 'anywear-beta-split-'));
    const sourceFile = path.join(directory, 'workload-preview.template.json');
    const targetFile = path.join(directory, 'base-preview.template.json');
    await writeFile(sourceFile, `${JSON.stringify(templates.source, null, 2)}\n`);
    await writeFile(targetFile, `${JSON.stringify(templates.target, null, 2)}\n`);
    const upload = async (file, key) => {
      const object = `s3://${templateBucket}/${key}`;
      try {
        await run('aws', ['s3', 'cp', file, object]);
      } catch (error) {
        throw new Error(`Refactor template upload to ${object} failed; no refactor was created`, { cause: error });
      }
    };
    await upload(sourceFile, sourceTemplateKey);
    await upload(targetFile, targetTemplateKey);
    const input = {
      StackDefinitions: [
        { StackName: WORKLOAD_STACK, TemplateURL: sourceTemplateUrl },
        { StackName: BASE_STACK, TemplateURL: targetTemplateUrl },
      ],
      ResourceMappings: templates.resourceMappings,
    };
    const inputFile = path.join(directory, 'create-stack-refactor.json');
    await writeFile(inputFile, `${JSON.stringify(input)}\n`);
    const created = await runAws(['cloudformation', 'create-stack-refactor', '--cli-input-json', `file://${inputFile}`], { run });
    // Poll the asynchronous preview to a terminal state before reading actions.
    // Only AVAILABLE is success; CREATE_FAILED (or any other status) and the
    // bounded timeout refuse before the execute path.
    let describe;
    for (let attempt = 1; attempt <= REFACTOR_PREVIEW_MAX_ATTEMPTS; attempt += 1) {
      describe = await runAws(['cloudformation', 'describe-stack-refactor',
        '--stack-refactor-id', created.StackRefactorId], { run });
      const status = describe.Status;
      if (status === 'CREATE_COMPLETE') {
        if (describe.ExecutionStatus !== 'AVAILABLE') {
          throw new Error(`Refactor preview CREATE_COMPLETE is not AVAILABLE: `
            + `${describe.ExecutionStatus ?? 'unavailable'}${describe.StatusReason ? ` (${describe.StatusReason})` : ''}`);
        }
        break;
      }
      if (status !== 'CREATE_IN_PROGRESS') {
        throw new Error(`Refactor preview ended ${status ?? 'unavailable'}: ${describe.StatusReason ?? 'no status reason'}`);
      }
      if (attempt === REFACTOR_PREVIEW_MAX_ATTEMPTS) {
        throw new Error(`Refactor preview did not reach CREATE_COMPLETE within `
          + `${(REFACTOR_PREVIEW_MAX_ATTEMPTS * REFACTOR_PREVIEW_INTERVAL_MS) / 1000} seconds `
          + `(last status ${status})`);
      }
      await sleep(REFACTOR_PREVIEW_INTERVAL_MS);
    }
    const preview = { describe,
    actions: await runAws(['cloudformation', 'list-stack-refactor-actions',
      '--stack-refactor-id', created.StackRefactorId], { run }) };
    const clean = validateRefactorPreview({ ...preview, resourceMappings: templates.resourceMappings });
    return { stage, applied: true, stackRefactorId: created.StackRefactorId, preview, clean,
      templateBucket, templateRegion, sourceTemplateKey, sourceTemplateUrl, targetTemplateKey, targetTemplateUrl };
  }
  // execute: re-validate the recorded preview before the separate execution call.
  const describe = readJson(options.describe);
  const previewActions = readJson(options.actions);
  const mappings = readJson(options['resource-mappings']);
  const clean = validateRefactorPreview({ describe, actions: previewActions, resourceMappings: mappings });
  if (!options.apply) return { stage, applied: false, clean };
  if (!describe.StackRefactorId) throw new Error('A recorded StackRefactorId is required to execute');
  await runAws(['cloudformation', 'execute-stack-refactor', '--stack-refactor-id', describe.StackRefactorId], { run });
  await runAws(['cloudformation', 'wait', 'stack-refactor-complete', '--stack-refactor-id', describe.StackRefactorId], { run });
  return { stage, applied: true, clean, stackRefactorId: describe.StackRefactorId,
    readback: 'Read the distribution physical ID/domain/Deployed status and both stacks before deleting the Workload stack' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const result = await runStage(options);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.output, output);
  }
  process.stdout.write(output);
}
