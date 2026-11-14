import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTemplates } from '../../scripts/lib/compare-templates.mjs';

// A miniature stage-base template. The comparator is generic; the allowances are
// keyed by stack name and identity phase.
const base = () => ({
  Parameters: { BetaApiSizingProfile: { Type: 'String', Default: 's1' } },
  Conditions: { BetaApiS2: { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] } },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'x' } },
    PreSignUp: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'beta-anywear-pre-sign-up',
      Code: { S3Key: `${'a'.repeat(64)}.zip` } }, Metadata: { 'aws:asset:path': 'asset.old', 'aws:asset:is-bundled': 'true' } },
    Meta: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v1:count=1' } },
    Database: { Type: 'AWS::RDS::DBCluster', Properties: { DeletionProtection: false } },
    Repo: { Type: 'AWS::ECR::Repository', Properties: { RepositoryName: 'beta-anywear-service',
      LifecyclePolicy: { LifecyclePolicyText: JSON.stringify({ rules: [{ rulePriority: 1, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] }) } } },
    BetaE2EQualificationRoleABCD1234: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'beta-e2e-qualification-role' } },
  },
  Outputs: {
    Existing: { Value: 'x' },
    PublishOutputRefAnyWearVpcA8B15590: { Value: { Ref: 'AnyWearVpc' } },
  },
});
const options = (overrides = {}) => ({ phase: 'legacy', stage: 'beta', stackName: 'AnyWearPlatformStack-beta', ...overrides });

test('an unchanged template is accepted in every phase', () => {
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const report = compareTemplates(base(), base(), options({ phase }));
    assert.equal(report.accepted, true); assert.deepEqual(report.rejected, []);
  }
});

test('a removed weak cross-stack output is rejected: the baselines are re-recorded exact', () => {
  const after = base(); delete after.Outputs.PublishOutputRefAnyWearVpcA8B15590;
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    for (const stage of ['beta', 'prod']) {
      const report = compareTemplates(base(), after, options({ phase, stage, stackName: `AnyWearPlatformStack-${stage}` }));
      assert.equal(report.accepted, false, `${stage} ${phase}`);
      assert.deepEqual(report.rejected.map(entry => entry.path), ['/Outputs/PublishOutputRefAnyWearVpcA8B15590']);
    }
  }
  // A real output change is not a removal and still fails.
  const changed = base(); changed.Outputs.Existing = { Value: 'y' };
  assert.equal(compareTemplates(base(), changed, options()).accepted, false);
  // Removing any other output fails.
  const other = base(); delete other.Outputs.Existing;
  assert.equal(compareTemplates(base(), other, options()).accepted, false);
});

test('only the reviewed resource allowances pass', () => {
  const telemetry = base(); telemetry.Resources.Meta = { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:count=2' } };
  assert.equal(compareTemplates(base(), telemetry, options()).accepted, true);
  const lambda = base(); lambda.Resources.PreSignUp.Properties.Code.S3Key = `${'b'.repeat(64)}.zip`;
  lambda.Resources.PreSignUp.Metadata['aws:asset:path'] = 'asset.new';
  const lambdaReport = compareTemplates(base(), lambda, options());
  assert.equal(lambdaReport.accepted, true);
  assert.ok(lambdaReport.allowed.every(entry => entry.reason === 'Verified prebuilt Lambda asset location'));
  const retention = base();
  retention.Resources.Repo.Properties.LifecyclePolicy.LifecyclePolicyText = JSON.stringify({ rules: [
    { rulePriority: 1, selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'], countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } },
    { rulePriority: 2, selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 30 }, action: { type: 'expire' } }] });
  assert.equal(compareTemplates(base(), retention, options({ ecrImageRetention: true })).accepted, true);
  assert.equal(compareTemplates(base(), retention, options({ ecrImageRetention: false })).accepted, false);
  const recovery = base();
  recovery.Resources.Database.Properties = { BackupRetentionPeriod: 7, PreferredBackupWindow: '16:00-16:30', DeletionProtection: true };
  assert.equal(compareTemplates(base(), recovery, options()).accepted, true);
});

test('dedicated identity resources are allowed only outside the legacy phase', () => {
  const without = base(); delete without.Resources.BetaE2EQualificationRoleABCD1234;
  const added = base();
  const foundation = options({ phase: 'roles-added', stackName: 'AnyWearFoundationStack' });
  assert.equal(compareTemplates(without, added, foundation).accepted, true);
  const report = compareTemplates(without, added, foundation);
  assert.equal(report.allowed[0].reason, 'Dedicated Beta identity resource');
  assert.equal(compareTemplates(without, added, { ...foundation, phase: 'legacy' }).accepted, false);
});

test('only the #217 cleanup S3 and E2E CloudTrail statements are allowed on the dedicated identities', () => {
  const wardrobeObject = (prefix) => ({ 'Fn::Join': ['', [
    { 'Fn::GetAtt': ['AnyWearWardrobeBucketABCD1234', 'Arn'] }, `/${prefix}`]] });
  const wardrobeArn = { 'Fn::GetAtt': ['AnyWearWardrobeBucketABCD1234', 'Arn'] };
  const cleanupPolicy = () => ({
    Type: 'AWS::IAM::Policy',
    Properties: {
      PolicyName: 'CleanupTaskRoleDefaultPolicyABCD1234',
      Roles: [{ Ref: 'CleanupTaskRoleABCD1234' }],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Action: 's3:DeleteObject', Effect: 'Allow',
            Resource: [wardrobeObject('wearable-items/*'), wardrobeObject('base-photos/*'),
              wardrobeObject('outfit-generations/*'), wardrobeObject('task-attempts/vto/*')] },
          { Action: 's3:ListBucket', Effect: 'Allow', Resource: wardrobeArn,
            Condition: { StringLike: { 's3:prefix': ['wearable-items/*', 'base-photos/*',
              'outfit-generations/*', 'task-attempts/vto/*'] } } },
        ],
      },
    },
  });
  const e2ePolicy = (region = { Ref: 'AWS::Region' }) => ({
    Type: 'AWS::IAM::Policy',
    Properties: {
      PolicyName: 'DedicatedPolicy',
      Roles: ['beta-e2e-qualification-role'],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Action: 'cloudtrail:LookupEvents', Effect: 'Allow', Resource: '*',
          Condition: { StringEquals: { 'aws:RequestedRegion': region } } }],
      },
    },
  });
  const granted = () => {
    const after = base();
    after.Resources.CleanupTaskRoleDefaultPolicyABCD1234 = cleanupPolicy();
    after.Resources.E2EQualificationRoleDedicatedPolicyABCD1234 = e2ePolicy();
    return after;
  };
  const grantReasons = [
    'Issue #217: E2E qualification role reads CloudTrail AdminCreateUser events',
    "Issue #217: cleanup task role deletes captured users' S3 objects",
  ];
  for (const phase of ['roles-added', 'retired']) {
    const report = compareTemplates(base(), granted(), options({ phase }));
    assert.equal(report.accepted, true, phase);
    assert.deepEqual(report.allowed.map((entry) => entry.reason).filter((reason) => reason.startsWith('Issue #217')).sort(),
      [...grantReasons].sort());
    for (const reason of grantReasons) assert.equal(report.allowed.filter((entry) => entry.reason === reason).length, 1);
  }
  // The matrix synthesizes with a literal region; both renderings are the same bound.
  assert.equal(compareTemplates(base(), (() => {
    const after = granted();
    after.Resources.E2EQualificationRoleDedicatedPolicyABCD1234 = e2ePolicy('ap-east-1');
    return after;
  })(), options({ phase: 'roles-added' })).accepted, true);
  // `@aws-cdk/aws-iam:minimizePolicies` sorts the delete statement's resource
  // array and merges the CloudTrail grant into the pre-existing `Resource: '*'`
  // regional statement. Both are the same reviewed grant, not a wider one.
  const minimized = granted();
  minimized.Resources.CleanupTaskRoleDefaultPolicyABCD1234.Properties.PolicyDocument.Statement[0]
    .Resource = [wardrobeObject('base-photos/*'), wardrobeObject('outfit-generations/*'),
      wardrobeObject('task-attempts/vto/*'), wardrobeObject('wearable-items/*')];
  minimized.Resources.E2EQualificationRoleDedicatedPolicyABCD1234.Properties.PolicyDocument.Statement = [{
    Action: ['cloudtrail:LookupEvents', 'ecs:DeregisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
    Effect: 'Allow', Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } },
  }];
  const minimizedReport = compareTemplates(base(), minimized, options({ phase: 'roles-added' }));
  assert.equal(minimizedReport.accepted, true);
  assert.equal(minimizedReport.allowed
    .filter((entry) => entry.reason.startsWith('Issue #217')).length, 2);
  // Legacy carries neither identity, so neither grant may appear there.
  assert.equal(compareTemplates(base(), granted(), options()).accepted, false);

  const rejectedWith = (mutate, policyId) => {
    const after = granted();
    mutate(after);
    const report = compareTemplates(base(), after, options({ phase: 'roles-added' }));
    assert.equal(report.accepted, false);
    // The mutated policy loses its grant record and becomes a rejected difference;
    // a grant on the other policy is unaffected by this mutation.
    assert.ok(report.rejected.some((entry) => entry.path === `/Resources/${policyId}`));
    assert.equal(report.allowed.some((entry) => entry.path === `/Resources/${policyId}/Properties/PolicyDocument/Statement`), false);
  };
  const CLEANUP = 'CleanupTaskRoleDefaultPolicyABCD1234';
  const E2E = 'E2EQualificationRoleDedicatedPolicyABCD1234';
  // A delete on the bucket or on a prefix outside the four is not the reviewed
  // object scope.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[0].Resource[0] = wardrobeArn;
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[0].Resource[0] = wardrobeObject('task-attempts/*');
  }, CLEANUP);
  // A fifth resource widens the delete scope even when the four prefixes remain.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[0].Resource.push(wardrobeObject('avatar-renders/*'));
  }, CLEANUP);
  // The action is pinned: a versioned or family delete is a different grant.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[0].Action = 's3:DeleteObjectVersion';
  }, CLEANUP);
  // The list grant needs the four prefixes and nothing broader.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition.StringLike['s3:prefix'] = ['wearable-items/*'];
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition.StringLike['s3:prefix'] = ['wearable-items/*', 'base-photos/*', 'outfit-generations/*'];
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition.StringLike['s3:prefix'] = ['wearable-items/*', 'base-photos/*',
      'outfit-generations/*', 'task-attempts/legacy/*'];
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition.StringLike['s3:prefix'] = ['*'];
  }, CLEANUP);
  // The condition shape is pinned: another operator or an extra key is not this grant.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition = {
      StringEquals: { 's3:prefix': ['wearable-items/*', 'base-photos/*', 'outfit-generations/*', 'task-attempts/vto/*'] } };
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement[1].Condition.StringLike['aws:RequestedRegion'] = 'ap-east-1';
  }, CLEANUP);
  // A second S3 statement or a second CloudTrail action is not this grant.
  rejectedWith((after) => {
    after.Resources[CLEANUP].Properties.PolicyDocument.Statement.push(
      { Action: 's3:GetObject', Effect: 'Allow', Resource: wardrobeObject('*') });
  }, CLEANUP);
  rejectedWith((after) => {
    after.Resources[E2E].Properties.PolicyDocument.Statement
      .push({ Action: 'cloudtrail:StartLogging', Effect: 'Allow', Resource: '*' });
  }, E2E);
  // The CloudTrail read has no resource-level scope, so `*` without the region
  // bound (or naming a resource) is not the reviewed statement.
  rejectedWith((after) => {
    delete after.Resources[E2E].Properties.PolicyDocument.Statement[0].Condition;
  }, E2E);
  rejectedWith((after) => {
    after.Resources[E2E].Properties.PolicyDocument.Statement[0]
      .Resource = { 'Fn::GetAtt': ['BetaE2EQualificationRoleABCD1234', 'Arn'] };
  }, E2E);
  rejectedWith((after) => {
    after.Resources[E2E].Properties.PolicyDocument.Statement[0]
      .Action = ['cloudtrail:LookupEvents', 'cloudtrail:StartLogging'];
  }, E2E);
  // The same grants on a Production platform are not reviewed.
  assert.equal(compareTemplates(base(), granted(), options({ phase: 'roles-added',
    stackName: 'AnyWearPlatformStack-prod' })).accepted, false);
});

test('only the phase-dependent cleanup stage-contract parameter may be added outside legacy', () => {
  const parameter = {
    Type: 'AWS::SSM::Parameter',
    Properties: {
      Name: '/anywear/beta/cleanup_task_role_arn', Type: 'String',
      Value: { 'Fn::GetAtt': ['CleanupTaskRoleABCD1234', 'Arn'] },
      Description: 'AnyWear-Infra AnyWearRuntimeStack-beta stage contract: dedicated cleanup task role ARN',
    },
  };
  const added = base();
  added.Resources.StageContractCleanupTaskRoleArnParamABCD1234 = parameter;
  for (const phase of ['roles-added', 'retired']) {
    const report = compareTemplates(base(), added, options({ phase }));
    assert.equal(report.accepted, true, phase);
    assert.equal(report.allowed.length, 1);
    assert.equal(report.allowed[0].reason, 'Phase-dependent stage-contract cleanup task role parameter');
  }
  // Legacy publishes no cleanup role, so it must not add the parameter.
  assert.equal(compareTemplates(base(), added, options()).accepted, false);
  // Any other name, description, shape or stack is not the reviewed addition.
  const wrongName = structuredClone(added);
  wrongName.Resources.StageContractCleanupTaskRoleArnParamABCD1234.Properties.Name = '/anywear/beta/not_cleanup';
  assert.equal(compareTemplates(base(), wrongName, options({ phase: 'roles-added' })).accepted, false);
  const wrongDescription = structuredClone(added);
  wrongDescription.Resources.StageContractCleanupTaskRoleArnParamABCD1234.Properties.Description = 'stage contract: cleanup';
  assert.equal(compareTemplates(base(), wrongDescription, options({ phase: 'roles-added' })).accepted, false);
  const wrongShape = structuredClone(added);
  wrongShape.Resources.StageContractCleanupTaskRoleArnParamABCD1234.Properties.Overwrite = true;
  assert.equal(compareTemplates(base(), wrongShape, options({ phase: 'roles-added' })).accepted, false);
  const wrongId = structuredClone(added);
  wrongId.Resources.StageContractOtherParamABCD1234 = wrongId.Resources.StageContractCleanupTaskRoleArnParamABCD1234;
  delete wrongId.Resources.StageContractCleanupTaskRoleArnParamABCD1234;
  assert.equal(compareTemplates(base(), wrongId, options({ phase: 'roles-added' })).accepted, false);
  assert.equal(compareTemplates(base(), added, options({ phase: 'roles-added',
    stackName: 'AnyWearPlatformStack-prod' })).accepted, false);
});

test('the stage-contract description consumer rename is the only description delta allowed', () => {
  const before = base();
  before.Resources.VpcIdParam = {
    Type: 'AWS::SSM::Parameter',
    Properties: { Name: '/anywear/beta/vpc_id', Type: 'String', Value: 'vpc-0123456789abcdef0',
      Description: 'AnyWear-Service AnyWearRuntimeStack-beta stage contract: shared Beta VPC id' },
  };
  const after = structuredClone(before);
  after.Resources.VpcIdParam.Properties.Description =
    'AnyWear-Infra AnyWearRuntimeStack-beta stage contract: shared Beta VPC id';
  for (const phase of ['legacy', 'roles-added', 'retired']) {
    const report = compareTemplates(before, after, options({ phase }));
    assert.equal(report.accepted, true, phase);
    assert.deepEqual(report.allowed.map(entry => entry.path), ['/Resources/VpcIdParam/Properties/Description']);
    assert.equal(report.allowed[0].reason, 'Stage-contract parameter description consumer rename');
  }
  // A Name, Type or Value change on the same resource is still rejected.
  for (const [property, value] of [['Name', '/anywear/beta/other'], ['Type', 'StringList'], ['Value', 'vpc-other']]) {
    const changed = structuredClone(after);
    changed.Resources.VpcIdParam.Properties[property] = value;
    const report = compareTemplates(before, changed, options({ phase: 'legacy' }));
    assert.equal(report.accepted, false, property);
    assert.ok(report.rejected.some(entry => entry.path === `/Resources/VpcIdParam/Properties/${property}`), property);
  }
  // The allowance is exactly this rename: the pre-change baseline text, the
  // candidate text, a `/anywear/beta/` name and the Beta Base stack are required.
  const wrongBefore = structuredClone(before);
  wrongBefore.Resources.VpcIdParam.Properties.Description = 'stage contract: shared Beta VPC id';
  assert.equal(compareTemplates(wrongBefore, after, options()).accepted, false);
  const wrongAfter = structuredClone(after);
  wrongAfter.Resources.VpcIdParam.Properties.Description =
    'AnyWear-Infra stage contract: shared Beta VPC id';
  assert.equal(compareTemplates(before, wrongAfter, options()).accepted, false);
  const otherName = structuredClone(before);
  otherName.Resources.VpcIdParam.Properties.Name = '/somewhere/else/vpc_id';
  const otherNameAfter = structuredClone(after);
  otherNameAfter.Resources.VpcIdParam.Properties.Name = '/somewhere/else/vpc_id';
  assert.equal(compareTemplates(otherName, otherNameAfter, options()).accepted, false);
  assert.equal(compareTemplates(before, after, options({ stackName: 'AnyWearPlatformStack-prod' })).accepted, false);
});

test('any other resource or output change is rejected with its exact path', () => {
  const before = base(); const after = base();
  after.Resources.Bucket.Properties.BucketName = 'y';
  const report = compareTemplates(before, after, options());
  assert.equal(report.accepted, false);
  assert.deepEqual(report.rejected.map(entry => entry.path), ['/Resources/Bucket/Properties/BucketName']);
});

test('the release slice sizing, telemetry, cleanup and machine-auth allowances are gone', () => {
  const after = base();
  after.Resources.ApiService = { Type: 'AWS::ECS::Service', Properties: { ServiceName: 'beta-anywear-api', DesiredCount: 1 } };
  after.Conditions.BetaApiS2 = { 'Fn::Equals': [{ Ref: 'BetaApiSizingProfile' }, 's2-api'] };
  const report = compareTemplates({ ...base(), Resources: { ...base().Resources } }, after, options({ stackName: 'AnyWearWorkloadStack-beta' }));
  assert.equal(report.accepted, false);
  assert.ok(report.rejected.some(entry => entry.path === '/Resources/ApiService'));
});
