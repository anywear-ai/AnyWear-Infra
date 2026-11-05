import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { readIdentityPhase, type IdentityPhase } from './identity-phase';
import { readLegacyRoleSource, type LegacyRoleSource } from './legacy-role-source';

export interface FoundationStackProps extends cdk.StackProps {
  identityPhase?: IdentityPhase;
  legacyRoleSource: LegacyRoleSource;
}

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const identityPhase = readIdentityPhase(props?.identityPhase);
    const legacyRoleSource = readLegacyRoleSource(props.legacyRoleSource);
    if (legacyRoleSource === 'external' && (this.account !== '650880818323' || this.region !== 'ap-east-1')) {
      throw new Error('External legacy roles require the reviewed account 650880818323 in ap-east-1');
    }

    // Setup GitHub OIDC Trust Provider
    // This is a singleton resource per AWS Account
    const githubProvider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    new cdk.CfnOutput(this, 'GitHubOIDCProviderArn', {
      value: githubProvider.openIdConnectProviderArn,
      description: 'The ARN of the GitHub OIDC Provider',
    });

    // GitHub's immutable OIDC subject remains stable if a repository is renamed,
    // so trust only the owner/repository ID form. Issue #266 step 8 moved the
    // owner from `git-malu@11473072` to `anywear-ai@352675702` with every
    // repository ID unchanged and listed both owner subjects for the transfer
    // window; step 24 narrows each trust back to the new owner alone, so the
    // `(owner id, repository id)` pair is trusted exactly once.
    const ownerSubject = (repository: string, id: number, stage: string) =>
      `repo:anywear-ai@352675702/${repository}@${id}:environment:${stage}`;
    const serviceSubject = (stage: 'dev' | 'beta' | 'prod') => ownerSubject('AnyWear-Service', 1158460323, stage);
    const e2eSubject = (stage: 'dev' | 'beta') => ownerSubject('AnyWear-E2E', 1317091305, stage);
    const clientSubject = ownerSubject('AnyWear-Client', 1176104200, 'beta');

    // The deployed Foundation owns only its OIDC provider/helpers. Existing
    // Dev/Beta pipeline identities stay outside it; no adoption or Prod creation.
    if (legacyRoleSource === 'cdk') for (const stage of ['dev', 'beta', 'prod'] as const) {
      const subjects = stage === 'beta' && identityPhase === 'retired' ? [
        // Preserve the role identity with an unmatchable retired subject. No
        // repository is trusted, including the new Infra repository.
        'anywear:retired:beta-github-actions-pipeline-role',
      ] : [
        serviceSubject(stage),
        ...(stage === 'prod' ? [] : [e2eSubject(stage)]),
        ...(stage === 'beta' ? [clientSubject] : []),
      ];
      const role = new iam.Role(this, `${stage}GitHubActionsRole`, {
        roleName: `${stage}-github-actions-pipeline-role`,
        assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': subjects,
          },
        }),
      });
      if (stage === 'beta' && identityPhase === 'retired') continue;
      // Beta billing controls are deployed in the account's billing home
      // region, while the application platform remains in ap-east-1.
      const cdkRoleRegions = stage === 'beta'
        ? [this.region, process.env.BILLING_REGION || 'us-east-1']
        : [this.region];
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: cdkRoleRegions.map((region) => (
          `arn:aws:iam::${this.account}:role/cdk-*-role-${this.account}-${region}`
        )),
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/anywear/${stage}/*`],
      }));
      const secretResources = [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/${stage}/cloudfront_origin_header-*`,
      ];
      if (stage === 'dev') {
        secretResources.push(
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/dev/qweather_api_key-*`,
        );
      }
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretResources,
      }));
    }

    if (identityPhase === 'legacy') return;
    const betaSubject = (repository: string, id: number) => ownerSubject(repository, id, 'beta');
    const createRole = (constructId: string, name: string, subject: string) => new iam.Role(this, constructId, {
      roleName: `beta-${name}-role`,
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
    });
    const infraSubject = betaSubject('AnyWear-Infra', 1409047265);
    const deploy = createRole('BetaInfraDeployRole', 'infra-deploy', infraSubject);
    const runtime = createRole('BetaInfraRuntimeRole', 'infra-runtime', infraSubject);
    const artifacts = createRole('BetaServiceArtifactRole', 'service-artifact',
      ownerSubject('AnyWear-Service', 1158460323, 'service-artifacts'));
    createRole('BetaServiceDataRole', 'service-data', betaSubject('AnyWear-Service', 1158460323));
    createRole('BetaClientPublishRole', 'client-publish', betaSubject('AnyWear-Client', 1176104200));
    createRole('BetaE2EQualificationRole', 'e2e-qualification', betaSubject('AnyWear-E2E', 1317091305));
    // Issue #166 M4: a Base deploy resolves its API origin by reading the
    // Infra-owned Runtime stack (an absent stack is a `ValidationError` that
    // still requires authorization) and, before the MOVE, the legacy Workload
    // stack. Those reads run under this runtime role, whose live read policy is
    // the Base stack's `DedicatedPolicy` and does not yet cover the renamed
    // Runtime stack at M4 (the new Base policy is applied by the same update that
    // needs the pre-read). Foundation therefore owns the read grants and step 8
    // deploys them before M4. The Runtime ARN is permanent. The Workload ARN is
    // transitional: after M3/M4 deletes Workload and the Base literal-origin
    // fallback is the only source, a later reviewed Foundation deploy removes
    // the Workload ARN. Neither grant adds a write, a managed policy or another
    // stack family.
    const stageStackArn = (stackName: string) => this.formatArn({
      service: 'cloudformation', resource: 'stack', resourceName: `${stackName}/*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    runtime.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      resources: [stageStackArn('AnyWearRuntimeStack-beta'), stageStackArn('AnyWearWorkloadStack-beta')],
    }));
    // Existing CDK bootstrap roles still own their reviewed deployment policies.
    // Direct callers cannot assume image-publishing or CFN execution roles.
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [...new Set([this.region, process.env.BILLING_REGION || 'us-east-1'])]
        .flatMap((region) => ['deploy', 'file-publishing', 'lookup'].map((purpose) => (
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${purpose}-role-${this.account}-${region}`
        ))),
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        'ecr:DescribeImages', 'ecr:DescribeImageScanFindings', 'ecr:ListImages', 'ecr:GetLifecyclePolicy'],
      resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/beta-anywear-service`],
    }));

  }
}
