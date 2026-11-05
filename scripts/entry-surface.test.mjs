import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { assertProtectedExecutor, e2eExecutorPaths } from './operation-boundaries.mjs';
import { RELEASE_IDENTITY_OPERATIONS } from './release-inputs.mjs';

// Census guard for the post-#158 Infra surface. It describes the tree that exists
// now: Infra owns Foundation, Billing, the Beta stage base, Egress and Runtime;
// the retired `AnyWearWorkloadStack-beta` and its Service deploy chain are
// historical, so `deploy-workload` is not an Infra operation. This file asserts the entry files
// and their job/permission shape per job, not per file, so a future file that
// grows a dispatch surface or a credential job fails here.
const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
const workflowFile = name => new URL(`../.github/workflows/${name}`, import.meta.url);
const actionFile = name => new URL(`../.github/actions/${name}/action.yml`, import.meta.url);
const loadWorkflow = async name => yaml.load(await readFile(workflowFile(name), 'utf8'));
const loadAction = async name => yaml.load(await readFile(actionFile(name), 'utf8'));
const actionlintConfig = async () => yaml.load(await readFile(new URL('../.github/actionlint.yaml', import.meta.url), 'utf8'));

const declaresEnvironment = job => Object.hasOwn(job ?? {}, 'environment');
const holdsIdToken = job => job?.permissions?.['id-token'] === 'write';
const credentialJobs = workflow => Object.entries(workflow.jobs ?? {})
  .filter(([, job]) => declaresEnvironment(job) || holdsIdToken(job)).map(([jobName]) => jobName);

const mutateOperations = Object.freeze(['deploy-foundation', 'deploy-billing', 'deploy-platform',
  'deploy-egress', 'delete-egress', 'deploy-runtime', 'stop-runtime', 'restore-release', 'migrate',
  'admission-status', 'add-testers', 'set-testers']);

test('the workflow directory is exactly the three Beta entries plus the callable', async () => {
  // GitHub accepts both `.yml` and `.yaml`; the census must see either extension,
  // or a `.yaml` entry would be invisible to every assertion below.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file)).sort();
  assert.deepEqual(files, ['check.yml', 'mutate.yml', 'production.yml', 'runtime.yml']);
  const workflows = Object.fromEntries(await Promise.all(files.map(async file => [file, await loadWorkflow(file)])));

  const dispatchSurfaces = files.filter(file => Object.hasOwn(workflows[file].on ?? {}, 'workflow_dispatch'));
  assert.deepEqual(dispatchSurfaces, ['mutate.yml', 'runtime.yml'], 'exactly two workflow_dispatch surfaces');

  // The three Beta entries: one automatic check and two manual chains.
  const betaEntries = files.filter(file => file === 'check.yml' || dispatchSurfaces.includes(file));
  assert.deepEqual(betaEntries, ['check.yml', 'mutate.yml', 'runtime.yml']);

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

test('mutate.yml keeps one preflight → verify → deploy → qualify-hook chain and no workload deploy', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  assert.deepEqual(Object.keys(mutate.jobs), ['preflight', 'verify', 'deploy', 'qualify-hook']);
  const { preflight, verify, deploy } = mutate.jobs;

  assert.equal(preflight.needs, undefined);
  assert.equal(verify.needs, 'preflight');
  assert.equal(deploy.needs, 'verify', 'credentials are acquired only after verification');
  assert.equal(mutate.jobs['qualify-hook'].needs, 'deploy', 'the qualification follows a successful deployment');

  // One credential job, and it is the only one: `preflight` and `verify` have no
  // environment and no OIDC identity.
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  const roleHolders = name => Object.entries(mutate.jobs)
    .filter(([, job]) => JSON.stringify(job).includes(name)).map(([jobName]) => jobName);
  assert.deepEqual(roleHolders('INFRA_DEPLOY_ROLE_ARN'), ['deploy'], 'exactly one job can mutate');
  assert.deepEqual(roleHolders('INFRA_RUNTIME_ROLE_ARN'), ['deploy']);
  assert.equal(deploy.environment, 'beta');
  assert.equal(holdsIdToken(deploy), true);
  for (const job of [preflight, verify, mutate.jobs['qualify-hook']]) {
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

  // Exactly two things cross from `verify` to `deploy`: the release bytes as the
  // transport artifact, and the published digest set as this job output.
  assert.deepEqual(verify.outputs, { release_assets: '${{ steps.verify.outputs.release_assets }}' });
  assert.equal(deploy.env.VERIFIED_RELEASE_ASSETS, '${{ needs.verify.outputs.release_assets }}');

  assert.deepEqual(mutate.on.workflow_dispatch.inputs.operation.options, mutateOperations);
  assert.equal(mutate.on.workflow_dispatch.inputs.operation.required, true);
  // #226: the deploy chain's two context inputs. `release` is representable and
  // refused in the credential-free preflight; `release_version` never shipped and
  // has no producer because no tag reaches Infra.
  const deliveryTrigger = mutate.on.workflow_dispatch.inputs.delivery_trigger;
  assert.equal(deliveryTrigger.type, 'choice');
  assert.deepEqual(deliveryTrigger.options, ['deploy', 'release', 'manual']);
  assert.equal(deliveryTrigger.default, 'manual');
  assert.equal(deliveryTrigger.required, true);
  assert.equal(mutate.on.workflow_dispatch.inputs.dispatched_by.type, 'string');
  assert.equal(mutate.on.workflow_dispatch.inputs.dispatched_by.default, '');
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
  // #166 drill precondition: the retained Egress EIP allocation is an optional
  // string input passed to the operation env; its pattern is enforced by
  // check-operation/validateOperationInputs, not by a workflow_dispatch pattern.
  const natEipInput = mutate.on.workflow_dispatch.inputs.nat_eip_allocation_id;
  assert.equal(natEipInput.type, 'string');
  assert.equal(natEipInput.default, '');
  assert.match(natEipInput.description, /deploy-egress/);
  assert.match(natEipInput.description, /eipalloc-/);
  assert.equal(Object.hasOwn(natEipInput, 'pattern'), false);
  assert.equal(mutate.env.NAT_EIP_ALLOCATION_ID, '${{ inputs.nat_eip_allocation_id }}');
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

// #226: the deploy chain's qualification hop. Its whole credential surface is one
// App installation token narrowed to `AnyWear-E2E` with `actions: write`; it holds
// no environment, no OIDC identity and no AWS role, and it dispatches last.
test('the qualification hook is credential-free, single-token and dispatches last', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  const hook = mutate.jobs['qualify-hook'];
  assert.ok(hook, 'mutate.yml carries the deploy chain qualification hook');
  // Only the operation that deploys a Runtime tuple, and only after `deploy`
  // succeeded. A schema-boundary refusal fails `deploy`, so the hook never runs.
  assert.equal(hook.if, "success() && inputs.operation == 'deploy-runtime'");
  assert.equal(declaresEnvironment(hook), false, 'the hook declares no environment');
  assert.equal(holdsIdToken(hook), false, 'the hook holds no OIDC identity');
  assert.deepEqual(hook.permissions, { contents: 'read' }, 'the hook holds contents: read only');
  // The census is the proof: the hook adds no credential job.
  assert.deepEqual(credentialJobs(mutate), ['deploy']);
  const jobText = JSON.stringify(hook);
  for (const name of ['INFRA_DEPLOY_ROLE_ARN', 'INFRA_RUNTIME_ROLE_ARN', 'AWS_ACCOUNT_ID', 'id-token']) {
    assert.equal(jobText.includes(name), false, `the qualification hook must not carry ${name}`);
  }

  // Exactly one token, for one repository, with exactly one permission.
  const tokens = hook.steps.filter(step => String(step.uses ?? '').startsWith('actions/create-github-app-token@'));
  assert.equal(tokens.length, 1, 'the hook mints exactly one App installation token');
  const token = tokens[0];
  assert.equal(token.with['app-id'], 3346940);
  assert.equal(token.with['private-key'], '${{ secrets.APP_PRIVATE_KEY }}');
  assert.equal(token.with.repositories, 'AnyWear-E2E');
  assert.equal(token.with['permission-actions'], 'write');
  assert.deepEqual(Object.keys(token.with).filter(name => name.startsWith('permission-')), ['permission-actions'],
    'actions: write is the token\'s only permission');

  // The dispatch is the job's last step: nothing may follow it.
  const dispatchIndex = hook.steps.findIndex(step => step.run === 'node scripts/qualification-dispatch.mjs');
  assert.ok(dispatchIndex > 0, 'the hook dispatches the qualification');
  assert.equal(dispatchIndex, hook.steps.length - 1, 'nothing runs after the dispatch');
  assert.equal(hook.steps.indexOf(token) < dispatchIndex, true, 'the token exists before the dispatch');
  assert.equal(hook.steps[dispatchIndex].env.GH_TOKEN, '${{ steps.app.outputs.token }}');
});

// #226: `queue: max` beside `cancel-in-progress: false`, and the reviewed actionlint
// ignore the pinned 1.7.12 needs because it predates the key.
test('the runtime queue is bounded and the pinned linter rejection is reviewed', async () => {
  const mutate = await loadWorkflow('mutate.yml');
  assert.deepEqual(mutate.concurrency, { group: 'anywear-infra-runtime', 'cancel-in-progress': false, queue: 'max' });
  const config = await actionlintConfig();
  const ignore = config.paths['.github/workflows/mutate.yml']?.ignore;
  assert.ok(Array.isArray(ignore), 'mutate.yml carries the reviewed queue ignore');
  assert.equal(ignore.length, 1);
  assert.match(ignore[0], /unexpected key "queue" for "concurrency" section/);
  // The ignore names one file and one message: no other workflow uses `queue`.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file));
  const queueHolders = [];
  for (const file of files) {
    if (Object.hasOwn((await loadWorkflow(file)).concurrency ?? {}, 'queue')) queueHolders.push(file);
  }
  assert.deepEqual(queueHolders, ['mutate.yml']);
  assert.equal(Object.hasOwn(config.paths, '.github/workflows/runtime.yml'), false);
});

test('the only artifact a protected mutating run publishes is the release bytes, retained one day', async () => {
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
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].with.name, 'service-release-bytes-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(downloads[0].with.path, upload.with.path,
    'the download path must equal the single upload search path, which is the artifact root');

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
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
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
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const name of retiredNames) assert.equal(text.includes(name), false, `${file} must not name ${name}`);
  }
  // The release-inputs module exposes the frozen four-name asset set instead.
  const release = await readFile(new URL('../scripts/release-inputs.mjs', import.meta.url), 'utf8');
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
