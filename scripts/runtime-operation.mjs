import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseJson, canonicalJson, matches, DIGEST, SHA } from './lib/json-contract.mjs';
import { enforceBetaPlatformLogRetention } from '../.github/scripts/beta-platform-log-retention.mjs';
import { normalizeTesterEmails, runTesterAllowlist } from './lib/tester-allowlist.mjs';
import { changedStackNames } from './lib/operation-stacks.mjs';
import { validateReleaseInput, SELECTED_RELEASE_DIRECTORY } from './lib/release-inputs.mjs';
import { validateDeliveryInput } from './lib/delivery-inputs.mjs';
import { readLifecycleStatus } from './lib/lifecycle-status.mjs';
import { runRestoreRelease } from './lib/restore-release.mjs';
import { assertTerminalRuntime, assertRuntimeAbsent, describeStack, runtimeExists, runtimeStack, terminalStackStatuses } from './lib/one-writer.mjs';
import { operationBoundary, sessionPolicy, assertAwsAllowed, assertOneShotAllowed, assertDeployAllowed, assertProtectedExecutor } from './lib/operation-boundaries.mjs';
import { runAuthorizationPreflight } from './lib/authorization-preflight.mjs';
import { observeBetaState } from './lib/observe-beta-state.mjs';
import { account, region } from './lib/deployment-contract.mjs';
import { assertRuntimePhase, deployRuntime, stopRuntime } from './lib/runtime-deploy.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The tester operations are named for their effect, so routing them is an
// explicit table rather than a prefix rule: a renamed operation must be added here
// or it runs nothing, instead of silently matching or silently falling through.
export const testerOperationActions = Object.freeze({
  'admission-status': 'status', 'add-testers': 'add', 'set-testers': 'set',
});
// The tester operations and `restore-release` take no tester payload. #213 retired
// the admission open/close operations, so release recovery is the only remaining
// recovery entry here.
const admissionRecoveryOperations = ['restore-release'];
// A dispatch surface is a workflow, not an operation. These inputs now exist on
// every operation of their entry, so their per-operation scope is enforced here
// (before credentials) instead of by the file that carries them.
const testerOperations = ['add-testers', 'set-testers'];
const contextVariableOperations = ['deploy-foundation', 'deploy-billing', 'deploy-platform', 'restore-release',
  'deploy-runtime', 'stop-runtime'];
export function validateOperationInputs(env = process.env) {
  const boundary = operationBoundary(env);
  const operation = env.INFRA_OPERATION;
  // Issue #266: the repository numeric id is the durable identity; the owner name
  // moves with the transfer and the boundary above already binds this run's own
  // repository and workflow.
  if (env.GITHUB_REPOSITORY_ID !== '1409047265'
    || env.GITHUB_REF !== 'refs/heads/main' || !SHA.test(env.GITHUB_SHA ?? '') || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !boundary.readOnly && env.ENABLE_BETA_MUTATION !== 'true') throw new Error('Protected Infra main executor and activation required');
  if (env.AWS_ACCOUNT_ID !== account || env.AWS_REGION !== region) throw new Error('Unexpected account/region');
  if (!['legacy', 'roles-added', 'retired'].includes(env.INFRA_IDENTITY_PHASE)) throw new Error('Explicit identity phase required');
  if (!['true', 'false'].includes(env.INFRA_RETENTION_PROTECTION)) throw new Error('Explicit retention protection required');
  // Only a Platform deploy, a Runtime deploy and a release recovery consume
  // Service-built identity; every other operation must not carry a release
  // identity at all.
  const release = validateReleaseInput(env, operation);
  // The deploy chain's entry event and its dispatching run belong to the one
  // operation that deploys a Runtime tuple (#226). `release` is refused here, in
  // the credential-free preflight, so a tag-shaped dispatch fails before any job
  // holds a token, an environment or an OIDC identity.
  validateDeliveryInput(env, operation);
  // The Runtime operations act only on the recorded live identity phase.
  if (operation === 'deploy-runtime' || operation === 'stop-runtime') assertRuntimePhase(operation, env);
  // Only a deployment or a release recovery may vary these workflow-level
  // inputs; every other operation runs the retired, protected context.
  if (!contextVariableOperations.includes(operation)
    && (env.INFRA_IDENTITY_PHASE !== 'retired' || env.INFRA_RETENTION_PROTECTION !== 'true')) {
    throw new Error('Only deployment and release recovery may vary identity phase and retention protection');
  }
  if (admissionRecoveryOperations.includes(operation)) {
    if (normalizeTesterEmails(env.TESTER_EMAILS) !== '[]') throw new Error('Release recovery accepts no tester mutation payload');
  }
  if (Object.hasOwn(testerOperationActions, operation)) {
    const payload = normalizeTesterEmails(env.TESTER_EMAILS);
    if (operation === 'admission-status' && payload !== '[]') throw new Error('Admission status accepts no mutation payload');
  }
  if (!testerOperations.includes(operation) && normalizeTesterEmails(env.TESTER_EMAILS ?? '[]') !== '[]') {
    throw new Error('Tester payload belongs only to the tester operations');
  }
  // The retained Egress EIP allocation is a deploy-egress start input only. An
  // empty workflow_dispatch value is absence; any non-empty value must match the
  // reviewed allocation form before credentials.
  const natEipAllocationId = env.NAT_EIP_ALLOCATION_ID;
  if (natEipAllocationId !== undefined && natEipAllocationId !== '') {
    if (operation !== 'deploy-egress') throw new Error('NAT_EIP_ALLOCATION_ID belongs only to deploy-egress');
    if (!/^eipalloc-[0-9a-f]+$/.test(natEipAllocationId)) {
      throw new Error('NAT_EIP_ALLOCATION_ID must be an Elastic IP allocation id (eipalloc-...)');
    }
  }
  // Cross-repository boundary, not a local preference: these names remain live
  // outside Infra. Service's own .github/scripts/run-one-shot-task.sh:19,29,34 and
  // .github/scripts/runtime-checkpoint.test.mjs:97-98,148,161 read the evidence and
  // checkpoint scopes, and AnyWear-E2E sets them through
  // scripts/runtime-one-shot-runner.mjs:95,100, scripts/beta-runtime-adapter.mjs:16,98
  // and scripts/fixtures/runtime-checkpoint-helper.sh:3-4. Keep rejecting them here.
  for (const key of ['RUNTIME_DRILL_RUN_SCOPE', 'RUNTIME_DRILL_CHECKPOINT_PROTOCOL', 'LIFECYCLE_EVIDENCE_RUN_SCOPE', 'LIFECYCLE_EVIDENCE_ASYNC']) {
    if (env[key]) throw new Error('Experimental task scopes are not ordinary Beta workflow inputs');
  }
  return { source_sha: env.GITHUB_SHA, operation, service_release: release,
    ...(operation === 'deploy-egress' && natEipAllocationId ? { nat_eip_allocation_id: natEipAllocationId } : {}) };
}
const baseStack = 'AnyWearPlatformStack-beta';
const egressStack = 'AnyWearEgressStack-beta';
// The ECR repository Service's deploy chain pushes to. Tag immutability makes
// `service-artifacts-<commit>` a one-image lookup, so a release operation can
// record the deployed image digest from ECR instead of a release manifest.
export const SERVICE_IMAGE_REPOSITORY = 'beta-anywear-service';
export function serviceImageTag(serviceCommit) {
  return `service-artifacts-${serviceCommit}`;
}
// Resolve the release image digest for one Service commit before the deploy. A
// missing or ambiguous tag fails closed before CloudFormation is touched.
export async function resolveServiceImageDigest(io, serviceCommit) {
  const tag = serviceImageTag(serviceCommit);
  const { imageDetails } = await io.aws(['ecr', 'describe-images', '--repository-name', SERVICE_IMAGE_REPOSITORY,
    '--image-ids', `imageTag=${tag}`]);
  if (!Array.isArray(imageDetails) || imageDetails.length !== 1) {
    throw new Error(`The immutable ECR tag ${tag} does not resolve to exactly one image`);
  }
  const [image] = imageDetails;
  if (!Array.isArray(image.imageTags) || !image.imageTags.includes(tag)) {
    throw new Error(`The immutable ECR tag ${tag} does not name the resolved image`);
  }
  return matches(image.imageDigest, DIGEST, `ECR tag ${tag} image digest`);
}
// The legacy Service stack that still exists until the one-time split migration
// deletes it. Its `ApiLoadBalancerDnsName` output is the only origin source
// before the Runtime stack exists; it is a read-only transition path.
const legacyWorkloadStack = 'AnyWearWorkloadStack-beta';
const API_ORIGIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const isOrigin = value => typeof value === 'string' && API_ORIGIN.test(value);
const stackRead = (io, name, region) => describeStack(io, name, region);
const outputOf = (stack, key) => (stack?.Outputs ?? []).find(output => output.OutputKey === key)?.OutputValue;
// The Base stack's recorded origin (#254). The distribution's origin is the
// `ApiOriginDomainName` stack parameter, so a stopped environment reads the value
// the last Runtime deploy wrote instead of a template literal. A value the
// parameter's DNS guard would reject is treated as unavailable and falls through,
// like an absent parameter, so a malformed record can never become an origin.
async function baseParameterOrigin(io) {
  const base = await stackRead(io, baseStack);
  if (!base) return undefined;
  const parameter = (base.Parameters ?? []).find(entry => entry?.ParameterKey === 'ApiOriginDomainName');
  return isOrigin(parameter?.ParameterValue) ? parameter.ParameterValue : undefined;
}
// A Base deploy needs the live API ALB DNS name as the distribution origin.
// Order: a running Runtime stack's output, then the live `ApiOriginDomainName`
// parameter already recorded on the Base stack (the stopped state, and the
// one-time M4 update), then the legacy Workload output before the MOVE. The Base
// read is before Workload so that the stopped state never needs the transitional
// Workload read after M4.
export async function readApiOrigin(io) {
  const runtime = await stackRead(io, runtimeStack);
  if (runtimeExists(runtime)) {
    const runtimeOrigin = outputOf(runtime, 'ApiLoadBalancerDnsName');
    if (!isOrigin(runtimeOrigin)) {
      throw new Error('The Runtime stack exists but its ApiLoadBalancerDnsName output is missing or not a DNS name');
    }
    return runtimeOrigin;
  }
  const baseOrigin = await baseParameterOrigin(io);
  if (baseOrigin) return baseOrigin;
  const workload = await stackRead(io, legacyWorkloadStack);
  const workloadOrigin = outputOf(workload, 'ApiLoadBalancerDnsName');
  if (isOrigin(workloadOrigin)) return workloadOrigin;
  throw new Error('A Base deploy requires the live API load-balancer DNS name from the Runtime stack, the live ApiOriginDomainName parameter on the Base stack, or the legacy Workload stack before the MOVE');
}
// Infra deploys both the persistent Base stack and the Runtime stack. A Base or
// Egress mutation must read the Runtime stack terminal before CloudFormation is
// touched, so the two operations never cross a deployment. A missing Runtime is
// simply the stopped state; `restore-release` still requires it to exist (start first).
export async function deployOperationStack(io, operation) {
  const [stack] = changedStackNames(operation);
  if (!stack) throw new Error(`Operation ${operation} has no stack to deploy`);
  if (stack === baseStack || stack === egressStack) {
    const runtime = await stackRead(io, runtimeStack);
    if (runtimeExists(runtime)) assertTerminalRuntime(runtime, operation);
  }
  await io.deploy(stack);
  return stack;
}
// The stop sequence is Runtime (Infra's `stop-runtime`) then Egress. This
// operation is the second step only: it refuses while the Runtime stack exists.
// The retained EIP is the allocation the next start must reuse, so its output is
// proven before the destroy removes it and the stack's outputs.
export async function deleteOperationStack(io, operation) {
  const [stack] = changedStackNames(operation);
  if (operation !== 'delete-egress' || stack !== egressStack) {
    throw new Error(`Operation ${operation} has no stack to delete`);
  }
  assertRuntimeAbsent(await stackRead(io, runtimeStack), operation);
  const egress = await stackRead(io, egressStack);
  const allocationId = outputOf(egress, 'EgressNatEipAllocationId');
  if (typeof allocationId !== 'string' || !allocationId) {
    throw new Error('delete-egress requires the EgressNatEipAllocationId output before deleting the stack');
  }
  await io.destroy(stack);
  return stack;
}
// `deployScope` restricts synthesis to the stack this operation deploys: only an
// application-scope deploy (the Base stack) loads Service-built Lambda assets and
// passes the API origin as the `ApiOriginDomainName` stack parameter; the Egress
// stack is a separate scope with no artifacts.
function deployScopeFor(stack) {
  if (stack === baseStack) return 'application';
  if (stack === 'AnyWearBillingStack-beta') return 'billing';
  if (stack === egressStack) return 'egress';
  if (stack === runtimeStack) return 'runtime';
  return 'foundation';
}
export function cdkDeploymentArguments(stack, directory, env, { apiOriginDomainName, natEipAllocationId } = {}) {
  const deployScope = deployScopeFor(stack);
  if (deployScope === 'application' && !apiOriginDomainName) throw new Error('The Base deploy requires the API origin domain name');
  return ['cdk', 'deploy', stack, '--exclusively', '--require-approval', 'never',
    '-c', `deployScope=${deployScope}`, '-c', 'stage=beta', '-c', 'legacyRoleSource=external', '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`,
    '-c', `ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`,
    // #254: the origin is a CloudFormation stack parameter now, so the deploy
    // passes it with the CDK CLI's `--parameters KEY=VALUE` form instead of the
    // old `-c apiOriginDomainName` context the synthesis read.
    ...(deployScope === 'application' ? ['-c', `artifactDirectory=${directory}`, '--parameters', `ApiOriginDomainName=${apiOriginDomainName}`] : []),
    ...(deployScope === 'egress' && natEipAllocationId ? ['-c', `natEipAllocationId=${natEipAllocationId}`] : [])];
}
// The Egress destroy uses the same restricted deploy session and reviewed
// context; `--force` is safe because the stack holds no retained resources.
export function cdkDestroyArguments(stack, env) {
  return ['cdk', 'destroy', stack, '--force', '--exclusively',
    '-c', `deployScope=${deployScopeFor(stack)}`, '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${env.INFRA_IDENTITY_PHASE}`, '-c', `ecrImageRetention=${env.INFRA_RETENTION_PROTECTION}`];
}
export function cleanAwsEnvironment(env) {
  const result = { ...env };
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
    'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) delete result[key];
  return { ...result, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' };
}
export async function credentialEnvironment(kind, env = process.env, purpose = 'operation',
  { requestToken = fetch, run = execute, sessionMarker } = {}) {
  validateOperationInputs(env);
  const policy = sessionPolicy(kind, env, purpose);
  const role = `arn:aws:iam::650880818323:role/beta-infra-${kind}-role`;
  const configured = env[kind === 'deploy' ? 'INFRA_DEPLOY_ROLE_ARN' : 'INFRA_RUNTIME_ROLE_ARN'];
  if (configured !== role) throw new Error('Dedicated Infra role is not configured');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Protected GitHub OIDC executor required');
  const request = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (request.protocol !== 'https:' || !request.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('Unexpected OIDC request endpoint');
  request.searchParams.set('audience', 'sts.amazonaws.com');
  const response = await requestToken(request, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('OIDC token retrieval failed');
  const token = (await response.json()).value;
  if (typeof token !== 'string' || !token) throw new Error('OIDC token missing');
  // D2: the preflight requests its own session name (`infra-<kind>-preflight-<run>`),
  // so the CloudTrail reconciliation can exclude the sensor's own calls.
  const sessionName = `infra-${kind}${sessionMarker ? `-${sessionMarker}` : ''}-${env.GITHUB_RUN_ID}`;
  let assumed;
  try {
    assumed = parseJson((await run('aws', ['sts', 'assume-role-with-web-identity', '--role-arn', role,
      '--role-session-name', sessionName, '--web-identity-token', token, '--policy', policy, '--duration-seconds', '3600', '--output', 'json'],
      { env: cleanAwsEnvironment(env), timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout);
  } catch {
    // execFile errors include token-bearing arguments; keep them out of logs.
    throw new Error('Dedicated restricted STS assumption failed');
  }
  if (!assumed.AssumedRoleUser?.Arn?.startsWith(`arn:aws:sts::650880818323:assumed-role/beta-infra-${kind}-role/${sessionName}`)) throw new Error('Dedicated assumed principal mismatch');
  const credentials = assumed.Credentials;
  return { ...cleanAwsEnvironment(env), AWS_ACCESS_KEY_ID: credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey, AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_REGION: 'ap-east-1', AWS_DEFAULT_REGION: 'ap-east-1' };
}
export async function createRuntimeIo(env = process.env, { run = execute, assume = credentialEnvironment, purpose = 'operation', directory = SELECTED_RELEASE_DIRECTORY, changedStacks = [] } = {}) {
  const credentials = new Map();
  const roleEnv = async kind => {
    validateOperationInputs(env);
    sessionPolicy(kind, env, purpose);
    const key = `${kind}:${purpose}`;
    if (!credentials.has(key) || Date.now() - credentials.get(key).at > 50 * 60_000) {
      credentials.set(key, { promise: assume(kind, env, purpose), at: Date.now() });
    }
    const entry = credentials.get(key);
    try { return await entry.promise; }
    catch (error) { if (credentials.get(key) === entry) credentials.delete(key); throw error; }
  };
  const io = {
    region: 'ap-east-1', now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    changedStacks,
    // The mutation landed. One mechanism records it, whichever path made it: the
    // CDK deploy, the CDK destroy, or the change set `deploy-runtime` executes
    // itself. `runOperation`'s catch publishes the set when a later gate refuses,
    // so a landed change is never missing from the "changed but unqualified" line.
    markChanged(stack) {
      changedStacks.push(stack);
    },
    async aws(args, awsRegion) {
      assertAwsAllowed(env, args, purpose);
      if (awsRegion) args = [...args, '--region', awsRegion];
      const explicitRegion = args.indexOf('--region');
      if (explicitRegion >= 0 && !['ap-east-1', 'us-east-1'].includes(args[explicitRegion + 1])) throw new Error('Unexpected operation region');
      const awsEnv = await roleEnv('runtime');
      const result = await run('aws', [...args, ...(explicitRegion < 0 ? ['--region', 'ap-east-1'] : []), '--output', 'json'], { env: awsEnv, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim() ? parseJson(result.stdout) : {};
    },
    // Issue #195: the Runtime change-set driver runs under the restricted deploy
    // session, never the read-only runtime session. Every call is checked against
    // the deploy-session allow-list before it reaches AWS.
    async awsAs(session, args) {
      if (session !== 'deploy') throw new Error(`Unsupported explicit operation session ${session}`);
      if (purpose !== 'operation') throw new Error('Qualification cannot use the deploy session');
      assertAwsAllowed(env, args, purpose, 'deploy');
      const awsEnv = await roleEnv('deploy');
      const result = await run('aws', [...args, '--region', 'ap-east-1', '--output', 'json'],
        { env: awsEnv, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim() ? parseJson(result.stdout) : {};
    },
    // The CDK CLI creates this run's change set under the bootstrap deploy role.
    // `--no-execute` records the delta and stops; the operation describes it,
    // judges it and then executes or deletes it through `awsAs`.
    async deployRuntimeChangeSet({ args }) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      if (env.INFRA_OPERATION !== 'deploy-runtime') throw new Error('Only deploy-runtime may create a Runtime change set');
      assertDeployAllowed(env, runtimeStack);
      const awsEnv = await roleEnv('deploy');
      await run('npx', args, { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
    },
    // A synchronous runner for the bake's AWS reads. It resolves the runtime
    // session once and checks every call against the same reviewed allow-list;
    // the bake's evaluation is deterministic and its transport is the CLI.
    async runtimeAwsRunner() {
      if (purpose !== 'operation') throw new Error('Qualification cannot run the deployment bake');
      const awsEnv = await roleEnv('runtime');
      return (args) => {
        assertAwsAllowed(env, args, purpose, 'runtime');
        return execFileSync('aws', [...args, '--region', 'ap-east-1', '--output', 'json'],
          { env: awsEnv, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
      };
    },
    async oneShot(role, revision, argument = '', payload) {
      if (purpose !== 'operation') throw new Error('Qualification cannot invoke operation helpers');
      assertOneShotAllowed(env, role, argument, payload);
      // Pre-mutation preflight (#165): a migration or tester one-shot changes
      // data, so the policy simulation runs first. A deny stops the operation
      // before the task is registered or started.
      await runAuthorizationPreflight({ sessions: ['runtime'], env, purpose, assume, run });
      const awsEnv = await roleEnv('runtime');
      let result;
      try { result = await run('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role, revision.digest, revision.commit, argument, ...(payload === undefined ? [] : [payload])],
        { cwd: root, env: { ...awsEnv, BASH_ENV: path.join(root, '.github/scripts/operation-hook.sh'), INFRA_REPOSITORY_DIRECTORY: root }, timeout: 4_200_000, maxBuffer: 10 * 1024 * 1024 });
      } catch (error) {
        // The script prints `Task definition:` and `Task ARN:` before it waits and
        // exits non-zero after the task fails, so its captured output is the only
        // record of the task this run left behind. Write it to the step log before
        // the refusal, the way `oneShotProbe` preserves a failed read.
        const stdout = String(error.stdout ?? '');
        const stderr = String(error.stderr ?? '');
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        throw new Error('One-shot execution failed; preserve task resources and inspect redacted run evidence');
      }
      // Preserve the launch's own output first: the identity, exit-code and digest
      // checks below can still throw, and a failed launch must name its task.
      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      const tasks = [...new Set([...stdout.matchAll(/^Task ARN: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      const definitions = [...new Set([...stdout.matchAll(/^Task definition: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      if (tasks.length !== 1 || definitions.length !== 1) throw new Error('Unique one-shot identity missing');
      const task = (await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', tasks[0]])).tasks?.[0];
      const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', definitions[0]])).taskDefinition;
      const actualContainer = task?.containers?.find(item => item.name === 'OneShot');
      const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
      if (task?.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definitions[0] || actualContainer?.exitCode !== 0
        || actualContainer.imageDigest !== revision.digest) throw new Error('Actual one-shot image/result differs from the deployed revision');
      if (role === 'lifecycle' && canonicalJson(container.command) !== canonicalJson(['node', 'dist/ops/beta-lifecycle.js', argument,
        ...(payload === undefined ? [] : [payload])])) throw new Error('Actual lifecycle command differs from the requested action');
      if (role === 'lifecycle' && argument === 'status') {
        const status = await readLifecycleStatus(io, task, definition);
        return status;
      }
    },
    // Issue #194: a non-throwing variant of `oneShot` for the pre-mutation
    // schema-journal probe. It performs the same authorization, launch, unique
    // task/definition identity, STOPPED, image-digest and command-identity checks,
    // but *returns* the container exit code so the schema gate can decide the
    // refusal (a non-zero read is a `reader-failed`, not a launcher crash). A
    // launch or identity failure still throws, as it invalidates the evidence.
    async oneShotProbe(role, revision, argument = '') {
      if (purpose !== 'operation') throw new Error('Qualification cannot invoke operation helpers');
      assertOneShotAllowed(env, role, argument);
      // Same pre-mutation preflight as `oneShot`: the runtime session's effective
      // authorization is simulated before the task is registered or started.
      await runAuthorizationPreflight({ sessions: ['runtime'], env, purpose, assume, run });
      const awsEnv = await roleEnv('runtime');
      let result;
      try {
        result = await run('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', role, revision.digest, revision.commit, argument],
          { cwd: root, env: { ...awsEnv, BASH_ENV: path.join(root, '.github/scripts/operation-hook.sh'), INFRA_REPOSITORY_DIRECTORY: root }, timeout: 4_200_000, maxBuffer: 10 * 1024 * 1024 });
      } catch (error) {
        // The task script exits non-zero after it prints the stopped task identity,
        // so the runner can still read and judge the actual container result.
        result = { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
      const tasks = [...new Set([...String(result.stdout ?? '').matchAll(/^Task ARN: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      const definitions = [...new Set([...String(result.stdout ?? '').matchAll(/^Task definition: (arn:aws:ecs:[^\s]+)$/gm)].map(match => match[1]))];
      if (tasks.length !== 1 || definitions.length !== 1) {
        throw new Error('One-shot probe identity missing; inspect redacted run evidence');
      }
      const task = (await io.aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', tasks[0]])).tasks?.[0];
      const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', definitions[0]])).taskDefinition;
      const actualContainer = task?.containers?.find(item => item.name === 'OneShot');
      const container = definition?.containerDefinitions?.find(item => item.name === 'OneShot');
      if (task?.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definitions[0]
        || actualContainer?.imageDigest !== revision.digest) {
        throw new Error('Actual one-shot image/result differs from the deployed revision');
      }
      if (role === 'verify'
        && canonicalJson(container?.command) !== canonicalJson(['node', 'dist/verify.js', argument])) {
        throw new Error('Actual verify command differs from the requested action');
      }
      const exitCode = Number.isSafeInteger(actualContainer.exitCode) ? actualContainer.exitCode : 'unavailable';
      process.stdout.write(String(result.stdout ?? ''));
      if (result.stderr) process.stderr.write(String(result.stderr));
      return { exitCode, task, definition };
    },
    async deploy(stack) {
      if (purpose !== 'operation') throw new Error('Qualification cannot deploy');
      assertDeployAllowed(env, stack);
      const apiOriginDomainName = stack === baseStack ? await readApiOrigin(io) : undefined;
      const natEipAllocationId = stack === egressStack ? env.NAT_EIP_ALLOCATION_ID : undefined;
      const awsEnv = await roleEnv('deploy');
      await run('npx', cdkDeploymentArguments(stack, directory, env, { apiOriginDomainName, natEipAllocationId }),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      // The mutation landed: record it as a changed stack so a later failure still
      // names what the run already altered in its step summary.
      io.markChanged(stack);
      if (stack === baseStack) {
        await enforceBetaPlatformLogRetention(io, { ref: env.GITHUB_REF, enabled: env.ENABLE_BETA_MUTATION });
      }
    },
    // The stop paths. `delete-egress` is the second stop step and destroys only
    // the Egress stack; since #195 `stop-runtime` deletes only the release slice.
    async destroy(stack) {
      if (purpose !== 'operation') throw new Error('Qualification cannot destroy');
      assertDeployAllowed(env, stack);
      if (env.INFRA_OPERATION === 'delete-egress') {
        if (stack !== egressStack) throw new Error('Only delete-egress may destroy the Egress stack');
      } else if (env.INFRA_OPERATION === 'stop-runtime') {
        if (stack !== runtimeStack) throw new Error('Only stop-runtime may destroy the Runtime stack');
      } else throw new Error('This operation may not destroy a stack');
      const awsEnv = await roleEnv('deploy');
      await run('npx', cdkDestroyArguments(stack, env),
        { cwd: root, env: awsEnv, timeout: 3_600_000, maxBuffer: 20 * 1024 * 1024 });
      io.markChanged(stack);
    },
    async http(url) {
      const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Deployed application identity unavailable');
      return parseJson(Buffer.from(await response.arrayBuffer()));
    },
    async verifyHealth(url, revision) {
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) }); const body = await response.json();
          if (response.ok && body.service_commit === revision.commit && body.image_digest === revision.digest && body.status === 'ok') return;
        } catch { /* Wait for the reviewed existing endpoint to become ready. */ }
        await io.sleep(10_000);
      }
      throw new Error('Public health failed to match the deployed image');
    },
  };
  return io;
}
export async function runOperation(env = process.env, {
  createIo = createRuntimeIo,
  // `deploy-runtime` executes its own change set and then runs four gates. This
  // seam lets the tests inject its collaborators (synthesis, `/health` probe, bake
  // and schema gate) so a landed-then-refused mutation is credential-free testable;
  // production passes none and gets the real implementations.
  deployRuntimeDependencies = {},
} = {}) {
  const inputs = validateOperationInputs(env);
  const operation = env.INFRA_OPERATION;
  // The stacks this run has already mutated. If a later gate refuses, the step
  // summary names them: a red run that already changed a stack is the platform
  // fact the operator decides the follow-up from, and it replaces the retired
  // record's `partial`/`requires-explicit-recovery` verdict.
  const changedStacks = [];
  try {
  const io = await createIo(env, { changedStacks });
  if ((await io.aws(['sts', 'get-caller-identity'])).Account !== account) throw new Error('Wrong runtime account');
  // A release operation resolves the image digest its Service commit was published
  // under from the immutable ECR tag, under the operation's own session and before
  // the deploy. A missing or ambiguous tag fails with no mutation. Every other
  // operation takes no release. The service half of the four controls stays: the
  // deploy still proves the tag→commit binding and the image digest it deploys.
  let serviceRelease = null;
  if (inputs.service_release) {
    serviceRelease = { ...inputs.service_release,
      imageDigest: await resolveServiceImageDigest(io, inputs.service_release.serviceCommit) };
  }
  if (operation === 'state') {
    // Read-only state is a run fact: the observed status is printed to the step log
    // and the summary, never written to a record. A failed read still throws with
    // the partial state preserved on the error.
    const state = await observeBetaState(io);
    process.stdout.write(`${JSON.stringify(state)}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(env.GITHUB_STEP_SUMMARY,
        `Beta state: ${state.stacks.map(stack => `${stack.stack_name}=${stack.status}`).join('; ')}\n`);
    }
    return;
  }
  if (operation === 'restore-release') await runRestoreRelease({ io, infraSha: env.GITHUB_SHA, env });
  else if (Object.hasOwn(testerOperationActions, operation)) await runTesterAllowlist(testerOperationActions[operation], env.TESTER_EMAILS, io);
  else if (operation === 'migrate') {
    // #243: the migration runs the release the operator names, whether or not it
    // is deployed. There is no Runtime stack to read an image from — the stack
    // cannot be created before the migration it needs — so the sealed artifact
    // identity resolved above is the only source of the image. The stack reads
    // below are refusals, not image selection: they stop a stopped or racing
    // environment by name before the task is registered, instead of letting the
    // container fail at the image pull minutes later.
    if (!serviceRelease) throw new Error('migrate requires the explicit Service release tag');
    const platform = await stackRead(io, baseStack);
    if (!terminalStackStatuses.has(platform?.StackStatus)) {
      throw new Error(`migrate requires a terminal ${baseStack}; observed ${platform?.StackStatus ?? 'unavailable'}`);
    }
    // Beta's Egress stack is on by default. An absent read is the stopped
    // environment: the migration neither creates nor deletes it, and names Beta's
    // start sequence as the remedy.
    const egress = await stackRead(io, egressStack);
    if (egress?.StackName !== egressStack) {
      throw new Error(`migrate requires ${egressStack}; Beta is stopped, run its start sequence`);
    }
    if (!terminalStackStatuses.has(egress.StackStatus)) {
      throw new Error(`migrate requires a terminal ${egressStack}; observed ${egress.StackStatus ?? 'unavailable'}`);
    }
    // The migration does not need the Runtime stack, so an absent one proceeds; a
    // present one mid-update is refused rather than raced, because a schema
    // changing under the run is not a schema it can migrate.
    const runtime = await stackRead(io, runtimeStack);
    if (runtimeExists(runtime)) assertTerminalRuntime(runtime, 'migrate');
    // The step log states the identity the run proves: tag, Service commit and the
    // digest the release tag resolved to in this run.
    process.stdout.write(`migrate runs Service release ${serviceRelease.releaseTag}@${serviceRelease.serviceCommit} `
      + `from image ${serviceRelease.imageDigest}\n`);
    await io.oneShot('migrate', { digest: serviceRelease.imageDigest, commit: serviceRelease.serviceCommit });
  } else if (operation === 'deploy-runtime') {
    // Issue #195: one operation deploys a Service release, resolves the image
    // digest, judges the change set and bakes the six signals in this same
    // mutating job. Its job conclusion is the verdict; nothing follows it.
    await deployRuntime({ ...deployRuntimeDependencies, io, env, release: serviceRelease });
  } else if (operation === 'stop-runtime') {
    await stopRuntime({ io, env });
  } else if (operation === 'delete-egress') {
    await deleteOperationStack(io, operation);
  } else {
    // The Base and account-wide stacks take no release input; only the Base stack
    // consumes Service-built Lambda assets, and its deploy proved those bytes
    // through the reviewed artifact identity before credentials. A Base deploy
    // additionally reads the Infra-owned Runtime stack terminal first (one
    // writer) and takes its live API origin.
    await deployOperationStack(io, operation);
  }
  const base = await stackRead(io, baseStack);
  const runtime = await stackRead(io, runtimeStack);
  if (!terminalStackStatuses.has(base?.StackStatus)) throw new Error(`The Base stack is not terminal after ${operation}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `runtime_exists=${runtimeExists(runtime)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const release = inputs.service_release ? ` Service release ${inputs.service_release.releaseTag}@${inputs.service_release.serviceCommit}.` : '';
    await appendFile(env.GITHUB_STEP_SUMMARY, `Infra operation ${operation}; source ${env.GITHUB_SHA}.${release}\n`);
  }
  } catch (error) {
    // A mutation that landed and then failed a later gate still ends with a
    // non-success run; this one summary line makes "changed but unqualified"
    // legible from the run itself. Nothing reports the operation complete.
    if (changedStacks.length) {
      const names = [...new Set(changedStacks)].join(', ');
      process.stderr.write(`Infra operation ${operation} already changed ${names} before failing; the run is failed and the change is unqualified.\n`);
      if (env.GITHUB_STEP_SUMMARY) {
        await appendFile(env.GITHUB_STEP_SUMMARY,
          `Infra operation ${operation} already changed ${names} and did not complete: the run is failed and the change is unqualified. Follow the Beta runbook's decision procedure.\n`);
      }
    }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runOperation();
