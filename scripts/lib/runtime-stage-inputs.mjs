import { sha256 } from './json-contract.mjs';
import { SSM_GET_PARAMETERS_LIMIT } from './stage-contract-parameters.mjs';

// The exact `/anywear/beta/...` surface one `deploy-runtime` consumes. The list is
// the reviewed Service release read set moved into this repository (#195): the 36
// definitions the pinned contract publishes at the `roles-added` phase (the 35
// unconditional names plus the conditional cleanup task role), the two reviewed
// constants the deploy passes as plain `CfnParameter` values, and
// `qweather_api_host`, which the Runtime template resolves itself. The three
// names `cognito_user_pool_id`, `cognito_client_id` and `s3_bucket_name` are both
// contract names and reused Base names; they appear once.
//
// `isolated_subnet_ids` is a published contract name with no Runtime reader; the
// deployment does not read it, so it is not in this set.
export const RUNTIME_STAGE_INPUT_NAMES = Object.freeze([
  '/anywear/beta/vpc_id',
  '/anywear/beta/public_subnet_ids',
  '/anywear/beta/private_subnet_ids',
  '/anywear/beta/ecs_cluster_name',
  '/anywear/beta/database_secret_arn',
  '/anywear/beta/database_host',
  '/anywear/beta/database_port',
  '/anywear/beta/api_security_group_id',
  '/anywear/beta/worker_security_group_id',
  '/anywear/beta/load_balancer_security_group_id',
  '/anywear/beta/service_repository_uri',
  '/anywear/beta/service_repository_name',
  '/anywear/beta/service_repository_arn',
  '/anywear/beta/vto_queue_url',
  '/anywear/beta/vto_queue_arn',
  '/anywear/beta/vto_queue_name',
  '/anywear/beta/auto_tagging_queue_url',
  '/anywear/beta/auto_tagging_queue_arn',
  '/anywear/beta/auto_tagging_queue_name',
  '/anywear/beta/vto_dlq_name',
  '/anywear/beta/auto_tagging_dlq_name',
  '/anywear/beta/s3_bucket_arn',
  '/anywear/beta/operations_topic_arn',
  '/anywear/beta/cloudfront_prefix_list_id',
  '/anywear/beta/vlm_config_arn',
  '/anywear/beta/api_base_url',
  '/anywear/beta/cleanup_task_role_arn',
  '/anywear/beta/verification_task_role_arn',
  '/anywear/beta/one_shot_execution_role_arn',
  '/anywear/beta/one_shot_log_group_name',
  '/anywear/beta/one_shot_log_group_arn',
  '/anywear/beta/one_shot_security_group_id',
  '/anywear/beta/ecs_cluster_arn',
  '/anywear/beta/vto_dlq_url',
  '/anywear/beta/auto_tagging_dlq_url',
  '/anywear/beta/cognito_user_pool_id',
  '/anywear/beta/cognito_client_id',
  '/anywear/beta/s3_bucket_name',
  '/anywear/beta/qweather_api_host',
]);

// The two reviewed constants the deployment passes as plain template parameters.
// They are read from the same contract surface, so they are also record inputs.
export const RUNTIME_DEPLOY_PARAMETER_INPUTS = Object.freeze([
  '/anywear/beta/vlm_config_arn', '/anywear/beta/cloudfront_prefix_list_id',
]);

// The four queue URLs and the ECS cluster name the 300-second bake reads. They are
// contract values like every other stage input: the deploy names them by
// parameter, never by an account/region literal or a guessed queue name. The bake
// passes the URLs to `sqs get-queue-attributes` and the cluster to
// `ecs describe-services`, so a queue *name* where a URL belongs fails every SQS
// read at Deployment and the gate can never pass.
export const RUNTIME_QUEUE_URL_NAMES = Object.freeze({
  vto: '/anywear/beta/vto_queue_url',
  auto_tagging: '/anywear/beta/auto_tagging_queue_url',
  vto_dlq: '/anywear/beta/vto_dlq_url',
  auto_tagging_dlq: '/anywear/beta/auto_tagging_dlq_url',
});
export const RUNTIME_ECS_CLUSTER_INPUT = '/anywear/beta/ecs_cluster_name';
const QUEUE_URL = /^https:\/\/sqs\.[a-z0-9.-]+\/\d{12}\/[A-Za-z0-9_.-]+$/;
const ECS_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

export function runtimeStageInputBatches() {
  return Array.from({ length: Math.ceil(RUNTIME_STAGE_INPUT_NAMES.length / SSM_GET_PARAMETERS_LIMIT) },
    (_, index) => Object.freeze(RUNTIME_STAGE_INPUT_NAMES.slice(
      index * SSM_GET_PARAMETERS_LIMIT, (index + 1) * SSM_GET_PARAMETERS_LIMIT)));
}

const VLM_ARN = /^arn:aws:secretsmanager:ap-east-1:650880818323:secret:.+$/;
const PREFIX_LIST = /^pl-[a-z0-9]+$/;

const valueOf = (values, name) => (values instanceof Map ? values.get(name) : values?.[name]);

// The bake's queue URLs, read from the same contract surface as the hashed
// deploy inputs. A missing value, a bare queue name, or anything that is not a full
// `https://sqs.` URL fails closed before the gate runs.
export function runtimeBakeQueueUrls(values) {
  const queueUrls = {};
  for (const [purpose, name] of Object.entries(RUNTIME_QUEUE_URL_NAMES)) {
    const value = valueOf(values, name);
    if (typeof value !== 'string' || !QUEUE_URL.test(value)) {
      throw new Error(`The stage contract ${name} is not an https://sqs. queue URL`);
    }
    queueUrls[purpose] = value;
  }
  return Object.freeze(queueUrls);
}

// The deployed ECS cluster name. It is one of the 39 contract names, so the deploy
// does not carry a second literal that could drift from the Base stack.
export function runtimeEcsClusterName(values) {
  const value = valueOf(values, RUNTIME_ECS_CLUSTER_INPUT);
  if (typeof value !== 'string' || !ECS_CLUSTER_NAME.test(value)) {
    throw new Error(`The stage contract ${RUNTIME_ECS_CLUSTER_INPUT} is not an ECS cluster name`);
  }
  return value;
}

// Read the whole Runtime stage surface in bounded `ssm get-parameters` calls and
// return its sorted `inputs[]` rows (name, SSM version, value sha256) together with
// the values. A missing name fails closed: the `roles-added` phase
// publishes every one of the 39 names, so an absent name is a wrong phase or a
// Base that was never deployed.
export async function readRuntimeStageContract(io) {
  const byName = new Map();
  for (const batch of runtimeStageInputBatches()) {
    const response = await io.aws(['ssm', 'get-parameters', '--names', ...batch], 'ap-east-1');
    const parameters = response.Parameters;
    const invalid = response.InvalidParameters ?? [];
    if (!Array.isArray(parameters) || !Array.isArray(invalid)) throw new Error('Runtime stage contract unavailable');
    if (invalid.length) throw new Error(`Runtime stage contract parameters unavailable: ${invalid.join(', ')}`);
    if (parameters.length !== batch.length) throw new Error('Runtime stage contract parameters unavailable');
    for (const parameter of parameters) {
      if (!batch.includes(parameter?.Name) || byName.has(parameter.Name)) {
        throw new Error(`Runtime stage contract parameter ${parameter?.Name} unexpected`);
      }
      if (typeof parameter.Value !== 'string' || parameter.Type === 'SecureString') {
        throw new Error(`Runtime stage contract parameter ${parameter.Name} unreadable`);
      }
      if (!Number.isSafeInteger(Number(parameter.Version)) || Number(parameter.Version) < 1) {
        throw new Error(`Runtime stage contract parameter ${parameter.Name} has no version`);
      }
      byName.set(parameter.Name, parameter);
    }
  }
  return {
    inputs: RUNTIME_STAGE_INPUT_NAMES.map((parameter) => {
      const observed = byName.get(parameter);
      return { parameter, version: String(observed.Version), value_sha256: sha256(observed.Value) };
    }).sort((left, right) => (left.parameter < right.parameter ? -1 : left.parameter > right.parameter ? 1 : 0)),
    values: new Map(RUNTIME_STAGE_INPUT_NAMES.map((parameter) => [parameter, byName.get(parameter).Value])),
  };
}

// The deployment parameters whose values come from the stage contract rather than
// from the sealed artifact or the live stack.
export async function readRuntimeDeployValues(io) {
  const response = await io.aws(['ssm', 'get-parameters', '--names', ...RUNTIME_DEPLOY_PARAMETER_INPUTS], 'ap-east-1');
  const invalid = response.InvalidParameters ?? [];
  if (invalid.length || !Array.isArray(response.Parameters) || response.Parameters.length !== 2) {
    throw new Error(`Runtime deploy inputs unavailable: ${invalid.join(', ')}`);
  }
  const values = new Map(response.Parameters.map((parameter) => [parameter.Name, parameter.Value]));
  const vlm = values.get('/anywear/beta/vlm_config_arn');
  const prefix = values.get('/anywear/beta/cloudfront_prefix_list_id');
  if (typeof vlm !== 'string' || !VLM_ARN.test(vlm)) throw new Error('The stage contract VLM config ARN is invalid');
  if (typeof prefix !== 'string' || !PREFIX_LIST.test(prefix)) throw new Error('The stage contract CloudFront prefix list id is invalid');
  return { VlmConfigArn: vlm, CloudFrontPrefixListId: prefix };
}
