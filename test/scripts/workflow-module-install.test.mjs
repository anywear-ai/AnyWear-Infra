import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import yaml from 'js-yaml';

// Regression guard for observe run 39102443422: a credential-free job ran
// `node scripts/record-deployment.mjs` without installing dependencies, so a
// bare-specifier dependency import failed with ERR_MODULE_NOT_FOUND. Those record
// jobs retired with #207, so the anchor is now the rule rather than the job: every
// job that runs a repository module must install the pinned dependencies before
// its first module-using step. Every workflow is scanned, so a newly added job of
// that shape — in either entry or any other workflow — fails until it installs.
const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);

// A shell command uses a repository module when it executes a module from the
// repository's own source directories, either directly with Node or through a
// require/import of a repository path.
const repositoryModulePatterns = Object.freeze([
  // `node scripts/record-deployment.mjs`, `node .github/scripts/<script>.mjs`,
  // `node --test scripts/*.test.mjs .github/scripts/*.test.mjs`.
  /\bnode\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:\.\/)?(?:scripts|packages|bin|test|lib|\.github\/scripts)\/[\w./*{}-]+\.(?:mjs|cjs|js|ts)\b/,
  // `require('./scripts/x.mjs')`, `import(...)`, `from '../scripts/x.mjs'`.
  /\b(?:require\s*\(\s*|import\s*\(\s*|from\s+|import\s+)(['"])(?:\.\.?\/)?(?:scripts|packages|bin|test|lib|\.github\/scripts)\/[\w./-]+\1/,
]);
const installPattern = /\bnpm\s+(?:ci|install)\b/;

const isRepositoryModuleStep = step => typeof step.run === 'string'
  && repositoryModulePatterns.some(pattern => pattern.test(step.run));
const isInstallStep = step => typeof step.run === 'string' && installPattern.test(step.run);
const commandOf = step => step.run.trim().split('\n')[0].trim();

// The one job allowed to run a repository module before `npm ci` is Production's
// source-disabled onboarding blocker. `production.yml` is `workflow_call`-only —
// never an entry — and its blocker must stay the first executed step so no
// activation variable can bypass it, so the ordering rule cannot hold there
// without widening the contract. The exemption is exact and asserted below; it is
// not a general escape hatch and must be removed if the job changes shape.
const installOrderExemptions = Object.freeze([
  { file: 'production.yml', job: 'promotion', firstModuleCommand: 'node scripts/promote-production.mjs' },
]);

async function loadWorkflows() {
  // GitHub accepts both `.yml` and `.yaml`; scan either extension so a `.yaml`
  // workflow cannot escape the module-install rule.
  const files = (await readdir(workflowDirectory)).filter(file => /\.ya?ml$/.test(file)).sort();
  return Promise.all(files.map(async file => ({
    file,
    workflow: yaml.load(await readFile(new URL(file, workflowDirectory), 'utf8')),
  })));
}

test('every job that runs a repository module installs dependencies before it', async () => {
  const workflows = await loadWorkflows();
  assert.ok(workflows.length > 0, 'workflow files are present');
  const checked = [];
  const violations = [];
  for (const { file, workflow } of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const firstModule = steps.findIndex(isRepositoryModuleStep);
      if (firstModule === -1) continue;
      checked.push(`${file}#${jobName}`);
      const firstInstall = steps.findIndex(isInstallStep);
      if (firstInstall !== -1 && firstInstall < firstModule) continue;
      violations.push({ file, jobName, firstModule, firstInstall, command: commandOf(steps[firstModule]) });
    }
  }
  // Keep the rule observable: the scan still finds module-running jobs, so a
  // broken pattern cannot make this test pass vacuously.
  assert.ok(checked.length > 0, 'the scan still finds repository-module jobs');
  // Regression anchors: the credential-free preflight jobs run a repository module
  // and stay covered by the derived rule.
  for (const moduleJob of ['runtime.yml#preflight', 'mutate.yml#preflight']) {
    assert.ok(checked.includes(moduleJob), `${moduleJob} is covered by the module scan`);
  }

  const exemptionFor = violation => installOrderExemptions
    .find(exemption => exemption.file === violation.file && exemption.job === violation.jobName);
  const unexpected = violations.filter(violation => exemptionFor(violation) === undefined);
  assert.deepEqual(unexpected.map(({ file, jobName, command }) => `${file} ${jobName} (${command})`), [],
    'every job that runs a repository module installs dependencies before it');

  const exempted = new Set();
  for (const violation of violations.filter(candidate => exemptionFor(candidate) !== undefined)) {
    const exemption = exemptionFor(violation);
    // Exact: the exempt job must still start its module use with the recorded
    // blocker and still install later in the same job, so the exemption cannot
    // mask a missing install.
    assert.equal(violation.command, exemption.firstModuleCommand,
      `${violation.file} ${violation.jobName} exemption command`);
    assert.notEqual(violation.firstInstall, -1,
      `${violation.file} ${violation.jobName} still installs dependencies after the blocker`);
    exempted.add(`${exemption.file}#${exemption.job}`);
  }
  for (const exemption of installOrderExemptions) {
    assert.ok(exempted.has(`${exemption.file}#${exemption.job}`),
      `${exemption.file} ${exemption.job} no longer matches its exemption; remove the stale entry`);
  }

  // The exemption stays bound to the callable-only Production workflow and its
  // source-disabled blocker.
  const production = workflows.find(({ file }) => file === 'production.yml');
  assert.ok(production, 'production.yml is present');
  assert.deepEqual(Object.keys(production.workflow.on ?? {}), ['workflow_call'],
    'production.yml stays workflow_call-only');
  const promotion = production.workflow.jobs?.promotion;
  assert.ok(promotion, 'production.yml keeps the promotion job');
  const executed = (promotion.steps ?? []).filter(step => typeof step.run === 'string');
  assert.equal(executed[0]?.run, 'node scripts/promote-production.mjs',
    'the Production source blocker stays the first executed step');
});
