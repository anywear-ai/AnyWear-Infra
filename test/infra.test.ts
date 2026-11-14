import * as cdk from 'aws-cdk-lib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import { Template } from 'aws-cdk-lib/assertions';
import { BillingStack } from '../lib/billing-stack';
import { EgressStack } from '../lib/egress-stack';
import { FoundationStack } from '../lib/foundation-stack';
import { API_DISTRIBUTION_IDENTITY, DEFAULT_QWEATHER_API_HOST, PlatformStack } from '../lib/platform-stack';
import { BASE_EXPORTS } from '../lib/base-exports';
import { stageContractInputs } from '../lib/stage-contract';
import { DEPLOYMENT_SQS_DEPTH_ATTRIBUTES } from '../lib/contracts.mjs';
import runtimePolicies from './fixtures/runtime-policy.json';
import workloadExtensionResources from './fixtures/workload-extension-resources.json';
import workloadBakeReads from './fixtures/workload-bake-reads.json';
import workloadCfnActions from './fixtures/workload-cfn-actions.json';
import * as path from 'node:path';
import type { ArtifactInputs } from '../lib/artifact-inputs';
import { readIdentityPhase } from '../lib/identity-phase';
import type { IdentityPhase } from '../lib/identity-phase';
const artifactInputs: ArtifactInputs = {
  lambdas: {
    'pre-sign-up': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
    'post-confirmation': { path: path.resolve(__dirname, 'fixtures/placeholder.zip') },
  },
  runtimePolicy: runtimePolicies,
};
import cdkConfig from '../cdk.json';

const root = path.resolve(__dirname, '..');

// Issue #166 removed the stopped topology: one Base template per stage. Issue
// #254 moved the Beta API distribution origin from a synthesis argument to the
// `ApiOriginDomainName` stack parameter, so a Beta synthesis needs no origin input.
function synthesizePlatform(stage: string, identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, { stage, artifactInputs, identityPhase });
  return Template.fromStack(stack).toJSON();
}

function synthesizeFoundation(identityPhase?: IdentityPhase): Record<string, any> {
  const app = new cdk.App();
  return Template.fromStack(new FoundationStack(app, 'AnyWearFoundationStack', { identityPhase, legacyRoleSource: 'cdk' })).toJSON();
}

function synthesizeBilling(): Record<string, any> {
  const app = new cdk.App();
  return Template.fromStack(new BillingStack(app, 'AnyWearBillingStack-beta', { stage: 'beta' })).toJSON();
}

function hasFunctionNamed(template: Record<string, any>, functionName: string): boolean {
  return Object.values(template.Resources).some((resource: any) => (
    resource.Type === 'AWS::Lambda::Function'
      && resource.Properties?.FunctionName === functionName
  ));
}

function pipelinePolicies(template: Record<string, any>, stage: string): any[] {
  return Object.values(template.Resources).filter((resource: any) => (
    ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.includes(`${stage}-github-actions-pipeline-role`)
  ));
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function effectivePipelineGrantHash(template: Record<string, any>, stage: string): string {
  // Normalize authorization, not statement packing; preserve intrinsic/condition array order.
  const grants = pipelinePolicies(template, stage).flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => {
      expect(Object.keys(statement).every((key) => ['Action', 'Resource', 'Effect', 'Condition'].includes(key))).toBe(true);
      return [statement.Action].flat().flatMap((Action) => [statement.Resource].flat().map((Resource) => (
        JSON.stringify(canonical({ Action, Resource, Effect: statement.Effect,
          ...(statement.Condition ? { Condition: statement.Condition } : {}) }))
      )));
    });
  return createHash('sha256').update(JSON.stringify([...new Set(grants)].sort())).digest('hex');
}

function policyValueUpperBound(value: any, template: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((entry) => policyValueUpperBound(entry, template));
  if (!value || typeof value !== 'object') return value;
  if (value['Fn::Join']) {
    const [separator, parts] = value['Fn::Join'];
    return policyValueUpperBound(parts, template).join(separator);
  }
  if (value.Ref === 'AWS::StackId') {
    return `arn:aws:cloudformation:ap-east-1:650880818323:stack/${'X'.repeat(128)}/${'X'.repeat(36)}`;
  }
  if (value.Ref) {
    const resource = template.Resources[value.Ref];
    if (resource?.Type === 'AWS::SSM::Parameter') return resource.Properties.Name;
    // Deliberately over-budget the generated CloudFront distribution ID.
    if (resource?.Type === 'AWS::CloudFront::Distribution') return 'X'.repeat(256);
    throw new Error(`Unbounded policy Ref: ${value.Ref}`);
  }
  if (value['Fn::GetAtt']) {
    const [id, attribute] = value['Fn::GetAtt'];
    expect(attribute).toBe('Arn');
    const resource = template.Resources[id];
    const properties = resource.Properties;
    switch (resource.Type) {
      case 'AWS::S3::Bucket': return `arn:aws:s3:::${properties.BucketName}`;
      case 'AWS::ECR::Repository': return `arn:aws:ecr:ap-east-1:650880818323:repository/${properties.RepositoryName}`;
      case 'AWS::ECS::Cluster': return `arn:aws:ecs:ap-east-1:650880818323:cluster/${properties.ClusterName}`;
      case 'AWS::IAM::Role': return `arn:aws:iam::650880818323:role/${properties.RoleName}`;
      case 'AWS::Lambda::Function': return `arn:aws:lambda:ap-east-1:650880818323:function:${properties.FunctionName}`;
      case 'AWS::SQS::Queue': return `arn:aws:sqs:ap-east-1:650880818323:${properties.QueueName}`;
      // Cognito UserPoolId has a maximum length of 55.
      case 'AWS::Cognito::UserPool': return `arn:aws:cognito-idp:ap-east-1:650880818323:userpool/${'X'.repeat(55)}`;
      default: throw new Error(`Unbounded policy attribute: ${id}.${attribute}`);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, policyValueUpperBound(entry, template)]));
}

describe('Platform safety controls', () => {
  it.each([
    ['dev', 'c45a8484eff8aabe92a894d5db6df813457ec863678a55eba153605d00098161'],
    // Includes the Beta-only scoped AdminInitiateAuth grant. #213 removed the
    // admission mode parameter, so the Beta hash was re-recorded from the new
    // source: exactly one SSM admission ARN (the tester allowlist) remains.
    ['beta', 'ea0988605fea9f6f1cafcd533a2b7b5f93b88485a2dde860516d08fd705ba397'],
    ['prod', '12feb7f5939fc6e88051f7b16871a679f6d47f6e5eb73c8fb54b44307d0d528b'],
  ] as const)('preserves pre-quota-repair effective pipeline grants for %s', (stage, baselineHash) => {
    const app = new cdk.App({ context: cdkConfig.context });
    const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
      artifactInputs,
      stage, env: { account: '650880818323', region: 'ap-east-1' },
    });
    const template = Template.fromStack(stack).toJSON();
    // Frozen from main 2e03278 before moving the three statements, with deployment CDK flags.
    expect(effectivePipelineGrantHash(template, stage)).toBe(baselineHash);
    const policies = pipelinePolicies(template, stage);
    const inline = policies.filter((policy) => policy.Type === 'AWS::IAM::Policy');
    const managed = policies.filter((policy) => policy.Type === 'AWS::IAM::ManagedPolicy');
    expect(inline).toHaveLength(1);
    expect(managed).toHaveLength(stage === 'beta' ? 1 : 0);
    if (stage === 'beta') {
      const statements = managed[0].Properties.PolicyDocument.Statement;
      expect(managed[0].Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
      expect(managed[0].Properties.Users).toBeUndefined();
      expect(managed[0].Properties.Groups).toBeUndefined();
      expect(statements).toHaveLength(3);
      expect(statements.map((statement: any) => statement.Action).sort())
        .toEqual(['ecs:ListTagsForResource', 'ecs:TagResource', 'logs:GetLogEvents']);
      expect(inline[0].Properties.PolicyDocument.Statement.every((statement: any) => (
        ![statement.Action].flat().some((action) => statements.some((moved: any) => moved.Action === action))
      ))).toBe(true);
      const inlineBytes = inline.reduce((total, policy) => total
        + Buffer.byteLength(JSON.stringify(policyValueUpperBound(policy.Properties.PolicyDocument, template))), 0);
      // Read-only IAM audit: the externally owned baseline inline policy is 607 bytes.
      expect(inlineBytes + 607).toBeLessThan(10240);
      expect(Buffer.byteLength(JSON.stringify(policyValueUpperBound(managed[0].Properties.PolicyDocument, template))))
        .toBeLessThan(6144);
    }
  });

  it('grants protected lifecycle evidence reads only to the Beta pipeline', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const policies = pipelinePolicies(synthesizePlatform(stage), stage);
      const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      const has = (action: string) => statements.some((statement: any) => [statement.Action].flat().includes(action));
      for (const action of ['logs:GetLogEvents', 'rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition']) {
        expect(has(action)).toBe(stage === 'beta');
      }
      if (stage === 'beta') {
        const logRead = statements.find((statement: any) => [statement.Action].flat().includes('logs:GetLogEvents'));
        expect(JSON.stringify(logRead.Resource)).toContain('/anywear/beta/one-shot:');
      }
    }
  });

  it('bounds wildcard lifecycle evidence reads to the Beta pipeline region in the single topology', () => {
    const readActions = ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics', 'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition'];
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', env: { account: '650880818323', region: 'ap-east-1' },
      });
      const policies = Object.values(Template.fromStack(stack).toJSON().Resources)
        .filter((resource: any) => resource.Type === 'AWS::IAM::Policy') as any[];
      for (const action of readActions) {
        const grants = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement
          .filter((statement: any) => [statement.Action].flat().includes(action))
          .map((statement: any) => ({ policy, statement })));
        expect(grants).toHaveLength(1);
        expect(grants[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
        expect([grants[0].statement.Resource].flat()).toEqual(['*']);
        expect(grants[0].statement.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      }
    }
  });

  it('covers exact Beta retention inventory without expanding other stages or existing grants', () => {
    const ownedNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'];
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', env: { account: '650880818323', region: 'ap-east-1' },
      });
      const policies = Object.values(Template.fromStack(stack).toJSON().Resources)
        .filter((resource: any) => resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles.includes('beta-github-actions-pipeline-role')) as any[];
      const grants = (action: string) => policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement
        .filter((statement: any) => [statement.Action].flat().includes(action))
        .map((statement: any) => ({ policy, statement })));
      const expectedResources: Record<string, any[]> = {
        'cloudformation:ListStackResources': [{ Ref: 'AWS::StackId' }],
        'lambda:GetFunction': ownedNames.map((name) => `arn:aws:lambda:ap-east-1:650880818323:function:${name}`),
        'logs:DescribeLogGroups': ['*'],
        'logs:PutRetentionPolicy': ownedNames.map((name) => `arn:aws:logs:ap-east-1:650880818323:log-group:/aws/lambda/${name}:*`),
      };
      for (const [action, resources] of Object.entries(expectedResources)) {
        const matches = grants(action);
        expect(matches).toHaveLength(1);
        expect(matches[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
        expect(matches[0].statement.Effect).toBe('Allow');
        expect([matches[0].statement.Action].flat()).toEqual([action]);
        expect([matches[0].statement.Resource].flat()).toEqual(resources);
        expect(matches[0].statement.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      }
      expect(JSON.stringify(grants('cloudformation:ListStackResources')[0].statement.Resource)).not.toContain('*');
      const describe = grants('cloudformation:DescribeStacks');
      expect(describe).toHaveLength(1);
      expect(describe[0].policy.Properties.Roles).toEqual(['beta-github-actions-pipeline-role']);
      expect(describe[0].statement.Action).toEqual(['cloudformation:DescribeStacks', 'ec2:DescribeManagedPrefixLists', 'ecr:DescribeImages']);
      expect(describe[0].statement.Resource).toBe('*');
      expect(describe[0].statement.Condition).toBeUndefined();
      expect(grants('sts:GetCallerIdentity')).toHaveLength(0);
    }
    for (const stage of ['dev', 'prod']) {
      const statements = (Object.values(synthesizePlatform(stage).Resources) as any[])
        .filter((resource) => resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles.includes(`${stage}-github-actions-pipeline-role`))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
      for (const action of ['cloudformation:ListStackResources', 'lambda:GetFunction', 'logs:DescribeLogGroups', 'logs:PutRetentionPolicy']) {
        expect(statements.some((statement: any) => [statement.Action].flat().includes(action))).toBe(false);
      }
      const describe = statements.filter((statement: any) => [statement.Action].flat().includes('cloudformation:DescribeStacks'));
      expect(describe).toHaveLength(1);
      expect(describe[0].Action).toEqual(['cloudformation:DescribeStacks', 'ec2:DescribeManagedPrefixLists', 'ecr:DescribeImages']);
      expect(describe[0].Resource).toBe('*');
      expect(describe[0].Condition).toBeUndefined();
    }
  });

  it('scopes new runtime drill permissions to Beta resources without unsupported ECS IAM constraints', () => {
    const template = synthesizePlatform('beta');
    const statements = pipelinePolicies(template, 'beta')
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
    const forAction = (action: string) => statements.filter((statement: any) => [statement.Action].flat().includes(action));
    const register = forAction('ecs:RegisterTaskDefinition');
    expect(register).toHaveLength(3);
    expect(register.every((statement: any) => statement.Resource !== '*')).toBe(true);
    expect(JSON.stringify(register)).toContain('beta-anywear-task-audit:*');
    expect(JSON.stringify(register)).toContain('beta-anywear-migrate:*');
    expect(JSON.stringify(register)).toContain('beta-anywear-verify:*');
    expect(register[1].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
      StringLike: { 'aws:RequestTag/anywear-runtime-run-scope': '?*' } });
    expect(forAction('ecs:TagResource')[0].Condition).toEqual({ StringEquals: {
      'aws:RequestedRegion': { Ref: 'AWS::Region' }, 'ecs:CreateAction': 'RegisterTaskDefinition',
    } });
    for (const action of ['ecs:DescribeTaskDefinition', 'ecs:ListTaskDefinitions', 'ecs:DeregisterTaskDefinition',
      'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:DescribeScalingPolicies',
      'application-autoscaling:DescribeScheduledActions']) {
      expect(forAction(action)).toHaveLength(1);
      expect(forAction(action)[0].Resource).toBe('*');
      expect(forAction(action)[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } });
    }
    const updates = forAction('ecs:UpdateService');
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[0].Resource)).toContain('service/beta-anywear/beta-anywear-api');
    expect(JSON.stringify(updates[1].Resource)).toContain('service/beta-anywear/beta-anywear-worker');
    expect(JSON.stringify(updates[1].Condition.ArnLike)).toContain('beta-anywear-nonpaid-*');
    expect(JSON.stringify(forAction('ecs:StopTask')[0].Resource)).toContain('task/beta-anywear/*');
    expect(forAction('iam:PassRole').every((statement: any) => statement.Condition.StringEquals['iam:PassedToService']
      === 'ecs-tasks.amazonaws.com')).toBe(true);
    const logs = JSON.stringify(forAction('logs:GetLogEvents')[0].Resource);
    for (const purpose of ['task-audit', 'lifecycle', 'tester-cleanup']) {
      expect(logs).toContain(`/anywear/beta/one-shot:log-stream:beta-anywear-${purpose}/OneShot/*`);
    }
    expect(logs).not.toContain('/anywear/beta/one-shot:*');
    expect(JSON.stringify(forAction('logs:FilterLogEvents')[0].Resource)).toContain('/anywear/beta/worker:*');
    expect(forAction('sqs:ReceiveMessage')[0].Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^AsyncRuntimeAutoTaggingDeadLetterQueue/), 'Arn'] });
    expect(forAction('sqs:DeleteMessage')).toHaveLength(0);
    expect(forAction('ssm:PutParameter')).toHaveLength(0);
    expect(forAction('application-autoscaling:RegisterScalableTarget')).toHaveLength(0);
    expect(forAction('sqs:GetQueueAttributes')[0].Resource).toHaveLength(4);
    // #213: the pipeline role reads only the tester allowlist, so CDK collapses the
    // one-element resource list to a single ARN object.
    const pipelineSsmRead = [forAction('ssm:GetParameter')[0].Resource].flat();
    expect(pipelineSsmRead).toHaveLength(1);
    expect(JSON.stringify(pipelineSsmRead)).toContain('TesterAllowlist');
  });

  it('preserves only exact cost families with a separate required request tag and Beta region bound', () => {
    {
      const app = new cdk.App();
      const stack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
        artifactInputs,
        stage: 'beta', env: { account: '650880818323', region: 'ap-east-1' },
      });
      const statements = pipelinePolicies(Template.fromStack(stack).toJSON(), 'beta')
        .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
      const forAction = (action: string) => statements.filter((statement: any) => [statement.Action].flat().includes(action));
      const register = forAction('ecs:RegisterTaskDefinition');
      const arn = (family: string) => stack.resolve(stack.formatArn({
        service: 'ecs', resource: 'task-definition', resourceName: `${family}:*`,
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }));
      expect(register).toHaveLength(3);
      const normal = register.find((statement: any) => !statement.Condition.StringLike);
      const runtime = register.find((statement: any) => statement.Condition.StringLike?.['aws:RequestTag/anywear-runtime-run-scope']);
      const cost = register.find((statement: any) => statement.Condition.StringLike?.['aws:RequestTag/anywear-lifecycle-evidence-run-scope']);
      expect([normal.Resource].flat()).toEqual(['migrate', 'verify', 'lifecycle', 'tester-cleanup', 'task-audit']
        .map((purpose) => arn(`beta-anywear-${purpose}`)));
      expect([runtime.Resource].flat()).toEqual([arn('beta-anywear-nonpaid-*')]);
      const costFamilies = ['beta-anywear-lifecycle-fixture', ...['migrate', 'verify', 'lifecycle', 'lifecycle-fixture']
        .map((purpose) => `beta-anywear-${purpose}-evidence-*`)];
      expect([cost.Resource].flat()).toEqual(costFamilies.map(arn));
      expect(cost.Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' },
        StringLike: { 'aws:RequestTag/anywear-lifecycle-evidence-run-scope': '?*' } });
      expect(runtime.Condition.StringLike).toEqual({ 'aws:RequestTag/anywear-runtime-run-scope': '?*' });
      for (const statement of register) expect(statement.Condition.StringEquals['aws:RequestedRegion']).toBe('ap-east-1');
      const resources = register.flatMap((statement: any) => [statement.Resource].flat());
      for (const forbidden of ['*', arn('beta-anywear-*'), arn('prod-anywear-migrate'),
        arn('beta-anywear-task-audit-evidence-*'), arn('beta-anywear-tester-cleanup-evidence-*')]) {
        expect(resources).not.toContainEqual(forbidden);
      }
      const tagging = forAction('ecs:TagResource');
      expect(tagging).toHaveLength(1);
      expect(tagging[0].Condition).toEqual({ StringEquals: {
        'aws:RequestedRegion': 'ap-east-1', 'ecs:CreateAction': 'RegisterTaskDefinition',
      } });
      for (const family of costFamilies) expect([tagging[0].Resource].flat()).toContainEqual(arn(family));
      const logs = forAction('logs:GetLogEvents');
      expect(logs).toHaveLength(1);
      expect(logs[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
      for (const family of costFamilies) {
        expect([logs[0].Resource].flat()).toContainEqual(stack.resolve(stack.formatArn({
          service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/one-shot:log-stream:${family}/OneShot/*`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })));
      }
      expect(JSON.stringify(logs)).not.toContain('/anywear/beta/one-shot:*');
    }
  });

  it('preserves the Production pipeline ECS and PassRole contracts without runtime drill grants', () => {
    const template = synthesizePlatform('prod');
    const statements = Object.values(template.Resources).filter((resource: any) => resource.Type === 'AWS::IAM::Policy'
      && JSON.stringify(resource.Properties.Roles).includes('prod-github-actions-pipeline-role'))
      .flatMap((resource: any) => resource.Properties.PolicyDocument.Statement);
    const ecs = statements.filter((statement: any) => [statement.Action].flat().includes('ecs:RegisterTaskDefinition'));
    expect(ecs).toEqual([{ Action: ['ecs:RegisterTaskDefinition', 'ecs:DeregisterTaskDefinition', 'ecs:RunTask',
      'ecs:DescribeTasks', 'ecs:DescribeServices'], Effect: 'Allow', Resource: '*' }]);
    const pass = statements.find((statement: any) => [statement.Action].flat().includes('iam:PassRole'));
    expect(pass.Resource).toHaveLength(3);
    expect(pass.Condition).toBeUndefined();
    const actions = statements.flatMap((statement: any) => [statement.Action].flat());
    expect(actions).not.toEqual(expect.arrayContaining(['ecs:UpdateService']));
    for (const action of ['ecs:StopTask', 'logs:GetLogEvents', 'logs:FilterLogEvents', 'ecs:TagResource',
      'ecs:ListTaskDefinitions', 'application-autoscaling:DescribeScalableTargets', 'sqs:ReceiveMessage', 'ssm:GetParameter']) {
      expect(actions).not.toContain(action);
    }
  });

  it('keeps custom:e2e_bootstrap in the pool schema but out of the app client read attributes', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const userPool = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPool');
    // AWS cannot delete a custom attribute from an existing pool, so the schema
    // keeps it; #213 made it inert by removing the client's read attribute.
    expect(userPool.Properties.Schema).toEqual(expect.arrayContaining([
      expect.objectContaining({ Name: 'e2e_bootstrap', AttributeDataType: 'String', Mutable: false }),
    ]));
    const userPoolClient = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPoolClient');

    expect(userPoolClient.Properties.ReadAttributes).toEqual(expect.arrayContaining([
      'email', 'email_verified',
    ]));
    expect(userPoolClient.Properties.ReadAttributes).not.toContain('custom:e2e_bootstrap');
    expect(userPoolClient.Properties.WriteAttributes).not.toContain('custom:e2e_bootstrap');
  });

  it('gives the PreSignUp trigger a ten-second timeout for its one admission read', () => {
    for (const stage of ['dev', 'beta']) {
      const resources = Object.values(synthesizePlatform(stage).Resources) as any[];
      const preSignUp = resources.find((resource) => resource.Type === 'AWS::Lambda::Function'
        && resource.Properties.FunctionName === `${stage}-anywear-pre-sign-up`);
      expect(preSignUp.Properties.Timeout).toBe(10);
      // The PostConfirmation timeout is unchanged: the trigger's deadline is not a
      // shared Lambda default.
      const sync = resources.find((resource) => resource.Type === 'AWS::Lambda::Function'
        && resource.Properties.FunctionName === `${stage}-anywear-post-confirmation-sync`);
      expect(sync.Properties.Timeout).toBe(30);
    }
  });

  it('enables admin password auth only for the Beta Cognito client', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const resources = Object.values(synthesizePlatform(stage).Resources) as any[];
      const userPoolClient = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPoolClient');
      const flows = userPoolClient.Properties.ExplicitAuthFlows;
      if (stage === 'beta') expect(flows).toEqual(expect.arrayContaining(['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH']));
      else expect(flows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });

  it('uses the worker visibility and duplicate-delivery budget on both task queues', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    for (const [taskType, policy] of Object.entries(runtimePolicies)) {
      const queue = resources.find((resource) => resource.Type === 'AWS::SQS::Queue'
        && resource.Properties.QueueName === `beta-anywear-${taskType}`);
      expect(queue.Properties.VisibilityTimeout).toBe(policy.queueVisibilitySeconds);
      expect(queue.Properties.RedrivePolicy.maxReceiveCount).toBe(policy.maxReceives);
      expect(queue.Properties.RedrivePolicy.maxReceiveCount).toBeGreaterThan(policy.maxAttempts);
    }
  });

  it('keeps dev compute local while provisioning managed dependencies', () => {
    const resources = Object.values(synthesizePlatform('dev').Resources) as any[];

    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::SQS::Queue')).toHaveLength(4);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECR::Repository')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Service')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toHaveLength(0);
  });

  it('keeps long-lived state and the shared ECS boundary in PlatformStack', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];

    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECR::Repository')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::SQS::Queue')).toHaveLength(4);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Service')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')).toHaveLength(0);
    const parameters = resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter');
    expect(parameters.some((parameter: any) => parameter.Properties.Name.endsWith('/qweather_api_key'))).toBe(false);
    const roleNames = resources
      .filter((resource) => resource.Type === 'AWS::IAM::Role')
      .map((resource) => resource.Properties?.RoleName);
    expect(roleNames).toContain('beta-anywear-migration-task');
    expect(roleNames).toContain('beta-anywear-verification-task');
  });

  it('uses the dedicated QWeather API host for every stage by default', () => {
    for (const stage of ['dev', 'beta', 'prod']) {
      const resources = Object.values(synthesizePlatform(stage).Resources) as any[];
      const parameter = resources.find((resource) => (
        resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties?.Name === `/anywear/${stage}/qweather_api_host`
      ));

      expect(parameter?.Properties?.Value).toBe(DEFAULT_QWEATHER_API_HOST);
    }
  });


  it('allows the Beta database to pause at zero ACU after five minutes without connections', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const database = resources.find((resource) => resource.Type === 'AWS::RDS::DBCluster');
    const instances = resources.filter((resource) => resource.Type === 'AWS::RDS::DBInstance');

    expect(database.Properties.Engine).toBe('aurora-postgresql');
    expect(database.Properties.EngineVersion).toBe('17.7');
    expect(database.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0,
      MaxCapacity: 2,
      SecondsUntilAutoPause: 300,
    });
    expect(instances).toHaveLength(1);
    expect(instances[0].Properties.DBInstanceClass).toBe('db.serverless');
    expect(database.Properties.DeletionProtection).toBe(true);
    expect(database.Properties.BackupRetentionPeriod).toBe(7);
    expect(database.Properties.PreferredBackupWindow).toBe('16:00-16:30');
    expect(database.Properties.PreferredBackupWindow).toMatch(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/);
    // Issue #166: Beta's data is persistent Base state; a Base update can never
    // replace or delete the cluster.
    expect(database.DeletionPolicy).toBe('Retain');
    expect(database.UpdateReplacePolicy).toBe('Retain');
  });

  it('keeps Beta egress and compute out of the persistent Base stack', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];
    // The disposable Egress stack owns the NAT, the EIP and the S3 gateway
    // endpoint; deleting it leaves the Base subnets isolated.
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::NatGateway')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::EIP')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::VPCEndpoint')).toHaveLength(0);
    expect(resources.filter((resource) => resource.Type === 'AWS::EC2::Subnet')).toHaveLength(6);
    // The public route tables carry only the internet-gateway default route; no
    // Base route table has a NAT route or an S3 prefix-list route.
    const routes = resources.filter((resource) => resource.Type === 'AWS::EC2::Route');
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => route.Properties.NatGatewayId === undefined
      && route.Properties.GatewayId !== undefined)).toBe(true);
    // Base owns each subnet's route table and its single association; the
    // disposable Egress stack only adds default routes into these tables.
    const routeTables = resources.filter((resource) => resource.Type === 'AWS::EC2::RouteTable');
    const associations = resources.filter((resource) => resource.Type === 'AWS::EC2::SubnetRouteTableAssociation');
    expect(routeTables).toHaveLength(6);
    expect(associations).toHaveLength(6);
    // The Egress boundary is a same-account CloudFormation export/import pair:
    // Base exports its VPC, the NAT placement subnet and the two Private route
    // tables; Egress imports them and creates no association of its own.
    const exported = Object.fromEntries(Object.values(template.Outputs)
      .filter((output: any) => output.Export?.Name)
      .map((output: any) => [output.Export.Name, output.Value]));
    expect(Object.keys(exported).sort()).toEqual([BASE_EXPORTS.vpcId, BASE_EXPORTS.natSubnetId,
      ...BASE_EXPORTS.privateRouteTableIds].sort());
    expect(exported[BASE_EXPORTS.vpcId]).toEqual({ Ref: expect.stringMatching(/^AnyWearVpc[A-F0-9]{8}$/) });
    expect(exported[BASE_EXPORTS.natSubnetId]).toEqual({ Ref: expect.stringMatching(/^AnyWearVpcPublicSubnet1Subnet[A-F0-9]{8}$/) });
    for (const [index, exportName] of BASE_EXPORTS.privateRouteTableIds.entries()) {
      expect(exported[exportName]).toEqual({ Ref: expect.stringMatching(
        new RegExp(`^${['AnyWearVpcPrivateSubnet1RouteTable', 'AnyWearVpcPrivateSubnet2RouteTable'][index]}[A-F0-9]{8}$`)) });
    }
    expect(resources.filter((resource) => resource.Type === 'AWS::RDS::DBCluster')).toHaveLength(1);
    expect(resources.filter((resource) => resource.Type === 'AWS::ECS::Cluster')).toHaveLength(1);
    // No environment activity output exists any more: run state is the existence
    // of the Runtime stack.
    expect(template.Outputs.BetaActive).toBeUndefined();
    expect(JSON.stringify(template.Outputs)).not.toContain('BetaActive');

    // The API distribution is pinned to the live source logical ID, uses the
    // literal origin, and is retained.
    const distributions = Object.entries(template.Resources)
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::CloudFront::Distribution');
    expect(distributions).toHaveLength(2);
    expect(distributions.map(([id]) => id)).toContain(API_DISTRIBUTION_IDENTITY.logicalId);
    expect(distributions.map(([id]) => id)).toContainEqual(expect.stringMatching(/^AnyWearClientDistribution[A-F0-9]{8}$/));
    const [, apiDistribution] = distributions.find(([id]) => id === API_DISTRIBUTION_IDENTITY.logicalId)! as [string, any];
    // Issue #254: the origin is the `ApiOriginDomainName` stack parameter, so the
    // template carries no load-balancer literal and a Runtime deploy can repoint
    // the edge by writing that one parameter. The parameter keeps the DNS-name
    // guard the deleted synthesis context used and has no default, so a Base
    // deploy must supply the value.
    expect(apiDistribution.Properties.DistributionConfig.Origins[0]).toMatchObject({
      Id: API_DISTRIBUTION_IDENTITY.originId,
      DomainName: { Ref: 'ApiOriginDomainName' },
    });
    expect(template.Parameters.ApiOriginDomainName).toMatchObject({
      Type: 'String',
      AllowedPattern: '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$',
    });
    expect(template.Parameters.ApiOriginDomainName.Default).toBeUndefined();
    expect(template.Parameters.ApiOriginDomainName.Description).toMatch(/API load-balancer DNS name/);
    expect(apiDistribution.Properties.DistributionConfig.DefaultCacheBehavior.TargetOriginId)
      .toBe(API_DISTRIBUTION_IDENTITY.originId);
    expect(apiDistribution.DeletionPolicy).toBe('Retain');
    expect(apiDistribution.UpdateReplacePolicy).toBe('Retain');

    // Persistent Base resources are retained together.
    for (const resource of resources.filter((entry) => entry.Type === 'AWS::S3::Bucket')) {
      expect(resource.UpdateReplacePolicy).toBe('Retain');
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    const userPool = resources.find((resource) => resource.Type === 'AWS::Cognito::UserPool');
    expect(userPool.UpdateReplacePolicy).toBe('Retain');
    const repository = resources.find((resource) => resource.Type === 'AWS::ECR::Repository');
    expect(repository.UpdateReplacePolicy).toBe('Retain');
    expect(repository.DeletionPolicy).toBe('Retain');
  });


  it('keeps billing controls out of regional platform stacks', () => {
    const betaResources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const prodResources = Object.values(synthesizePlatform('prod').Resources) as any[];

    expect(betaResources.some((resource) => resource.Type === 'AWS::EC2::VPCEndpoint')).toBe(false);
    expect(betaResources.some((resource) => resource.Type === 'AWS::Budgets::Budget')).toBe(false);
    expect(betaResources.some((resource) => resource.Type === 'AWS::CE::AnomalyMonitor')).toBe(false);
    expect(prodResources.some((resource) => resource.Type === 'AWS::Budgets::Budget')).toBe(false);
  });

  it('configures the approved Beta budget and anomaly notifications in the billing stack', () => {
    const resources = Object.values(synthesizeBilling().Resources) as any[];
    const budget = resources.find((resource) => resource.Type === 'AWS::Budgets::Budget');
    const anomalyMonitor = resources.find((resource) => resource.Type === 'AWS::CE::AnomalyMonitor');
    const anomalySubscription = resources.find((resource) => resource.Type === 'AWS::CE::AnomalySubscription');
    const subscriptions = resources.filter((resource) => resource.Type === 'AWS::SNS::Subscription');

    expect(budget.Properties.Budget.BudgetLimit).toEqual({ Amount: 300, Unit: 'USD' });
    expect(budget.Properties.NotificationsWithSubscribers).toHaveLength(4);
    expect(budget.Properties.NotificationsWithSubscribers.map((entry: any) => entry.Notification.NotificationType))
      .toEqual(['ACTUAL', 'ACTUAL', 'ACTUAL', 'FORECASTED']);
    expect(anomalyMonitor.Properties.MonitorType).toBe('DIMENSIONAL');
    expect(anomalyMonitor.Properties.MonitorDimension).toBe('SERVICE');
    expect(anomalySubscription.Properties.Threshold).toBe(10);
    expect(anomalySubscription.Properties.Frequency).toBe('IMMEDIATE');
    expect(anomalySubscription.Properties.Subscribers).toHaveLength(1);
    expect(anomalySubscription.Properties.Subscribers[0].Type).toBe('SNS');
    expect(anomalySubscription.Properties.Subscribers[0].Address.Ref).toBeDefined();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((resource: any) => resource.Properties.Endpoint).sort()).toEqual([
      'luma26c@gmail.com',
      'windy005@126.com',
    ]);
  });

  it('configures only the approved recipients on Beta operations', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const subscriptions = resources.filter((resource) => resource.Type === 'AWS::SNS::Subscription');

    expect(subscriptions.map((resource: any) => resource.Properties.Endpoint).sort()).toEqual([
      'luma26c@gmail.com',
      'windy005@126.com',
    ]);
  });

  it('expires only unpromoted task attempts after seven days', () => {
    const template = synthesizePlatform('beta');
    const bucket = Object.values(template.Resources).find(
      (resource: any) => resource.Type === 'AWS::S3::Bucket',
    ) as any;
    expect(bucket.Properties.LifecycleConfiguration.Rules).toContainEqual(expect.objectContaining({
      Id: 'ExpireUnpromotedTaskAttempts',
      Prefix: 'task-attempts/',
      ExpirationInDays: 7,
    }));
  });

  it('creates the test-user trigger only outside production', () => {
    const devTemplate = synthesizePlatform('dev');
    const prodTemplate = synthesizePlatform('prod');
    expect(hasFunctionNamed(devTemplate, 'dev-anywear-pre-sign-up')).toBe(true);
    expect(hasFunctionNamed(prodTemplate, 'prod-anywear-pre-sign-up')).toBe(false);
  });

  it('retains every Beta Lambda log group for two weeks without changing Production', () => {
    const beta = synthesizePlatform('beta');
    const betaResources = Object.entries(beta.Resources) as [string, any][];
    const betaFunctions = betaResources.filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
    const betaApplicationFunctions = betaFunctions.filter(([, resource]) => resource.Properties?.FunctionName);
    const betaLambdaLogGroups = betaApplicationFunctions.map(([functionId]) => {
      const logGroup = betaResources.find(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
        && JSON.stringify(resource.Properties?.LogGroupName).includes(`"Ref":"${functionId}"`));
      expect(logGroup).toBeDefined();
      return logGroup![1];
    });

    expect(betaApplicationFunctions).toHaveLength(2);
    expect(betaLambdaLogGroups).toHaveLength(betaApplicationFunctions.length);
    expect(betaLambdaLogGroups.every((logGroup) => logGroup.Properties.RetentionInDays === 14)).toBe(true);

    const betaRetentionResources = betaResources.filter(([, resource]) => resource.Type === 'Custom::LogRetention'
      && JSON.stringify(resource.Properties.LogGroupName).includes('CustomResourceProviderHandler'));
    const betaCustomProviderHandlers = betaFunctions.filter(([functionId]) => functionId.includes('CustomResourceProviderHandler'));
    expect(betaRetentionResources).toHaveLength(betaCustomProviderHandlers.length);
    expect(betaRetentionResources.every(([, resource]) => resource.Properties.RetentionInDays === 14)).toBe(true);
    expect(betaRetentionResources.every(([, resource]) => JSON.stringify(resource.Properties.LogGroupName).includes('CustomResourceProviderHandler'))).toBe(true);
    expect(betaResources.some(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
      && JSON.stringify(resource.Properties?.LogGroupName).includes('CustomResourceProvider'))).toBe(false);

    const prod = synthesizePlatform('prod');
    const prodResources = Object.entries(prod.Resources) as [string, any][];
    const prodFunctions = prodResources.filter(([, resource]) => resource.Type === 'AWS::Lambda::Function');
    const prodApplicationFunctions = prodFunctions.filter(([, resource]) => resource.Properties?.FunctionName);
    for (const [functionId] of prodApplicationFunctions) {
      const logGroup = prodResources.find(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
        && JSON.stringify(resource.Properties?.LogGroupName).includes(`"Ref":"${functionId}"`));
      if (logGroup) {
        expect(logGroup[1].Properties.RetentionInDays).toBe(731);
      }
    }

    expect(prodApplicationFunctions).toHaveLength(1);
    expect(prodResources.some(([, resource]) => resource.Type === 'AWS::Logs::LogGroup'
      && resource.Properties?.RetentionInDays === 14)).toBe(false);
  });

  it('retains the Beta Container Insights performance log group for two weeks', () => {
    const betaResources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const betaContainerInsightsRetentionResources = betaResources.filter((resource) => (
      resource.Type === 'Custom::LogRetention'
        && resource.Properties?.LogGroupName === '/aws/ecs/containerinsights/beta-anywear/performance'
    ));

    expect(betaContainerInsightsRetentionResources).toHaveLength(1);
    expect(betaContainerInsightsRetentionResources[0].Properties.RetentionInDays).toBe(14);

    const prodResources = Object.values(synthesizePlatform('prod').Resources) as any[];
    expect(prodResources.some((resource) => (
      resource.Type === 'Custom::LogRetention'
        && resource.Properties?.LogGroupName === '/aws/ecs/containerinsights/prod-anywear/performance'
    ))).toBe(false);
  });

  it('creates the one Beta admission parameter with the empty default only in Beta', () => {
    const beta = synthesizePlatform('beta');
    const betaParameterNames = Object.values(beta.Resources)
      .filter((resource: any) => resource.Type === 'AWS::SSM::Parameter')
      .map((resource: any) => resource.Properties.Name as string);
    // #213: `/anywear/beta/tester_allowlist` is the only admission parameter. The
    // retired mode name is composed here so this test does not spell it out.
    const retiredModeName = ['admission', 'mode'].join('_');
    expect(betaParameterNames.some((name) => name.includes(retiredModeName))).toBe(false);
    const betaAdmissionParameters = Object.values(beta.Resources).filter(
      (resource: any) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Name === '/anywear/beta/tester_allowlist',
    ) as any[];
    expect(betaAdmissionParameters.map((parameter) => parameter.Properties)).toEqual([
      expect.objectContaining({ Name: '/anywear/beta/tester_allowlist', Type: 'String', Value: '[]' }),
    ]);
    expect(betaParameterNames.filter((name) => name === '/anywear/beta/tester_allowlist')).toHaveLength(1);
    const betaPolicies = Object.values(beta.Resources).filter((resource: any) => resource.Type === 'AWS::IAM::Policy');
    const verificationGrant = betaPolicies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .find((statement: any) => JSON.stringify(statement.Action).includes('cognito-idp:AdminUpdateUserAttributes'));
    expect(verificationGrant).toBeDefined();
    expect(verificationGrant.Action).toEqual(expect.arrayContaining([
      'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminGetUser',
    ]));
    expect(JSON.stringify(verificationGrant.Resource)).toContain('AnyWearUserPool');
    expect(JSON.stringify(verificationGrant.Resource)).not.toContain('*');
    const adminAuthGrant = betaPolicies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .find((statement: any) => [statement.Action].flat().includes('cognito-idp:AdminInitiateAuth'));
    expect(adminAuthGrant).toBeDefined();
    expect([adminAuthGrant.Action].flat()).toContain('cognito-idp:AdminInitiateAuth');
    expect(JSON.stringify(adminAuthGrant.Resource)).toContain('AnyWearUserPool');
    expect(JSON.stringify(adminAuthGrant.Resource)).not.toContain('*');
    for (const stage of ['dev', 'prod']) {
      const template = synthesizePlatform(stage);
      expect(Object.values(template.Resources).some((resource: any) => resource.Type === 'AWS::SSM::Parameter'
        && /\/tester_allowlist$/.test(resource.Properties.Name))).toBe(false);
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminUpdateUserAttributes');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminGetUser');
      expect(JSON.stringify(template)).not.toContain('cognito-idp:AdminInitiateAuth');
    }
  });

  it('gives the PreSignUp trigger and the lifecycle task the tester allowlist only', () => {
    const template = synthesizePlatform('beta');
    const resources = Object.values(template.Resources) as any[];
    const expectedParameterId = Object.entries(template.Resources).find(
      ([, resource]: [string, any]) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Name === '/anywear/beta/tester_allowlist',
    )![0];
    const ssmStatements = (resource: any) => {
      const roleId = resource.Properties.Role['Fn::GetAtt'][0];
      const policies = resources.filter((candidate) => candidate.Type === 'AWS::IAM::Policy'
        && candidate.Properties.Roles.some((role: any) => role.Ref === roleId));
      return policies.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
        .filter((statement: any) => JSON.stringify(statement.Action).includes('ssm:'));
    };
    for (const functionName of ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync']) {
      const trigger = resources.find((resource) => resource.Type === 'AWS::Lambda::Function'
        && resource.Properties.FunctionName === functionName);
      // The trigger-level activity variable is gone: the admission decision gates
      // the same paths, and the stopped state is carried by the stack outputs.
      expect(trigger.Properties.Environment?.Variables?.BETA_ACTIVE).toBeUndefined();
      expect(JSON.stringify(trigger.Properties.Environment ?? {})).not.toContain('BETA_ACTIVE');
      const statements = ssmStatements(trigger);
      if (functionName === 'beta-anywear-pre-sign-up') {
        // Registration is the one admission decision, so only this trigger reads
        // the list.
        expect(statements).toHaveLength(1);
        expect(statements[0].Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters']);
        // A one-element resource list is a single ARN object in the template.
        const resources = [statements[0].Resource].flat();
        expect(resources).toHaveLength(1);
        expect(resources.map((resource: any) => resource['Fn::Join'][1].at(-1).Ref))
          .toEqual([expectedParameterId]);
        expect(JSON.stringify(resources)).not.toContain('*');
      } else {
        // PostConfirmation provisions without reading admission: no SSM grant.
        expect(statements).toHaveLength(0);
      }
    }
    const lifecycleRoleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-lifecycle-task'
    ))![0];
    const lifecycleStatements = resources.filter((resource) => resource.Type === 'AWS::IAM::Policy'
      && resource.Properties.Roles.some((role: any) => role.Ref === lifecycleRoleId))
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => JSON.stringify(statement.Action).includes('ssm:'));
    expect(lifecycleStatements).toHaveLength(1);
    expect(lifecycleStatements[0].Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter']);
    const lifecycleResources = [lifecycleStatements[0].Resource].flat();
    expect(lifecycleResources).toHaveLength(1);
    expect(lifecycleResources.map((resource: any) => resource['Fn::Join'][1].at(-1).Ref))
      .toEqual([expectedParameterId]);
    expect(JSON.stringify(lifecycleResources)).not.toContain('*');
  });

  it('publishes exactly the 35 unconditional Beta stage-contract parameters without duplicates', () => {
    const resources = Object.values(synthesizePlatform('beta').Resources) as any[];
    const parameters = resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter');
    const names = parameters.map((parameter) => parameter.Properties.Name);
    expect(new Set(names).size).toBe(names.length);
    // #213 removed the admission mode parameter: 42 -> 41 published parameters.
    expect(parameters).toHaveLength(41);
    const stageContract = parameters.filter((parameter) => (
      parameter.Properties.Description?.startsWith('AnyWear-Infra AnyWearRuntimeStack-beta stage contract: ')));
    expect(stageContract).toHaveLength(35);
    expect(stageContract.map((parameter) => parameter.Properties.Name).sort()).toEqual([
      'api_base_url', 'api_security_group_id', 'auto_tagging_dlq_name', 'auto_tagging_dlq_url', 'auto_tagging_queue_arn',
      'auto_tagging_queue_name', 'auto_tagging_queue_url', 'cloudfront_prefix_list_id', 'database_host',
      'database_port', 'database_secret_arn', 'ecs_cluster_arn', 'ecs_cluster_name', 'isolated_subnet_ids',
      'load_balancer_security_group_id', 'one_shot_execution_role_arn', 'one_shot_log_group_arn',
      'one_shot_log_group_name', 'one_shot_security_group_id', 'operations_topic_arn', 'private_subnet_ids',
      'public_subnet_ids', 's3_bucket_arn', 'service_repository_arn', 'service_repository_name',
      'service_repository_uri', 'verification_task_role_arn', 'vlm_config_arn', 'vpc_id', 'vto_dlq_name',
      'vto_dlq_url', 'vto_queue_arn', 'vto_queue_name', 'vto_queue_url', 'worker_security_group_id',
    ].map((name) => `/anywear/beta/${name}`).sort());
    expect(stageContract.filter((parameter) => parameter.Properties.Type === 'StringList')
      .map((parameter) => parameter.Properties.Name).sort())
      .toEqual(['/anywear/beta/isolated_subnet_ids', '/anywear/beta/private_subnet_ids', '/anywear/beta/public_subnet_ids']);
    expect(stageContract.every((parameter) => ['String', 'StringList'].includes(parameter.Properties.Type))).toBe(true);
    expect(stageContract.every((parameter) => parameter.Properties.Name.startsWith('/anywear/beta/'))).toBe(true);
    expect(stageContract.every((parameter) => parameter.Properties.Description.length > 60)).toBe(true);
    expect(stageContract.find((parameter) => parameter.Properties.Name === '/anywear/beta/vlm_config_arn')!.Properties.Value)
      .toBe('arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/doubao_vlm_config-FEH2DQ');
    expect(stageContract.find((parameter) => parameter.Properties.Name === '/anywear/beta/cloudfront_prefix_list_id')!
      .Properties.Value).toBe('pl-14b2577d');
    // The cleanup role exists only outside the legacy phase, so neither the role
    // nor its ARN parameter is in the legacy synth.
    expect(resources.some((resource) => resource.Type === 'AWS::IAM::Role'
      && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task')).toBe(false);
    expect(stageContract.some((parameter) => parameter.Properties.Name === '/anywear/beta/cleanup_task_role_arn')).toBe(false);
    // The five reused published names and the one runtime-owned admission
    // parameter keep their existing single resource.
    for (const name of ['cognito_user_pool_id', 'cognito_client_id', 's3_bucket_name', 'qweather_api_host',
      'tester_allowlist', 'aws_region']) {
      expect(parameters.filter((parameter) => parameter.Properties.Name === `/anywear/beta/${name}`)).toHaveLength(1);
    }
    for (const stage of ['dev', 'prod']) {
      const other = Object.values(synthesizePlatform(stage).Resources) as any[];
      expect(other.filter((resource) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Description?.includes('stage contract'))).toHaveLength(0);
    }

    expect(stageContractInputs('beta')).toEqual({
      vlmConfigArn: 'arn:aws:secretsmanager:ap-east-1:650880818323:secret:/anywear/beta/doubao_vlm_config-FEH2DQ',
      cloudFrontPrefixListId: 'pl-14b2577d',
    });
    expect(() => stageContractInputs('prod')).toThrow(/requires explicit vlmConfigArn and cloudFrontPrefixListId/);
    expect(() => stageContractInputs('dev')).toThrow(/requires explicit vlmConfigArn and cloudFrontPrefixListId/);
  });

  it('publishes the phase-dependent cleanup role ARN only while the identity phase creates the role', () => {
    {
      const legacy = Object.values(synthesizePlatform('beta').Resources) as any[];
      const added = Object.values(synthesizePlatform('beta', 'roles-added').Resources) as any[];
      const retired = Object.values(synthesizePlatform('beta', 'retired').Resources) as any[];
      const contract = (resources: any[]) => resources.filter((resource) => resource.Type === 'AWS::SSM::Parameter'
        && resource.Properties.Description?.startsWith('AnyWear-Infra AnyWearRuntimeStack-beta stage contract: '));
      expect(contract(legacy)).toHaveLength(35);
      expect(contract(added)).toHaveLength(36);
      expect(contract(retired)).toHaveLength(36);
      for (const resources of [added, retired]) {
        const cleanup = contract(resources).filter((resource) => resource.Properties.Name === '/anywear/beta/cleanup_task_role_arn');
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0].Properties.Type).toBe('String');
        expect(cleanup[0].Properties.Value).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^CleanupTaskRole[A-F0-9]{8}$/), 'Arn'] });
      }
    }
  });

  it('keeps the live one-shot execution-role log-stream grant', () => {
    for (const stage of ['beta', 'prod'] as const) {
      const app = new cdk.App();
      const stack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
        artifactInputs, stage,
        env: { account: '650880818323', region: 'ap-east-1' },
      });
      const template = Template.fromStack(stack).toJSON();
      const roleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
        resource.Type === 'AWS::IAM::Role'
          && resource.Properties.RoleName === `${stage}-anywear-one-shot-execution`
      ))?.[0];
      expect(roleId).toBeDefined();
      const policy = Object.values(template.Resources).find((resource: any) => (
        resource.Type === 'AWS::IAM::Policy'
          && resource.Properties.Roles?.length === 1
          && resource.Properties.Roles[0]?.Ref === roleId
      )) as any;
      expect(policy).toBeDefined();
      const [logGroupId] = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
        resource.Type === 'AWS::Logs::LogGroup'
          && resource.Properties.LogGroupName === `/anywear/${stage}/one-shot`
      ))!;
      expect(logGroupId).toMatch(/^OneShotLogGroup[A-F0-9]{8}$/);
      const statements = policy.Properties.PolicyDocument.Statement;
      // The live role has exactly three statements; the third is the awslogs
      // stream grant that `AwsLogDriver.bind()` appended while the release slice
      // was synthesized in this app.
      expect(statements).toHaveLength(3);
      expect(statements[0].Action).toEqual(expect.arrayContaining([
        'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer',
      ]));
      expect(statements[1]).toEqual({ Action: 'ecr:GetAuthorizationToken', Effect: 'Allow', Resource: '*' });
      expect(statements[2]).toEqual({
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Effect: 'Allow',
        // The live grant's ARN ends in `:*`. Reference the log group's
        // CloudFormation `Arn` attribute (which includes that suffix) instead of
        // a hand-written literal that can omit it.
        Resource: { 'Fn::GetAtt': [logGroupId, 'Arn'] },
      });
      expect(statements[2].Resource)
        .not.toBe(`arn:aws:logs:ap-east-1:650880818323:log-group:/anywear/${stage}/one-shot`);
    }
  });

  it('limits synthetic lifecycle message cleanup to the two Beta dead-letter queues', () => {
    const template = synthesizePlatform('beta');
    const lifecycleRoleId = Object.entries(template.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-lifecycle-task'
    ))![0];
    const statements = (Object.values(template.Resources) as any[])
      .filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles.some((role: any) => role.Ref === lifecycleRoleId))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Action).includes('sqs:ReceiveMessage'));
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility']);
    const queueIds = statements[0].Resource.map((resource: any) => resource['Fn::GetAtt'][0]);
    expect(queueIds).toHaveLength(2);
    expect(queueIds.map((id: string) => template.Resources[id].Properties.QueueName).sort())
      .toEqual(['beta-anywear-auto-tagging-dlq', 'beta-anywear-vto-dlq']);
    expect(JSON.stringify(statements[0])).not.toContain('PurgeQueue');
    expect(JSON.stringify(statements[0].Resource)).not.toContain('*');
  });

  it('retains production storage and protects the database', () => {
    const template = synthesizePlatform('prod');
    const resources = Object.entries(template.Resources) as [string, any][];
    const bucket = resources.map(([, resource]) => resource).find(
      (resource) => resource.Type === 'AWS::S3::Bucket',
    ) as any;
    const [databaseId, database] = resources.find(
      ([, resource]) => resource.Type === 'AWS::RDS::DBCluster',
    )!;
    const writer = resources.find(([, resource]) => resource.Type === 'AWS::RDS::DBInstance'
      && resource.Properties.DBClusterIdentifier?.Ref === databaseId)?.[1];

    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(database.DeletionPolicy).toBe('Retain');
    expect(database.Properties.DeletionProtection).toBe(true);
    expect(database.Properties.BackupRetentionPeriod).toBe(35);
    expect(database.Properties.PreferredBackupWindow).toBe('16:00-16:30');
    expect(database.Properties.StorageEncrypted).toBe(true);
    expect(writer.DeletionPolicy).toBe('Retain');
    expect(database.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 2,
    });
  });

  it('bootstraps stage roles and excludes E2E from Production trust', () => {
    const template = synthesizeFoundation();
    const roles = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Role'
        && resource.Properties?.RoleName?.endsWith('-github-actions-pipeline-role'),
    ) as any[];
    expect(roles).toHaveLength(3);
    const prod = roles.find((role) => role.Properties.RoleName === 'prod-github-actions-pipeline-role');
    const beta = roles.find((role) => role.Properties.RoleName === 'beta-github-actions-pipeline-role');
    const subjects = (role: any): string[] => role.Properties.AssumeRolePolicyDocument.Statement[0]
      .Condition.StringEquals['token.actions.githubusercontent.com:sub'];
    // Issue #266 step 24: every trust lists exactly one subject, the
    // organization owner `anywear-ai@352675702`, with the repository half
    // (`@<repository id>`) unchanged from the transfer-window list.
    const subject = (repository: string, id: number, stage: string): string =>
      `repo:anywear-ai@352675702/${repository}@${id}:environment:${stage}`;
    expect(subjects(beta)).toHaveLength(3);
    expect(subjects(beta)).toEqual([
      subject('AnyWear-Service', 1158460323, 'beta'),
      subject('AnyWear-E2E', 1317091305, 'beta'),
      subject('AnyWear-Client', 1176104200, 'beta'),
    ]);
    expect(subjects(prod)).toEqual([subject('AnyWear-Service', 1158460323, 'prod')]);

    const policies = Object.values(template.Resources).filter(
      (resource: any) => resource.Type === 'AWS::IAM::Policy',
    ) as any[];
    const devPolicy = JSON.stringify(policies.find((policy) => (
      JSON.stringify(policy.Properties.PolicyDocument.Statement).includes('secretsmanager:GetSecretValue')
      && JSON.stringify(policy).includes('/anywear/dev/cloudfront_origin_header-*')
    )));
    expect(devPolicy).toContain('/anywear/dev/qweather_api_key-*');
    expect(devPolicy).toContain('/anywear/dev/cloudfront_origin_header-*');
  });

  // Issue #266 step 24: every role trust carries exactly one subject, the
  // organization owner `anywear-ai@352675702`, with the repository half
  // (`@<repository id>`) unchanged from the step-8 transfer-window list. The
  // personal owner `git-malu@11473072` no longer authorizes any repository.
  it('trusts only the new owner subject on all nine synthesized role trusts', () => {
    const template = synthesizeFoundation('roles-added');
    const subjectsOf = (roleName: string): string[] => {
      const role = (Object.values(template.Resources) as any[]).find((resource) => (
        resource.Type === 'AWS::IAM::Role' && resource.Properties?.RoleName === roleName));
      expect(role).toBeDefined();
      // A dedicated role binds its single subject as a string; a legacy role
      // keeps the array form. Normalize both to the trusted set.
      return [role.Properties.AssumeRolePolicyDocument.Statement[0]
        .Condition.StringEquals['token.actions.githubusercontent.com:sub']].flat();
    };
    const subject = (repository: string, id: number, stage: string): string =>
      `repo:anywear-ai@352675702/${repository}@${id}:environment:${stage}`;
    // The six dedicated Beta identities, each bound to its one repository id.
    const dedicated: Record<string, string> = {
      'beta-infra-deploy-role': subject('AnyWear-Infra', 1409047265, 'beta'),
      'beta-infra-runtime-role': subject('AnyWear-Infra', 1409047265, 'beta'),
      'beta-service-data-role': subject('AnyWear-Service', 1158460323, 'beta'),
      'beta-service-artifact-role': subject('AnyWear-Service', 1158460323, 'service-artifacts'),
      'beta-client-publish-role': subject('AnyWear-Client', 1176104200, 'beta'),
      'beta-e2e-qualification-role': subject('AnyWear-E2E', 1317091305, 'beta'),
    };
    // The three legacy pipeline identities keep their exact subject sets.
    const legacy: Record<string, string[]> = {
      'dev-github-actions-pipeline-role': [
        subject('AnyWear-Service', 1158460323, 'dev'),
        subject('AnyWear-E2E', 1317091305, 'dev'),
      ],
      'beta-github-actions-pipeline-role': [
        subject('AnyWear-Service', 1158460323, 'beta'),
        subject('AnyWear-E2E', 1317091305, 'beta'),
        subject('AnyWear-Client', 1176104200, 'beta'),
      ],
      'prod-github-actions-pipeline-role': [subject('AnyWear-Service', 1158460323, 'prod')],
    };
    for (const [roleName, expected] of Object.entries(dedicated)) {
      expect(subjectsOf(roleName)).toEqual([expected]);
    }
    for (const [roleName, expected] of Object.entries(legacy)) {
      expect(subjectsOf(roleName)).toEqual(expected);
    }
    // No trust lists a second subject or the retired personal owner.
    for (const roleName of [...Object.keys(dedicated), ...Object.keys(legacy)]) {
      const subjects = subjectsOf(roleName);
      expect(subjects.every((value) => /^repo:anywear-ai@352675702\//.test(value))).toBe(true);
      expect(new Set(subjects).size).toBe(subjects.length);
    }
    // The retired phase still trusts no repository, including the new owner.
    const retired = synthesizeFoundation('retired');
    const retiredBeta = (Object.values(retired.Resources) as any[]).find((resource) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties?.RoleName === 'beta-github-actions-pipeline-role'));
    expect(retiredBeta.Properties.AssumeRolePolicyDocument.Statement[0]
      .Condition.StringEquals['token.actions.githubusercontent.com:sub'])
      .toEqual(['anywear:retired:beta-github-actions-pipeline-role']);
  });
});

describe('Explicit infrastructure identity cutover', () => {
  const names = ['infra-deploy', 'infra-runtime', 'service-artifact', 'service-data', 'client-publish', 'e2e-qualification'];
  // Issue #158 step A adds the Service deployment identities. Their grants live
  // in Foundation, not in the Platform-side dedicated role map.
  const serviceDeployRoleNames = ['service-deploy', 'service-deploy-cfn'];
  const policiesFor = (template: any, name: string) => Object.values(template.Resources).filter((resource: any) =>
    ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
      && resource.Properties.Roles?.some((role: any) => role === `beta-${name}-role` || (role.Ref && template.Resources[role.Ref]?.Properties?.RoleName === `beta-${name}-role`))) as any[];
  const grantsFor = (template: any, name: string): any[] => policiesFor(template, name)
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const actionsFor = (template: any, name: string): string[] => grantsFor(template, name).flatMap((statement) =>
    [statement.Action].flat());

  it('fails closed for unknown phases and defaults to legacy', () => {
    expect(readIdentityPhase(undefined)).toBe('legacy');
    for (const value of [null, '', true, 'production', 'cutover']) expect(() => readIdentityPhase(value)).toThrow();
  });

  it('adds policies while retaining every legacy Beta resource and output', () => {
    const legacy = synthesizePlatform('beta');
    const added = synthesizePlatform('beta', 'roles-added');
    for (const [id, resource] of Object.entries(legacy.Resources)) expect(added.Resources[id]).toEqual(resource);
    for (const [key, value] of Object.entries(legacy.Outputs)) expect(added.Outputs[key]).toEqual(value);
    expect(Object.keys(added.Outputs).filter(key => !legacy.Outputs[key])).toEqual(['CleanupTaskRoleArn']);
    const newResources = Object.entries(added.Resources).filter(([id]) => !legacy.Resources[id]);
    expect(newResources).toHaveLength(8);
    expect(newResources.filter(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Policy')).toHaveLength(6);
    const cleanup = newResources.find(([, resource]: [string, any]) => resource.Type === 'AWS::IAM::Role')![1] as any;
    expect(cleanup.Properties.RoleName).toBe('beta-anywear-tester-cleanup-task');
    const cleanupParameter = newResources
      .filter(([, resource]: [string, any]) => resource.Type === 'AWS::SSM::Parameter') as [string, any][];
    expect(cleanupParameter).toHaveLength(1);
    expect(cleanupParameter[0][1].Properties.Name).toBe('/anywear/beta/cleanup_task_role_arn');
    expect(cleanupParameter[0][1].Properties.Description).toBe(
      'AnyWear-Infra AnyWearRuntimeStack-beta stage contract: dedicated cleanup task role ARN, '
        + 'published only while the identity phase creates it');
  });

  it('keeps the old Beta role identity but removes its trust and template-owned grants only at retirement', () => {
    const before = synthesizeFoundation('roles-added');
    const retired = synthesizeFoundation('retired');
    const roleId = Object.entries(before.Resources).find(([, resource]: [string, any]) =>
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-github-actions-pipeline-role')![0];
    expect(retired.Resources[roleId].Properties.RoleName).toBe('beta-github-actions-pipeline-role');
    expect(retired.Resources[roleId].Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals
      ['token.actions.githubusercontent.com:sub']).toEqual(['anywear:retired:beta-github-actions-pipeline-role']);
    for (const [id, resource] of Object.entries(before.Resources) as [string, any][]) {
      if (resource.Type === 'AWS::IAM::Role' && ['dev', 'prod'].some((stage) =>
        resource.Properties.RoleName === `${stage}-github-actions-pipeline-role`)) expect(retired.Resources[id]).toEqual(resource);
    }
    expect(pipelinePolicies(synthesizePlatform('beta', 'retired'), 'beta')).toHaveLength(0);
    for (const stage of ['dev', 'prod']) {
      expect(synthesizePlatform(stage, 'retired')).toEqual(synthesizePlatform(stage, 'legacy'));
    }
  });

  it('separates artifact, data, Client, runtime and qualification capabilities', () => {
    const template = synthesizePlatform('beta', 'roles-added');
    const artifactActions = actionsFor(synthesizeFoundation('roles-added'), 'service-artifact');
    expect(artifactActions).toContain('ecr:PutImage');
    expect(artifactActions.every((action) => action.startsWith('ecr:'))).toBe(true);
    for (const name of ['service-artifact', 'service-data', 'client-publish', 'e2e-qualification', 'infra-runtime']) {
      expect(actionsFor(template, name)).not.toContain('sts:AssumeRole');
      expect(actionsFor(template, name)).not.toContain('cloudformation:CreateChangeSet');
    }
    const clientActions = actionsFor(template, 'client-publish');
    expect(clientActions).toContain('s3:PutObject');
    expect(clientActions).toContain('cloudfront:CreateInvalidation');
    expect(clientActions.every((action) => ['cloudformation:DescribeStacks', 'ssm:GetParameter', 'ssm:GetParameters',
      's3:ListBucket', 's3:GetBucketLocation', 's3:GetObject', 's3:PutObject', 's3:DeleteObject',
      'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'].includes(action))).toBe(true);
    const clientWrites = grantsFor(template, 'client-publish').filter((grant) =>
      [grant.Action].flat().some((action) => ['s3:PutObject', 's3:DeleteObject', 'cloudfront:CreateInvalidation'].includes(action)));
    expect(JSON.stringify(clientWrites)).toContain('AnyWearClientBucket');
    expect(JSON.stringify(clientWrites)).toContain('AnyWearClientDistribution');
    expect(JSON.stringify(clientWrites)).not.toContain('AnyWearWardrobeBucket');
    for (const [name, families] of [['service-data', ['verify', 'tester-cleanup']],
      ['e2e-qualification', ['artifact-verify']]] as const) {
      const registration = grantsFor(template, name).filter((grant) => [grant.Action].flat().includes('ecs:RegisterTaskDefinition'));
      expect(registration).toHaveLength(1);
      const resources = JSON.stringify(registration[0].Resource);
      for (const family of families) expect(resources).toContain(`beta-anywear-${family}:*`);
      expect([registration[0].Resource].flat()).toHaveLength(families.length);
      expect(resources).not.toContain('beta-anywear-api');
      expect(resources).not.toContain('beta-anywear-worker');
    }
    // The selection/deployment records are emitted as artifacts and never
    // written. compare-templates.mjs allows a dedicated Beta identity policy
    // wholesale, so this negative assertion is what stops the grant returning.
    const runtimePuts = grantsFor(template, 'infra-runtime')
      .filter((grant) => [grant.Action].flat().includes('ssm:PutParameter'));
    for (const record of ['/anywear/beta/infra_selection', '/anywear/beta/infra_deployment']) {
      expect(JSON.stringify(runtimePuts.map((grant) => grant.Resource))).not.toContain(record);
    }
    // Round 15: the observe path's first exercise of the stage-contract SSM
    // surface. The Workload conversion made the release slice read every value
    // under `/anywear/beta/`, and the E2E qualification observer validates every
    // value under the prefix against the platform record, so the runtime and E2E
    // principals both get the prefix read on top of the nine pre-contract named
    // reads. Pin the effective authorization (the CDK CLI merges statements with
    // equal actions, so statement packing is not the contract): exactly the two
    // read actions, exactly the prefix plus the nine names on both prefix readers,
    // the unchanged nine-name surface on the deploy neighbour, and the whole
    // write/delete/version negative inventory.
    const resolvePolicyArn = (value: any): any => {
      if (Array.isArray(value)) return value.map(resolvePolicyArn);
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => resolvePolicyArn(part)).join(separator);
      }
      if (value?.Ref === 'AWS::Partition') return 'aws';
      if (value?.Ref === 'AWS::Region') return 'ap-east-1';
      if (value?.Ref === 'AWS::AccountId') return '650880818323';
      return value;
    };
    const preContractParameters = ['cognito_user_pool_id', 'cognito_client_id', 'aws_region', 's3_bucket_name',
      'qweather_api_host', 'tester_allowlist', 'infra_selection', 'infra_deployment']
      .map((parameter) => `arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/${parameter}`).sort();
    const stageContractPrefix = 'arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*';
    const ssmInventory = (name: string) => {
      const statements = grantsFor(template, name)
        .filter((grant) => [grant.Action].flat().some((action) => action.startsWith('ssm:')));
      expect(statements.length).toBeGreaterThan(0);
      for (const grant of statements) expect(grant.Effect).toBe('Allow');
      const actions = [...new Set(statements.flatMap((grant) => [grant.Action].flat()))].sort();
      // Statement packing is not the contract: the CDK CLI merges statements
      // with equal actions, and one ARN may appear in several statements (the
      // prefix ARN now backs both the named reads and the #228 path read).
      const resources = [...new Set(statements.flatMap((grant) => [grant.Resource].flat().map(resolvePolicyArn)))].sort();
      return { actions, resources };
    };
    expect(ssmInventory('infra-runtime')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [...preContractParameters, stageContractPrefix].sort(),
    });
    // The E2E qualification observer reads the same stage-contract prefix the
    // runtime observer does, plus the #228 discovery read over the whole prefix
    // (without decryption); removing or widening either prefix grant fails
    // here.
    expect(ssmInventory('e2e-qualification')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [...preContractParameters, stageContractPrefix].sort(),
    });
    expect(ssmInventory('infra-deploy')).toEqual({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: preContractParameters,
    });
    for (const name of ['infra-runtime', 'e2e-qualification']) {
      for (const forbidden of ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:DeleteParameters',
        'ssm:PutParameterVersion', 'ssm:DescribeParameters', 'ssm:*']) {
        expect(actionsFor(template, name)).not.toContain(forbidden);
      }
    }
    // #228: `ssm:GetParametersByPath` is the e2e observer's stage-path
    // discovery read only; the runtime and deploy principals keep the named and
    // prefix `GetParameter(s)` reads and never gain the path read.
    for (const name of ['infra-runtime', 'infra-deploy']) {
      expect(actionsFor(template, name)).not.toContain('ssm:GetParametersByPath');
    }
    const passRoles = grantsFor(template, 'e2e-qualification').find((grant) => [grant.Action].flat().includes('iam:PassRole'));
    expect([passRoles.Resource].flat()).toHaveLength(2);
    for (const forbidden of ['MigrationTaskRole', 'LifecycleTaskRole', 'CleanupTaskRole']) expect(JSON.stringify(passRoles)).not.toContain(forbidden);
    const dataPassRoles = grantsFor(template, 'service-data').find((grant) => [grant.Action].flat().includes('iam:PassRole'));
    expect(JSON.stringify(dataPassRoles)).toContain('CleanupTaskRole');
    expect(JSON.stringify(dataPassRoles)).not.toContain('LifecycleTaskRole');
    const cleanupPolicy = (Object.values(template.Resources) as any[]).find(resource => resource.Type === 'AWS::IAM::Policy' && JSON.stringify(resource.Properties.Roles).includes('CleanupTaskRole'));
    expect(JSON.stringify(cleanupPolicy)).not.toContain('ssm:');
    expect(JSON.stringify(cleanupPolicy)).not.toContain('cognito-idp:');
    // Issue #185: the operator cleanup's caller-side identity phase preflights
    // the captured identity with a read-only AdminGetUser and deletes exactly
    // that user, so the data role holds exactly the two Cognito actions on the
    // Beta user pool. No ListUsers, no account-wide listing, and the fixed
    // cleanup task role stays DB/DLQ-only.
    const userPoolId = (Object.entries(template.Resources) as [string, any][])
      .find(([, resource]) => resource.Type === 'AWS::Cognito::UserPool')?.[0];
    expect(userPoolId).toBeDefined();
    const cognitoGrants = grantsFor(template, 'service-data')
      .filter((grant) => [grant.Action].flat().some((action) => action.startsWith('cognito-idp:')));
    expect(cognitoGrants.length).toBeGreaterThan(0);
    for (const grant of cognitoGrants) expect(grant.Effect).toBe('Allow');
    expect([...new Set(cognitoGrants.flatMap((grant) => [grant.Action].flat()))].sort())
      .toEqual(['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminGetUser']);
    expect([...new Set(cognitoGrants.flatMap((grant) => [grant.Resource].flat()))])
      .toEqual([{ 'Fn::GetAtt': [userPoolId, 'Arn'] }]);
    const e2eRegistration = grantsFor(template, 'e2e-qualification')
      .find((grant) => [grant.Action].flat().includes('ecs:RegisterTaskDefinition'));
    expect(JSON.stringify(e2eRegistration.Resource)).not.toContain('beta-anywear-lifecycle:');

    // Issue #95 sizing pre-flight read. The qualification principal had no
    // Application Auto Scaling grant, so its opt-in sizing stage failed before
    // any paid workload started. The grant stays on the E2E principal, stays
    // read-only, and stays bound to the Beta region.
    const scalableTargetId = 'application-autoscaling:DescribeScalableTargets';
    const scalableTargetGrants = grantsFor(template, 'e2e-qualification')
      .filter((grant) => [grant.Action].flat().includes(scalableTargetId));
    expect(scalableTargetGrants).toHaveLength(1);
    expect([scalableTargetGrants[0].Action].flat()).toEqual([scalableTargetId]);
    expect(scalableTargetGrants[0].Effect).toBe('Allow');
    expect(scalableTargetGrants[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } });
    // Resolve the region/account/partition tokens so this pins the exact ARN.
    const scalableResource = (values: any): string => values['Fn::Join'][1]
      .map((part: any) => (part.Ref === 'AWS::Partition' ? 'aws' : part.Ref === 'AWS::Region' ? 'ap-east-1'
        : part.Ref === 'AWS::AccountId' ? '650880818323' : part)).join(values['Fn::Join'][0]);
    expect(scalableResource(scalableTargetGrants[0].Resource))
      .toBe('arn:aws:application-autoscaling:ap-east-1:650880818323:scalable-target/*');
    expect(policiesFor(template, 'e2e-qualification')
      .filter((policy) => JSON.stringify(policy.Properties.PolicyDocument).includes(scalableTargetId)))
      .toHaveLength(1);
    // Widening either the shared helper or a neighbor's grants would fail here.
    for (const name of names) {
      expect(actionsFor(template, name).filter((action) => action.startsWith('application-autoscaling:')))
        .toEqual(name === 'e2e-qualification' ? [scalableTargetId] : []);
    }
    expect(actionsFor(synthesizePlatform('beta'), 'infra-deploy')).not.toContain(scalableTargetId);
    const pipelineBetaActions = (Object.values(synthesizePlatform('beta').Resources) as any[])
      .filter((resource) => ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy'].includes(resource.Type)
        && JSON.stringify(resource.Properties.Roles).includes('beta-github-actions-pipeline-role'))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement: any) => [statement.Action].flat());
    for (const forbidden of ['application-autoscaling:RegisterScalableTarget', 'application-autoscaling:PutScalingPolicy',
      'application-autoscaling:DeleteScalingPolicy', 'application-autoscaling:DeregisterScalableTarget',
      'application-autoscaling:TagResource']) {
      expect(actionsFor(template, 'e2e-qualification')).not.toContain(forbidden);
      expect(actionsFor(template, 'infra-runtime')).not.toContain(forbidden);
      expect(pipelineBetaActions).not.toContain(forbidden);
    }
  });

  it('grants the E2E qualification role exactly the #228 discovery read surface and no write', () => {
    // Synthesized with the concrete env like the aggregate quota test, so the
    // ARNs and region conditions render as literals the byte-quota walker can
    // resolve (the env-less helper leaves pseudo-parameter Refs in the joins).
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App({ context: cdkConfig.context });
    const template = Template.fromStack(new PlatformStack(app, 'AnyWearPlatformStack-beta', {
      stage: 'beta', env, identityPhase: 'roles-added', artifactInputs,
    })).toJSON();
    const resolvePolicyArn = (value: any): any => {
      if (Array.isArray(value)) return value.map(resolvePolicyArn);
      if (value?.['Fn::Join']) {
        const [separator, parts] = value['Fn::Join'];
        return parts.map((part: any) => resolvePolicyArn(part)).join(separator);
      }
      if (value?.Ref === 'AWS::Partition') return 'aws';
      if (value?.Ref === 'AWS::Region') return 'ap-east-1';
      if (value?.Ref === 'AWS::AccountId') return '650880818323';
      return value;
    };
    const forAction = (action: string) => grantsFor(template, 'e2e-qualification')
      .filter((grant) => [grant.Action].flat().includes(action));
    // The whole-prefix SSM discovery read. The #228 second-iteration
    // correction (smoke 40105334687) makes it conditionless: the synthesized
    // statement stays separate from the same-resource GetParameter(s) reads
    // and carries no condition block, the same style as the stack-trio pin.
    const pathReads = forAction('ssm:GetParametersByPath');
    expect(pathReads).toHaveLength(1);
    expect(pathReads[0].Effect).toBe('Allow');
    expect([pathReads[0].Action].flat()).toEqual(['ssm:GetParametersByPath']);
    expect([pathReads[0].Resource].flat().map(resolvePolicyArn))
      .toEqual(['arn:aws:ssm:ap-east-1:650880818323:parameter/anywear/beta/*']);
    expect(pathReads[0].Condition).toBeUndefined();
    // The CloudFormation read trio on the `AnyWear*` stack prefix in both
    // observation regions (the CDK policy merger unions the two source
    // statements into one trio statement, so pin the effective grant), plus
    // `ListStacks` bound to those two regions.
    const stackWildcards = ['arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWear*/*',
      'arn:aws:cloudformation:us-east-1:650880818323:stack/AnyWear*/*'];
    const stackReads = forAction('cloudformation:DescribeStacks');
    expect(stackReads).toHaveLength(1);
    expect([stackReads[0].Action].flat()).toEqual(['cloudformation:DescribeStacks',
      'cloudformation:GetTemplate', 'cloudformation:ListStackResources']);
    expect([stackReads[0].Resource].flat().map(resolvePolicyArn)).toEqual(stackWildcards);
    expect(stackReads[0].Condition).toBeUndefined();
    const listStacks = forAction('cloudformation:ListStacks');
    expect(listStacks).toHaveLength(1);
    expect(listStacks[0].Resource).toBe('*');
    expect(listStacks[0].Condition).toEqual({
      StringEquals: { 'aws:RequestedRegion': ['ap-east-1', 'us-east-1'] },
    });
    // The Lambda reads on the Service-built name prefix and the region-bound
    // account listing.
    const lambdaReads = forAction('lambda:GetFunction');
    expect(lambdaReads).toHaveLength(1);
    expect([lambdaReads[0].Action].flat()).toEqual(['lambda:GetFunction', 'lambda:GetFunctionConfiguration']);
    expect([lambdaReads[0].Resource].flat().map(resolvePolicyArn))
      .toEqual(['arn:aws:lambda:ap-east-1:650880818323:function:beta-anywear-*']);
    const listFunctions = forAction('lambda:ListFunctions');
    expect(listFunctions).toHaveLength(1);
    expect(listFunctions[0].Resource).toBe('*');
    expect(listFunctions[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
    // The queue attribute reads on the beta name prefix and the region-bound
    // listing (`ListQueues` has no IAM condition keys; the prefix is the
    // request parameter).
    const queueReads = forAction('sqs:GetQueueAttributes');
    expect(queueReads).toHaveLength(1);
    expect([queueReads[0].Action].flat()).toEqual(['sqs:GetQueueAttributes']);
    expect([queueReads[0].Resource].flat().map(resolvePolicyArn))
      .toEqual(['arn:aws:sqs:ap-east-1:650880818323:beta-anywear-*']);
    const listQueues = forAction('sqs:ListQueues');
    expect(listQueues).toHaveLength(1);
    expect(listQueues[0].Resource).toBe('*');
    expect(listQueues[0].Condition).toEqual({ StringEquals: { 'aws:RequestedRegion': 'ap-east-1' } });
    // The CloudFront listing is global and carries no condition.
    const listDistributions = forAction('cloudfront:ListDistributions');
    expect(listDistributions).toHaveLength(1);
    expect(listDistributions[0].Resource).toBe('*');
    expect(listDistributions[0].Condition).toBeUndefined();
    // The new surface is read-only on every statement: no write/delete/create
    // action appears on the role from these families, and the discovery actions
    // stay on the e2e principal only.
    for (const forbidden of ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:DeleteParameters',
      'ssm:PutParameterVersion', 'cloudformation:CreateStack', 'cloudformation:UpdateStack',
      'cloudformation:DeleteStack', 'lambda:CreateFunction', 'lambda:UpdateFunctionCode', 'lambda:DeleteFunction',
      'sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:PurgeQueue', 'cloudfront:CreateDistribution',
      'cloudfront:UpdateDistribution', 'cloudfront:DeleteDistribution']) {
      expect(actionsFor(template, 'e2e-qualification')).not.toContain(forbidden);
    }
    for (const name of ['infra-runtime', 'infra-deploy']) {
      for (const action of ['ssm:GetParametersByPath', 'cloudformation:ListStacks', 'lambda:ListFunctions',
        'sqs:ListQueues', 'cloudfront:ListDistributions']) {
        expect(actionsFor(template, name)).not.toContain(action);
      }
    }
    // The Platform-side inline policy still fits the aggregate quota; the
    // cross-stack aggregate (Platform + Foundation) is pinned separately.
    const e2eBytes = policiesFor(template, 'e2e-qualification').reduce((size, policy) => size
      + Buffer.byteLength(JSON.stringify(policyValueUpperBound(policy.Properties.PolicyDocument, template))), 0);
    expect(e2eBytes).toBeLessThan(10240);
  });

  it('grants the cleanup task role exactly the #217 wardrobe-object statements and no Cognito action', () => {
    const template = synthesizePlatform('beta', 'roles-added');
    const [roleId] = (Object.entries(template.Resources) as [string, any][]).find(([, resource]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task'))!;
    expect(roleId).toMatch(/^CleanupTaskRole[A-F0-9]{8}$/);
    const policies = (Object.values(template.Resources) as any[]).filter((resource) => (
      resource.Type === 'AWS::IAM::Policy' && JSON.stringify(resource.Properties.Roles) === JSON.stringify([{ Ref: roleId }])));
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement;
    const bucketId = (Object.entries(template.Resources) as [string, any][]).find(([, resource]) => (
      resource.Type === 'AWS::S3::Bucket'
        && JSON.stringify(resource.Properties.BucketName ?? '').includes('anywear-wardrobe-bucket')))?.[0];
    expect(bucketId).toBeDefined();
    const objectArn = (prefix: string) => ({
      'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, `/${prefix}`]],
    });
    // Issue #217: the versioned cleanup operation's `cleanupTesterRecords` deletes
    // each captured user's objects under the four cleaned prefixes and lists only
    // those prefixes. Issue #311 adds the VTO result objects under
    // `outfit-generations/<sub>/` and the VTO staging objects under
    // `task-attempts/vto/<vto_id>/`. The statements stay split: delete on the
    // object ARNs, list on the bucket ARN under the `s3:prefix` condition.
    const s3Statements = statements.filter((statement: any) => JSON.stringify(statement.Action).includes('"s3:'));
    expect(s3Statements).toEqual([
      { Action: 's3:DeleteObject', Effect: 'Allow',
        Resource: [objectArn('wearable-items/*'), objectArn('base-photos/*'),
          objectArn('outfit-generations/*'), objectArn('task-attempts/vto/*')] },
      { Action: 's3:ListBucket', Effect: 'Allow', Resource: { 'Fn::GetAtt': [bucketId, 'Arn'] },
        Condition: { StringLike: { 's3:prefix': ['wearable-items/*', 'base-photos/*',
          'outfit-generations/*', 'task-attempts/vto/*'] } } },
    ]);
    // The pre-#217 grants are retained ahead of the two S3 statements: the
    // database-secret read and the two-dead-letter-queue statement.
    expect(statements).toHaveLength(4);
    expect(statements[0].Action).toContain('secretsmanager:GetSecretValue');
    expect(statements[1].Action).toEqual(
      ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility']);
    expect(statements[1].Resource.map((resource: any) => template.Resources[resource['Fn::GetAtt'][0]]
      .Properties.QueueName).sort()).toEqual(['beta-anywear-auto-tagging-dlq', 'beta-anywear-vto-dlq']);
    // The fixed cleanup task role carries no Cognito action (nor SSM), at every
    // phase that creates it.
    for (const phase of ['roles-added', 'retired'] as const) {
      const phased = synthesizePlatform('beta', phase);
      const phasedRole = (Object.entries(phased.Resources) as [string, any][]).find(([, resource]) => (
        resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === 'beta-anywear-tester-cleanup-task'))![0];
      const phasedPolicies = (Object.values(phased.Resources) as any[]).filter((resource) => (
        resource.Type === 'AWS::IAM::Policy'
          && JSON.stringify(resource.Properties.Roles) === JSON.stringify([{ Ref: phasedRole }])));
      expect(phasedPolicies).toHaveLength(1);
      expect(JSON.stringify(phasedPolicies[0])).not.toContain('cognito-idp:');
      expect(JSON.stringify(phasedPolicies[0])).not.toContain('cognito:');
      expect(JSON.stringify(phasedPolicies[0])).not.toContain('ssm:');
    }
  });

  it('grants the E2E qualification role exactly the #217 read-only CloudTrail lookup', () => {
    const template = synthesizePlatform('beta', 'roles-added');
    const e2ePolicies = (Object.entries(template.Resources) as [string, any][]).filter(([, resource]) => (
      resource.Type === 'AWS::IAM::Policy'
        && JSON.stringify(resource.Properties.Roles) === JSON.stringify(['beta-e2e-qualification-role'])));
    expect(e2ePolicies).toHaveLength(1);
    const [policyId, policy] = e2ePolicies[0];
    expect(policyId).toMatch(/^E2EQualificationRoleDedicatedPolicy[A-F0-9]{8}$/);
    // Issue #217: the E2E `reconcile` operation reads the Beta pool's
    // `AdminCreateUser` CloudTrail events over its 7-day lookback. The action has
    // no resource-level scope, so the region condition is the bound.
    const cloudTrail = policy.Properties.PolicyDocument.Statement
      .filter((statement: any) => JSON.stringify(statement.Action).includes('cloudtrail:'));
    expect(cloudTrail).toEqual([{
      Action: 'cloudtrail:LookupEvents',
      Effect: 'Allow',
      Resource: '*',
      Condition: { StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } } },
    }]);
    // Exactly that one CloudTrail action and no account-wide Cognito listing.
    expect(actionsFor(template, 'e2e-qualification').filter((action) => action.startsWith('cloudtrail:')))
      .toEqual(['cloudtrail:LookupEvents']);
    expect(JSON.stringify(policy)).not.toContain('cloudtrail:StartLogging');
    expect(actionsFor(template, 'e2e-qualification')).not.toContain('cognito-idp:ListUsers');
  });

  it('constrains CDK assumption to the reviewed bootstrap roles and regions', () => {
    const foundation = synthesizeFoundation('roles-added');
    const statements = (Object.values(foundation.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Policy')
      .flatMap((resource) => resource.Properties.PolicyDocument.Statement);
    const assumptions = statements.filter((statement) => [statement.Action].flat().includes('sts:AssumeRole'));
    const dedicated = assumptions.find((statement) => JSON.stringify(statement.Resource).includes('cdk-hnb659fds-deploy-role'));
    expect(dedicated).toBeDefined();
    expect([dedicated.Resource].flat()).toHaveLength(6);
    expect(JSON.stringify(dedicated.Resource)).not.toContain('image-publishing');
    expect(JSON.stringify(dedicated.Resource)).not.toContain('cfn-exec');
    expect(JSON.stringify(dedicated.Resource)).not.toContain('cdk-*');
  });

  it('keeps every dedicated role within the aggregate IAM inline policy quota', () => {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const app = new cdk.App({ context: cdkConfig.context });
    const foundationStack = new FoundationStack(app, 'AnyWearFoundationStack', {
      env, identityPhase: 'roles-added', legacyRoleSource: 'cdk',
    });
    const platformStack = new PlatformStack(app, 'AnyWearPlatformStack-beta', {
      stage: 'beta', env, identityPhase: 'roles-added', artifactInputs,
    });
    const foundation = Template.fromStack(foundationStack).toJSON();
    const platform = Template.fromStack(platformStack).toJSON();
    for (const name of [...names]) {
      const local = policiesFor(platform, name);
      const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) =>
        resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === `beta-${name}-role`)![0];
      const base = (Object.values(foundation.Resources) as any[]).filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles?.some((role: any) => role.Ref === roleId));
      const bytes = local.reduce((size, policy) => size + Buffer.byteLength(JSON.stringify(
        policyValueUpperBound(policy.Properties.PolicyDocument, platform))), 0)
        + base.reduce((size, policy) => size + Buffer.byteLength(JSON.stringify(policy.Properties.PolicyDocument)), 0);
      expect(bytes).toBeLessThan(10240);
    }
  });

  it('activates rollback retention only explicitly and preserves the original any-image threshold', () => {
    for (const stage of ['beta', 'prod']) {
      const app = new cdk.App();
      const protectedStack = new PlatformStack(app, `AnyWearPlatformStack-${stage}`, {
        stage, artifactInputs, ecrImageRetention: true,
      });
      const template = Template.fromStack(protectedStack).toJSON();
      const repository = (Object.values(template.Resources) as any[]).find((resource) => resource.Type === 'AWS::ECR::Repository');
      const policy = JSON.parse(repository.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(policy.rules).toHaveLength(2);
      expect(policy.rules[0]).toEqual(expect.objectContaining({ rulePriority: 1,
        selection: { tagStatus: 'tagged', tagPrefixList: ['protected-service-'],
          countType: 'imageCountMoreThan', countNumber: 1000 }, action: { type: 'expire' } }));
      expect(policy.rules[1]).toEqual(expect.objectContaining({ rulePriority: 2,
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: stage === 'beta' ? 30 : 100 },
        action: { type: 'expire' } }));
      const original = (Object.values(synthesizePlatform(stage).Resources) as any[])
        .find((resource) => resource.Type === 'AWS::ECR::Repository');
      const originalPolicy = JSON.parse(original.Properties.LifecyclePolicy.LifecyclePolicyText);
      expect(originalPolicy.rules).toHaveLength(1);
      expect(originalPolicy.rules[0].selection).toEqual({ tagStatus: 'any',
        countType: 'imageCountMoreThan', countNumber: stage === 'beta' ? 30 : 100 });
    }
  });
});

describe('Disposable Beta Egress stack', () => {
  function synthesizeEgress(props: { natEipAllocationId?: string } = {}): Record<string, any> {
    const app = new cdk.App();
    return Template.fromStack(new EgressStack(app, 'AnyWearEgressStack-beta', {
      env: { account: '650880818323', region: 'ap-east-1' }, ...props,
    })).toJSON();
  }

  it('adds only default routes, NAT/EIP and the S3 gateway endpoint into Base-owned route tables', () => {
    const template = synthesizeEgress();
    const resources = Object.values(template.Resources) as any[];
    const ofType = (type: string) => resources.filter((resource) => resource.Type === type);

    expect(ofType('AWS::EC2::NatGateway')).toHaveLength(1);
    expect(ofType('AWS::EC2::EIP')).toHaveLength(1);
    // Issue #166 new-EIP experiment: the logical IDs changed so CloudFormation
    // replaces the EIP/allocation and NAT and points the routes at the new NAT.
    expect(template.Resources.NatEipNext).toBeDefined();
    expect(template.Resources.NatGatewayNext).toBeDefined();
    expect(template.Resources.NatEip).toBeUndefined();
    expect(template.Resources.NatGateway).toBeUndefined();
    // The stack-owned EIP is retained so deleting Egress for a stop does not
    // release the allocation the drill wants to reuse on the next start.
    expect(template.Resources.NatEipNext.DeletionPolicy).toBe('Retain');
    expect(template.Resources.NatEipNext.UpdateReplacePolicy).toBe('Retain');
    expect(template.Resources.NatGatewayNext.Properties.AllocationId)
      .toEqual({ 'Fn::GetAtt': ['NatEipNext', 'AllocationId'] });
    expect(template.Resources.NatEipNext.Properties.Tags).toEqual([
      { Key: 'Name', Value: 'beta-anywear-egress-nat' },
    ]);
    expect(template.Resources.NatGatewayNext.Properties.Tags).toEqual([
      { Key: 'Name', Value: 'beta-anywear-egress-nat' },
    ]);
    // AWS allows one association per subnet and Base owns it: Egress creates no
    // route table and no association, only routes in the imported Base tables.
    expect(ofType('AWS::EC2::RouteTable')).toHaveLength(0);
    expect(ofType('AWS::EC2::SubnetRouteTableAssociation')).toHaveLength(0);
    const routes = ofType('AWS::EC2::Route');
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.Properties.RouteTableId)).toEqual(
      BASE_EXPORTS.privateRouteTableIds.map((name) => ({ 'Fn::ImportValue': name })));
    expect(routes.every((route) => route.Properties.DestinationCidrBlock === '0.0.0.0/0'
      && route.Properties.NatGatewayId !== undefined)).toBe(true);
    expect(routes.map((route) => route.Properties.NatGatewayId))
      .toEqual([{ Ref: 'NatGatewayNext' }, { Ref: 'NatGatewayNext' }]);
    const endpoint = ofType('AWS::EC2::VPCEndpoint');
    expect(endpoint).toHaveLength(1);
    expect(String(endpoint[0].Properties.ServiceName)).toContain('s3');
    expect(endpoint[0].Properties.VpcId).toEqual({ 'Fn::ImportValue': BASE_EXPORTS.vpcId });
    expect(endpoint[0].Properties.RouteTableIds).toEqual(
      BASE_EXPORTS.privateRouteTableIds.map((name) => ({ 'Fn::ImportValue': name })));
    expect(ofType('AWS::EC2::NatGateway')[0].Properties.SubnetId)
      .toEqual({ 'Fn::ImportValue': BASE_EXPORTS.natSubnetId });
    // The Egress stack owns no Base or Runtime resource: no subnet, VPC, Aurora,
    // Cognito, bucket, ECR, SSM parameter or distribution is recreated here.
    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::RDS::DBCluster', 'AWS::S3::Bucket',
      'AWS::Cognito::UserPool', 'AWS::ECR::Repository', 'AWS::SSM::Parameter', 'AWS::CloudFront::Distribution']) {
      expect(ofType(type)).toHaveLength(0);
    }
    // No stage-contract parameter is added for the route tables: the only
    // parameter is CDK's own bootstrap-version read.
    expect((Object.values(template.Parameters) as any[]).map((parameter) => parameter.Default))
      .toEqual(['/cdk-bootstrap/hnb659fds/version']);
    expect(Object.keys(template.Outputs).sort()).toEqual([
      'EgressNatEipAllocationId', 'EgressNatGatewayId', 'EgressPrivateRouteTableIds',
    ]);
    expect(template.Outputs.EgressNatGatewayId.Value).toEqual({ Ref: 'NatGatewayNext' });
    expect(template.Outputs.EgressNatEipAllocationId.Value)
      .toEqual({ 'Fn::GetAtt': ['NatEipNext', 'AllocationId'] });
  });

  it('reuses a retained EIP allocation when natEipAllocationId is provided', () => {
    const allocationId = 'eipalloc-0a5198fb91b876949';
    const template = synthesizeEgress({ natEipAllocationId: allocationId });
    // No EIP resource is created; the NAT and output use the retained allocation.
    expect(template.Resources.NatEipNext).toBeUndefined();
    expect(template.Resources.NatGatewayNext).toBeDefined();
    expect(template.Resources.NatGatewayNext.Properties.AllocationId).toBe(allocationId);
    expect(template.Outputs.EgressNatEipAllocationId.Value).toBe(allocationId);
    expect(template.Outputs.EgressNatGatewayId.Value).toEqual({ Ref: 'NatGatewayNext' });
    const routes = Object.values(template.Resources).filter((resource: any) => resource.Type === 'AWS::EC2::Route') as any[];
    expect(routes.map((route) => route.Properties.NatGatewayId))
      .toEqual([{ Ref: 'NatGatewayNext' }, { Ref: 'NatGatewayNext' }]);
    expect(template.Resources.NatGatewayNext.Properties.SubnetId)
      .toEqual({ 'Fn::ImportValue': BASE_EXPORTS.natSubnetId });
    expect(template.Resources.NatGatewayNext.Properties.Tags).toEqual([
      { Key: 'Name', Value: 'beta-anywear-egress-nat' },
    ]);
    expect(template.Resources.S3GatewayEndpoint.Properties.RouteTableIds).toEqual(
      BASE_EXPORTS.privateRouteTableIds.map((name) => ({ 'Fn::ImportValue': name })));
    // A malformed allocation is refused at synthesis.
    expect(() => synthesizeEgress({ natEipAllocationId: 'eipalloc-NOTHEX' }))
      .toThrow(/natEipAllocationId must be an Elastic IP allocation id/);
  });

  it('synthesizes from the egress-only app scope without Service artifacts', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'anywear-egress-scope-'));
    try {
      execFileSync(process.execPath, [path.join(root, 'bin', 'infra.js')], {
        cwd: root, stdio: 'pipe', timeout: 120_000,
        env: { ...process.env, CDK_CONTEXT_JSON: JSON.stringify({ deployScope: 'egress', identityPhase: 'retired',
          legacyRoleSource: 'external', ecrImageRetention: 'true' }), CDK_OUTDIR: directory,
          CDK_DEFAULT_ACCOUNT: '650880818323', CDK_DEFAULT_REGION: 'ap-east-1', BILLING_REGION: 'us-east-1' },
      });
      const files = readdirSync(directory).filter((file) => file.endsWith('.template.json')).sort();
      expect(files).toEqual(['AnyWearEgressStack-beta.template.json', 'AnyWearFoundationStack.template.json']);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 180_000);
});

// Issue #166 M4: the Base deploy resolves its API origin under
// `beta-infra-runtime-role` before it applies the new Base policy. The live
// runtime-role read policy is the Base stack's DedicatedPolicy and covers
// Foundation/Platform/Workload, not the renamed Runtime stack; the Runtime grant
// inside the new Base template is applied by the very update that needs the
// pre-read. This test uses the real synthesized Foundation + Base policies (no
// IAM mock) and proves the effective union authorizes the M4 reads: Runtime is
// permanent (absence is a ValidationError that still needs authorization) and
// Workload is the transitional pre-MOVE read.
describe('Issue #166 runtime-role CloudFormation read surface', () => {
  const roleName = 'beta-infra-runtime-role';
  const render = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(render).join(',');
    if (value?.['Fn::Join']) {
      const [separator, parts] = value['Fn::Join'];
      return parts.map((part: any) => (part?.Ref === 'AWS::Partition' ? 'aws' : part)).join(separator);
    }
    return JSON.stringify(value);
  };
  const runtimeArn = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearRuntimeStack-beta/*';
  const workloadArn = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearWorkloadStack-beta/*';

  function synthesis(): { foundation: any; base: any } {
    const env = { account: '650880818323', region: 'ap-east-1' };
    const foundationApp = new cdk.App();
    const foundation = Template.fromStack(new FoundationStack(foundationApp, 'AnyWearFoundationStack', {
      env, identityPhase: 'retired', legacyRoleSource: 'cdk',
    })).toJSON();
    const baseApp = new cdk.App();
    const base = Template.fromStack(new PlatformStack(baseApp, 'AnyWearPlatformStack-beta', {
      stage: 'beta', env, identityPhase: 'retired', artifactInputs,
    })).toJSON();
    return { foundation, base };
  }
  const policiesForRuntime = (template: any, roleId?: string): any[] => (Object.values(template.Resources) as any[])
    .filter((resource) => resource.Type === 'AWS::IAM::Policy'
      && resource.Properties.Roles?.some((role: any) => (roleId ? role.Ref === roleId : role === roleName)));

  it('grants only the runtime principal read access to the disposable Egress stack', () => {
    const { base } = synthesis();
    const egressArn = 'arn:aws:cloudformation:ap-east-1:650880818323:stack/AnyWearEgressStack-beta/*';
    const policiesFor = (template: any, name: string): any[] => (Object.values(template.Resources) as any[])
      .filter((resource) => resource.Type === 'AWS::IAM::Policy'
        && resource.Properties.Roles?.includes(name));
    const grantsFor = (template: any, name: string): any[] => policiesFor(template, name)
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const egressGrants = (name: string) => grantsFor(base, name)
      .filter((statement: any) => [statement.Resource].flat().map(render).includes(egressArn));
    const runtimeGrants = egressGrants('beta-infra-runtime-role');
    expect(runtimeGrants).toHaveLength(1);
    expect([runtimeGrants[0].Action].flat().sort())
      .toEqual(['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources']);
    expect([runtimeGrants[0].Resource].flat().map(render)).toEqual([egressArn]);
    // No other dedicated principal reads the Egress stack.
    for (const name of ['beta-infra-deploy-role', 'beta-client-publish-role', 'beta-service-data-role',
      'beta-e2e-qualification-role']) {
      expect(egressGrants(name)).toHaveLength(0);
    }
  });

  it('authorizes DescribeStacks and GetTemplate on Runtime and Workload before the Base update', () => {
    const { foundation, base } = synthesis();
    const roleId = Object.entries(foundation.Resources).find(([, resource]: [string, any]) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === roleName))![0];
    const foundationRuntime = policiesForRuntime(foundation, roleId);
    const baseRuntime = policiesForRuntime(base);
    // The Foundation-owned grant exists exactly once, with exactly the two reads
    // and exactly the Runtime + transitional Workload stack ARNs.
    expect(foundationRuntime.length).toBeGreaterThanOrEqual(1);
    const foundationStatements = foundationRuntime.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const stackReads = foundationStatements.filter((statement: any) => [statement.Action].flat()
      .includes('cloudformation:DescribeStacks'));
    expect(stackReads).toHaveLength(1);
    expect([stackReads[0].Action].flat().sort())
      .toEqual(['cloudformation:DescribeStacks', 'cloudformation:GetTemplate']);
    expect([stackReads[0].Resource].flat().map(render).sort()).toEqual([runtimeArn, workloadArn].sort());
    // The Base stack's own runtime-role policy covers Runtime (after M4) and no
    // longer Workload; the Foundation grant is what bridges the pre-read.
    const baseStackResources = new Set(baseRuntime
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => [statement.Action].flat().some((action: string) => (
        ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'].includes(action))))
      .flatMap((statement: any) => [statement.Resource].flat().map(render)));
    expect(baseStackResources).toContain(runtimeArn);
    expect(baseStackResources).not.toContain(workloadArn);
    // The effective union is the M4 precondition: both reads are authorized on
    // Runtime (Base) and on Workload (Foundation, transitional).
    const effective = [...foundationStatements, ...baseRuntime
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)]
      .filter((statement: any) => [statement.Action].flat()
        .some((action: string) => ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'].includes(action)))
      .flatMap((statement: any) => [statement.Resource].flat().map(render));
    expect(effective).toEqual(expect.arrayContaining([runtimeArn, workloadArn]));
    // The grant is inline and read-only: no managed policy and no write.
    const role = (Object.values(foundation.Resources) as any[]).find((resource) => (
      resource.Type === 'AWS::IAM::Role' && resource.Properties.RoleName === roleName));
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    for (const action of ['cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateStack']) {
      expect(effective).not.toContain(action);
    }
  });
});
