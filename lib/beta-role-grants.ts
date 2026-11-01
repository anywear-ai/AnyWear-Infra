import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { PlatformStack } from './platform-stack';

// Trust is created in Foundation. Importing by physical name avoids introducing
// new Foundation/Platform exports or changing existing cross-stack references.
export function grantBetaDedicatedRoles(stack: cdk.Stack, props: {
  platform: PlatformStack;
  preSignUpLambda: lambda.Function;
  syncLambda: lambda.Function;
}): void {
  const p = props.platform;
  if (!p.cluster || !p.migrationTaskRole || !p.verificationTaskRole || !p.oneShotExecutionRole || !p.lifecycleTaskRole
    || !p.clientBucket || !p.clientDistribution || !p.cleanupTaskRole) throw new Error('Dedicated Beta roles require the existing Beta platform');
  const role = (id: string, name: string) => iam.Role.fromRoleName(stack, id, `beta-${name}-role`, {
    defaultPolicyName: 'DedicatedPolicy',
  });
  const deploy = role('InfraDeployRole', 'infra-deploy');
  const runtime = role('InfraRuntimeRole', 'infra-runtime');
  const data = role('ServiceDataRole', 'service-data');
  const client = role('ClientPublishRole', 'client-publish');
  const e2e = role('E2EQualificationRole', 'e2e-qualification');
  const regional = { StringEquals: { 'aws:RequestedRegion': stack.region } };
  const arn = (service: string, resource: string, resourceName: string, region = stack.region) => stack.formatArn({
    service, resource, resourceName, region,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  // Issue #166: the release slice is the Infra-owned Runtime stack. These
  // read grants follow the stack identity; they do not widen any action.
  const stackArns = ['AnyWearFoundationStack', 'AnyWearPlatformStack-beta', 'AnyWearRuntimeStack-beta']
    .map((name) => arn('cloudformation', 'stack', `${name}/*`));
  const platformAndRuntime = stackArns.slice(1);
  // The tester allowlist is the only admission parameter after #213; there is no
  // mode parameter for any principal to read.
  const admissionNames = ['tester_allowlist'];
  const parameters = (names: string[]) => names.map((name) => arn('ssm', 'parameter', `anywear/beta/${name}`));
  const publicParameters = ['cognito_user_pool_id', 'cognito_client_id', 'aws_region', 's3_bucket_name', 'qweather_api_host'];
  const describeStacks = (principal: iam.IRole, resources = platformAndRuntime) => principal.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources }),
  );
  const getParameters = (principal: iam.IRole, names: string[]) => principal.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['ssm:GetParameter', 'ssm:GetParameters'], resources: parameters(names) }),
  );
  // The Beta stage contract is published as one `/anywear/beta/` prefix. A
  // `deploy-runtime` operation reads the 39 contract names under it (the Runtime
  // conversion replaced the Base stack-output reads with the contract), and the
  // E2E qualification observer reads the same prefix when it qualifies the
  // deployed tuple. The runtime and E2E principals therefore get the prefix read:
  // it is the same two read actions as the named reads above, and no write,
  // delete or version mutation is added here or anywhere else.
  const getStageContractParameters = (principal: iam.IRole) => principal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [arn('ssm', 'parameter', 'anywear/beta/*')],
    }),
  );
  const taskDefinition = (family: string) => arn('ecs', 'task-definition', `beta-anywear-${family}:*`);
  const services = ['api', 'worker'].map((name) => arn('ecs', 'service', `beta-anywear/beta-anywear-${name}`));
  const tasks = arn('ecs', 'task', 'beta-anywear/*');
  const clusterCondition = { ArnEquals: { 'ecs:cluster': p.cluster.clusterArn } };
  const describeRuntime = (principal: iam.IRole) => {
    principal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ecs:DescribeServices'], resources: services }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'], resources: [tasks], conditions: clusterCondition,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks'], resources: ['*'], conditions: clusterCondition,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition'],
      resources: ['*'], conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecr:DescribeImages', 'ecr:BatchGetImage'], resources: [p.repository.repositoryArn],
    }));
  };
  const oneShots = (principal: iam.IRole, families: string[], passRoles: string[]) => {
    const definitions = families.map(taskDefinition);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RegisterTaskDefinition'], resources: definitions, conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:TagResource'], resources: definitions,
      conditions: { StringEquals: { 'aws:RequestedRegion': stack.region, 'ecs:CreateAction': 'RegisterTaskDefinition' } },
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'], resources: definitions, conditions: clusterCondition,
    }));
    // ECS deregistration has no supported resource scope. The reviewed helper
    // must verify exact task-family/run ownership before calling this action.
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DeregisterTaskDefinition'], resources: ['*'], conditions: regional,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: passRoles,
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'],
      resources: families.map((family) => stack.formatArn({
        service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/one-shot:log-stream:beta-anywear-${family}/OneShot/*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      })),
    }));
  };

  // Artifact ECR grants live in Foundation, allowing artifact publication before
  // constructing the Platform app which requires sealed inputs.

  describeStacks(client);
  getParameters(client, ['cognito_user_pool_id', 'cognito_client_id']);
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [p.clientBucket.bucketArn],
  }));
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [p.clientBucket.arnForObjects('*')],
  }));
  client.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: [p.clientDistribution.distributionArn],
  }));

  // Application cleanup remains Service-owned and runs only its two reviewed
  // task families. Lifecycle configuration/start/stop belongs to Infra.
  describeStacks(data);
  describeRuntime(data);
  oneShots(data, ['verify', 'tester-cleanup'], [
    p.verificationTaskRole.roleArn, p.cleanupTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);
  // Issue #185: the operator cleanup's caller-side identity phase preflights the
  // captured identity with a read-only AdminGetUser and deletes exactly that
  // user from the Beta pool. No ListUsers or account-wide listing, and the fixed
  // cleanup task role stays DB/DLQ-only.
  p.userPool.grant(data, 'cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser');

  const billingRegion = process.env.BILLING_REGION || 'us-east-1';
  for (const principal of [deploy, runtime]) {
    describeStacks(principal, stackArns);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:GetTemplate', 'cloudformation:ListStackResources'], resources: stackArns,
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources'],
      resources: [arn('cloudformation', 'stack', 'AnyWearBillingStack-beta/*', billingRegion)],
    }));
    getParameters(principal, [...publicParameters, ...admissionNames, 'infra_selection', 'infra_deployment']);
    describeRuntime(principal);
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      resources: [props.preSignUpLambda.functionArn, props.syncLambda.functionArn],
    }));
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'], resources: [p.vtoQueue.queueArn, p.autoTaggingQueue.queueArn,
        p.vtoDeadLetterQueue.queueArn, p.autoTaggingDeadLetterQueue.queueArn],
    }));
  }
  // Issue #228: the E2E qualification observer discovers the deployed surface
  // through the platform's public list/describe APIs instead of a committed name
  // list. The e2e principal therefore reads the reviewed `AnyWear*` stack prefix
  // in both observation regions (the deploy/runtime principals above keep the
  // named grants) plus the prefix discovery actions. Every statement here is a
  // read-only superset of the previous named grants, so the pre-#228 observer
  // keeps working when this lands first.
  const anywearStackArns = ['AnyWear*/*'].flatMap((resourceName) => [stack.region, billingRegion]
    .map((region) => arn('cloudformation', 'stack', resourceName, region)));
  describeStacks(e2e, anywearStackArns);
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:GetTemplate', 'cloudformation:ListStackResources'], resources: anywearStackArns,
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:ListStacks'], resources: ['*'],
    conditions: { StringEquals: { 'aws:RequestedRegion': [stack.region, billingRegion] } },
  }));
  getParameters(e2e, [...publicParameters, ...admissionNames, 'infra_selection', 'infra_deployment']);
  describeRuntime(e2e);
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
    resources: [stack.formatArn({
      service: 'lambda', resource: 'function', resourceName: 'beta-anywear-*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })],
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['lambda:ListFunctions'], resources: ['*'], conditions: regional,
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['sqs:GetQueueAttributes'],
    resources: [stack.formatArn({ service: 'sqs', resource: 'beta-anywear-*', arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME })],
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['sqs:ListQueues'], resources: ['*'], conditions: regional,
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudfront:ListDistributions'], resources: ['*'],
  }));
  // The discovery read for the stage path: the whole `/anywear/beta/` prefix,
  // conditionless (smoke 40105334687, second-iteration correction recorded on
  // #228). Decryption control is `kms:Decrypt`, which this role does not hold,
  // so `ssm:WithDecryption` is not a usable SSM IAM condition key here, and
  // `ssm:Recursive` binds only the call shape, which the flat-prefix resource
  // scope already bounds. The conditionless form matches the proven
  // `GetParameter`/`GetParameters` prefix statements on the same ARN below.
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ssm:GetParametersByPath'], resources: [arn('ssm', 'parameter', 'anywear/beta/*')],
  }));
  // The observation read surface is the whole stage-contract prefix, not only
  // the nine pre-contract names the deployment/qualification path still reads.
  // The E2E qualification role runs the same observer against the deployed
  // platform, so it needs the same prefix read as the runtime principal.
  getStageContractParameters(runtime);
  getStageContractParameters(e2e);
  // `delete-egress` reads the stack it destroys; Egress is part of the stage's
  // disposable stack set and the runtime role is the operation's read session.
  // This is a separate runtime-only statement: the deploy/client/data/e2e
  // principals do not read the Egress stack.
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources'],
    resources: [arn('cloudformation', 'stack', 'AnyWearEgressStack-beta/*')],
  }));
  // Issue #195: `deploy-runtime` reads the change set back as its AC 4 evidence
  // and executes it. The CDK CLI creates the change set through the bootstrap
  // deploy role; this restricted session only describes, executes or deletes it.
  // The two ARNs are the Runtime stack and its change-set collection; nothing
  // outside the release slice is reachable, and no create action is granted.
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet'],
    resources: [arn('cloudformation', 'stack', 'AnyWearRuntimeStack-beta/*'),
      arn('cloudformation', 'changeSet', '*')],
  }));
  // Issue #254: `deploy-runtime` repairs the Beta edge after its Runtime stack is
  // terminal by writing one Base-stack parameter, so the deploy role may update
  // that one stack. The resource is the Base stack's ARN form the read grants
  // above already use; the operation's call allow-list pins the
  // previous-template shape, so the template itself cannot change, and no
  // CloudFront or PassRole grant is added.
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:UpdateStack'],
    resources: [arn('cloudformation', 'stack', 'AnyWearPlatformStack-beta/*')],
  }));
  // Issue #195: the 300-second six-signal bake runs inside `deploy-runtime` under
  // the read-only runtime session, and its verdict is the step log and the job
  // conclusion (#207). Two read-only statements on the existing read role: the
  // deployed bake alarm states and the worker outbox log lines. No write, no
  // managed policy, no new principal.
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudwatch:DescribeAlarms'],
    resources: [stack.formatArn({
      service: 'cloudwatch', resource: 'alarm', resourceName: 'beta-anywear-*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })],
  }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['logs:FilterLogEvents'],
    resources: ['/anywear/beta/worker', '/anywear/beta/worker:*'].map((name) => stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: name,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })),
  }));
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ec2:DescribeManagedPrefixLists'], resources: ['*'], conditions: regional,
  }));
  // Issue #165: the authorization preflight explains before the operation mutates
  // whether the restricted sessions can perform their reads. The IAM policy
  // simulator actions have no resource-level scope, so the grant is exactly these
  // two actions on `*`, a read of policy evaluation rather than a mutation.
  for (const principal of [deploy, runtime]) {
    principal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:SimulatePrincipalPolicy', 'iam:SimulateCustomPolicy'], resources: ['*'],
    }));
  }
  // Runtime synth resolves the existing CloudFront origin header; this is the
  // only runtime secret read required by the deployment consumer itself.
  deploy.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:/anywear/beta/cloudfront_origin_header-*`],
  }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['ecr:PutImage', 'ecr:GetLifecyclePolicy', 'ecr:StartLifecyclePolicyPreview', 'ecr:GetLifecyclePolicyPreview'],
    resources: [p.repository.repositoryArn],
  }));
  // The four one-shot drivers the runtime session may register and run: the
  // forward migration, the schema-journal probe, the tester allowlist lifecycle and
  // the E2E qualification helper. Each task acts under its own task role, and the run
  // and its platform facts are the evidence; this grant is the invoke surface only.
  oneShots(runtime, ['migrate', 'verify', 'lifecycle', 'artifact-verify'], [
    p.migrationTaskRole.roleArn, p.verificationTaskRole.roleArn, p.lifecycleTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['rds:DescribeDBClusters', 'rds:DescribeEvents', 'cloudwatch:GetMetricStatistics'],
    resources: ['*'], conditions: regional,
  }));
  oneShots(e2e, ['artifact-verify'], [
    p.verificationTaskRole.roleArn, p.oneShotExecutionRole.roleArn,
  ]);
  // The opt-in sizing pre-flight captures each service's autoscaling minimum
  // before any paid workload starts. Application Auto Scaling exposes no
  // resource or tag scope below the account's scalable-target collection, so
  // the Beta region bound is the only narrowing available. Read-only: no
  // scalable-target or scaling-policy mutation is granted here.
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['application-autoscaling:DescribeScalableTargets'],
    resources: [arn('application-autoscaling', 'scalable-target', '*')], conditions: regional,
  }));
  const ownedFunctionNames = ['beta-anywear-pre-sign-up', 'beta-anywear-post-confirmation-sync', 'AnyWearPlatformStack-beta-*'];
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: ['*'], conditions: regional }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:GetFunction'],
    resources: ownedFunctionNames.map(name => `arn:aws:lambda:${stack.region}:${stack.account}:function:${name}`), conditions: regional }));
  runtime.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['logs:PutRetentionPolicy'],
    resources: ownedFunctionNames.map(name => `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/${name}:*`), conditions: regional }));
  p.userPool.grant(e2e, 'cognito-idp:AdminConfirmSignUp', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser',
    'cognito-idp:GetUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminUpdateUserAttributes',
    'cognito-idp:AdminGetUser', 'cognito-idp:AdminInitiateAuth');
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'], resources: [p.wardrobeBucket.arnForObjects('*')],
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['logs:FilterLogEvents'], resources: ['api', 'worker'].map((purpose) => stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: `/anywear/beta/${purpose}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })),
  }));
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['sqs:ReceiveMessage', 'sqs:ChangeMessageVisibility'], resources: [p.autoTaggingDeadLetterQueue.queueArn],
  }));
  // Issue #217: the E2E `reconcile` operation diffs the Beta pool's
  // `AdminCreateUser` CloudTrail events over the 7-day lookback to find
  // identities no lifecycle manifest names. `cloudtrail:LookupEvents` has no
  // resource-level scope, so the statement is exactly that one read-only action
  // on `*`, bound to the Beta region like the other regional reads above. No
  // other CloudTrail action and no account-wide Cognito listing is added.
  e2e.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['cloudtrail:LookupEvents'], resources: ['*'], conditions: regional,
  }));
}
