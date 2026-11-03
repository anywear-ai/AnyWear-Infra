import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalDeployedTemplateHash,
  stableTaskDefinition,
  taskDefinitionContentHash,
  normaliseDeployedTemplate,
} from '../lib/contracts.mjs';
import { canonicalJson, parseJson, sha256, DIGEST, SHA } from './json-contract.mjs';
import { describeStack, runtimeExists, runtimeStack, terminalStackStatuses } from './one-writer.mjs';
import { synthStage } from './recovery-contract.mjs';
import { readRuntimeDeployValues, readRuntimeStageContract, runtimeBakeQueueUrls, runtimeEcsClusterName } from './runtime-stage-inputs.mjs';
import { runBakeGate } from './bake-gate.mjs';
import { SELECTED_RELEASE_DIRECTORY } from './release-inputs.mjs';
import { runSchemaBoundaryGate } from './schema-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_STACK = runtimeStack;
export const BASE_STACK = 'AnyWearPlatformStack-beta';
export const RUNTIME_REGION = 'ap-east-1';
export const PHASE = 'roles-added';
// The five template parameters a `deploy-runtime` passes. The first two identify
// the release, the retained sizing profile comes from the live stack (the reviewed
// default applies only when the stack has never carried it), and the final pair
// comes from the reviewed stage contract.
export const RUNTIME_DEPLOY_PARAMETER_KEYS = Object.freeze([
  'ServiceImageDigest', 'ServiceCommitSha', 'BetaApiSizingProfile',
  'VlmConfigArn', 'CloudFrontPrefixListId',
]);
const SIZING_PROFILES = Object.freeze(['s1', 's2-api']);
const CHANGE_SET_NAME = /^[A-Za-z][-A-Za-z0-9]{0,127}$/;
const SERVICE_NAMES = Object.freeze(['beta-anywear-api', 'beta-anywear-worker']);
// Issue #254: the Base stack's API-origin parameter and the DNS-name guard the
// parameter itself carries. A value outside this pattern never reaches a write.
const API_ORIGIN_PARAMETER = 'ApiOriginDomainName';
const API_ORIGIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const BOOTSTRAP_PARAMETER = 'ParameterKey=BootstrapVersion,UsePreviousValue=true';
// Issue #195: the declared template normalisation (`normaliseDeployedTemplate` in
// `lib/contracts.mjs`) drops the `CDKMetadata` resource and its condition before
// the deployed template is hashed, because they are CDK diagnostic metadata, not
// infrastructure. The change-set judgement applies the same declaration: an
// `AWS::CDK::Metadata` change is evidence, never a stack change, a delta or a
// replacement. Every other resource keeps the fail-closed guard unchanged.
export const DECLARED_DIAGNOSTIC_RESOURCE_TYPES = Object.freeze(['AWS::CDK::Metadata']);
export const DECLARED_DIAGNOSTIC_EXCLUSION = 'declared CDK diagnostic metadata';

export function assertRuntimePhase(operation, env = process.env) {
  if (!['deploy-runtime', 'stop-runtime'].includes(operation)) {
    throw new Error(`Runtime operation required; got ${operation}`);
  }
  // The live Runtime stack is at the recorded `roles-added` phase. Both other
  // phases would change the template's cleanup surface, so they fail closed
  // before any AWS call rather than synthesizing a different stack.
  if (env.INFRA_IDENTITY_PHASE !== PHASE) {
    throw new Error(`${operation} requires the recorded live identity phase ${PHASE}; got ${env.INFRA_IDENTITY_PHASE}`);
  }
}

export function runtimeChangeSetName(env) {
  const name = `anywear-runtime-${env.GITHUB_RUN_ID}`;
  if (!CHANGE_SET_NAME.test(name)) throw new Error('Invalid Runtime change-set name');
  return name;
}

const TEMPLATE_HASH = /^[a-f0-9]{64}$/;

/** The parsed `test/baselines/provenance.json` record. */
function readRuntimeProvenance() {
  return JSON.parse(readFileSync(path.join(ROOT, 'test/baselines/provenance.json'), 'utf8'));
}

/** The recorded normalised identity of the live Runtime phase. */
export function recordedRuntimePhaseHash(provenance = readRuntimeProvenance()) {
  const hash = provenance.runtime_identity?.identity_phases?.[PHASE];
  if (typeof hash !== 'string' || !TEMPLATE_HASH.test(hash)) {
    throw new Error('The recorded Runtime roles-added identity is missing');
  }
  return hash;
}

/**
 * The recorded live predecessors from one `identity_revision` member. The member is
 * optional: an absent list means the recorded identity is the only accepted live
 * template. A malformed list or entry fails closed, because a deployment must never
 * widen its own drift allowance from a broken record.
 */
export function recordedLivePredecessors(identityRevision) {
  const predecessors = identityRevision?.accepted_live_predecessors;
  if (predecessors === undefined) return Object.freeze([]);
  if (!Array.isArray(predecessors)) throw new Error('The recorded Runtime live predecessor set must be an array');
  for (const hash of predecessors) {
    if (typeof hash !== 'string' || !TEMPLATE_HASH.test(hash)) {
      throw new Error('The recorded Runtime live predecessor is not a 64-hex digest');
    }
  }
  return Object.freeze([...predecessors]);
}

/**
 * The live-template acceptance set: the recorded phase identity plus the recorded
 * `accepted_live_predecessors` (issue #183's one recorded transition). It is used
 * only for the live `Original` drift check; the synthesis check and the post-deploy
 * read-back stay exact against `recordedRuntimePhaseHash()`.
 */
export function acceptedLiveRuntimeHashes(provenance = readRuntimeProvenance()) {
  return Object.freeze([recordedRuntimePhaseHash(provenance),
    ...recordedLivePredecessors(provenance.runtime_identity?.identity_revision)]);
}

/**
 * Assert the live `Original` template is the recorded identity or a recorded live
 * predecessor. `accepted` is the injectable seam the deploy path defaults to
 * `acceptedLiveRuntimeHashes()`; tests pin it to their fixture identity so a fixture
 * template never widens the production acceptance set.
 */
export function assertLiveRuntimeIdentity(liveNormalisedHash, accepted = acceptedLiveRuntimeHashes()) {
  if (!Array.isArray(accepted) || accepted.length === 0) {
    throw new Error('The accepted Runtime live identities are unavailable');
  }
  if (!accepted.includes(liveNormalisedHash)) {
    throw new Error(`The deployed Runtime template normalises to ${liveNormalisedHash}, not the recorded ${PHASE} identity ${accepted[0]}`);
  }
  return liveNormalisedHash;
}

/**
 * Resolve the five deploy parameters. The live stack's retained sizing profile
 * wins; the reviewed default applies only when the stack never carried it. Release
 * identity values are validated before they reach a template.
 */
export function runtimeDeployParameters({ liveParameters = [], deployValues, release }) {
  if (!Array.isArray(liveParameters)) throw new Error('Invalid live Runtime parameters');
  if (!release || typeof release !== 'object') throw new Error('A sealed artifact identity is required');
  if (!SHA.test(release.serviceCommit ?? '')) throw new Error('Invalid release Service commit');
  if (!DIGEST.test(release.imageDigest ?? '')) throw new Error('Invalid release image digest');
  if (!deployValues || typeof deployValues !== 'object') throw new Error('The Runtime deploy inputs were not read');
  const live = new Map();
  for (const entry of liveParameters) {
    if (typeof entry?.ParameterKey !== 'string' || typeof entry.ParameterValue !== 'string') {
      throw new Error('Invalid live Runtime parameter');
    }
    live.set(entry.ParameterKey, entry.ParameterValue);
  }
  const profile = live.get('BetaApiSizingProfile') ?? 's1';
  if (!SIZING_PROFILES.includes(profile)) throw new Error(`Unreviewed retained Beta sizing profile ${profile}`);
  return Object.freeze({
    ServiceImageDigest: release.imageDigest,
    ServiceCommitSha: release.serviceCommit,
    BetaApiSizingProfile: profile,
    VlmConfigArn: deployValues.VlmConfigArn,
    CloudFrontPrefixListId: deployValues.CloudFrontPrefixListId,
  });
}

/** The exact CDK deploy arguments for the Runtime change set. */
export function runtimeCdkDeployArguments({ parameters, changeSetName, identityPhase, retentionProtection }) {
  const keys = Object.keys(parameters).sort();
  if (canonicalJson(keys) !== canonicalJson([...RUNTIME_DEPLOY_PARAMETER_KEYS].sort())) {
    throw new Error('The Runtime deploy must pass exactly the five reviewed parameters');
  }
  if (!CHANGE_SET_NAME.test(changeSetName ?? '')) throw new Error('Invalid Runtime change-set name');
  // The CDK CLI declares `--parameters` as an `array` option with `nargs: 1` and
  // documents the `STACK:KEY=VALUE` form, so one flag consumes exactly one value.
  // Prefixing five bare values with a single `--parameters` (the #195 form) kept
  // only the first and let `--previous-parameters` (default true) silently retain
  // the other four: the 2026-10-23 compatible dispatch advanced
  // `ServiceImageDigest` while `ServiceCommitSha` stayed on the previous release.
  // One stack-qualified flag per parameter plus `--previous-parameters=false`
  // makes a dropped parameter fail the deploy instead of inheriting a stale value.
  return ['cdk', 'deploy', RUNTIME_STACK, '--exclusively', '--require-approval', 'never', '--no-execute',
    '--change-set-name', changeSetName,
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${identityPhase}`, '-c', `ecrImageRetention=${retentionProtection}`,
    '--previous-parameters=false',
    ...RUNTIME_DEPLOY_PARAMETER_KEYS.flatMap((key) =>
      ['--parameters', `${RUNTIME_STACK}:${key}=${parameters[key]}`])];
}

/** The CDK destroy arguments for `stop-runtime`. */
export function runtimeCdkDestroyArguments(identityPhase, retentionProtection) {
  return ['cdk', 'destroy', RUNTIME_STACK, '--force', '--exclusively',
    '-c', 'deployScope=runtime', '-c', 'stage=beta', '-c', 'legacyRoleSource=external',
    '-c', `identityPhase=${identityPhase}`, '-c', `ecrImageRetention=${retentionProtection}`];
}

/**
 * Classify a CloudFormation change set as the AC 4 evidence.
 *
 * A converged stack has no update to make. CloudFormation may answer that with an
 * empty change set, with a `FAILED` set whose reason is "didn't contain changes",
 * or with no change set at all (the CDK CLI short-circuits); all three are
 * `converged: true`. Any Add/Remove/Modify is a delta the caller must judge,
 * except a change to an `AWS::CDK::Metadata` resource: that resource is the
 * declared diagnostic metadata the template normalisation drops, so it is kept in
 * `diagnostic_changes` as evidence and never counts as a real delta or
 * replacement.
 */
export function classifyChangeSet(changeSet) {
  if (changeSet === undefined || changeSet === null) {
    return Object.freeze({ converged: true, status: 'absent', executionStatus: 'absent', reason: 'no change set',
      changes: [], resource_changes: [], diagnostic_changes: [], replacement: false });
  }
  const status = String(changeSet.Status ?? 'unknown');
  const executionStatus = String(changeSet.ExecutionStatus ?? 'unknown');
  const reason = String(changeSet.StatusReason ?? '');
  const changes = (changeSet.Changes ?? []).map((row) => {
    const resourceType = row?.ResourceChange?.ResourceType ?? 'unavailable';
    return {
      action: String(row?.Type ?? 'unknown'),
      logical_id: row?.ResourceChange?.LogicalResourceId ?? 'unavailable',
      resource_type: resourceType,
      action_type: String(row?.ResourceChange?.Action ?? row?.Type ?? 'unknown'),
      replacement: row?.ResourceChange?.Replacement ?? 'False',
      ...(DECLARED_DIAGNOSTIC_RESOURCE_TYPES.includes(resourceType)
        ? { declared_diagnostic: true, excluded: DECLARED_DIAGNOSTIC_EXCLUSION } : {}),
    };
  });
  const resourceChanges = changes.filter((change) => change.declared_diagnostic !== true);
  const diagnosticChanges = changes.filter((change) => change.declared_diagnostic === true);
  const noChanges = /didn'?t contain changes|did not contain changes/i.test(reason);
  const failed = status === 'FAILED' && !noChanges;
  // A set whose only changes are declared diagnostics is converged: the
  // normalised templates are equal, so the CDKMetadata payload is not a stack
  // change and never a reason to refuse. The diagnostic rows stay visible in the
  // returned classification for the run log.
  const converged = !failed && (noChanges || resourceChanges.length === 0);
  return Object.freeze({
    converged, failed, status, execution_status: executionStatus, reason, changes,
    resource_changes: resourceChanges, diagnostic_changes: diagnosticChanges,
    replacement: resourceChanges.some((change) => change.replacement === 'True' || change.replacement === 'Conditional'),
  });
}

/**
 * Issue #220: the board-authorized admission rule for a change set created under
 * an unchanged Service artifact identity.
 *
 * A dispatched release that is already deployed may still carry a reviewed,
 * non-replacement Runtime template delta: an Infra-owned alarm or metric-filter
 * change has to land between Service releases. The synthesis check and the
 * post-deploy read-back still require that delta to normalise to the recorded
 * `roles-added` identity, so it must be reviewed into
 * `test/baselines/provenance.json` first. This guard admits exactly that delta —
 * every real change an `Add` or a `Modify` with `Replacement: 'False'` — and
 * refuses everything else: any `Remove`, any `Add`/`Modify` whose `Replacement`
 * is `True` or `Conditional`, and a change set that failed. Declared CDK diagnostic
 * metadata is never a real change, so it cannot appear in this judgement.
 */
export function assertReleaseStableChangeSet(classification) {
  if (classification.failed) throw new Error(`The Runtime change set failed: ${classification.reason || classification.status}`);
  const changes = classification.resource_changes ?? classification.changes;
  // CloudFormation reports each row's `Type` as `Resource`; the action is
  // `ResourceChange.Action`, which the classifier already parsed as `action_type`.
  // (Issue #220's first deployment refused every real row because this guard read
  // `action` — the row type — instead; the tests now use the real row shape.)
  const refused = changes.filter((change) => !((change.action_type === 'Add' || change.action_type === 'Modify')
    && change.replacement === 'False'));
  if (refused.length) {
    const summary = refused.map((change) => `${change.action_type} ${change.logical_id} (${change.replacement})`).join(', ');
    throw new Error('An unchanged Runtime release admits only Add/Modify changes without replacement; '
      + `the change set lists ${refused.length} refused: ${summary}`);
  }
}

/** An absent stack is the Add-only start path; every change must be an Add. */
export function assertCreateOnlyChangeSet(classification) {
  if (classification.failed) throw new Error(`The Runtime change set failed: ${classification.reason || classification.status}`);
  if (classification.converged) return;
  // Same real row shape as `assertReleaseStableChangeSet`: `ResourceChange.Action`.
  const notAdd = classification.changes.filter((change) => change.action_type !== 'Add');
  if (notAdd.length) {
    throw new Error(`A missing Runtime stack must be created only with Add changes; observed ${notAdd.map((change) => change.logical_id).join(', ')}`);
  }
}

async function describeChangeSet(io, stack, changeSetName) {
  try {
    return await io.awsAs('deploy', ['cloudformation', 'describe-change-set', '--stack-name', stack,
      '--change-set-name', changeSetName]);
  } catch (error) {
    const text = [error?.stderr, error?.message].filter((value) => typeof value === 'string').join('\n');
    if (/does not exist|ChangeSetNotFound/i.test(text)) return undefined;
    throw error;
  }
}

// The deploy session describes, executes or deletes this run's change set and
// nothing else (#195). Both the converged no-op and the fail-closed delta leave no
// AVAILABLE change set behind; the thrown classification names the delta, so no
// later describe of a deleted set is required.
async function deleteChangeSet(io, stack, changeSetName) {
  await io.awsAs('deploy', ['cloudformation', 'delete-change-set', '--stack-name', stack,
    '--change-set-name', changeSetName]);
}

async function waitForTerminalStack(io, stack, { timeoutMs = 3_600_000, intervalMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = await describeStack(io, stack);
    const status = observed?.StackStatus ?? 'unavailable';
    if (terminalStackStatuses.has(status)) return observed;
    if (/ROLLBACK|FAILED/i.test(status)) throw new Error(`The Runtime stack update ended in ${status}`);
    if (Date.now() + intervalMs > deadline) throw new Error(`The Runtime stack did not become terminal; observed ${status}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Assert the synthesized Runtime template normalises to the recorded live
 * `roles-added` identity. It is separate from the synthesis so the refusal is
 * testable without a full cloud assembly; issue #220's admission rule depends on
 * it, because a template delta not reviewed into the record must never reach a
 * change set.
 */
export function assertSynthesizedRuntimeIdentity(template, expected = recordedRuntimePhaseHash()) {
  const observed = canonicalDeployedTemplateHash(template);
  if (observed !== expected) {
    throw new Error(`The synthesized Runtime template normalises to ${observed}, not the recorded ${PHASE} identity ${expected}`);
  }
  return observed;
}

/** Synthesize the Runtime template from the one Infra app and assert its identity. */
export async function synthesizeRuntimeTemplate(env) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anywear-runtime-identity-'));
  try {
    synthStage({ repository: ROOT, directory, stage: 'beta', deployScope: 'runtime',
      inputs: { identityPhase: env.INFRA_IDENTITY_PHASE, ecrImageRetention: env.INFRA_RETENTION_PROTECTION === 'true',
        legacyRoleSource: 'external' } });
    const file = path.join(directory, `${RUNTIME_STACK}.template.json`);
    const template = JSON.parse(await readFile(file, 'utf8'));
    const expected = recordedRuntimePhaseHash();
    const observed = assertSynthesizedRuntimeIdentity(template, expected);
    return { template, raw_sha256: sha256(canonicalJson(template)), normalised_sha256: observed, expected };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function observeEcsIdentities(io, release, cluster) {
  const response = await io.aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...SERVICE_NAMES]);
  const services = response.services;
  if (!Array.isArray(services) || services.length !== SERVICE_NAMES.length) {
    throw new Error('The Runtime ECS services are not both deployed');
  }
  const observed = {};
  for (const service of services) {
    const purpose = SERVICE_NAMES.includes(service.serviceName) ? service.serviceName.replace('beta-anywear-', '') : undefined;
    if (!purpose || service.status !== 'ACTIVE' || typeof service.taskDefinition !== 'string') {
      throw new Error(`The Runtime ECS service ${service.serviceName} is not usable`);
    }
    if (!Number.isSafeInteger(service.runningCount) || service.runningCount !== service.desiredCount || service.runningCount < 1) {
      throw new Error(`The Runtime ECS service ${service.serviceName} is not at its desired count`);
    }
    if (!Array.isArray(service.deployments) || service.deployments.length !== 1
      || service.deployments[0].rolloutState !== 'COMPLETED') {
      throw new Error(`The Runtime ECS service ${service.serviceName} has not completed its rollout`);
    }
    const definition = (await io.aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition])).taskDefinition;
    const contentHash = taskDefinitionContentHash(definition);
    const image = stableTaskDefinition(definition).container.image;
    if (typeof image !== 'string' || !image.includes(release.imageDigest)) {
      throw new Error(`The deploys task definition for ${service.serviceName} does not carry the deployed image digest`);
    }
    observed[purpose] = {
      service_arn: service.serviceArn,
      task_definition_arn: service.taskDefinition,
      task_definition_sha256: contentHash,
      image_digest: release.imageDigest,
    };
  }
  for (const purpose of ['api', 'worker']) {
    if (!observed[purpose]) throw new Error(`The Runtime ECS ${purpose} identity is missing`);
  }
  return observed;
}

/**
 * Read `/health` under the deployed endpoint and return the minimum Client
 * version floor. Identity mismatches fail immediately; a transient unavailable
 * endpoint is retried within a bounded window.
 */
export async function readRuntimeHealth(apiBaseUrl, release, { fetchImpl = fetch, sleep, timeoutMs = 600_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (typeof apiBaseUrl !== 'string' || !/^https:\/\//.test(apiBaseUrl)) throw new Error('Invalid deployed API endpoint');
  const wait = sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  let unavailability = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok || body?.status !== 'ok') {
        unavailability = `HTTP ${response.status} status ${body?.status ?? 'unavailable'}`;
      } else {
        if (body.service_commit !== release.serviceCommit) {
          throw new Error(`The deployed /health commit ${body.service_commit ?? 'absent'} differs from the release ${release.serviceCommit}`);
        }
        if (body.image_digest !== release.imageDigest) {
          throw new Error(`The deployed /health image digest ${body.image_digest ?? 'absent'} differs from the release ${release.imageDigest}`);
        }
        const floor = body.minimum_client_version;
        if (!Number.isSafeInteger(floor) || floor < 0) {
          throw new Error('The deployed /health minimum client version is not a non-negative safe integer');
        }
        return floor;
      }
    } catch (error) {
      if (/differs from the release|minimum client version/.test(error.message)) throw error;
      unavailability = error.message;
    }
    if (Date.now() + 10_000 > deadline) break;
    await wait(10_000);
  }
  throw new Error(`The deployed /health did not identify the release: ${unavailability}`);
}

/**
 * The deployed identity a `deploy-runtime` proved: the read-back parameter pair,
 * the normalised template hash and the `/health` floor. It is a return value for
 * the caller and the run log, never a record (#207).
 */
export function deployedIdentity({ release, minimumClientVersion, templateSha256 }) {
  return Object.freeze({
    service_sha: release.serviceCommit,
    image_digest: release.imageDigest,
    minimum_client_version: minimumClientVersion,
    template_sha256: templateSha256,
  });
}

/** Resolve the deployed parameters as a plain map for the retain/compare checks. */
export function deployedParameterMap(stack) {
  const map = new Map();
  for (const entry of stack?.Parameters ?? []) {
    if (typeof entry?.ParameterKey === 'string') map.set(entry.ParameterKey, entry.ParameterValue);
  }
  return map;
}

/** The pinned revision the live Runtime stack carries, when both halves are valid. */
export function runtimePinnedRevision(stack) {
  const parameters = deployedParameterMap(stack);
  const serviceCommit = parameters.get('ServiceCommitSha');
  const imageDigest = parameters.get('ServiceImageDigest');
  if (typeof serviceCommit !== 'string' || !SHA.test(serviceCommit)
    || typeof imageDigest !== 'string' || !DIGEST.test(imageDigest)) return undefined;
  return { serviceCommit, imageDigest };
}

/** The exact `cloudformation update-stack` the deploy session may issue (#254). */
export function apiOriginUpdateArguments(origin) {
  if (typeof origin !== 'string' || !API_ORIGIN.test(origin)) throw new Error('Invalid API origin DNS name');
  return ['cloudformation', 'update-stack', '--stack-name', BASE_STACK, '--use-previous-template',
    '--parameters', BOOTSTRAP_PARAMETER, `ParameterKey=${API_ORIGIN_PARAMETER},ParameterValue=${origin}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM'];
}

/**
 * The Beta edge repair (#254). The Runtime stack publishes the load balancer the
 * Base distribution must point at as `ApiLoadBalancerDnsName`. When the Base
 * stack's recorded `ApiOriginDomainName` already equals it, this writes nothing
 * and logs nothing, so a release deploy on a running Beta keeps the Base stack's
 * `LastUpdatedTime`. Otherwise it issues exactly one `update-stack` that reuses
 * the deployed template and changes only that parameter, then polls
 * `describe-stacks` until `UPDATE_COMPLETE`.
 *
 * The poll cannot accept the pre-update terminal read: both the old and the new
 * state are `UPDATE_COMPLETE`, so it requires the `LastUpdatedTime` read before
 * the update to have moved. Any `ROLLBACK`/`FAILED` status, an absent or
 * unreadable post-update stack, the deadline, or a failed `update-stack` call
 * ends the run before `/health` is read, naming the edge. The accepted write is
 * recorded as a landed change before the poll, so a poll failure still leaves the
 * Base stack in the failed-run summary.
 */
export async function repairApiOrigin(io, runtime, { timeoutMs = 900_000, intervalMs = 15_000 } = {}) {
  const origin = (runtime?.Outputs ?? []).find((output) => output.OutputKey === 'ApiLoadBalancerDnsName')
    ?.OutputValue;
  if (typeof origin !== 'string' || !API_ORIGIN.test(origin)) {
    throw new Error(`deploy-runtime requires the ${RUNTIME_STACK} ApiLoadBalancerDnsName output before it can repair the Beta edge origin`);
  }
  const base = await describeStack(io, BASE_STACK);
  if (!base) {
    throw new Error(`deploy-runtime cannot repair the Beta edge origin: ${BASE_STACK} is absent`);
  }
  const parameter = (base.Parameters ?? []).find((entry) => entry?.ParameterKey === API_ORIGIN_PARAMETER);
  if (!parameter) {
    throw new Error(`${BASE_STACK} does not declare the ${API_ORIGIN_PARAMETER} parameter, so the Beta edge origin cannot be written; one deploy-platform installs it`);
  }
  const recorded = parameter.ParameterValue;
  if (recorded === origin) return { changed: false, origin };
  const before = base.LastUpdatedTime;
  try {
    await io.awsAs('deploy', apiOriginUpdateArguments(origin));
  } catch (error) {
    throw new Error(`The Beta edge origin was not written: cloudformation update-stack failed on ${BASE_STACK} (${API_ORIGIN_PARAMETER}); /health was not read and the public endpoint still points at ${recorded || 'no recorded origin'}`, { cause: error });
  }
  // The update call was accepted, so CloudFormation has started a Base-stack
  // update: record the landed change before the poll, the way the Runtime change
  // set is recorded at execute-change-set acceptance. A poll failure below then
  // still leaves the failed-run summary naming the Base stack.
  io.markChanged(BASE_STACK);
  const deadline = io.now() + timeoutMs;
  for (;;) {
    let observed;
    try {
      observed = await describeStack(io, BASE_STACK);
    } catch (error) {
      throw new Error(`The Beta edge origin was not verified: ${API_ORIGIN_PARAMETER} was set to ${origin} but reading ${BASE_STACK} failed (${error?.message ?? 'unknown error'}); /health was not read`, { cause: error });
    }
    if (!observed) {
      throw new Error(`The Beta edge origin was not verified: ${API_ORIGIN_PARAMETER} was set to ${origin} but ${BASE_STACK} is absent after the origin write; /health was not read`);
    }
    const status = observed.StackStatus ?? 'unavailable';
    if (/ROLLBACK|FAILED/i.test(status)) {
      throw new Error(`The Beta edge origin was not written: ${BASE_STACK}'s ${API_ORIGIN_PARAMETER} update to ${origin} ended in ${status}; /health was not read`);
    }
    // Only the update this run issued is accepted: the pre-update read is
    // terminal with the same status, so its timestamp must have moved.
    if (terminalStackStatuses.has(status) && observed.LastUpdatedTime !== before) break;
    if (io.now() + intervalMs > deadline) {
      throw new Error(`The Beta edge origin was not written: ${BASE_STACK} did not reach UPDATE_COMPLETE after setting ${API_ORIGIN_PARAMETER} to ${origin}; observed ${status}; /health was not read`);
    }
    await io.sleep(intervalMs);
  }
  process.stdout.write(`api_origin_repointed ${recorded} -> ${origin}\n`);
  return { changed: true, origin };
}

/** `deploy-runtime`: one converged-or-additive mutation, judged and baked in place. */
export async function deployRuntime({ io, env, release,
  synthesize = synthesizeRuntimeTemplate, health = readRuntimeHealth, bake = runBakeGate,
  schemaGate = runSchemaBoundaryGate,
  // The live-template acceptance set is a seam like the collaborators above: tests
  // pin it to their fixture identity, while production uses the recorded identity
  // plus its recorded live predecessor(s). It is used only for the live `Original`
  // drift check; synthesis and the post-deploy read-back stay exact.
  acceptedLiveHashes = acceptedLiveRuntimeHashes() }) {
  assertRuntimePhase('deploy-runtime', env);
  const base = await describeStack(io, BASE_STACK);
  if (!terminalStackStatuses.has(base?.StackStatus)) {
    throw new Error(`deploy-runtime requires a terminal Base stack; observed ${base?.StackStatus ?? 'unavailable'}`);
  }
  const runtime = await describeStack(io, RUNTIME_STACK);
  const stackExists = runtimeExists(runtime);
  if (stackExists && !terminalStackStatuses.has(runtime.StackStatus)) {
    throw new Error(`deploy-runtime requires a terminal Runtime stack; observed ${runtime.StackStatus}`);
  }
  const deployed = deployedParameterMap(runtime);
  const identityUnchanged = stackExists && deployed.get('ServiceCommitSha') === release.serviceCommit
    && deployed.get('ServiceImageDigest') === release.imageDigest;
  const deployedRevision = runtimePinnedRevision(runtime);

  const deployValues = await readRuntimeDeployValues(io);
  // The bake's queue URLs and ECS cluster are contract values from the same
  // reviewed 39-name read; they are never account/region literals or guessed queue
  // names. Both fail closed here, before the change set exists, if the contract
  // value is missing or malformed.
  const contract = await readRuntimeStageContract(io);
  const inputs = contract.inputs;
  const cluster = runtimeEcsClusterName(contract.values);
  const queueUrls = runtimeBakeQueueUrls(contract.values);
  const parameters = runtimeDeployParameters({ liveParameters: runtime?.Parameters ?? [], deployValues, release });
  // Issue #194: the schema-boundary gate runs after the stage-contract read and
  // parameter resolution and before synthesis, the change set or any other
  // mutation. A SchemaBoundaryError propagates: nothing after this line runs.
  await schemaGate({ io, env, deployedRevision,
    release: { releaseTag: release.releaseTag, serviceCommit: release.serviceCommit,
      imageDigest: release.imageDigest },
    directory: SELECTED_RELEASE_DIRECTORY });
  const synthesized = await synthesize(env);

  // A running stack's deployed template must be the recorded identity or one of the
  // recorded live predecessors (issue #183's single transition). Anything else is
  // drift, not this release, and fails closed before the change set.
  if (stackExists) {
    const liveBody = (await io.aws(['cloudformation', 'get-template', '--stack-name', RUNTIME_STACK,
      '--template-stage', 'Original'])).TemplateBody;
    const liveTemplate = typeof liveBody === 'string' ? parseJson(liveBody) : liveBody;
    assertLiveRuntimeIdentity(canonicalDeployedTemplateHash(liveTemplate), acceptedLiveHashes);
  }

  const changeSetName = runtimeChangeSetName(env);
  await io.deployRuntimeChangeSet({
    parameters, changeSetName,
    args: runtimeCdkDeployArguments({ parameters, changeSetName, identityPhase: env.INFRA_IDENTITY_PHASE,
      retentionProtection: env.INFRA_RETENTION_PROTECTION }),
  });
  const changeSet = await describeChangeSet(io, RUNTIME_STACK, changeSetName);
  const classification = classifyChangeSet(changeSet);

  if (classification.converged) {
    // The reviewed converged no-op: nothing executes, and the read-back below
    // still proves the deployed identity. A declared diagnostic delta (the
    // CDKMetadata Analytics payload) is not a stack change.
    if (changeSet !== undefined) {
      await deleteChangeSet(io, RUNTIME_STACK, changeSetName);
    }
  } else {
    if (identityUnchanged) {
      // Issue #220: the live stack already carries the dispatched release, so the
      // change set can only be an Infra-owned template delta. The board authorized
      // admitting a reviewed, non-replacement one and executing it; a removal or a
      // replacement still fails closed. The refused path deletes the change set
      // before it throws, so nothing is left AVAILABLE for a later execution, and
      // the error names the delta the classification already reports.
      try {
        assertReleaseStableChangeSet(classification);
      } catch (error) {
        if (changeSet !== undefined) {
          await deleteChangeSet(io, RUNTIME_STACK, changeSetName);
        }
        throw error;
      }
    } else if (!stackExists) {
      assertCreateOnlyChangeSet(classification);
    }
    await io.awsAs('deploy', ['cloudformation', 'execute-change-set', '--stack-name', RUNTIME_STACK,
      '--change-set-name', changeSetName]);
    // The change set landed. Record it here, at the mutation, before the stack
    // read-back, the ECS identity proof, `/health` and the 300-second bake: every
    // one of those gates can still refuse, and the failed run then names the stack
    // it already changed. `deploy-runtime` executes the change set itself, so it
    // records through the same mechanism as `io.deploy`/`io.destroy` instead of
    // relying on either of them.
    io.markChanged(RUNTIME_STACK);
    await waitForTerminalStack(io, RUNTIME_STACK);
  }

  // Read back the deployed template and parameters, then prove the identity.
  const stack = await describeStack(io, RUNTIME_STACK);
  if (!runtimeExists(stack) || !terminalStackStatuses.has(stack.StackStatus)) {
    throw new Error(`The Runtime stack is not terminal after deploy; observed ${stack?.StackStatus ?? 'absent'}`);
  }
  const body = (await io.aws(['cloudformation', 'get-template', '--stack-name', RUNTIME_STACK,
    '--template-stage', 'Original'])).TemplateBody;
  const template = typeof body === 'string' ? parseJson(body) : body;
  const templateSha256 = canonicalDeployedTemplateHash(template);
  if (templateSha256 !== synthesized.expected) {
    throw new Error(`The deployed Runtime template normalises to ${templateSha256}, not the recorded ${PHASE} identity ${synthesized.expected}`);
  }
  normaliseDeployedTemplate(template);
  const after = deployedParameterMap(stack);
  for (const key of RUNTIME_DEPLOY_PARAMETER_KEYS) {
    if (after.get(key) !== parameters[key]) {
      throw new Error(`The deployed Runtime parameter ${key} does not match the requested deployment`);
    }
  }

  // The two ECS service identities stay a fail-closed proof of the deployed
  // release: an ACTIVE service at its desired count, one COMPLETED rollout, and a
  // task definition carrying the deployed image digest. The result is logged, not
  // recorded (#207).
  await observeEcsIdentities(io, release, cluster);
  // Issue #254: the Runtime stack is terminal and its identities are proven, so
  // the edge repair runs here — before the `/health` read and the bake use the
  // public endpoint. A matching parameter writes nothing; a stale one writes the
  // Base stack's single parameter and is recorded as a landed change.
  await repairApiOrigin(io, stack);
  const apiBaseUrl = new Map(inputs.map((row) => [row.parameter, row])).has('/anywear/beta/api_base_url')
    ? (await io.aws(['ssm', 'get-parameter', '--name', '/anywear/beta/api_base_url'])).Parameter?.Value : undefined;
  if (typeof apiBaseUrl !== 'string' || !/^https:\/\//.test(apiBaseUrl)) throw new Error('The stage contract api_base_url is unavailable');
  const minimumClientVersion = await health(apiBaseUrl, release, { sleep: io.sleep });
  const gate = await bake({ stage: 'beta', stack: RUNTIME_STACK, apiBaseUrl, cluster,
    queueUrls, logGroup: '/anywear/beta/worker',
    serviceSha: release.serviceCommit, imageDigest: release.imageDigest,
    now: io.now, sleep: io.sleep, fetchImpl: fetch, runAws: await io.runtimeAwsRunner() });
  if (gate.result !== 'passed') {
    const failures = gate.signals.filter((signal) => signal.state !== 'not-breaching')
      .map((signal) => ({ signal: signal.name, state: signal.state, exceptions: signal.exceptions }));
    throw new Error(`The 300-second bake failed: ${JSON.stringify(failures)}`);
  }
  // The bake's verdict is a run fact: the deploy step log carries it, and no
  // record member does.
  process.stdout.write(`${JSON.stringify({ gate: gate.name, result: gate.result,
    duration_seconds: gate.duration_seconds, probes_sent: gate.probe.probes_sent,
    service_sha: release.serviceCommit, image_digest: release.imageDigest,
    minimum_client_version: minimumClientVersion, template_sha256: templateSha256 })}\n`);
  return deployedIdentity({ release, minimumClientVersion, templateSha256 });
}

/** `stop-runtime`: delete only the release slice; absent is the accepted no-op. */
export async function stopRuntime({ io, env }) {
  assertRuntimePhase('stop-runtime', env);
  const base = await describeStack(io, BASE_STACK);
  if (!terminalStackStatuses.has(base?.StackStatus)) {
    throw new Error(`stop-runtime requires a terminal Base stack; observed ${base?.StackStatus ?? 'unavailable'}`);
  }
  const runtime = await describeStack(io, RUNTIME_STACK);
  if (!runtimeExists(runtime)) return 'absent';
  if (!terminalStackStatuses.has(runtime.StackStatus)) {
    throw new Error(`stop-runtime requires a terminal Runtime stack; observed ${runtime.StackStatus}`);
  }
  await io.destroy(RUNTIME_STACK);
  return 'destroyed';
}
