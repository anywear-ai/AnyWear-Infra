import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  STAGE_CONTRACT_CONDITIONAL_PARAMETERS,
  STAGE_CONTRACT_PARAMETERS,
  STAGE_CONTRACT_STAGE,
  stageContractSchemaHash,
  stageParameters,
  type StageParameter,
} from './contracts.mjs';

export type Stage = 'beta' | 'prod';
export type IdentityPhase = 'legacy' | 'roles-added' | 'retired';

/**
 * `IDatabaseCluster` omits the attached secret even though the imported
 * cluster carries it; the Workload grants read access through that secret.
 */
export type PlatformDatabase = rds.IDatabaseCluster & { readonly secret?: secretsmanager.ISecret };

/** The application region; the Platform stack and every weak read live here. */
export const PLATFORM_REGION = 'ap-east-1';

/** The two Availability Zones of the Platform VPC (subnet id order follows). */
const ZONES = ['ap-east-1a', 'ap-east-1b'];

/**
 * One stage-base value the release slice consumes.
 *
 * `parameter` is the suffix the Platform stack publishes under
 * `/anywear/<stage>/`; `output` is the exact `PublishOutput...` name the
 * historical reference-form baseline read before the SSM conversion. `index`
 * is set when the value was one element of a published `StringList` parameter.
 * `publication` records the phase-aware rule: the eight cleanup fixtures that
 * exist in every Platform phase are `always`; the cleanup task role exists only
 * at `identityPhase !== 'legacy'`. Values without `publication` are the reads
 * that exist in every phase, including the unconditional `api_base_url` the
 * Base stack publishes for the Client-facing API endpoint.
 */
export type PlatformPublication = 'always' | 'non-legacy';
export type PlatformReference = {
  readonly parameter: string;
  readonly kind: 'String';
  readonly output?: string;
  readonly publication?: PlatformPublication;
} | {
  readonly parameter: string;
  readonly kind: 'List';
  readonly index: number;
  readonly output: string;
  readonly publication?: PlatformPublication;
};

/**
 * The reviewed stage-base contract (AnyWear #158 step D, extended by #166).
 *
 * The Base stack publishes these names. The Runtime template resolves them with
 * `AWS::SSM::Parameter::Value<String>` / `<List<String>>` parameters at deploy
 * time, so the release slice needs no `Fn::GetStackOutput` read of the stage
 * base. Every legacy entry records the exact Platform output it replaced;
 * `test/workload-identity.test.ts` cross-checks the same list against
 * `test/baselines/provenance.json`.
 */
export const PLATFORM_REFERENCES = {
  // Platform VPC (`AnyWearVpc`) and its Public/Private/Isolated subnet tiers.
  vpcId: { parameter: 'vpc_id', kind: 'String', output: 'PublishOutputRefAnyWearVpcA8B15590AB9CA509' },
  publicSubnet1: {
    parameter: 'public_subnet_ids', kind: 'List', index: 0,
    output: 'PublishOutputRefAnyWearVpcPublicSubnet1Subnet5CC36A8305BC9630',
  },
  publicSubnet2: {
    parameter: 'public_subnet_ids', kind: 'List', index: 1,
    output: 'PublishOutputRefAnyWearVpcPublicSubnet2Subnet78E1776F16455447',
  },
  privateSubnet1: {
    parameter: 'private_subnet_ids', kind: 'List', index: 0,
    output: 'PublishOutputRefAnyWearVpcPrivateSubnet1Subnet2CB21A9B8EE63669',
  },
  privateSubnet2: {
    parameter: 'private_subnet_ids', kind: 'List', index: 1,
    output: 'PublishOutputRefAnyWearVpcPrivateSubnet2Subnet360A1C5092550D4E',
  },
  // Aurora cluster endpoint and its attached secret (`AnyWearDatabase`).
  databaseEndpointAddress: {
    parameter: 'database_host', kind: 'String',
    output: 'PublishOutputFnGetAttAnyWearDatabase2CD487D8EndpointAddress8F10C00D',
  },
  databaseEndpointPort: {
    parameter: 'database_port', kind: 'String',
    output: 'PublishOutputFnGetAttAnyWearDatabase2CD487D8EndpointPort898B970A',
  },
  databaseSecretArn: {
    parameter: 'database_secret_arn', kind: 'String',
    output: 'PublishOutputRefAnyWearDatabaseSecretAttachment4886B38144EA741B',
  },
  // Wardrobe bucket (`AnyWearWardrobeBucket`): ARN and the reused name.
  wardrobeBucketArn: {
    parameter: 's3_bucket_arn', kind: 'String',
    output: 'PublishOutputFnGetAttAnyWearWardrobeBucket61DCC096Arn724558D0',
  },
  wardrobeBucketName: {
    parameter: 's3_bucket_name', kind: 'String',
    output: 'PublishOutputRefAnyWearWardrobeBucket61DCC096146CB5ED',
  },
  // Service repository (`AsyncRuntime`), queues and dead-letter queues.
  repositoryArn: {
    parameter: 'service_repository_arn', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeServiceRepository6535F885Arn0E0FEE89',
  },
  repositoryName: {
    parameter: 'service_repository_name', kind: 'String',
    output: 'PublishOutputRefAsyncRuntimeServiceRepository6535F885E981090C',
  },
  vtoQueueArn: {
    parameter: 'vto_queue_arn', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeVtoQueue7826D09DArnE4D35296',
  },
  vtoQueueName: {
    parameter: 'vto_queue_name', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeVtoQueue7826D09DQueueNameE55C65DE',
  },
  vtoQueueUrl: {
    parameter: 'vto_queue_url', kind: 'String',
    output: 'PublishOutputRefAsyncRuntimeVtoQueue7826D09D30543F7E',
  },
  autoTaggingQueueArn: {
    parameter: 'auto_tagging_queue_arn', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeAutoTaggingQueueEC10AA50ArnF3081676',
  },
  autoTaggingQueueName: {
    parameter: 'auto_tagging_queue_name', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeAutoTaggingQueueEC10AA50QueueName4DC945B2',
  },
  autoTaggingQueueUrl: {
    parameter: 'auto_tagging_queue_url', kind: 'String',
    output: 'PublishOutputRefAsyncRuntimeAutoTaggingQueueEC10AA508CE2FD1E',
  },
  vtoDeadLetterQueueName: {
    parameter: 'vto_dlq_name', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeVtoDeadLetterQueueE526C0CEQueueNameB688750E',
  },
  autoTaggingDeadLetterQueueName: {
    parameter: 'auto_tagging_dlq_name', kind: 'String',
    output: 'PublishOutputFnGetAttAsyncRuntimeAutoTaggingDeadLetterQueueD5D55868QueueName504A8E35',
  },
  // Shared ECS cluster (`Cluster`).
  clusterName: { parameter: 'ecs_cluster_name', kind: 'String', output: 'PublishOutputRefClusterEB0386A7D87642F6' },
  // Security groups: API, worker and load balancer.
  apiSecurityGroupId: {
    parameter: 'api_security_group_id', kind: 'String',
    output: 'PublishOutputFnGetAttApiSecurityGroup4E5BB726GroupIdF3427EAD',
  },
  workerSecurityGroupId: {
    parameter: 'worker_security_group_id', kind: 'String',
    output: 'PublishOutputFnGetAttWorkerSecurityGroup5529CF0BGroupId1D09B9A4',
  },
  loadBalancerSecurityGroupId: {
    parameter: 'load_balancer_security_group_id', kind: 'String',
    output: 'PublishOutputFnGetAttLoadBalancerSecurityGroup3036A0FCGroupId273B4B7E',
  },
  // Cognito user pool and client (already published before this conversion).
  userPoolId: {
    parameter: 'cognito_user_pool_id', kind: 'String',
    output: 'PublishOutputRefAnyWearUserPoolAFAAA9816AD1F62D',
  },
  userPoolClientId: {
    parameter: 'cognito_client_id', kind: 'String',
    output: 'PublishOutputRefAnyWearUserPoolClient15EC205A2F344351',
  },
  // Beta operations topic (`Ref` = topic ARN; beta only).
  operationsTopicArn: {
    parameter: 'operations_topic_arn', kind: 'String',
    output: 'PublishOutputRefOperationsTopicC9C1CC12DC655C30',
  },
  // The repository URI the release slice pulls and reports. It used to be
  // composed from the repository ARN/name outputs; it is now its own stage-base
  // value so the URI itself is a recorded deployment input.
  repositoryUri: { parameter: 'service_repository_uri', kind: 'String' },
  // The public API base URL. Since #166 the API CloudFront distribution lives
  // in Infra Base and publishes this value; Runtime no longer owns or
  // synthesizes the distribution and consumes the URL as a required,
  // unconditional stage input.
  apiBaseUrl: { parameter: 'api_base_url', kind: 'String' },
  // The #86 cleanup-fixture identities. They identify the one-shot execution
  // surface (three IAM roles, the one-shot log group and its security group)
  // plus the cluster ARN and the two DLQ URLs the cleanup state machine passes
  // to its tasks. Platform publishes eight of them in every phase; the cleanup
  // task role exists only at `identityPhase !== 'legacy'`.
  cleanupTaskRoleArn: {
    parameter: 'cleanup_task_role_arn', kind: 'String', publication: 'non-legacy',
    output: 'PublishOutputFnGetAttCleanupTaskRoleF315C2CAArn2EB4E994',
  },
  verificationTaskRoleArn: {
    parameter: 'verification_task_role_arn', kind: 'String', publication: 'always',
    output: 'PublishOutputFnGetAttVerificationTaskRoleF6CF2A5DArnB22041FB',
  },
  oneShotExecutionRoleArn: {
    parameter: 'one_shot_execution_role_arn', kind: 'String', publication: 'always',
    output: 'PublishOutputFnGetAttOneShotExecutionRoleE1BB48E7Arn39CA2DDF',
  },
  oneShotLogGroupArn: {
    parameter: 'one_shot_log_group_arn', kind: 'String', publication: 'always',
    output: 'PublishOutputFnGetAttOneShotLogGroup31A8D153Arn0ADD13BC',
  },
  oneShotLogGroupName: {
    parameter: 'one_shot_log_group_name', kind: 'String', publication: 'always',
    output: 'PublishOutputRefOneShotLogGroup31A8D153831F5076',
  },
  oneShotSecurityGroupId: {
    parameter: 'one_shot_security_group_id', kind: 'String', publication: 'always',
    output: 'PublishOutputFnGetAttOneShotSecurityGroup6BBA5E34GroupIdB64CCD4A',
  },
  clusterArn: {
    parameter: 'ecs_cluster_arn', kind: 'String', publication: 'always',
    output: 'PublishOutputFnGetAttClusterEB0386A7Arn0CAA3DA3',
  },
  vtoDeadLetterQueueUrl: {
    parameter: 'vto_dlq_url', kind: 'String', publication: 'always',
    output: 'PublishOutputRefAsyncRuntimeVtoDeadLetterQueueE526C0CEC16C2935',
  },
  autoTaggingDeadLetterQueueUrl: {
    parameter: 'auto_tagging_dlq_url', kind: 'String', publication: 'always',
    output: 'PublishOutputRefAsyncRuntimeAutoTaggingDeadLetterQueueD5D55868858C7817',
  },
} as const satisfies Record<string, PlatformReference>;

/** The four names the Platform stack already published before this conversion. */
export const REUSED_PARAMETER_NAMES = [
  'cognito_user_pool_id',
  'cognito_client_id',
  's3_bucket_name',
  'qweather_api_host',
] as const;

/**
 * The typed stage-base contract from `lib/contracts.mjs`: 36 definitions (35
 * published in every Beta identity phase plus the phase-conditional
 * `cleanup_task_role_arn`).
 *
 * The contract names the Beta stage (`/anywear/beta/...`) and imports no CDK
 * module; the Service app is the producer of its own `CfnParameter`s.
 * `platformParameterName` scopes the same suffixes to the synthesized stage, and
 * the contract's `kind` selects `Value<String>` or `Value<List<String>>`.
 */
const STAGE_CONTRACT_DEFINITIONS = stageParameters();
const STAGE_CONTRACT_NAME_SET = new Set(STAGE_CONTRACT_DEFINITIONS.map((definition) => definition.name));
const CONDITIONAL_STAGE_CONTRACT_NAMES = new Set(STAGE_CONTRACT_DEFINITIONS
  .filter((definition) => STAGE_CONTRACT_CONDITIONAL_PARAMETERS.includes(definition.parameter))
  .map((definition) => definition.name));

// The app declares its own parameters, so the contract surface is a build-time
// invariant: a contract change that removes, renames or reclassifies a definition
// must fail here instead of silently dropping a stage-base read.
if (STAGE_CONTRACT_DEFINITIONS.length !== 36
  || STAGE_CONTRACT_PARAMETERS.length !== 35
  || STAGE_CONTRACT_CONDITIONAL_PARAMETERS.length !== 1
  || CONDITIONAL_STAGE_CONTRACT_NAMES.size !== 1
  || STAGE_CONTRACT_NAME_SET.size !== 36) {
  throw new Error('The lib/contracts.mjs surface is not the reviewed 36/35/1 contract');
}

/** The 36 contract definitions plus the four reused Platform names. */
const STAGE_INPUT_DEFINITIONS: ReadonlyMap<string, StageParameter> = new Map([
  ...STAGE_CONTRACT_DEFINITIONS.map((definition) => [definition.name, definition] as const),
  ...REUSED_PARAMETER_NAMES.map((name) => [name, {
    name,
    kind: 'String',
    parameter: platformParameterName(STAGE_CONTRACT_STAGE, name),
  }] as const),
]);

/**
 * The content identity of the stage-contract surface, computed with the
 * package's own schema function.
 *
 * `stageContractSchemaHash` hashes the sorted `{parameter, version}` pairs of a
 * stage-input row set. At synth time no SSM version exists, so this pins the
 * *name surface* at contract generation 1: a package change that renames, removes
 * or reorders a definition changes the hash, and the pinned value below fails
 * before synthesis. It is a source-level fingerprint: a deploy reads each
 * parameter's real SSM `Version` from the live contract, and no artifact writes
 * this constant as an input version (#207).
 */
export const STAGE_CONTRACT_SURFACE_HASH = stageContractSchemaHash(
  STAGE_CONTRACT_DEFINITIONS.map((definition) => ({
    parameter: definition.parameter,
    version: '1',
    value_sha256: '0'.repeat(64),
  })),
);

/** The full stage-base contract: the 36 package names plus the reused four. */
export const STAGE_CONTRACT_PARAMETER_NAMES: readonly string[] = [
  ...STAGE_CONTRACT_DEFINITIONS.map((definition) => definition.name),
  ...REUSED_PARAMETER_NAMES,
];

export interface PlatformInputsProps {
  stage: Stage;
  identityPhase: IdentityPhase;
}

/**
 * The typed Platform values the release slice consumes.
 *
 * Every value is a `<stage>`-scoped SSM parameter published by the Base stack,
 * which CloudFormation resolves at deploy time; the release slice keeps no weak
 * `Fn::GetStackOutput` read. Cleanup-only values are declared only at the
 * `roles-added`/`retired` identity phases, matching the Base publication's
 * phase rules. The Runtime stack exists only while the environment runs, so
 * there is no stopped variant.
 */
export interface PlatformInputs {
  stage: Stage;
  vpc: ec2.IVpc;
  database: PlatformDatabase;
  wardrobeBucket: s3.IBucket;
  repository: ecr.IRepository;
  /** The recorded ECR URI (`service_repository_uri`), not an ARN derivation. */
  repositoryUri: string;
  /** The Base-published public API URL (`api_base_url`); Runtime owns no distribution. */
  apiBaseUrl: string;
  vtoQueue: sqs.IQueue;
  vtoDeadLetterQueue: sqs.IQueue;
  autoTaggingQueue: sqs.IQueue;
  autoTaggingDeadLetterQueue: sqs.IQueue;
  cluster: ecs.ICluster;
  apiSecurityGroup: ec2.ISecurityGroup;
  workerSecurityGroup: ec2.ISecurityGroup;
  loadBalancerSecurityGroup: ec2.ISecurityGroup;
  operationsTopic?: sns.ITopic;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  qWeatherApiKeySecret: secretsmanager.ISecret;
  /**
   * Subnets the one-shot cleanup tasks run in: the Base VPC's private tier.
   * Since #166 that tier is the only private tier and the Egress stack provides
   * its NAT route, so the value is the imported VPC's private subnets.
   */
  cleanupSubnets: ec2.ISubnet[];
  cleanupTaskRole?: iam.IRole;
  verificationTaskRole?: iam.IRole;
  oneShotExecutionRole?: iam.IRole;
  oneShotLogGroup?: logs.ILogGroup;
  oneShotSecurityGroup?: ec2.ISecurityGroup;
}

/** The full `/anywear/<stage>/...` name of a stage-base parameter. */
export function platformParameterName(stage: Stage, parameter: string): string {
  return `/anywear/${stage}/${parameter}`;
}

/** A role import that carries the recorded ARN and accepts no policy mutations. */
function importedRole(scope: Construct, id: string, arn: string): iam.IRole {
  const role = iam.Role.fromRoleArn(scope, id, arn);
  // The one-shot execution role already owns its policies in the Platform
  // stack. The old same-app reference mutated that role after the Platform
  // template was synthesized, so the grant never landed; a mutation on an
  // imported role would instead create a new Workload policy resource.
  (role as unknown as { addToPrincipalPolicy: () => { statementAdded: boolean } })
    .addToPrincipalPolicy = () => ({ statementAdded: false });
  return role;
}

/** A `logs.ILogGroup` whose name and ARN are the two recorded Platform outputs. */
function importedLogGroup(scope: Construct, id: string, arn: string, name: string): logs.ILogGroup {
  // `fromLogGroupName` gives a same-stack log group whose name is the read; the
  // ARN is replaced with the Platform `Fn::GetAtt Arn` output. Splitting a token
  // ARN to recover the name (as `fromLogGroupArn` does) cannot reproduce the
  // recorded value, because the Platform ARN ends in `:*` at render time.
  const group = logs.LogGroup.fromLogGroupName(scope, id, name) as logs.LogGroup;
  (group as unknown as { logGroupArn: string }).logGroupArn = arn;
  return group;
}

export function platformInputs(scope: Construct, props: PlatformInputsProps): PlatformInputs {
  const stage = props.stage;
  const phaseHasCleanupRoles = props.identityPhase !== 'legacy';
  // The package owns the publication rule: the conditional cleanup task role
  // exists only while the identity phase creates it, and the four reused names
  // were published before the contract.
  const publishedStageNames = new Set([
    ...STAGE_CONTRACT_DEFINITIONS
      .filter((definition) => phaseHasCleanupRoles || !CONDITIONAL_STAGE_CONTRACT_NAMES.has(definition.name))
      .map((definition) => definition.name),
    ...REUSED_PARAMETER_NAMES,
  ]);
  /** A stage-base value resolved by CloudFormation from `/anywear/<stage>/...`. */
  const read = (reference: PlatformReference): string => {
    const definition = STAGE_INPUT_DEFINITIONS.get(reference.parameter);
    if (!definition) throw new Error(`Unknown stage-base parameter ${reference.parameter}`);
    if (!publishedStageNames.has(definition.name)) {
      throw new Error(`Stage-base parameter ${reference.parameter} is not published at ${props.identityPhase}`);
    }
    // The absolute name is the package's Beta name; another stage keeps the same
    // reviewed suffix under its own `/anywear/<stage>/...` prefix.
    const parameterName = stage === STAGE_CONTRACT_STAGE
      ? definition.parameter
      : platformParameterName(stage, definition.name);
    if (reference.kind === 'String') {
      if (definition.kind !== 'String') {
        throw new Error(`Stage-base parameter ${reference.parameter} is a ${definition.kind}, not a String`);
      }
      return ssm.StringParameter.valueForStringParameter(scope, parameterName);
    }
    if (definition.kind !== 'List') {
      throw new Error(`Stage-base parameter ${reference.parameter} is a ${definition.kind}, not a List`);
    }
    return cdk.Fn.select(reference.index,
      ssm.StringListParameter.valueForTypedListParameter(scope, parameterName));
  };

  const vpc = ec2.Vpc.fromVpcAttributes(scope, 'PlatformVpc', {
    vpcId: read(PLATFORM_REFERENCES.vpcId),
    availabilityZones: ZONES,
    publicSubnetIds: [read(PLATFORM_REFERENCES.publicSubnet1), read(PLATFORM_REFERENCES.publicSubnet2)],
    privateSubnetIds: [read(PLATFORM_REFERENCES.privateSubnet1), read(PLATFORM_REFERENCES.privateSubnet2)],
  });
  const databaseSecret = secretsmanager.Secret.fromSecretAttributes(scope, 'PlatformDatabaseSecret', {
    secretCompleteArn: read(PLATFORM_REFERENCES.databaseSecretArn),
  });
  const database = rds.DatabaseCluster.fromDatabaseClusterAttributes(scope, 'PlatformDatabase', {
    clusterIdentifier: 'platform-database-identity-not-read',
    clusterEndpointAddress: read(PLATFORM_REFERENCES.databaseEndpointAddress),
    port: cdk.Token.asNumber(read(PLATFORM_REFERENCES.databaseEndpointPort)),
    secret: databaseSecret,
  }) as PlatformDatabase;
  const wardrobeBucket = s3.Bucket.fromBucketAttributes(scope, 'PlatformWardrobeBucket', {
    bucketArn: read(PLATFORM_REFERENCES.wardrobeBucketArn),
    bucketName: read(PLATFORM_REFERENCES.wardrobeBucketName),
  });
  const repository = ecr.Repository.fromRepositoryAttributes(scope, 'PlatformRepository', {
    repositoryArn: read(PLATFORM_REFERENCES.repositoryArn),
    repositoryName: read(PLATFORM_REFERENCES.repositoryName),
  });
  const queue = (id: string, arn: PlatformReference, name: PlatformReference, url: PlatformReference): sqs.IQueue =>
    sqs.Queue.fromQueueAttributes(scope, id, {
      queueArn: read(arn), queueName: read(name), queueUrl: read(url),
    });
  const vtoQueue = queue('PlatformVtoQueue', PLATFORM_REFERENCES.vtoQueueArn,
    PLATFORM_REFERENCES.vtoQueueName, PLATFORM_REFERENCES.vtoQueueUrl);
  const autoTaggingQueue = queue('PlatformAutoTaggingQueue', PLATFORM_REFERENCES.autoTaggingQueueArn,
    PLATFORM_REFERENCES.autoTaggingQueueName, PLATFORM_REFERENCES.autoTaggingQueueUrl);
  // The dead-letter queues are read by name (alarm dimension) plus the cleanup
  // URL; the ARN is composed from the recorded name for the imported object
  // and never renders.
  const deadLetterQueue = (id: string, name: PlatformReference, url: PlatformReference): sqs.IQueue =>
    sqs.Queue.fromQueueAttributes(scope, id, {
      queueArn: cdk.Fn.join('', ['arn:aws:sqs:', PLATFORM_REGION, ':650880818323:', read(name)]),
      queueName: read(name),
      queueUrl: read(url),
    });
  const vtoDeadLetterQueue = deadLetterQueue('PlatformVtoDeadLetterQueue',
    PLATFORM_REFERENCES.vtoDeadLetterQueueName, PLATFORM_REFERENCES.vtoDeadLetterQueueUrl);
  const autoTaggingDeadLetterQueue = deadLetterQueue('PlatformAutoTaggingDeadLetterQueue',
    PLATFORM_REFERENCES.autoTaggingDeadLetterQueueName, PLATFORM_REFERENCES.autoTaggingDeadLetterQueueUrl);
  // These eight cleanup fixtures exist in every Platform phase. Their values
  // are consumed only by CleanupOperation, but the parameters are declared at
  // every identity phase to match the reviewed publication rule.
  const verificationTaskRoleArn = read(PLATFORM_REFERENCES.verificationTaskRoleArn);
  const oneShotExecutionRoleArn = read(PLATFORM_REFERENCES.oneShotExecutionRoleArn);
  const oneShotLogGroupArn = read(PLATFORM_REFERENCES.oneShotLogGroupArn);
  const oneShotLogGroupName = read(PLATFORM_REFERENCES.oneShotLogGroupName);
  const oneShotSecurityGroupId = read(PLATFORM_REFERENCES.oneShotSecurityGroupId);
  const clusterArn = read(PLATFORM_REFERENCES.clusterArn);
  // The cleanup task role is the only cleanup value Platform publishes solely
  // at `identityPhase !== 'legacy'`.
  const cleanupTaskRoleArn = phaseHasCleanupRoles
    ? read(PLATFORM_REFERENCES.cleanupTaskRoleArn)
    : undefined;
  const cluster = ecs.Cluster.fromClusterAttributes(scope, 'PlatformCluster', {
    clusterName: read(PLATFORM_REFERENCES.clusterName),
    clusterArn,
    vpc,
    securityGroups: [],
  });
  const securityGroup = (id: string, reference: PlatformReference): ec2.ISecurityGroup =>
    // Immutable imports intentionally do not accept rule mutations. Platform
    // owns every rule on these groups (the ALB->API rule already exists there);
    // the old same-app reference silently lost the late rule instead of adding
    // a duplicate, and the Workload template must not gain one now.
    ec2.SecurityGroup.fromSecurityGroupId(scope, id, read(reference), {
      allowAllOutbound: true,
      mutable: false,
    });
  const apiSecurityGroup = securityGroup('PlatformApiSecurityGroup', PLATFORM_REFERENCES.apiSecurityGroupId);
  const workerSecurityGroup = securityGroup('PlatformWorkerSecurityGroup', PLATFORM_REFERENCES.workerSecurityGroupId);
  const loadBalancerSecurityGroup = securityGroup('PlatformLoadBalancerSecurityGroup',
    PLATFORM_REFERENCES.loadBalancerSecurityGroupId);
  const oneShotSecurityGroup = phaseHasCleanupRoles
    ? ec2.SecurityGroup.fromSecurityGroupId(scope, 'PlatformOneShotSecurityGroup',
      oneShotSecurityGroupId, { allowAllOutbound: true, mutable: false })
    : undefined;
  const operationsTopic = stage === 'beta'
    ? sns.Topic.fromTopicArn(scope, 'PlatformOperationsTopic', read(PLATFORM_REFERENCES.operationsTopicArn))
    : undefined;
  const qWeatherApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
    scope,
    'PlatformQWeatherApiKeySecret',
    `/anywear/${stage}/qweather_api_key`,
  );

  // The Base VPC's private tier is the one private tier; the Egress stack owns
  // its NAT route while the environment runs. The list is consumed only by the
  // cleanup operation, so it is built only when cleanup exists.
  const cleanupSubnets = phaseHasCleanupRoles ? vpc.privateSubnets : [];

  return {
    stage: props.stage,
    vpc,
    database,
    wardrobeBucket,
    repository,
    repositoryUri: read(PLATFORM_REFERENCES.repositoryUri),
    apiBaseUrl: read(PLATFORM_REFERENCES.apiBaseUrl),
    vtoQueue,
    vtoDeadLetterQueue,
    autoTaggingQueue,
    autoTaggingDeadLetterQueue,
    cluster,
    apiSecurityGroup,
    workerSecurityGroup,
    loadBalancerSecurityGroup,
    operationsTopic,
    cognitoUserPoolId: read(PLATFORM_REFERENCES.userPoolId),
    cognitoClientId: read(PLATFORM_REFERENCES.userPoolClientId),
    qWeatherApiKeySecret,
    cleanupSubnets,
    ...(phaseHasCleanupRoles ? {
      cleanupTaskRole: importedRole(scope, 'PlatformCleanupTaskRole', cleanupTaskRoleArn!),
      verificationTaskRole: importedRole(scope, 'PlatformVerificationTaskRole', verificationTaskRoleArn),
      oneShotExecutionRole: importedRole(scope, 'PlatformOneShotExecutionRole', oneShotExecutionRoleArn),
      oneShotLogGroup: importedLogGroup(scope, 'PlatformOneShotLogGroup',
        oneShotLogGroupArn, oneShotLogGroupName),
      oneShotSecurityGroup,
    } : {}),
  };
}
