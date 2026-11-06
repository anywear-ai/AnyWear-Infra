import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_TARGETS } from './recovery-contract.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])]));
  return value;
}

function differences(before, after, at = '') {
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      differences(before[key], after[key], `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: at, before, after }];
}

const dedicatedRoleIds = new Map([['BetaInfraDeployRole', 'beta-infra-deploy-role'],
  ['BetaInfraRuntimeRole', 'beta-infra-runtime-role'], ['BetaServiceArtifactRole', 'beta-service-artifact-role'],
  ['BetaServiceDataRole', 'beta-service-data-role'], ['BetaClientPublishRole', 'beta-client-publish-role'],
  ['BetaE2EQualificationRole', 'beta-e2e-qualification-role']]);
const dedicatedPolicyIds = new Map([...dedicatedRoleIds].map(([id, name]) => [id.slice(4), name]));
function dedicatedResource(id, resource) {
  return (resource.Type === 'AWS::IAM::Role'
      && [...dedicatedRoleIds].some(([prefix, name]) => new RegExp(`^${prefix}[A-F0-9]{8}$`).test(id)
        && resource.Properties.RoleName === name))
    || (resource.Type === 'AWS::IAM::Policy'
      && ([...dedicatedRoleIds].some(([prefix]) => new RegExp(`^${prefix}DefaultPolicy[A-F0-9]{8}$`).test(id)
        && Array.isArray(resource.Properties.Roles) && resource.Properties.Roles.length === 1
        && typeof resource.Properties.Roles[0]?.Ref === 'string'
        && new RegExp(`^${prefix}[A-F0-9]{8}$`).test(resource.Properties.Roles[0].Ref))
        || [...dedicatedPolicyIds].some(([prefix, name]) => new RegExp(`^${prefix}DedicatedPolicy[A-F0-9]{8}$`).test(id)
          && JSON.stringify(resource.Properties.Roles) === JSON.stringify([name]))));
}

// The Runtime release slice's reviewed allowance. The recorded Runtime baseline
// is the legacy identity phase, where the fixed Beta cleanup operation does not
// exist; `roles-added`/`retired` add exactly that operation (#86): eight
// resources, its `cleanup_task_role_arn` SSM parameter and its state-machine
// output. Production synthesizes no cleanup operation, so prod phases must stay
// byte-identical.
const RUNTIME_STACK = /^AnyWearRuntimeStack-(?:beta|prod)$/;
// The exact #86 delta measured from the moved pre-change source: eight Beta-only
// resources, the phase-conditional `cleanup_task_role_arn` CfnParameter (which
// both stages read at a non-legacy phase) and two Beta state-machine outputs.
// The list is exhaustive on purpose: an extra resource is a rejected difference,
// not a broader pattern match.
const RUNTIME_CLEANUP_ALLOWANCE = Object.freeze({
  resources: Object.freeze([
    'CleanupOperationVerificationTaskDefinition2283B142',
    'CleanupOperationCleanupTaskDefinitionA07FB696',
    'CleanupOperationStateMachineRoleCA2603DB',
    'CleanupOperationStateMachineRoleDefaultPolicyB4112DAC',
    'CleanupOperationStateMachine7A35FF20',
    'CleanupOperationStateMachineVersionEE8B7AAD',
    'CleanupOperationE2EQualificationRolePolicyAnyWearRuntimeStackbetaCleanupOperationE2EQualificationRole31921AACEC4A9F4A',
    'CleanupOperationInfraRuntimeRolePolicyAnyWearRuntimeStackbetaCleanupOperationInfraRuntimeRole2BEFEE02EBF9968F',
  ]),
  parameter: /^SsmParameterValueanywear(?:beta|prod)cleanuptaskrolearnC96584B6F00A464EAD1953AFF4B05118Parameter$/,
  outputs: Object.freeze([
    'CleanupOperationCleanupStateMachineArn3993CAF0',
    'CleanupOperationCleanupStateMachineVersionArn18053210',
  ]),
});

// Issue #217 grants on two dedicated Beta identities. Both policies are new
// relative to the recorded legacy baseline, so the reviewed dedicated-identity
// allowances admit the whole policy. These predicates pin the permission surface
// those policies add to exactly the statements reviewed for #217, so a different
// action, resource, prefix or condition fails the comparison instead of riding
// the resource-level allowance. The cleanup role carries no other S3 statement
// and the E2E qualification policy no other CloudTrail statement.
const WARDROBE_BUCKET = /^AnyWearWardrobeBucket[A-F0-9]{8}$/;
const CLEANED_PREFIXES = Object.freeze(['wearable-items/*', 'base-photos/*']);
const statementActions = (statement) => [statement.Action].flat();
const statementKeys = (value, keys) => value !== null && typeof value === 'object'
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function wardrobeObjectPrefixArn(value, prefix) {
  const join = value?.['Fn::Join'];
  if (!Array.isArray(join) || join[0] !== '' || !Array.isArray(join[1]) || join[1].length !== 2) return false;
  const [bucket, suffix] = join[1];
  return WARDROBE_BUCKET.test(bucket?.['Fn::GetAtt']?.[0] ?? '') && bucket['Fn::GetAtt'][1] === 'Arn'
    && suffix === `/${prefix}`;
}
function wardrobeBucketArn(value) {
  return WARDROBE_BUCKET.test(value?.['Fn::GetAtt']?.[0] ?? '') && value['Fn::GetAtt'][1] === 'Arn';
}
// Exactly the two #217 statements: `s3:DeleteObject` on the two per-user prefix
// object ARNs and `s3:ListBucket` on the bucket ARN under the two-prefix
// `s3:prefix` condition. Anything else that touches S3 on this role returns
// `undefined` and stays a rejected difference.
function cleanupTaskRoleS3Grants(policy) {
  const statements = policy.Properties?.PolicyDocument?.Statement;
  if (!Array.isArray(statements)) return undefined;
  const s3 = statements.filter((statement) => statementActions(statement)
    .some((action) => typeof action === 'string' && action.startsWith('s3:')));
  if (s3.length !== 2) return undefined;
  const remove = s3.find((statement) => same(statementActions(statement), ['s3:DeleteObject']));
  const list = s3.find((statement) => same(statementActions(statement), ['s3:ListBucket']));
  if (!remove || !list) return undefined;
  // `minimizePolicies` sorts a statement's resource array, so compare the two
  // prefix ARNs as the exact set rather than in source order.
  if (!statementKeys(remove, ['Action', 'Effect', 'Resource']) || remove.Effect !== 'Allow'
    || !Array.isArray(remove.Resource) || remove.Resource.length !== CLEANED_PREFIXES.length
    || !CLEANED_PREFIXES.every((prefix) => remove.Resource.some((resource) => wardrobeObjectPrefixArn(resource, prefix)))) {
    return undefined;
  }
  if (!statementKeys(list, ['Action', 'Condition', 'Effect', 'Resource']) || list.Effect !== 'Allow'
    || !wardrobeBucketArn(list.Resource)
    || !statementKeys(list.Condition, ['StringLike'])
    || !same(list.Condition, { StringLike: { 's3:prefix': [...CLEANED_PREFIXES] } })) return undefined;
  return [remove, list];
}
// Exactly one read-only `cloudtrail:LookupEvents` statement on `*`, bound to the
// region the file already uses for the other regional reads. The grant has no
// resource-level scope, so the region condition is the bound; a second CloudTrail
// action, another resource or a missing condition returns `undefined`.
function cloudTrailLookupStatement(policy) {
  const statements = policy.Properties?.PolicyDocument?.Statement;
  if (!Array.isArray(statements)) return undefined;
  const cloudtrail = statements.filter((statement) => statementActions(statement)
    .some((action) => typeof action === 'string' && action.startsWith('cloudtrail:')));
  if (cloudtrail.length !== 1) return undefined;
  const [statement] = cloudtrail;
  // `minimizePolicies` merges statements with equal Effect/Resource/Condition,
  // so this grant may share its statement with the pre-existing regional reads.
  // The whole policy must still carry exactly this one CloudTrail action.
  const actions = statementActions(statement);
  if (!actions.every((action) => typeof action === 'string')
    || !same(actions.filter((action) => action.startsWith('cloudtrail:')), ['cloudtrail:LookupEvents'])) return undefined;
  if (!statementKeys(statement, ['Action', 'Condition', 'Effect', 'Resource'])) return undefined;
  const region = statement.Condition?.StringEquals?.['aws:RequestedRegion'];
  const regionBound = (typeof region === 'string' && region.length > 0)
    || same(region, { Ref: 'AWS::Region' });
  return statement.Effect === 'Allow' && statement.Resource === '*' && regionBound
    && same(statement.Condition, { StringEquals: { 'aws:RequestedRegion': region } }) ? statement : undefined;
}

// These are the complete extraction exceptions. Role additions/retirement are
// independently inspected; all application resources/outputs remain exact.
export function compareTemplates(before, after, { phase = 'legacy', stage, stackName, ecrImageRetention = false } = {}) {
  assert.ok(['legacy', 'roles-added', 'retired'].includes(phase), 'Unknown identity phase');
  const allowed = [];
  const rejected = [];
  const baseline = structuredClone(before);
  const candidate = structuredClone(after);
  for (const [id, resource] of Object.entries(candidate.Resources ?? {})) {
    const runtimeCleanupResource = RUNTIME_STACK.test(stackName) && phase !== 'legacy'
      && !baseline.Resources?.[id] && RUNTIME_CLEANUP_ALLOWANCE.resources.includes(id);
    if (runtimeCleanupResource) {
      allowed.push({ path: `/Resources/${id}`, reason: 'Issue #86 fixed Beta cleanup operation binding', after: resource });
      delete candidate.Resources[id];
      continue;
    }
    const cleanup = stackName === 'AnyWearPlatformStack-beta' && phase !== 'legacy' && !baseline.Resources?.[id]
      && ((/^CleanupTaskRole[A-F0-9]{8}$/.test(id) && resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task')
        || (/^CleanupTaskRoleDefaultPolicy[A-F0-9]{8}$/.test(id) && resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles?.length === 1 && /^CleanupTaskRole[A-F0-9]{8}$/.test(resource.Properties.Roles[0]?.Ref ?? '')));
    if (cleanup) {
      // Issue #217: the cleanup policy must carry exactly the reviewed S3 grant;
      // any other S3 surface on this role stays a rejected difference.
      const grants = resource.Type === 'AWS::IAM::Policy' ? cleanupTaskRoleS3Grants(resource) : true;
      if (grants) {
        allowed.push({ path: `/Resources/${id}`, reason: 'Dedicated Beta cleanup task identity', after: resource });
        if (Array.isArray(grants)) {
          allowed.push({ path: `/Resources/${id}/Properties/PolicyDocument/Statement`, after: grants,
            reason: 'Issue #217: cleanup task role deletes captured users\' S3 objects' });
        }
        delete candidate.Resources[id];
      }
      continue;
    }
    const e2eQualification = stackName === 'AnyWearPlatformStack-beta' && phase !== 'legacy'
      && !baseline.Resources?.[id] && resource.Type === 'AWS::IAM::Policy'
      && /^E2EQualificationRoleDedicatedPolicy[A-F0-9]{8}$/.test(id)
      && JSON.stringify(resource.Properties?.Roles) === JSON.stringify(['beta-e2e-qualification-role']);
    if (e2eQualification) {
      // Issue #217: the qualification policy must carry exactly the reviewed
      // read-only CloudTrail statement; any other CloudTrail surface is rejected.
      const grant = cloudTrailLookupStatement(resource);
      if (grant) {
        allowed.push({ path: `/Resources/${id}`, reason: 'Dedicated Beta identity resource', after: resource });
        allowed.push({ path: `/Resources/${id}/Properties/PolicyDocument/Statement`, after: [grant],
          reason: 'Issue #217: E2E qualification role reads CloudTrail AdminCreateUser events' });
        delete candidate.Resources[id];
      }
      continue;
    }
    const dedicatedStack = stackName === 'AnyWearFoundationStack'
      || (stackName === 'AnyWearPlatformStack-beta' && resource.Type === 'AWS::IAM::Policy');
    if (!baseline.Resources?.[id] && phase !== 'legacy' && dedicatedStack && dedicatedResource(id, resource)) {
      allowed.push({ path: `/Resources/${id}`, reason: 'Dedicated Beta identity resource', after: resource });
      delete candidate.Resources[id];
    }
  }
  if (phase !== 'legacy' && stackName === 'AnyWearPlatformStack-beta' && !baseline.Outputs?.CleanupTaskRoleArn
    && /^CleanupTaskRole[A-F0-9]{8}$/.test(candidate.Outputs?.CleanupTaskRoleArn?.Value?.['Fn::GetAtt']?.[0] ?? '')
    && candidate.Outputs.CleanupTaskRoleArn.Value['Fn::GetAtt'][1] === 'Arn'
    && Object.keys(candidate.Outputs.CleanupTaskRoleArn).join(',') === 'Value') {
    allowed.push({ path: '/Outputs/CleanupTaskRoleArn', reason: 'Dedicated cleanup helper interface', after: candidate.Outputs.CleanupTaskRoleArn });
    delete candidate.Outputs.CleanupTaskRoleArn;
  }
  for (const difference of differences(baseline, candidate)) {
    const [, , id] = difference.path.split('/');
    // The Runtime cleanup allowance: the phase-conditional SSM parameter and the
    // state-machine output exist only where the cleanup operation exists.
    const runtimeCleanupContract = RUNTIME_STACK.test(stackName) && phase !== 'legacy'
      && ((difference.path === `/Parameters/${id}` && RUNTIME_CLEANUP_ALLOWANCE.parameter.test(id)
        && difference.before === undefined
        && typeof difference.after === 'object' && difference.after !== null
        && difference.after.Type === 'AWS::SSM::Parameter::Value<String>'
        && difference.after.Default === `/anywear/${stage}/cleanup_task_role_arn`)
        || (difference.path === `/Outputs/${id}` && RUNTIME_CLEANUP_ALLOWANCE.outputs.includes(id)
          && difference.before === undefined));
    if (runtimeCleanupContract) {
      allowed.push({ ...difference, reason: 'Issue #86 fixed Beta cleanup operation binding' });
      continue;
    }
    const resource = before.Resources?.[id];
    const functionName = resource?.Properties?.FunctionName;
    const lambda = ['dev', 'beta', 'prod'].includes(stage)
      && [`${stage}-anywear-pre-sign-up`, `${stage}-anywear-post-confirmation-sync`].includes(functionName)
      && resource.Type === 'AWS::Lambda::Function';
    const codeLocation = lambda && difference.path === `/Resources/${id}/Properties/Code/S3Key`
      && typeof difference.before === 'string' && typeof difference.after === 'string'
      && /^[a-f0-9]{64}\.zip$/.test(difference.before) && /^[a-f0-9]{64}\.zip$/.test(difference.after);
    const assetMetadata = lambda && ['/Metadata/aws:asset:path', '/Metadata/aws:asset:is-bundled']
      .some((suffix) => difference.path === `/Resources/${id}${suffix}`);
    const retirement = phase === 'retired' && stackName === 'AnyWearPlatformStack-beta' && resource
      && ((['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && JSON.stringify(resource.Properties.Roles) === JSON.stringify(['beta-github-actions-pipeline-role'])
        && difference.path === `/Resources/${id}` && difference.after === undefined));
    const expectedRetiredTrust = resource?.Type === 'AWS::IAM::Role'
      && resource.Properties.RoleName === 'beta-github-actions-pipeline-role'
      ? structuredClone(resource.Properties.AssumeRolePolicyDocument.Statement) : undefined;
    if (expectedRetiredTrust) expectedRetiredTrust[0].Condition.StringEquals['token.actions.githubusercontent.com:sub']
      = ['anywear:retired:beta-github-actions-pipeline-role'];
    const retiredFoundation = phase === 'retired' && stackName === 'AnyWearFoundationStack' && resource
      && ((resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-github-actions-pipeline-role'
        && difference.path === `/Resources/${id}/Properties/AssumeRolePolicyDocument/Statement`
        && JSON.stringify(canonical(difference.after)) === JSON.stringify(canonical(expectedRetiredTrust)))
        || (resource.Type === 'AWS::IAM::Policy' && /^betaGitHubActionsRoleDefaultPolicy[A-F0-9]{8}$/.test(id)
          && difference.path === `/Resources/${id}` && difference.after === undefined));
    let protectedRetention = false;
    if (ecrImageRetention && resource?.Type === 'AWS::ECR::Repository'
      && resource.Properties.RepositoryName === `${stage}-anywear-service`
      && difference.path === `/Resources/${id}/Properties/LifecyclePolicy/LifecyclePolicyText`) {
      const original = JSON.parse(difference.before);
      const expected = { rules: [{ rulePriority: 1,
        selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'],
          countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
      { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: stage === 'prod' ? 100 : 30 },
        action: { type: 'expire' } }] };
      protectedRetention = original.rules?.length === 1 && original.rules[0].rulePriority === 1
        && JSON.stringify(canonical(original.rules[0].selection)) === JSON.stringify(canonical(expected.rules[1].selection))
        && JSON.stringify(canonical(JSON.parse(difference.after))) === JSON.stringify(canonical(expected));
    }
    // Issue #161: only the reviewed database recovery delta on the Platform
    // cluster may pass, and only from the exact pre-change baseline value.
    const recoveryTarget = RECOVERY_TARGETS[stage];
    const recoveryDelta = recoveryTarget && stackName === recoveryTarget.stackName
      && resource?.Type === 'AWS::RDS::DBCluster' && (() => {
        const targets = {
          BackupRetentionPeriod: recoveryTarget.pitrRetentionDays,
          PreferredBackupWindow: recoveryTarget.preferredBackupWindow,
          DeletionProtection: recoveryTarget.deletionProtection,
        };
        const prefix = `/Resources/${id}/Properties/`;
        if (!difference.path.startsWith(prefix)) return false;
        const property = difference.path.slice(prefix.length);
        if (!Object.hasOwn(targets, property) || difference.after !== targets[property]) return false;
        const baseline = property === 'DeletionProtection' ? stage === 'prod' : undefined;
        return difference.before === baseline;
      })();
    // CDK analytics is diagnostic metadata rather than a cloud resource update.
    const telemetry = resource?.Type === 'AWS::CDK::Metadata'
      && difference.path === `/Resources/${id}/Properties/Analytics`;
    // The stage-contract extension publishes `cleanup_task_role_arn` only while
    // the identity phase creates the cleanup task role. The reviewed baseline is
    // the legacy synth, which has neither the role nor the parameter; both are
    // allowed together and only there. This is the single parameter allowance:
    // the other 34 stage-contract parameters are unconditional and exact.
    const cleanupContractParameter = phase !== 'legacy' && stackName === 'AnyWearPlatformStack-beta'
      && /^StageContractCleanupTaskRoleArnParam[A-F0-9]{8}$/.test(id)
      && difference.path === `/Resources/${id}` && difference.before === undefined
      && JSON.stringify(Object.keys(difference.after ?? {}).sort()) === JSON.stringify(['Properties', 'Type'])
      && difference.after.Type === 'AWS::SSM::Parameter'
      && JSON.stringify(Object.keys(difference.after.Properties ?? {}).sort())
        === JSON.stringify(['Description', 'Name', 'Type', 'Value'])
      && difference.after.Properties.Name === '/anywear/beta/cleanup_task_role_arn'
      && difference.after.Properties.Type === 'String'
      && typeof difference.after.Properties.Description === 'string'
      && difference.after.Properties.Description
        .startsWith('AnyWear-Infra AnyWearRuntimeStack-beta stage contract: ');
    // The stage-contract consumer rename (#201) changes only the
    // `Properties/Description` text of a published stage-contract parameter. The
    // baseline text is the pre-change deployed identity (`AnyWear-Service ...`);
    // the candidate text names the post-merge consumer (`AnyWear-Infra ...`). This
    // allowance accepts that description text only: a `Name`, `Type` or `Value`
    // change on the same resource is still rejected.
    const stageContractDescription = stackName === 'AnyWearPlatformStack-beta'
      && resource?.Type === 'AWS::SSM::Parameter'
      && typeof resource.Properties.Name === 'string'
      && resource.Properties.Name.startsWith('/anywear/beta/')
      && difference.path === `/Resources/${id}/Properties/Description`
      && typeof difference.before === 'string'
      && difference.before.startsWith('AnyWear-Service AnyWearRuntimeStack-beta stage contract: ')
      && typeof difference.after === 'string'
      && difference.after.startsWith('AnyWear-Infra AnyWearRuntimeStack-beta stage contract: ');
    if (codeLocation || assetMetadata || retirement || retiredFoundation || telemetry || protectedRetention
      || recoveryDelta || cleanupContractParameter || stageContractDescription) {
      allowed.push({ ...difference, reason: codeLocation || assetMetadata ? 'Verified prebuilt Lambda asset location'
        : retirement || retiredFoundation ? 'Reviewed old Beta identity retirement'
        : protectedRetention ? 'Explicit protected rollback retention activation'
          : recoveryDelta ? 'Issue #161 explicit database recovery targets'
            : stageContractDescription ? 'Stage-contract parameter description consumer rename'
              : 'Phase-dependent stage-contract cleanup task role parameter' });
    } else rejected.push(difference);
  }
  return { phase, stage, stackName, accepted: rejected.length === 0, allowed, rejected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [beforeFile, afterFile, phase = 'legacy', stage, outputFile] = process.argv.slice(2);
  assert.ok(beforeFile && afterFile, 'Usage: compare-templates.mjs BEFORE AFTER [PHASE STAGE OUTPUT]');
  const report = compareTemplates(JSON.parse(readFileSync(beforeFile, 'utf8')),
    JSON.parse(readFileSync(afterFile, 'utf8')), { phase, stage, stackName: path.basename(afterFile, '.template.json') });
  if (outputFile) writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.accepted) process.exitCode = 1;
}
