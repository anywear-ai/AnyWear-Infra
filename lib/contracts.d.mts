// Type declarations for the AnyWear-Infra stage and deployment contract.
//
// The module is plain ESM JavaScript; these declarations are the consumer-facing
// contract for the stage-contract parameter surface, the stack identities, the
// deployed-template normalisation, the task-definition identity, and the
// 300-second six-signal bake gate's stage-free constants and name builders. Issue
// #207 retired the operation/deployment record chain, so the record validators,
// the record-gate block validators and the schema-boundary record member are not
// declared here any more. No build step and no runtime dependencies.

/** The CloudFormation value kind a stage parameter needs. */
export type StageInputKind = 'String' | 'List';

/** One typed stage-base parameter definition. */
export interface StageParameter {
  /** Short parameter suffix, for example `vpc_id`. */
  readonly name: string;
  /** The `CfnParameter` value kind: `String` or `List`. */
  readonly kind: StageInputKind;
  /** Absolute published SSM name, for example `/anywear/beta/vpc_id`. */
  readonly parameter: string;
}

/** The stage the contract names apply to. */
export declare const STAGE_CONTRACT_STAGE: 'beta';

/** The 35 `/anywear/beta/...` names published in every Beta identity phase. */
export declare const STAGE_CONTRACT_PARAMETERS: readonly string[];

/** The one name published only while the identity phase creates the cleanup task role. */
export declare const STAGE_CONTRACT_CONDITIONAL_PARAMETERS: readonly string[];

/** All 36 names a deployment may read: the unconditional 35 plus the conditional one. */
export declare const STAGE_CONTRACT_READ_PARAMETERS: readonly string[];

/**
 * The typed stage-parameter definitions, sorted by absolute SSM name. Includes
 * the conditional `cleanup_task_role_arn`; filter with
 * `STAGE_CONTRACT_CONDITIONAL_PARAMETERS` for a legacy identity phase.
 */
export declare function stageParameters(): readonly StageParameter[];

/** One recorded stage-contract input: parameter name, SSM version and value hash. */
export interface StageInputRow {
  readonly parameter: string;
  readonly version: string;
  readonly value_sha256: string;
}

/** Validate the sorted, unique stage-contract input rows a reader produced. */
export declare function validateStageInputs<T extends readonly StageInputRow[]>(rows: T): T;

/** The schema content hash derived from the recorded inputs. */
export declare function stageContractSchemaHash(rows: readonly StageInputRow[]): string;

/** The repository that owns the shared infrastructure, Foundation and stage base. */
export declare const INFRA_REPOSITORY: 'anywear-ai/AnyWear-Infra';

/** The repository that owns the release source; since #195 it produces no record. */
export declare const SERVICE_REPOSITORY: 'anywear-ai/AnyWear-Service';

/** `platformStackName('beta')` -> `AnyWearPlatformStack-beta`. */
export declare function platformStackName(stage: string): string;

/** `runtimeStackName('beta')` -> `AnyWearRuntimeStack-beta`. */
export declare function runtimeStackName(stage: string): string;

/** The release slice's one stack and the Infra workflow that deploys it. */
export interface ServiceRuntimeStack {
  readonly name: string;
  readonly region: string;
  readonly workflow_path: string;
}

export declare const SERVICE_RUNTIME_STACK: ServiceRuntimeStack;

/** The declared normalisation of a deployed template, as human-readable rules. */
export declare const DEPLOYED_TEMPLATE_NORMALISATION: readonly string[];

/**
 * Return a normalised copy of a deployed or synthesized CloudFormation template:
 * resource `Metadata` removed, the `CDKMetadata` resource and the
 * `CDKMetadataAvailable` condition dropped. The input is not mutated.
 */
export declare function normaliseDeployedTemplate(template: unknown): Record<string, unknown>;

/** The canonical sha256 of a deployed template after {@link normaliseDeployedTemplate}. */
export declare function canonicalDeployedTemplateHash(template: unknown): string;

/** The fixed, ordered names of the six baked signals. */
export declare const DEPLOYMENT_GATE_SIGNAL_NAMES: readonly string[];

/** The three GetQueueAttributes names the live SQS API accepts for depth. */
export declare const DEPLOYMENT_SQS_DEPTH_ATTRIBUTES: readonly string[];

/** The one stage-free threshold table, keyed by signal name. */
export declare const DEPLOYMENT_GATE_THRESHOLDS: Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The fixed comparison string of each signal, keyed by signal name. */
export declare const DEPLOYMENT_GATE_COMPARISONS: Readonly<Record<string, string>>;

/** The gate window: exactly 300 seconds. */
export declare const DEPLOYMENT_GATE_DURATION_SECONDS: 300;

/** Probe cadence: one `GET /readyz` every 15 seconds. */
export declare const DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS: 15;

/** Minimum probes and the ALB `RequestCount` floor for a usable 5xx denominator. */
export declare const DEPLOYMENT_GATE_REQUEST_FLOOR: 15;

/** The probe budget of a 300-second window. */
export declare const DEPLOYMENT_GATE_MAX_PROBES: 20;

/** The suffix every bake-gate name carries: `-anywear-deployment-bake`. */
export declare const DEPLOYMENT_GATE_NAME_SUFFIX: 'anywear-deployment-bake';

/** `deploymentBakeName('beta')` -> `beta-anywear-deployment-bake`. */
export declare function deploymentBakeName(stage: string): string;

/** The stage encoded in `AnyWearRuntimeStack-<stage>`. */
export declare function runtimeStageFromStack(stackName: string): string;

/** The deployed alarm names for one signal, for example `beta-anywear-alb-5xx`. */
export declare function deploymentAlarmName(stage: string, signalName: string): readonly string[];

/** The six signals' deployed alarm names, keyed by signal name. */
export declare function deploymentAlarmNames(stage: string): Readonly<Record<string, readonly string[]>>;

/** The stage-base queues the bake reads, keyed by purpose. */
export declare function deploymentQueueNames(stage: string): {
  readonly vto: string;
  readonly vto_dlq: string;
  readonly auto_tagging: string;
  readonly auto_tagging_dlq: string;
};

/** The normalized task-definition identity whose content hash names a deployment. */
export interface StableTaskDefinition {
  readonly family: unknown;
  readonly taskRoleArn: unknown;
  readonly executionRoleArn: unknown;
  readonly networkMode: unknown;
  readonly cpu: unknown;
  readonly memory: unknown;
  readonly container: {
    readonly name: unknown;
    readonly image: string;
    readonly command: unknown;
    readonly environment: readonly { readonly name: string; readonly value: string }[];
  };
}

/** Normalize a deployed task definition to its stable identity fields. */
export declare function stableTaskDefinition(definition: unknown): StableTaskDefinition;

/** The sha256 content hash of the normalized task definition. */
export declare function taskDefinitionContentHash(definition: unknown): string;

// Issue #195 retired the Foundation per-service deploy roles. The Runtime stack is
// deployed by the existing `beta-infra-deploy-role` through the standard CDK
// bootstrap path, so the role-naming and OIDC-subject helpers left with them.
