import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';

// Regression guard for run 39060250685: the six configuration names below lived
// only at `beta` environment scope, but the workflows read them from
// workflow-level `env`. `vars` resolves at repository scope unless a job declares
// `environment:`, so the credential-free `preflight` job saw empty values and
// rejected the account/region before any credential.
const workflowFiles = ['.github/workflows/mutate.yml', '.github/workflows/runtime.yml'];
const accountRegionNames = ['AWS_ACCOUNT_ID', 'AWS_REGION', 'CDK_DEFAULT_ACCOUNT', 'CDK_DEFAULT_REGION'];
const roleNames = ['INFRA_DEPLOY_ROLE_ARN', 'INFRA_RUNTIME_ROLE_ARN'];
const scoped = value => typeof value === 'string' && /\$\{\{\s*vars\./.test(value);

async function loadWorkflow(file) {
  return yaml.load(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
}

const holders = (workflow, name) => Object.entries(workflow.jobs)
  .filter(([, job]) => JSON.stringify(job).includes(name)).map(([jobName]) => jobName);

test('workflow-level env holds literal single-account constants and no scoped configuration', async () => {
  for (const file of workflowFiles) {
    const workflow = await loadWorkflow(file);
    const env = workflow.env ?? {};
    // The account and region are single-account constants, not environment
    // configuration: the scripts and validators hard-code the same values.
    assert.equal(env.AWS_ACCOUNT_ID, '650880818323', file);
    assert.equal(env.AWS_REGION, 'ap-east-1', file);
    assert.equal(env.CDK_DEFAULT_ACCOUNT, '650880818323', file);
    assert.equal(env.CDK_DEFAULT_REGION, 'ap-east-1', file);
    for (const name of [...accountRegionNames, ...roleNames]) {
      // The stage switch is the one deliberate workflow-level `vars.` reference;
      // these six must not be resolved from repository scope.
      if (Object.hasOwn(env, name)) assert.equal(scoped(env[name]), false, `${file} workflow env ${name} must not resolve vars at repository scope`);
    }
    for (const name of roleNames) {
      assert.equal(Object.hasOwn(env, name), false, `${file} workflow env must not hold ${name}`);
    }
  }
});

test('role ARNs resolve only inside jobs that declare the beta environment', async () => {
  for (const file of workflowFiles) {
    const workflow = await loadWorkflow(file);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const body = JSON.stringify(job);
      for (const name of roleNames) {
        if (!body.includes(name)) continue;
        assert.equal(job.environment, 'beta', `${file} ${jobName} references ${name} without environment: beta`);
        assert.equal(typeof job.env?.[name], 'string', `${file} ${jobName} must declare ${name} in its own job env`);
      }
    }
  }
  // The migrated layout is explicit: the mutation role only in the deploy job of
  // mutate.yml and the runtime role in the two credential jobs. #207 retired the
  // separate observation producer, so no job holds a read-only identity beside the
  // mutation role any more.
  const mutate = await loadWorkflow('.github/workflows/mutate.yml');
  const runtime = await loadWorkflow('.github/workflows/runtime.yml');
  assert.deepEqual(holders(mutate, 'INFRA_DEPLOY_ROLE_ARN'), ['deploy']);
  assert.deepEqual(holders(mutate, 'INFRA_RUNTIME_ROLE_ARN'), ['deploy']);
  assert.deepEqual(holders(runtime, 'INFRA_RUNTIME_ROLE_ARN'), ['state']);
  assert.equal(holders(mutate, 'INFRA_DEPLOY_ROLE_ARN').length, 1);
  assert.deepEqual(holders(mutate, 'INFRA_DEPLOY_ROLE_ARN').filter(name => mutate.jobs[name].environment !== 'beta'), []);
  assert.deepEqual(holders(runtime, 'INFRA_RUNTIME_ROLE_ARN').filter(name => runtime.jobs[name].environment !== 'beta'), []);
});

test('preflight stays environment-free, credential-free and fully resolvable at repository scope', async () => {
  for (const file of workflowFiles) {
    const workflow = await loadWorkflow(file);
    const preflight = workflow.jobs.preflight;
    assert.ok(preflight, `${file} keeps a preflight job`);
    assert.equal(preflight.environment, undefined, `${file} preflight must not declare an environment`);
    assert.equal(Object.hasOwn(preflight, 'environment'), false, `${file} preflight environment`);
    assert.equal(preflight.permissions?.['id-token'], undefined, `${file} preflight must not hold OIDC`);
    const effective = { ...(workflow.env ?? {}), ...(preflight.env ?? {}) };
    for (const name of [...accountRegionNames, ...roleNames]) {
      assert.equal(scoped(effective[name]), false, `${file} preflight ${name} must be concrete or absent`);
    }
    // The failing run read these two from the preflight's effective env.
    assert.equal(effective.AWS_ACCOUNT_ID, '650880818323', file);
    assert.equal(effective.AWS_REGION, 'ap-east-1', file);
    assert.equal(effective.CDK_DEFAULT_ACCOUNT, '650880818323', file);
    assert.equal(effective.CDK_DEFAULT_REGION, 'ap-east-1', file);
    for (const name of roleNames) assert.equal(Object.hasOwn(effective, name), false, `${file} preflight ${name}`);
  }
});

test('the single stage switch stays repository-scoped so the job gate can see it', async () => {
  for (const file of workflowFiles) {
    const workflow = await loadWorkflow(file);
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    // Job-level `if` is evaluated before any environment exists. An
    // environment-scoped-only switch would therefore never open the gate, so
    // `ENABLE_BETA_MUTATION` must stay a workflow-level repository variable.
    assert.equal(workflow.env?.ENABLE_BETA_MUTATION, '${{ vars.ENABLE_BETA_MUTATION }}', file);
    assert.deepEqual([...new Set(text.match(/ENABLE_[A-Z_]+/g) ?? [])], ['ENABLE_BETA_MUTATION'], `${file} switch names`);
  }
  const mutate = await loadWorkflow('.github/workflows/mutate.yml');
  assert.match(mutate.jobs.preflight.if, /vars\.ENABLE_BETA_MUTATION == 'true'/);
  assert.equal(mutate.jobs.deploy.if, undefined, 'the credential job keeps its needs-based scheduling');
  const runtime = await loadWorkflow('.github/workflows/runtime.yml');
  assert.equal(/ENABLE_BETA_MUTATION/.test(runtime.jobs.state.if), false, 'state must run with the switch closed');
  for (const workflow of [mutate, runtime]) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (job.environment !== 'beta') continue;
      assert.equal(Object.hasOwn(job.env ?? {}, 'AWS_ACCOUNT_ID'), false, `${jobName} inherits the literal account`);
    }
  }
});
