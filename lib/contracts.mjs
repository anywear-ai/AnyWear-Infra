// AnyWear-Infra stage and deployment contract
//
// The dependency-free source of the AnyWear Beta stage contract:
// the SSM parameter surface the stage base publishes, the stack identities, the
// deployed-template normalisation, the task-definition identity, and the bake
// gate's stage-free thresholds, signal names and resource-name builders.
// AnyWear-Infra's CDK app, operation scripts and tests import it directly, so no
// other repository pins a packed tarball. Nothing here reads AWS, CloudFormation
// or the filesystem.
//
// Issue #207 retired the operation/deployment record chain, so the record
// validators (`anywear_infra_*`, `anywear_service_deployment`) and the
// record-gate block validators are gone. The controls that remain are the
// schema-boundary gate, the 300-second six-signal bake, deployment authorization
// and the pre-credential release-byte proof; only their stage-free constants and
// builders live here. The schema-boundary comparison shape is owned by the gate
// that produces it, not by this package.
//
// The stage reading itself belongs to the consumer: `stageParameters()` returns
// the typed definitions, and a CDK app creates its own
// `AWS::SSM::Parameter::Value<String|List<String>>` `CfnParameter`s from them.
// Keeping `aws-cdk-lib` out keeps this package usable by plain Node scripts.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Canonical JSON and content hashing
//
// The record's `schema.content_sha256` and each task-definition identity are
// content hashes over RFC 8785-style canonical JSON. The same bytes must hash the
// same here and in AnyWear-Service, so this stays self-contained instead of
// importing another repository's helper.

// RFC 8785 uses ECMAScript number serialization and UTF-16 property sorting.
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate');
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Unpaired Unicode surrogate');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== undefined) return `{${Object.keys(value).sort()
    .map(key => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Unsupported JSON value');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contentHash(value) {
  return sha256(canonicalJson(value));
}

const HASH = /^[a-f0-9]{64}$/;

function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error(`Invalid ${label} fields`);
  return value;
}

function matches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

// ---------------------------------------------------------------------------
// Stage contract
//
// The stage base is published as plain SSM parameters under
// `/anywear/beta/...`. Every name in `STAGE_CONTRACT_PARAMETERS` exists in every
// Beta identity phase and environment variant. `cleanup_task_role_arn` exists
// only while the phase creates the cleanup task role (`identityPhase !==
// 'legacy'`), so a reader accepts its absence and never accepts a missing
// unconditional name. `api_base_url` is the public API distribution endpoint the
// Base stack owns (0.3.0); it is unconditional like the other resource values.

export const STAGE_CONTRACT_STAGE = 'beta';

const STAGE_CONTRACT_DEFINITIONS = Object.freeze([
  { name: 'api_base_url', kind: 'String', conditional: false },
  { name: 'api_security_group_id', kind: 'String', conditional: false },
  { name: 'auto_tagging_dlq_name', kind: 'String', conditional: false },
  { name: 'auto_tagging_dlq_url', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_arn', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_name', kind: 'String', conditional: false },
  { name: 'auto_tagging_queue_url', kind: 'String', conditional: false },
  { name: 'cleanup_task_role_arn', kind: 'String', conditional: true },
  { name: 'cloudfront_prefix_list_id', kind: 'String', conditional: false },
  { name: 'database_host', kind: 'String', conditional: false },
  { name: 'database_port', kind: 'String', conditional: false },
  { name: 'database_secret_arn', kind: 'String', conditional: false },
  { name: 'ecs_cluster_arn', kind: 'String', conditional: false },
  { name: 'ecs_cluster_name', kind: 'String', conditional: false },
  { name: 'isolated_subnet_ids', kind: 'List', conditional: false },
  { name: 'load_balancer_security_group_id', kind: 'String', conditional: false },
  { name: 'one_shot_execution_role_arn', kind: 'String', conditional: false },
  { name: 'one_shot_log_group_arn', kind: 'String', conditional: false },
  { name: 'one_shot_log_group_name', kind: 'String', conditional: false },
  { name: 'one_shot_security_group_id', kind: 'String', conditional: false },
  { name: 'operations_topic_arn', kind: 'String', conditional: false },
  { name: 'private_subnet_ids', kind: 'List', conditional: false },
  { name: 'public_subnet_ids', kind: 'List', conditional: false },
  { name: 's3_bucket_arn', kind: 'String', conditional: false },
  { name: 'service_repository_arn', kind: 'String', conditional: false },
  { name: 'service_repository_name', kind: 'String', conditional: false },
  { name: 'service_repository_uri', kind: 'String', conditional: false },
  { name: 'verification_task_role_arn', kind: 'String', conditional: false },
  { name: 'vlm_config_arn', kind: 'String', conditional: false },
  { name: 'vpc_id', kind: 'String', conditional: false },
  { name: 'vto_dlq_name', kind: 'String', conditional: false },
  { name: 'vto_dlq_url', kind: 'String', conditional: false },
  { name: 'vto_queue_arn', kind: 'String', conditional: false },
  { name: 'vto_queue_name', kind: 'String', conditional: false },
  { name: 'vto_queue_url', kind: 'String', conditional: false },
  { name: 'worker_security_group_id', kind: 'String', conditional: false },
]);

function stageParameterName(name) {
  return `/anywear/${STAGE_CONTRACT_STAGE}/${name}`;
}

// Public, typed definitions: the short suffix, the value kind a consumer's
// `CfnParameter` needs, and the absolute SSM name.
const STAGE_PARAMETER_DEFINITIONS = Object.freeze(STAGE_CONTRACT_DEFINITIONS
  .map(definition => Object.freeze({
    name: definition.name,
    kind: definition.kind,
    parameter: stageParameterName(definition.name),
  }))
  .sort((left, right) => (left.parameter < right.parameter ? -1 : left.parameter > right.parameter ? 1 : 0)));

const CONDITIONAL_NAMES = new Set(STAGE_CONTRACT_DEFINITIONS
  .filter(definition => definition.conditional)
  .map(definition => definition.name));

export const STAGE_CONTRACT_PARAMETERS = Object.freeze(STAGE_PARAMETER_DEFINITIONS
  .filter(definition => !CONDITIONAL_NAMES.has(definition.name))
  .map(definition => definition.parameter));

export const STAGE_CONTRACT_CONDITIONAL_PARAMETERS = Object.freeze(STAGE_PARAMETER_DEFINITIONS
  .filter(definition => CONDITIONAL_NAMES.has(definition.name))
  .map(definition => definition.parameter));

export const STAGE_CONTRACT_READ_PARAMETERS = Object.freeze(
  STAGE_PARAMETER_DEFINITIONS.map(definition => definition.parameter));

/**
 * The typed stage-parameter definitions, sorted by absolute SSM name.
 *
 * Each entry is `{ name, kind, parameter }`: the short suffix (`vpc_id`), the
 * CloudFormation value kind (`String` or `List`) and the absolute published name
 * (`/anywear/beta/vpc_id`). A consumer creates its own
 * `AWS::SSM::Parameter::Value<String>` or `...<List<String>>` `CfnParameter`
 * with that absolute name as its default.
 *
 * The conditional `cleanup_task_role_arn` definition is included; filter it with
 * `STAGE_CONTRACT_CONDITIONAL_PARAMETERS` when the identity phase is `legacy`.
 */
export function stageParameters() {
  return STAGE_PARAMETER_DEFINITIONS;
}

// `inputs[]` rows record the stage-contract parameter a deployment read: name,
// SSM version and the sha256 of the value. The value itself is never recorded.
export function validateStageInputs(rows) {
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid stage contract inputs');
  let previous;
  for (const row of rows) {
    exact(row, DEPLOYMENT_INPUT_FIELDS, 'stage contract input');
    matches(row.parameter, /^\/anywear\/[a-z]+\/[a-z0-9_]+$/, 'stage contract parameter');
    matches(row.version, /^[1-9][0-9]*$/, 'stage contract parameter version');
    matches(row.value_sha256, HASH, 'stage contract value hash');
    if (previous !== undefined && !(previous < row.parameter)) throw new Error('Stage contract inputs must be sorted and unique');
    previous = row.parameter;
  }
  return rows;
}

// The schema member is derived from the recorded inputs, so a reader can
// recompute it instead of trusting a cross-repository pin.
export function stageContractSchemaHash(rows) {
  return contentHash(validateStageInputs(rows).map(({ parameter, version }) => ({ parameter, version })));
}

// ---------------------------------------------------------------------------
// Stack identity

export const INFRA_REPOSITORY = 'anywear-ai/AnyWear-Infra';
export const SERVICE_REPOSITORY = 'anywear-ai/AnyWear-Service';

export function platformStackName(stage) {
  return `AnyWearPlatformStack-${stage}`;
}

// Issue #166: the release slice is the Runtime stack. Every resource in it is
// recreated on start, so the identity moved with it; the persistent state stayed
// in Base (`AnyWearPlatformStack-<stage>`).
export function runtimeStackName(stage) {
  return `AnyWearRuntimeStack-${stage}`;
}

// The release slice's one stack and the workflow that now deploys it. Since #195
// the producer is AnyWear-Infra's single mutation entry (`deploy-runtime`); the
// v6 record schema and validators below pin that producer.
export const SERVICE_RUNTIME_STACK = Object.freeze({
  name: runtimeStackName(STAGE_CONTRACT_STAGE),
  region: 'ap-east-1',
  workflow_path: '.github/workflows/mutate.yml',
});

// ---------------------------------------------------------------------------
// Deployed-template normalisation (Issue #195)
//
// CloudFormation's `Original` template and a CDK synthesis differ only in
// declared diagnostics: per-resource CDK `Metadata`, the `CDKMetadata` resource
// and the `CDKMetadataAvailable` condition. The deployment record's
// `template_sha256` is the canonical hash of the deployed template *after* this
// declaration, so it is directly comparable with the recorded per-phase
// baseline. The normalisation is exactly what `compare-live-foundation.mjs`
// already applies, and both the producer and any verifier call it here so they
// cannot drift.

export const DEPLOYED_TEMPLATE_NORMALISATION = Object.freeze([
  'remove every resource Metadata key',
  'drop the Resources/CDKMetadata resource',
  'drop the Conditions/CDKMetadataAvailable condition',
  'sha256 of RFC 8785-style canonical JSON',
]);

// The only resource metadata keys CDK emits. Anything else is an unreviewed
// difference and fails the normalisation before a hash is recorded.
const CDK_RESOURCE_METADATA_KEYS = Object.freeze(['aws:cdk:path', 'aws:asset:path', 'aws:asset:property', 'aws:asset:is-bundled']);

/**
 * Return a normalised copy of a deployed or synthesized CloudFormation template.
 *
 * The input is never mutated. Resource `Metadata` is removed (only the declared
 * CDK keys may be present), the `CDKMetadata` resource and the
 * `CDKMetadataAvailable` condition are dropped, and an empty `Conditions` map is
 * removed. Every other member is preserved exactly.
 */
export function normaliseDeployedTemplate(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('Invalid deployed template');
  }
  const result = structuredClone(template);
  for (const [id, resource] of Object.entries(result.Resources ?? {})) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
      throw new Error(`Invalid deployed template resource ${id}`);
    }
    for (const key of Object.keys(resource.Metadata ?? {})) {
      if (!CDK_RESOURCE_METADATA_KEYS.includes(key)) {
        throw new Error(`Unreviewed deployed template metadata ${id}/${key}`);
      }
    }
    delete resource.Metadata;
    if (id === 'CDKMetadata') {
      if (resource.Type !== 'AWS::CDK::Metadata') throw new Error('Invalid CDKMetadata resource identity');
      delete result.Resources[id];
      if (resource.Condition !== undefined && resource.Condition !== 'CDKMetadataAvailable') {
        throw new Error('Invalid CDKMetadata resource condition');
      }
    }
  }
  if (result.Conditions?.CDKMetadataAvailable !== undefined) {
    delete result.Conditions.CDKMetadataAvailable;
    if (!Object.keys(result.Conditions).length) delete result.Conditions;
  }
  return result;
}

/** The canonical sha256 of a deployed template after the declared normalisation. */
export function canonicalDeployedTemplateHash(template) {
  return contentHash(normaliseDeployedTemplate(template));
}

// The one stage-input row shape this package still validates. It is deliberately
// not exported: the record members it used to describe are retired with #207, and
// `validateStageInputs` below is the only reader.
const DEPLOYMENT_INPUT_FIELDS = Object.freeze(['parameter', 'version', 'value_sha256']);

// ---------------------------------------------------------------------------
// Deployment bake gate (Issue #162)
//
// `deploy-runtime` runs a bounded 300-second bake that reads the six named
// signals live from the deployed state and fails the deploy job on any breach or
// on missing evidence. The gate's result is the job conclusion and the run log;
// no record carries it. The constants and name builders below are the stage-free
// half of that control, shared with the CDK application so a signal, alarm or
// queue cannot drift between the bake and the resources it reads.
//
// The table below is one stage-free threshold set: `<stage>` appears only in
// resource and alarm names, never in a threshold, so Beta and Production share
// exactly the same pass criterion. A signal passes only when its recorded value
// is inside its threshold and every read produced enough data; missing, delayed
// or short data is `insufficient` and fails the gate exactly like `breaching`.

export const DEPLOYMENT_GATE_NAME_SUFFIX = 'anywear-deployment-bake';
export const DEPLOYMENT_GATE_DURATION_SECONDS = 300;
export const DEPLOYMENT_GATE_PROBE_INTERVAL_SECONDS = 15;
export const DEPLOYMENT_GATE_REQUEST_FLOOR = 15;
export const DEPLOYMENT_GATE_MAX_PROBES = 20;
export const DEPLOYMENT_GATE_SIGNAL_NAMES = Object.freeze([
  'alb_5xx_rate',
  'alb_p95_latency',
  'ecs_running_not_desired',
  'sqs_oldest_message_age',
  'sqs_dlq_depth',
  'outbox_oldest_age',
]);

// The three GetQueueAttributes names the live SQS API accepts for depth. The
// oldest-message age is not a GetQueueAttributes result: it is the AWS/SQS
// ApproximateAgeOfOldestMessage CloudWatch metric, so the bake reads it with
// GetMetricStatistics instead of an invented attribute name.
export const DEPLOYMENT_SQS_DEPTH_ATTRIBUTES = Object.freeze([
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
]);

// One stage-free table. Changing a threshold is a reviewed source change, not a
// deployment context or environment switch.
export const DEPLOYMENT_GATE_THRESHOLDS = Object.freeze({
  alb_5xx_rate: Object.freeze({ max_5xx: 0, min_requests: DEPLOYMENT_GATE_REQUEST_FLOOR }),
  alb_p95_latency: Object.freeze({ max_milliseconds: 5000 }),
  ecs_running_not_desired: Object.freeze({ max_gap_seconds: 120 }),
  sqs_oldest_message_age: Object.freeze({ max_seconds: 150 }),
  sqs_dlq_depth: Object.freeze({ max_depth: 0 }),
  outbox_oldest_age: Object.freeze({ max_age_milliseconds: 150000 }),
});

const DEPLOYMENT_GATE_SIGNAL_DEFINITIONS = Object.freeze({
  alb_5xx_rate: Object.freeze({
    value: Object.freeze(['target_5xx', 'elb_5xx', 'request_count']),
    threshold: Object.freeze(['max_5xx', 'min_requests']),
    comparison: 'sum(target_5xx, elb_5xx) > max_5xx; request_count < min_requests is insufficient',
  }),
  alb_p95_latency: Object.freeze({
    value: Object.freeze(['p95_milliseconds']),
    threshold: Object.freeze(['max_milliseconds']),
    comparison: 'p95_milliseconds > max_milliseconds',
  }),
  ecs_running_not_desired: Object.freeze({
    value: Object.freeze(['longest_gap_seconds', 'max_sample_gap_seconds', 'samples', 'services']),
    threshold: Object.freeze(['max_gap_seconds']),
    comparison: 'longest_gap_seconds >= max_gap_seconds; a non-single or non-COMPLETED deployment is breaching',
  }),
  sqs_oldest_message_age: Object.freeze({
    value: Object.freeze(['vto_seconds', 'auto_tagging_seconds']),
    threshold: Object.freeze(['max_seconds']),
    comparison: 'max(vto_seconds, auto_tagging_seconds) > max_seconds',
  }),
  sqs_dlq_depth: Object.freeze({
    value: Object.freeze(['vto_depth', 'auto_tagging_depth']),
    threshold: Object.freeze(['max_depth']),
    comparison: 'vto_depth + auto_tagging_depth > max_depth',
  }),
  outbox_oldest_age: Object.freeze({
    value: Object.freeze(['oldest_age_milliseconds', 'backlog', 'lines_observed']),
    threshold: Object.freeze(['max_age_milliseconds']),
    comparison: 'oldest_age_milliseconds > max_age_milliseconds; backlog > 0 with a null age is breaching',
  }),
});

export const DEPLOYMENT_GATE_COMPARISONS = Object.freeze(Object.fromEntries(
  Object.entries(DEPLOYMENT_GATE_SIGNAL_DEFINITIONS).map(([name, definition]) => [name, definition.comparison])));

const GATE_STAGE = /^[a-z][a-z0-9-]*$/;

function requireStage(stage) {
  if (typeof stage !== 'string' || !GATE_STAGE.test(stage)) throw new Error('Invalid deployment stage');
  return stage;
}

/** `deploymentBakeName('beta')` -> `beta-anywear-deployment-bake`. */
export function deploymentBakeName(stage) {
  return `${requireStage(stage)}-${DEPLOYMENT_GATE_NAME_SUFFIX}`;
}

/** The stage encoded in `AnyWearRuntimeStack-<stage>`. */
export function runtimeStageFromStack(stackName) {
  const match = typeof stackName === 'string' ? /^AnyWearRuntimeStack-([a-z][a-z0-9-]*)$/.exec(stackName) : null;
  if (!match) throw new Error('Invalid Runtime stack identity');
  return match[1];
}

// The deployed alarm entities each signal records. Names are the only place the
// stage appears; the threshold table above has no stage key.
const DEPLOYMENT_GATE_ALARM_SUFFIXES = Object.freeze({
  alb_5xx_rate: Object.freeze(['alb-5xx']),
  alb_p95_latency: Object.freeze(['api-p95-latency']),
  ecs_running_not_desired: Object.freeze(['ecs-running-not-desired']),
  sqs_oldest_message_age: Object.freeze(['vto-oldest-message', 'auto-tagging-oldest-message']),
  sqs_dlq_depth: Object.freeze(['vto-dlq-not-empty', 'auto-tagging-dlq-not-empty']),
  outbox_oldest_age: Object.freeze(['outbox-oldest-age']),
});

/** The deployed alarm names for one signal, for example `beta-anywear-alb-5xx`. */
export function deploymentAlarmName(stage, signalName) {
  requireStage(stage);
  const suffixes = DEPLOYMENT_GATE_ALARM_SUFFIXES[signalName];
  if (!suffixes) throw new Error(`Unknown deployment gate signal ${signalName}`);
  return suffixes.map((suffix) => `${stage}-anywear-${suffix}`);
}

/** The six signals' deployed alarm names, keyed by signal name. */
export function deploymentAlarmNames(stage) {
  return Object.freeze(Object.fromEntries(DEPLOYMENT_GATE_SIGNAL_NAMES.map((name) => [
    name, Object.freeze(deploymentAlarmName(stage, name))])));
}

/** The stage-base queues the bake reads, keyed by purpose. */
export function deploymentQueueNames(stage) {
  requireStage(stage);
  return Object.freeze({
    vto: `${stage}-anywear-vto`,
    vto_dlq: `${stage}-anywear-vto-dlq`,
    auto_tagging: `${stage}-anywear-auto-tagging`,
    auto_tagging_dlq: `${stage}-anywear-auto-tagging-dlq`,
  });
}

// The normalized task definition whose content hash identifies a deployed ECS
// service. It changes with image, environment, roles, command and sizing, never
// with the revision number alone.
export function stableTaskDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('Task definition observation unavailable');
  const container = definition.containerDefinitions?.length === 1 ? definition.containerDefinitions[0] : undefined;
  if (!container || typeof container.image !== 'string' || !container.image || !Array.isArray(container.environment)) {
    throw new Error('Single-container task definition required');
  }
  const environment = container.environment.map(entry => {
    if (typeof entry?.name !== 'string' || typeof entry?.value !== 'string') throw new Error('Task definition environment unavailable');
    return { name: entry.name, value: entry.value };
  }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { family: definition.family, taskRoleArn: definition.taskRoleArn, executionRoleArn: definition.executionRoleArn,
    networkMode: definition.networkMode, cpu: definition.cpu, memory: definition.memory,
    container: { name: container.name, image: container.image, command: container.command ?? [], environment } };
}

export function taskDefinitionContentHash(definition) {
  return contentHash(stableTaskDefinition(definition));
}

// Issue #195 retired the Foundation per-service deploy roles: the Service-role
// naming helpers (`serviceDeployRoleName`, `serviceDeployCfnRoleName`,
// `serviceTrustSubject`) left this package with them. The Runtime stack is now
// deployed by the existing `beta-infra-deploy-role` through the standard CDK
// bootstrap path, so there is no second service-role naming surface to keep.
