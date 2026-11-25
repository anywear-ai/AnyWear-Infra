import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { assertProtectedExecutor, e2eExecutorPaths } from '../../scripts/lib/operation-boundaries.mjs';
import { RELEASE_IDENTITY_OPERATIONS } from '../../scripts/lib/release-inputs.mjs';

// Census guard for the post-#158 Infra surface. It describes the tree that exists
// now: Infra owns Foundation, Billing, the Beta stage base, Egress and Runtime;
// the retired `AnyWearWorkloadStack-beta` and its Service deploy chain are
// historical, so `deploy-workload` is not an Infra operation. This file asserts the entry files
// and their job/permission shape per job, not per file, so a future file that
// grows a dispatch surface or a credential job fails here.
const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
const workflowFile = name => new URL(`../../.github/workflows/${name}`, import.meta.url);
const actionFile = name => new URL(`../../.github/actions/${name}/action.yml`, import.meta.url);
const loadWorkflow = async name => yaml.load(await readFile(workflowFile(name), 'utf8'));
const loadAction = async name => yaml.load(await readFile(actionFile(name), 'utf8'));
const actionlintConfig = async () => yaml.load(await readFile(new URL('../../.github/actionlint.yaml', import.meta.url), 'utf8'));

const declaresEnvironment = job => Object.hasOwn(job ?? {}, 'environment');
const holdsIdToken = job => job?.permissions?.['id-token'] === 'write';
const credentialJobs = workflow => Object.entries(workflow.jobs ?? {})
  .filter(([, job]) => declaresEnvironment(job) || holdsIdToken(job)).map(([jobName]) => jobName);

const mutateOperations = Object.freeze(['deploy-foundation', 'deploy-billing', 'deploy-platform',
  'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
  'admission-status', 'add-testers', 'set-testers', 'rearm-object-deletion', 'publish-client']);

test('the workflow directory is exactly the four Beta entries plus the callable', async () => {
  // GitHub accepts both `.yml` and `.yaml`; the census must see either extension,
  // or a `.yaml` entry would be invisible to every assertion below.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file)).sort();
  assert.deepEqual(files, ['check.yml', 'mutate.yml', 'production.yml', 'runtime.yml', 'schedule.yml']);
  const workflows = Object.fromEntries(await Promise.all(files.map(async file => [file, await loadWorkflow(file)])));

  const dispatchSurfaces = files.filter(file => Object.hasOwn(workflows[file].on ?? {}, 'workflow_dispatch'));
  assert.deepEqual(dispatchSurfaces, ['mutate.yml', 'runtime.yml', 'schedule.yml'],
    'exactly three workflow_dispatch surfaces');

  // The four Beta entries: one automatic check, two manual chains and the scheduled
  // entry that shares the runtime queue (ADR 0033 §10).
  const betaEntries = files.filter(file => file === 'check.yml' || dispatchSurfaces.includes(file));
  assert.deepEqual(betaEntries, ['check.yml', 'mutate.yml', 'runtime.yml', 'schedule.yml']);

  // `check.yml` is the automatic entry: PR plus main pushes, no dispatch surface.
  assert.deepEqual(Object.keys(workflows['check.yml'].on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflows['check.yml'].on.push, { branches: ['main'] });
  assert.equal(Object.hasOwn(workflows['check.yml'].on, 'workflow_dispatch'), false);

  // `production.yml` stays callable-only and is not an entry.
  assert.deepEqual(Object.keys(workflows['production.yml'].on), ['workflow_call']);
  assert.equal(Object.hasOwn(workflows['production.yml'].on, 'workflow_dispatch'), false);

  // Publication retired with the package: no workflow is triggered by a tag or a
  // release, and none asks for a package-registry write permission.
  for (const file of files) {
    const triggers = workflows[file].on ?? {};
    if (Object.hasOwn(triggers, 'push')) {
      assert.equal(Object.hasOwn(triggers.push ?? {}, 'tags'), false, `${file} must not trigger on a tag`);
    }
    assert.equal(Object.hasOwn(triggers, 'release'), false, `${file} must not trigger on a release`);
    assert.equal(workflows[file].permissions?.packages, undefined, `${file} must not hold a package-registry permission`);
  }
});

test('mutate.yml keeps one preflight → verify → deploy → qualify-hold chain and no workload deploy', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  assert.deepEqual(Object.keys(mutate.jobs), ['preflight', 'verify', 'deploy', 'qualify-hold']);
  const { preflight, verify, deploy } = mutate.jobs;
  const hold = mutate.jobs['qualify-hold'];

  assert.equal(preflight.needs, undefined);
  assert.equal(verify.needs, 'preflight');
  assert.equal(deploy.needs, 'verify', 'credentials are acquired only after verification');
  assert.equal(hold.needs, 'deploy', 'the qualification follows a successful deployment');

  // One credential job, and it is the only one: `preflight` and `verify` have no
  // environment and no OIDC identity.
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  const roleHolders = name => Object.entries(mutate.jobs)
    .filter(([, job]) => JSON.stringify(job).includes(name)).map(([jobName]) => jobName);
  assert.deepEqual(roleHolders('INFRA_DEPLOY_ROLE_ARN'), ['deploy'], 'exactly one job can mutate');
  assert.deepEqual(roleHolders('INFRA_RUNTIME_ROLE_ARN'), ['deploy']);
  assert.equal(deploy.environment, 'beta');
  assert.equal(holdsIdToken(deploy), true);
  for (const job of [preflight, verify, hold]) {
    assert.equal(declaresEnvironment(job), false);
    assert.equal(holdsIdToken(job), false);
  }
  // `verify` holds the read-only App token and nothing else.
  assert.deepEqual(verify.permissions, { contents: 'read' });

  // The credential-free preflight is the stage-switch gate.
  assert.match(preflight.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(preflight.if, /vars\.ENABLE_BETA_MUTATION == 'true'/);
  // #207 retired the trigger-set output and the observation/record jobs with the
  // record they produced.
  assert.equal(preflight.outputs, undefined, 'the retired trigger-set output is gone');
  assert.equal(Object.hasOwn(mutate.jobs, 'observe'), false);
  assert.equal(Object.hasOwn(mutate.jobs, 'record'), false);

  // Exactly three things cross from `verify` to `deploy` (#344 added the Client
  // publication digest beside the release bytes and their published digests).
  assert.deepEqual(verify.outputs, { release_assets: '${{ steps.verify.outputs.release_assets }}',
    client_bundle_digest: '${{ steps.client-bundle.outputs.client_bundle_digest }}' });
  assert.equal(deploy.env.VERIFIED_RELEASE_ASSETS, '${{ needs.verify.outputs.release_assets }}');
  assert.equal(deploy.env.VERIFIED_CLIENT_BUNDLE_DIGEST, '${{ needs.verify.outputs.client_bundle_digest }}');

  assert.deepEqual(mutate.on.workflow_dispatch.inputs.operation.options, mutateOperations);
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.required, true);
  // #226/#344: the two chain context inputs. `release` is representable and refused
  // everywhere; `publish` is the Client publication chain's event and belongs to
  // `publish-client` alone.
  const deliveryTrigger = mutate.on.workflow_dispatch.inputs.delivery_trigger;
  assert.equal(deliveryTrigger.type, 'choice');
  assert.deepEqual(deliveryTrigger.options, ['deploy', 'release', 'manual', 'publish']);
  assert.equal(deliveryTrigger.default, 'manual');
  assert.equal(deliveryTrigger.required, true);
  assert.equal(mutate.on.workflow_dispatch.inputs.dispatched_by.type, 'string');
  assert.equal(mutate.on.workflow_dispatch.inputs.dispatched_by.default, '');
  // #344: the Client publication identity, three optional strings whose
  // per-operation scope is enforced in the credential-free preflight.
  for (const [name, description] of [
    ['client_run_id', /publish-client only/],
    ['client_run_attempt', /publish-client only/],
    ['client_bundle_digest', /publish-client only/],
  ]) {
    const input = mutate.on.workflow_dispatch.inputs[name];
    assert.equal(input.type, 'string', name);
    assert.equal(input.default, '', name);
    assert.match(input.description, description, name);
    assert.equal(Object.hasOwn(input, 'pattern'), false, name);
  }
  assert.match(mutate.on.workflow_dispatch.inputs.client_bundle_digest.description, /64 lowercase hex/);
  assert.equal(mutate.env.CLIENT_RUN_ID, '${{ inputs.client_run_id }}');
  assert.equal(mutate.env.CLIENT_RUN_ATTEMPT, '${{ inputs.client_run_attempt }}');
  assert.equal(mutate.env.CLIENT_BUNDLE_DIGEST, '${{ inputs.client_bundle_digest }}');
  // The publication role is a reviewed workflow literal, the way the account and
  // region are pinned: no operator creates a repository variable for this PR.
  assert.equal(mutate.env.CLIENT_PUBLISH_ROLE_ARN, 'arn:aws:iam::650880818323:role/beta-client-publish-role');
  assert.equal(/vars\.CLIENT_PUBLISH_ROLE_ARN/.test(await readFile(workflowFile('mutate.yml'), 'utf8')), false);
  assert.equal(Object.hasOwn(mutate.on.workflow_dispatch.inputs, 'release_version'), false,
    'release_version never shipped; no tag reaches Infra');
  assert.equal(mutate.env.DELIVERY_TRIGGER, '${{ inputs.delivery_trigger }}');
  assert.equal(mutate.env.DISPATCHED_BY, '${{ inputs.dispatched_by }}');
  // The entry event is readable from the run list: operation, trigger, artifact
  // tag, and the dispatching run (or the actor for a manual dispatch).
  assert.match(mutate['run-name'], /inputs\.operation/);
  assert.match(mutate['run-name'], /inputs\.delivery_trigger/);
  assert.match(mutate['run-name'], /inputs\.service_artifact_tag/);
  assert.match(mutate['run-name'], /inputs\.dispatched_by/);
  assert.match(mutate['run-name'], /github\.actor/);
  // The retired Egress EIP pin (issue #166 drill precondition) is gone from the
  // dispatch surface: the Egress stack owns its EIP and releases it on stop, so a
  // start allocates a fresh one and no operator supplies an allocation id.
  assert.equal(Object.hasOwn(mutate.on.workflow_dispatch.inputs, 'nat_eip_allocation_id'), false);
  assert.equal(Object.hasOwn(mutate.env, 'NAT_EIP_ALLOCATION_ID'), false);
  // Issue #321: the abandoned-manifest re-arm carries exactly two dispatch inputs.
  // They are optional strings whose per-operation scope is enforced in the
  // credential-free preflight, exactly like the tester payload; the workflow
  // itself admits them on every operation.
  const manifestIdInput = mutate.on.workflow_dispatch.inputs.object_deletion_manifest_id;
  assert.equal(manifestIdInput.type, 'string');
  assert.equal(manifestIdInput.default, '');
  assert.match(manifestIdInput.description, /rearm-object-deletion/);
  assert.match(manifestIdInput.description, /empty on every other operation/);
  assert.equal(Object.hasOwn(manifestIdInput, 'pattern'), false);
  const expectedGenerationInput = mutate.on.workflow_dispatch.inputs.object_deletion_expected_generation;
  assert.equal(expectedGenerationInput.type, 'string');
  assert.equal(expectedGenerationInput.default, '');
  assert.match(expectedGenerationInput.description, /rearm-object-deletion/);
  assert.match(expectedGenerationInput.description, /positive integer/);
  assert.equal(Object.hasOwn(expectedGenerationInput, 'pattern'), false);
  assert.equal(mutate.env.OBJECT_DELETION_MANIFEST_ID, '${{ inputs.object_deletion_manifest_id }}');
  assert.equal(mutate.env.OBJECT_DELETION_EXPECTED_GENERATION, '${{ inputs.object_deletion_expected_generation }}');
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.options.includes('rearm-object-deletion'), true);
  // #158 step C: the retired Service release-slice deploy chain is not an Infra
  // operation. No operation, input or step may reintroduce it here.
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.options.includes('deploy-workload'), false);
  const text = await readFile(workflowFile('mutate.yml'), 'utf8');
  assert.equal(/deploy-workload/.test(text), false, 'mutate.yml must not name the retired workload operation');
  // #166/#195: Egress and Runtime are the disposable stacks Infra owns. Since
  // #195 the Runtime slice is deployed here too, by exactly these two operations;
  // the retired Workload identity stays absent.
  assert.match(text, /deploy-egress/);
  assert.match(text, /delete-egress/);
  assert.match(text, /deploy-runtime/);
  assert.match(text, /stop-runtime/);
  const runtimeOperations = mutate.on.workflow_dispatch.inputs.operation.options
    .filter(operation => /(?:^|-)runtime$/.test(operation) || operation === 'stop-runtime');
  assert.deepEqual(runtimeOperations.sort(), ['deploy-runtime', 'stop-runtime'],
    'exactly deploy-runtime and stop-runtime mutate the release slice');
  assert.equal(/AnyWearWorkloadStack/.test(text), false, 'mutate.yml must not name the retired Workload stack');
});

test('no AWS credential precedes the release identity and travelled-byte checks', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  // `verify` is the only pre-deploy job that reads the Service release, and it has
  // no AWS credential surface at all: the release identity read, the three
  // downloads and the byte upload happen before any environment or OIDC identity.
  assert.equal(mutate.jobs.verify.environment, undefined);
  assert.equal(mutate.jobs.verify.permissions?.['id-token'], undefined);
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  assert.equal(mutate.jobs.deploy.needs, 'verify');
  const verifyStep = mutate.jobs.verify.steps.find(step => step.uses === './.github/actions/verify-operation');
  assert.ok(verifyStep, 'the verify job runs the release-identity composite');
  assert.equal(mutate.jobs.deploy.steps.some(step => step.uses === './.github/actions/deploy-operation'), true);

  // The verify composite validates the operation/identity shape, mints the
  // read-only Service token, reads the release identity, downloads exactly the
  // consumed names and publishes the bytes and the digest output.
  const verify = await loadAction('verify-operation');
  const verifyRun = verify.runs.steps.map(step => step.run ?? '').join('\n');
  assert.match(verifyRun, /node scripts\/check-operation\.mjs/);
  assert.match(verifyRun, /node scripts\/verify-operation-inputs\.mjs/);
  assert.equal(verify.runs.steps.some(step => /download-artifact|assume-role|configure-aws-credentials/.test(
    `${step.uses ?? ''} ${step.run ?? ''}`)), false, 'the verify job downloads no credential surface');
  assert.deepEqual(Object.keys(verify.outputs), ['release_assets']);

  // The deploy composite proves the travelled bytes against the published digests
  // (one hash per file) before the operation step that requests the restricted STS
  // session, and nothing runs after that step.
  const deploy = await loadAction('deploy-operation');
  const steps = deploy.runs.steps;
  const proveIndex = steps.findIndex(step => step.run === 'node scripts/prove-release-bytes.mjs');
  const operationIndex = steps.findIndex(step => step.run === 'node scripts/runtime-operation.mjs');
  assert.ok(proveIndex >= 0, 'the deploy job proves the travelled release bytes');
  assert.ok(operationIndex > proveIndex, 'the byte proof precedes the credential-requesting operation');
  assert.equal(steps[proveIndex].if, "inputs.verify_artifact == 'true'");
  // Nothing between the proof and the operation may acquire a credential.
  for (const step of steps.slice(proveIndex, operationIndex)) {
    assert.equal(/configure-aws-credentials|assume-role|oidc/i.test(`${step.uses ?? ''} ${step.run ?? ''}`), false,
      'no credential step may sit between the byte proof and the operation');
  }
  assert.equal(steps.slice(operationIndex + 1).length, 0,
    'nothing runs after the credential-requesting operation: no record step');
});

// #226/#338: the deploy chain's qualification hold. Its whole credential surface is
// one App installation token narrowed to `AnyWear-E2E` with `actions: write`; it
// holds no environment, no OIDC identity and no AWS role, and it observes last.
test('the qualification hold is credential-free, single-token and observes last', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const hold = mutate.jobs['qualify-hold'];
  assert.ok(hold, 'mutate.yml carries the deploy chain qualification hold');
  // The two operations that change Beta's served tuple, and only after `deploy`
  // succeeded. A schema-boundary refusal fails `deploy`, so the hold never runs.
  assert.equal(hold.if,
    "success() && (inputs.operation == 'deploy-runtime' || inputs.operation == 'publish-client')");
  assert.equal(declaresEnvironment(hold), false, 'the hold declares no environment');
  assert.equal(holdsIdToken(hold), false, 'the hold holds no OIDC identity');
  assert.deepEqual(hold.permissions, { contents: 'read' }, 'the hold holds contents: read only');
  // #338: the 65-minute job timeout outlives the 55-minute observation ceiling, so
  // the observation's own deadline fires first and the recorder still runs.
  assert.equal(hold['timeout-minutes'], 65);
  // The census is the proof: the hold adds no credential job.
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  const jobText = JSON.stringify(hold);
  for (const name of ['INFRA_DEPLOY_ROLE_ARN', 'INFRA_RUNTIME_ROLE_ARN', 'AWS_ACCOUNT_ID', 'id-token']) {
    assert.equal(jobText.includes(name), false, `the qualification hold must not carry ${name}`);
  }

  // Exactly one token, for one repository, with exactly one permission.
  const tokens = hold.steps.filter(step => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.equal(tokens.length, 1, 'the hold mints exactly one App installation token');
  const token = tokens[0];
  assert.equal(token.with['app-id'], 3346940);
  assert.equal(token.with['private-key'], '${{ secrets.APP_PRIVATE_KEY }}');
  assert.equal(token.with.repositories, 'AnyWear-E2E');
  assert.equal(token.with['permission-actions'], 'write');
  assert.deepEqual(Object.keys(token.with).filter(name => name.startsWith('permission-')), ['permission-actions'],
    'actions: write is the token\'s only permission');

  // #338: the dispatch precedes the observation and nothing follows the observation.
  const dispatchIndex = hold.steps.findIndex(step => step.run === 'node scripts/qualification-dispatch.mjs');
  const observationIndex = hold.steps.findIndex(step => step.run === 'node scripts/qualification-observe.mjs');
  assert.ok(dispatchIndex > 0, 'the hold dispatches the qualification');
  assert.ok(observationIndex > dispatchIndex, 'the dispatch step precedes the observation step');
  assert.equal(observationIndex, hold.steps.length - 1, 'nothing runs after the observation');
  assert.equal(hold.steps[dispatchIndex].id, 'dispatch', 'the dispatch exposes the created run as a step output');
  const observation = hold.steps[observationIndex];
  // #344: the observation must also run for the Client publication, whose hold is
  // `delivery_trigger=publish`; a manual dispatch of either operation takes none.
  assert.equal(observation.if,
    "always() && (env.INFRA_OPERATION == 'deploy-runtime' && env.DELIVERY_TRIGGER == 'deploy'"
    + " || env.INFRA_OPERATION == 'publish-client' && env.DELIVERY_TRIGGER == 'publish')",
    'the observation records an outcome even when the dispatch step failed');
  assert.equal(observation.env.GH_TOKEN, '${{ steps.app.outputs.token }}');
  assert.equal(observation.env.QUALIFICATION_RUN_ID, '${{ steps.dispatch.outputs.run_id }}');
  assert.equal(observation.env.QUALIFICATION_RUN_URL, '${{ steps.dispatch.outputs.run_url }}');
  assert.equal(observation.id, 'observe', 'the observation exposes the outcome as a step output');
  assert.deepEqual(hold.outputs, { outcome: '${{ steps.observe.outputs.outcome }}' },
    'the job publishes exactly the observation step\'s outcome: ADR 0033 §7\'s job output');
  assert.equal(hold.steps.indexOf(token) < dispatchIndex, true, 'the token exists before the dispatch');
  assert.equal(hold.steps[dispatchIndex].env.GH_TOKEN, '${{ steps.app.outputs.token }}');
});

// #338: the pre-mutation admission read is the deploy job's first work after
// checkout and the dependency install, so a refusal fails the job before any AWS
// credential request — the composite that requests the OIDC session comes later.
test('the deploy job admits the mutation before any credential and mints one read-only token', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const steps = mutate.jobs.deploy.steps;
  const index = predicate => steps.findIndex(predicate);
  const checkoutIndex = index(step => step.uses === 'actions/checkout@v4');
  const setupNodeIndex = index(step => step.uses === 'actions/setup-node@v4');
  const installIndex = index(step => step.run === 'npm ci');
  const admissionIndex = index(step => step.run === 'node scripts/qualification-admission.mjs');
  const compositeIndex = index(step => step.uses === './.github/actions/deploy-operation');
  assert.ok(checkoutIndex >= 0, 'the deploy job checks out the source');
  assert.ok(setupNodeIndex >= 0, 'the deploy job sets up the pinned Node');
  assert.ok(installIndex >= 0, 'the deploy job installs the pinned dependencies');
  assert.ok(admissionIndex > checkoutIndex, 'the admission follows checkout');
  assert.ok(admissionIndex > setupNodeIndex, 'the admission follows setup-node');
  assert.ok(admissionIndex < compositeIndex,
    'the admission precedes the credential-requesting composite, so no AWS credential exists at a refusal');
  assert.equal(steps[admissionIndex].env.GH_TOKEN, '${{ steps.admission.outputs.token }}');
  assert.equal(Object.hasOwn(steps[admissionIndex], 'continue-on-error'), false,
    'a refusal is a normal failing step, not a tolerated one');

  // Exactly one token mint in `deploy`, read-only on AnyWear-E2E.
  const tokens = steps.filter(step => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.equal(tokens.length, 1, 'the deploy job mints exactly one App installation token');
  const token = tokens[0];
  assert.equal(token.id, 'admission');
  assert.equal(token.with['app-id'], 3346940);
  assert.equal(token.with['private-key'], '${{ secrets.APP_PRIVATE_KEY }}');
  assert.equal(token.with.owner, '${{ github.repository_owner }}');
  assert.equal(token.with.repositories, 'AnyWear-E2E');
  assert.equal(token.with['permission-actions'], 'read');
  assert.deepEqual(Object.keys(token.with).filter(name => name.startsWith('permission-')), ['permission-actions'],
    'actions: read is the token\'s only permission');
  // The intended shape, not merely "somewhere before the composite": the step after
  // `npm ci` is the read-only token mint and the step after that is the admission
  // run. Nothing in that gap can request a credential.
  assert.equal(steps[installIndex + 1], token, 'the token mint immediately follows the dependency install');
  assert.equal(steps[installIndex + 2], steps[admissionIndex], 'the admission run immediately follows its token mint');
  assert.equal(admissionIndex, installIndex + 2, 'no other step sits between the install and the admission');
  for (const step of steps.slice(installIndex + 1, admissionIndex)) {
    assert.equal(step, token, 'the only step between the install and the admission is the token mint');
    assert.equal(/configure-aws-credentials|aws-actions\/|id-token/.test(`${step.uses ?? ''} ${step.run ?? ''}`), false,
      'no step in the gap between the install and the admission can request a credential');
  }
  assert.ok(steps.indexOf(token) < admissionIndex, 'the read runs only after its token exists');
});

// ADR 0033 §5 allocates seven App tokens across the four repositories; this file
// owns the three that live in `mutate.yml` and proves no fourth appears in it.
test('mutate.yml holds exactly three App-token allocations and no fourth', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const allocations = [];
  for (const [jobName, job] of Object.entries(mutate.jobs)) {
    for (const step of job.steps ?? []) {
      if (!String(step.uses ?? '').startsWith('actions/create-github-app-token@')) continue;
      allocations.push({ jobName,
        permissions: Object.keys(step.with).filter(name => name.startsWith('permission-')),
        actionPermission: step.with['permission-actions'],
        repositories: step.with.repositories });
    }
  }
  assert.deepEqual(allocations, [
    // Allocation 6 (#344): the Client publisher proof and the `client-dist` download.
    { jobName: 'verify', permissions: ['permission-actions'], actionPermission: 'read', repositories: 'AnyWear-Client' },
    // Allocation 5: the pre-mutation admission read.
    { jobName: 'deploy', permissions: ['permission-actions'], actionPermission: 'read', repositories: 'AnyWear-E2E' },
    // Allocation 3: the qualification dispatch and the read-back of the same run.
    { jobName: 'qualify-hold', permissions: ['permission-actions'], actionPermission: 'write', repositories: 'AnyWear-E2E' },
  ], 'three allocations: verify reads the Client, deploy reads E2E, the hold writes E2E — actions only, one repository each');
  // The Client token is gated to the one operation that publishes.
  const clientToken = mutate.jobs.verify.steps
    .find(step => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.equal(clientToken.if, "env.INFRA_OPERATION == 'publish-client'");
  // It is minted after the credential-free admission composite, so a refused
  // operation never reaches the Client REST read.
  const verifySteps = mutate.jobs.verify.steps;
  assert.ok(verifySteps.findIndex(step => step.uses === './.github/actions/verify-operation')
    < verifySteps.indexOf(clientToken));
  // `runtime.yml` stays token-free, and the scheduled entry's one token is counted
  // in its own test.
  const runtime = await loadWorkflow('runtime.yml');
  assert.equal(JSON.stringify(runtime).includes('create-github-app-token'), false);
});

// #226: `queue: max` beside `cancel-in-progress: false`, and the reviewed actionlint
// ignore the pinned 1.7.12 needs because it predates the key.
test('the runtime queue is bounded and the pinned linter rejection is reviewed', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const schedule = await loadWorkflow('schedule.yml');
  assert.deepEqual(mutate.concurrency, { group: 'anywear-infra-runtime', 'cancel-in-progress': false, queue: 'max' });
  // #344: the scheduled entry joins the same non-cancelling group, so a nightly
  // reconcile queues behind an in-flight mutation instead of racing it.
  assert.deepEqual(schedule.concurrency, { group: 'anywear-infra-runtime', 'cancel-in-progress': false, queue: 'max' });
  const config = await actionlintConfig();
  for (const file of ['.github/workflows/mutate.yml', '.github/workflows/schedule.yml']) {
    const ignore = config.paths[file]?.ignore;
    assert.ok(Array.isArray(ignore), `${file} carries the reviewed queue ignore`);
    assert.equal(ignore.length, 1);
    assert.match(ignore[0], /unexpected key "queue" for "concurrency" section/);
  }
  // The ignore names one file and one message: no other workflow uses `queue`.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file));
  const queueHolders = [];
  for (const file of files) {
    if (Object.hasOwn((await loadWorkflow(file)).concurrency ?? {}, 'queue')) queueHolders.push(file);
  }
  assert.deepEqual(queueHolders, ['mutate.yml', 'schedule.yml']);
  assert.deepEqual(Object.keys(config.paths).sort(),
    ['.github/workflows/mutate.yml', '.github/workflows/production.yml', '.github/workflows/schedule.yml']);
  assert.equal(Object.hasOwn(config.paths, '.github/workflows/runtime.yml'), false);
});

test('a protected mutating run publishes only its transport bytes and the Client record', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const verify = await loadAction('verify-operation');
  const uploads = verify.runs.steps.filter(step => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  assert.equal(uploads.length, 1, 'the verify composite publishes exactly one artifact');
  const upload = uploads[0];
  assert.equal(upload.with.name, 'service-release-bytes-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(upload.with.path, '.service-artifacts/selected');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.if, /deploy-platform/);
  assert.match(upload.if, /restore-release/);
  assert.match(upload.if, /deploy-runtime/);
  assert.match(upload.if, /migrate/);

  // The upload has ONE search path, and `upload-artifact` uses the least common
  // ancestor of the search paths as the artifact root; with a single path that
  // root is `.service-artifacts/selected` itself, so the release bytes are stored
  // at the artifact root. The download must therefore extract into that same
  // directory — the one `prove-release-bytes.mjs`, `schema-gate.mjs` and the
  // stage-base CDK deploy read. A download to `.` would scatter the bytes into the
  // workspace root and every release run would fail closed at the byte proof.
  const downloads = mutate.jobs.deploy.steps
    .filter(step => String(step.uses ?? '').startsWith('actions/download-artifact'));
  assert.deepEqual(downloads.map(step => step.with.name), [
    'service-release-bytes-${{ github.run_id }}-${{ github.run_attempt }}',
    // #344: the Client publication's own transport artifact, retained one day and
    // read only by the re-hash in `client-publication.mjs publish`.
    'client-publish-bytes-${{ github.run_id }}-${{ github.run_attempt }}',
  ]);
  assert.equal(downloads[0].with.path, upload.with.path,
    'the download path must equal the single upload search path, which is the artifact root');
  assert.equal(downloads[1].with.path, '.client-artifacts/dist');
  assert.equal(downloads[1].if, "env.INFRA_OPERATION == 'publish-client'");
  // The publication's own uploads: the transport is workflow-owned (not a
  // composite), retains one day, and the record artifact retains ninety.
  const clientUpload = mutate.jobs.verify.steps
    .find(step => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  assert.equal(clientUpload.with.name, 'client-publish-bytes-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(clientUpload.with.path, '.client-artifacts/dist');
  assert.equal(clientUpload.with['retention-days'], 1);
  assert.equal(clientUpload.with['if-no-files-found'], 'error');
  assert.equal(clientUpload.if, "env.INFRA_OPERATION == 'publish-client'");
  const recordUpload = mutate.jobs.deploy.steps
    .find(step => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  assert.equal(recordUpload.with.name, 'client-publication-record-${{ github.run_id }}-${{ github.run_attempt }}');
  // Issue #344's `## Data Models` names the file `publication-record.json`.
  assert.equal(recordUpload.with.path, '.client-publication/publication-record.json');
  assert.equal(recordUpload.with['retention-days'], 90);
  assert.equal(recordUpload.if, "env.INFRA_OPERATION == 'publish-client'");
  // The mutating composite runs for every operation except the one that consumes no
  // Service release and performs its own publication instead.
  const composite = mutate.jobs.deploy.steps.find(step => step.uses === './.github/actions/deploy-operation');
  assert.equal(composite.if, "env.INFRA_OPERATION != 'publish-client'");
  // The publication's steps follow the admission read like every other operation's.
  const steps = mutate.jobs.deploy.steps;
  const admission = steps.findIndex(step => step.run === 'node scripts/qualification-admission.mjs');
  assert.ok(admission < steps.indexOf(composite));
  assert.ok(admission < steps.findIndex(step => step.run === 'node scripts/client-publication.mjs publish'));

  // No protected operation workflow or composite publishes an `infra-` evidence
  // artifact any more. `check.yml` is the automatic source-check entry, not a
  // protected operation, so its own matrix artifacts are outside this census.
  for (const file of ['mutate.yml', 'runtime.yml', 'production.yml']) {
    const text = await readFile(workflowFile(file), 'utf8');
    assert.equal(/name:\s*infra-/.test(text), false, `${file} must not publish an infra- artifact`);
  }
  const deployComposite = await readFile(actionFile('deploy-operation'), 'utf8');
  assert.equal(/upload-artifact/.test(deployComposite), false, 'the mutating job publishes no artifact');
  assert.equal(/name:\s*infra-/.test(deployComposite), false);
  assert.equal(/name:\s*infra-/.test(await readFile(actionFile('verify-operation'), 'utf8')), false);
});

// #243: the release identity is one reviewed list. Every site that gates on it —
// the verify job's read-only token, the artifact upload, the deploy job's byte
// download — must name exactly `RELEASE_IDENTITY_OPERATIONS`, so a code site and a
// workflow `if:` cannot disagree about which operations take a release.
test('every workflow gate on the release identity names exactly RELEASE_IDENTITY_OPERATIONS', async () => {
  const verify = await loadAction('verify-operation');
  const mutate = await loadWorkflow('mutate.yml');
  const gates = [
    ['verify-operation read-only token step', verify.runs.steps.find(step => step.id === 'app')?.if],
    ['verify-operation artifact upload step',
      verify.runs.steps.find(step => String(step.uses ?? '').startsWith('actions/upload-artifact'))?.if],
    ['mutate.yml release-bytes download step',
      mutate.jobs.deploy.steps.find(step => String(step.uses ?? '').startsWith('actions/download-artifact'))?.if],
  ];
  for (const [label, expression] of gates) {
    assert.ok(typeof expression === 'string' && expression.length, `${label} must gate on the operation`);
    const named = [...expression.matchAll(/env\.INFRA_OPERATION == '([a-z-]+)'/g)].map(match => match[1]).sort();
    assert.deepEqual(named, [...RELEASE_IDENTITY_OPERATIONS].sort(), label);
  }
  // The only input description that enumerates the operations names each of them.
  const description = mutate.on.workflow_dispatch.inputs.service_artifact_tag.description;
  for (const operation of RELEASE_IDENTITY_OPERATIONS) assert.ok(description.includes(operation), operation);
});

// #344: the scheduled entry. It is the single writer's scheduled qualification
// starter (ADR 0033 §10): a nightly reconcile plus a manual smoke/full, dispatched
// and held with the one AnyWear-E2E token the deploy chain's hold also uses. It
// declares no environment, no OIDC identity and no AWS credential.
test('schedule.yml is a two-job, credential-free hold with the fixed job name', async () => {
  const schedule = await loadWorkflow('schedule.yml');
  const text = await readFile(workflowFile('schedule.yml'), 'utf8');
  assert.deepEqual(Object.keys(schedule.jobs), ['preflight', 'hold'],
    'the E2E admission read keys on schedule.yml → hold, so neither job may be renamed away');
  const { preflight, hold } = schedule.jobs;
  assert.equal(preflight.needs, undefined);
  assert.equal(hold.needs, 'preflight');
  // Exactly one schedule and the manual dispatch surface.
  assert.deepEqual(Object.keys(schedule.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(schedule.on.schedule, [{ cron: '17 3 * * *' }]);
  const inputs = schedule.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.operation.options, ['reconcile', 'smoke', 'full']);
  assert.equal(inputs.operation.required, true);
  assert.equal(inputs.operation.type, 'choice');
  for (const name of ['expected_service_commit', 'expected_client_commit']) {
    assert.equal(inputs[name].type, 'string', name);
    assert.equal(inputs[name].default, '', name);
    assert.equal(inputs[name].required, undefined, name);
  }
  // Credential-free: no environment, no OIDC identity, no AWS credential name, and
  // no write permission. `contents: read` is the most it holds.
  assert.deepEqual(credentialJobs(schedule), []);
  for (const [jobName, job] of Object.entries(schedule.jobs)) {
    assert.equal(declaresEnvironment(job), false, `${jobName} declares no environment`);
    assert.equal(holdsIdToken(job), false, `${jobName} holds no OIDC identity`);
    assert.equal(JSON.stringify(job).includes('id-token'), false, `${jobName} must not name id-token`);
  }
  for (const name of ['AWS_ACCOUNT_ID', 'AWS_REGION', 'CDK_DEFAULT_ACCOUNT', 'CDK_DEFAULT_REGION',
    'INFRA_DEPLOY_ROLE_ARN', 'INFRA_RUNTIME_ROLE_ARN', 'CLIENT_PUBLISH_ROLE_ARN', 'configure-aws-credentials']) {
    assert.equal(text.includes(name), false, `schedule.yml must not carry ${name}`);
  }
  assert.deepEqual(schedule.permissions, { contents: 'read' });
  assert.equal(preflight.if, "github.ref == 'refs/heads/main' && vars.ENABLE_BETA_MUTATION == 'true'");
  assert.equal(schedule.env.ENABLE_BETA_MUTATION, '${{ vars.ENABLE_BETA_MUTATION }}');
  // The switch gates the entry; the schedule event names the default operation.
  assert.equal(schedule.env.SCHEDULE_OPERATION, "${{ inputs.operation || 'reconcile' }}");
  assert.equal(schedule.env.EXPECTED_SERVICE_COMMIT, '${{ inputs.expected_service_commit }}');
  assert.equal(schedule.env.EXPECTED_CLIENT_COMMIT, '${{ inputs.expected_client_commit }}');
  // The preflight validates before any token; the hold installs the pinned
  // dependencies before its first module run.
  assert.match(text, /node scripts\/schedule-qualification\.mjs validate/);
  const holdSteps = hold.steps;
  const install = holdSteps.findIndex(step => step.run === 'npm ci');
  const dispatch = holdSteps.findIndex(step => step.run === 'node scripts/schedule-qualification.mjs dispatch');
  assert.ok(install >= 0 && dispatch > install, 'the hold installs dependencies before its first module run');
  // One App token, narrowed to AnyWear-E2E with `actions: write` and nothing else.
  const tokens = holdSteps.filter(step => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.equal(tokens.length, 1, 'the scheduled hold mints exactly one App installation token');
  assert.equal(tokens[0].with['app-id'], 3346940);
  assert.equal(tokens[0].with['private-key'], '${{ secrets.APP_PRIVATE_KEY }}');
  assert.equal(tokens[0].with.repositories, 'AnyWear-E2E');
  assert.equal(tokens[0].with['permission-actions'], 'write');
  assert.deepEqual(Object.keys(tokens[0].with).filter(name => name.startsWith('permission-')), ['permission-actions']);
  // The dispatch precedes the observation and nothing follows the observation; the
  // observation reuses the deploy chain's recorder.
  const observe = holdSteps.findIndex(step => step.run === 'node scripts/qualification-observe.mjs');
  assert.ok(observe > dispatch, 'the dispatch precedes the observation');
  assert.equal(observe, holdSteps.length - 1, 'nothing runs after the observation');
  assert.equal(holdSteps[dispatch].id, 'dispatch');
  const observation = holdSteps[observe];
  assert.equal(observation.if, 'always()', 'every scheduled run leaves exactly one outcome');
  assert.equal(observation.id, 'observe');
  assert.equal(observation.env.GH_TOKEN, '${{ steps.app.outputs.token }}');
  assert.equal(observation.env.QUALIFICATION_RUN_ID, '${{ steps.dispatch.outputs.run_id }}');
  assert.equal(observation.env.QUALIFICATION_RUN_URL, '${{ steps.dispatch.outputs.run_url }}');
  assert.deepEqual(hold.outputs, { outcome: '${{ steps.observe.outputs.outcome }}' });
  assert.equal(hold['timeout-minutes'], 65, 'the 65-minute job outlives the 55-minute observation ceiling');
  // The entry dispatches E2E only: it runs no writer gate of its own and launches
  // no operation. #338's admission read lives in `mutate.yml`'s `deploy` job alone,
  // so this file must not even name it.
  assert.equal(text.includes('admission'), false);
  assert.equal(text.includes('runtime-operation'), false);
  assert.equal(text.includes('CLIENT_BUNDLE_DIGEST'), false);
});

test('runtime.yml keeps state runnable with the switch closed and publishes no evidence', async () => {
  const runtime = await loadWorkflow('runtime.yml');
  assert.deepEqual(Object.keys(runtime.jobs), ['preflight', 'state']);
  const { preflight, state } = runtime.jobs;

  assert.equal(preflight.needs, undefined);
  assert.equal(state.needs, 'preflight');

  // `state` is the one credential job; there is no observation or record job.
  assert.deepEqual(credentialJobs(runtime), ['state']);
  assert.equal(state.environment, 'beta');
  assert.equal(holdsIdToken(state), true);
  assert.equal(declaresEnvironment(preflight), false);
  assert.equal(holdsIdToken(preflight), false);

  // `state` works with the stage switch closed.
  assert.equal(state.if, "github.ref == 'refs/heads/main' && inputs.operation == 'state'");
  assert.equal(/ENABLE_BETA_MUTATION/.test(state.if), false, 'state must run with the switch closed');
  assert.deepEqual(runtime.on.workflow_dispatch.inputs.operation.options, ['state']);
  assert.equal(runtime.on.workflow_dispatch.inputs.operation.required, true);
  assert.equal(Object.hasOwn(runtime.jobs, 'observe'), false);
  assert.equal(Object.hasOwn(runtime.jobs, 'record'), false);
  const deployStep = state.steps.find(step => step.uses === './.github/actions/deploy-operation');
  assert.equal(deployStep.with.verify_artifact, 'false', 'read-only state has no verify artifact to prove');
});

test('exactly one ENABLE_* switch name exists across workflows and non-test executable sources', async () => {
  // This class regressed before: retired switch names survived the rename in code.
  // Documentation may name them as retired; executable sources and workflows may
  // not, so the retired names are composed here rather than written out and this
  // file is excluded from the scan as a test.
  const retiredNames = [['ENABLE', 'BETA', 'DEPLOY'].join('_'), ['ENABLE', 'BETA', 'CLEANUP', 'ACCEPTANCE'].join('_')];
  const tracked = (await execute('git', ['-C', repositoryRoot, 'ls-files', '.github', 'scripts'])).stdout
    .split(/\r?\n/).filter(Boolean)
    .filter(file => /\.(mjs|cjs|ts|yml|yaml)$/.test(file))
    .filter(file => !/(^|\/)(test|tests|__tests__)\//.test(file))
    .filter(file => !/\.(test|spec)\.[^.]+$/.test(file));
  assert.ok(tracked.length > 30, `tracked executable source set too small: ${tracked.length}`);
  const names = new Set();
  for (const file of tracked) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const match of text.matchAll(/ENABLE_[A-Z0-9_]+/g)) names.add(match[0]);
  }
  assert.deepEqual([...names].sort(), ['ENABLE_BETA_MUTATION']);
  for (const retired of retiredNames) assert.equal(names.has(retired), false, `${retired} is retired`);
  // The one switch is referenced by both manual entries.
  for (const file of ['mutate.yml', 'runtime.yml']) {
    assert.match(await readFile(workflowFile(file), 'utf8'), /ENABLE_BETA_MUTATION/, file);
  }
});

test('no release-manifest reader or retired Service parser remains in production sources', async () => {
  // #193: the release states its own identity (tag to commit, immutability and a
  // digest per asset), so no production source or workflow may name the retired
  // manifest asset or a retired parser helper. Tests may construct a legacy
  // five-asset release to prove rollback tolerance; production code may not.
  const retiredNames = ['service-artifacts.json', ['validate', 'Manifest'].join(''),
    ['zip', 'Stored'].join(''), ['assert', 'Native', 'Release', 'Attestation'].join('')];
  const tracked = (await execute('git', ['-C', repositoryRoot, 'ls-files', '.github', 'scripts'])).stdout
    .split(/\r?\n/).filter(Boolean)
    .filter(file => /\.(mjs|cjs|ts|yml|yaml)$/.test(file))
    .filter(file => !/(^|\/)(test|tests|__tests__|fixtures)\//.test(file))
    .filter(file => !/\.(test|spec)\.[^.]+$/.test(file));
  assert.ok(tracked.length > 20, `tracked production source set too small: ${tracked.length}`);
  for (const file of tracked) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const name of retiredNames) assert.equal(text.includes(name), false, `${file} must not name ${name}`);
  }
  // The release-inputs module exposes the frozen four-name asset set instead.
  const release = await readFile(new URL('../../scripts/lib/release-inputs.mjs', import.meta.url), 'utf8');
  assert.match(release, /export const RELEASE_ASSET_NAMES = Object\.freeze/);
  assert.match(release, /export const STAGE_BASE_ASSETS = Object\.freeze/);
  assert.match(release, /export async function assertSelectedReleaseBytes/);
});

test('AnyWear-E2E has exactly one reviewed executor workflow', async () => {
  // `integration.yml` was retired with the E2E consolidation. The allow-list is
  // pinned by identity, not only by behaviour, so a second executor path cannot
  // be added silently.
  assert.deepEqual(e2eExecutorPaths, ['.github/workflows/beta-qualification.yml']);
  const e2e = workflow => ({ GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E', GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: '6'.repeat(40),
    GITHUB_RUN_ID: '23', GITHUB_RUN_ATTEMPT: '1', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1',
    GITHUB_WORKFLOW_REF: `git-malu/AnyWear-E2E/${workflow}@refs/heads/main` });
  const executor = assertProtectedExecutor('5'.repeat(40), e2e('.github/workflows/beta-qualification.yml'));
  assert.equal(executor.repository, 'git-malu/AnyWear-E2E');
  assert.equal(executor.workflow_path, '.github/workflows/beta-qualification.yml');
  for (const retired of ['.github/workflows/integration.yml', '.github/workflows/other.yml']) {
    assert.throws(() => assertProtectedExecutor('5'.repeat(40), e2e(retired)), /workflow required/, retired);
  }
  // The file the retired path named does not exist on disk. Both workflow
  // extensions are enumerated so a `.yaml` file cannot hide the retired name.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file));
  assert.equal(files.includes('integration.yml'), false);
});
