import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// The scripts entry-surface guard (#210). `scripts/README.md` is the single
// declaration of which root programs exist and who runs them; this file is the
// executable half, so a file cannot join the credential chain without a reviewed
// position in it. Ten checks, all run by `npm run check`:
//
//   1. root surface = declared entries + manifest + declared data files, and every
//      tracked `test/**/*.test.mjs` is matched by the live command;
//   2. no test under `scripts/`, and `lib/` is its only directory;
//   3. every declared caller site really invokes its entry;
//   4. every workflow/action/shell/package invocation is declared;
//   5. every documented or TypeScript-spawned program is a declared entry;
//   6. every row's credential class matches the job that runs it;
//   7. every `scripts/lib/` module has a non-test importer;
//   8. `scripts/lib/` holds modules only (no main guard, two-level root anchors);
//   9. the declared operator entries load without a credential;
//  10. no exported binding is defined twice, and the shared constants agree.
//
// This file owns the file inventory, caller resolution, import liveness and
// constant identity. `test/scripts/entry-surface.test.mjs` owns the
// workflow/job/permission surface and reads the same YAML for different facts.

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const scriptsDirectory = path.join(repositoryRoot, 'scripts');
const moduleDirectory = path.join(scriptsDirectory, 'lib');
const workflowsDirectory = path.join(repositoryRoot, '.github', 'workflows');
const actionsDirectory = path.join(repositoryRoot, '.github', 'actions');

const CALLER_KINDS = Object.freeze(['workflow', 'action', 'shell', 'package', 'runbook', 'cdk']);
const CREDENTIAL_CLASSES = Object.freeze(['none', 'oidc-session', 'inherited', 'operator', 'synth']);

const readText = (file) => readFileSync(path.join(repositoryRoot, file), 'utf8');
const readJson = (file) => JSON.parse(readText(file));
const entriesOf = directory => readdirSync(directory, { withFileTypes: true });
const filesIn = directory => entriesOf(directory).filter(entry => entry.isFile()).map(entry => entry.name).sort();
const directoriesIn = directory => entriesOf(directory).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const isFile = (file) => {
  try {
    return statSync(path.join(repositoryRoot, file)).isFile();
  } catch {
    return false;
  }
};
const trackedFiles = (...patterns) => execFileSync('git', ['-C', repositoryRoot, 'ls-files', ...patterns], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean).map(file => file.split(path.sep).join('/'));
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

// The manifest is read once per check from the repository's own file, so a
// deleted or malformed table fails closed instead of silently shrinking the
// declared surface.
function readTable(lines, headerPattern, expectedCells, label) {
  const headerIndex = lines.findIndex(line => headerPattern.test(line.trim()));
  assert.ok(headerIndex >= 0, `scripts/README.md must hold the ${label} table`);
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
    const cells = splitRow(lines[index]);
    assert.equal(cells.length, expectedCells,
      `scripts/README.md:${index + 1} (${label}) has ${cells.length} cells, expected ${expectedCells}`);
    rows.push({ cells, line: index + 1 });
  }
  assert.ok(rows.length > 0, `scripts/README.md must hold at least one ${label} row`);
  return rows;
}

function manifest() {
  const lines = readText('scripts/README.md').split(/\r?\n/);
  const entryRows = readTable(lines, /^\|\s*Entry\s*\|\s*Caller\s*\|\s*Credential\s*\|\s*Proof\s*\|$/, 4, 'entry manifest');
  const entries = [];
  for (const { cells: [entryCell, callerCell, credential, proof], line } of entryRows) {
    const entry = entryCell.match(/^`([a-z0-9-]+\.mjs)`$/)?.[1];
    assert.ok(entry, `scripts/README.md:${line} entry cell must be a backticked root program name, got ${entryCell}`);
    const caller = callerCell.match(/^`([a-z-]+):([^`]+)`$/);
    assert.ok(caller, `scripts/README.md:${line} caller cell must be \`<kind>:<site>\`, got ${callerCell}`);
    assert.ok(CALLER_KINDS.includes(caller[1]),
      `scripts/README.md:${line} caller kind "${caller[1]}" must be one of ${CALLER_KINDS.join(', ')}`);
    assert.ok(CREDENTIAL_CLASSES.includes(credential),
      `scripts/README.md:${line} credential "${credential}" must be one of ${CREDENTIAL_CLASSES.join(', ')}`);
    assert.ok(proof.length > 0, `scripts/README.md:${line} must state the proof the entry contributes`);
    entries.push({ entry, kind: caller[1], site: caller[2], credential, proof, line });
  }
  const dataRows = readTable(lines, /^\|\s*File\s*\|\s*Consumer\s*\|$/, 2, 'data file');
  const data = dataRows.map(({ cells: [fileCell], line }) => {
    const file = fileCell.match(/^`([^`]+)`$/)?.[1];
    assert.ok(file, `scripts/README.md:${line} data cell must be a backticked file name, got ${fileCell}`);
    return file;
  });
  return { entries, data };
}

const packageJson = () => readJson('package.json');
const packageScripts = () => packageJson().scripts ?? {};

const workflowFileNames = () => filesIn(workflowsDirectory).filter(file => /\.ya?ml$/.test(file)).sort();
const workflowPath = file => `.github/workflows/${file}`;
const actionPaths = () => directoriesIn(actionsDirectory)
  .map(name => `.github/actions/${name}/action.yml`)
  .filter(isFile).sort();
const loadYamlFile = file => yaml.load(readText(file));
const loadWorkflows = () => workflowFileNames().map(file => ({ file, workflow: loadYamlFile(workflowPath(file)) }));
const loadActions = () => actionPaths().map(file => ({ file, action: loadYamlFile(file) }));
const jobRunText = job => (job?.steps ?? []).map(step => String(step.run ?? '')).join('\n');
const workflowRunText = workflow => Object.entries(workflow.jobs ?? {})
  .map(([jobName, job]) => ({ jobName, text: jobRunText(job) }));

// A program is invoked by path when the text names `scripts/<file>.mjs` as a
// whole path, whatever precedes it (`node `, `${DIR}/`, `from `).
const programPattern = (entry) => new RegExp(`scripts/${escapeRegExp(entry)}(?![\\w.-])`);
const invokes = (text, entry) => programPattern(entry).test(text);
const programNamesIn = text => [...text.matchAll(/scripts\/([a-z0-9-]+\.mjs)(?![\w.-])/g)].map(match => match[1]);
const shellCode = text => text.split(/\r?\n/)
  .map(line => line.replace(/#.*$/, '')).join('\n');
const nonCommentShellFiles = () => trackedFiles('.github/scripts').filter(file => file.endsWith('.sh'));

const classOfJob = (workflow, job, where) => {
  assert.notEqual(job, undefined, `${where} does not exist`);
  if (workflow.permissions === 'write-all' || job.permissions === 'write-all') {
    throw new Error(`${where} declares permissions: write-all; only the reviewed credential classes are allowed`);
  }
  const permissions = job.permissions ?? workflow.permissions ?? {};
  const declaresEnvironment = Object.hasOwn(job, 'environment');
  const holdsIdToken = typeof permissions === 'object' && permissions['id-token'] === 'write';
  if (declaresEnvironment && holdsIdToken) return 'oidc-session';
  if (!declaresEnvironment && !holdsIdToken) return 'none';
  throw new Error(`${where} declares ${declaresEnvironment ? 'an environment without id-token: write' : 'id-token: write without an environment'}; neither credential class applies`);
};

const jobClasses = () => {
  const classes = new Map();
  for (const { file, workflow } of loadWorkflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      classes.set(`${workflowPath(file)}@${jobName}`, classOfJob(workflow, job, `${workflowPath(file)} job ${jobName}`));
    }
  }
  return classes;
};
const actionUsers = () => {
  const users = new Map();
  for (const { file, workflow } of loadWorkflows()) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const uses = String(step.uses ?? '');
        if (!uses.startsWith('./.github/actions/')) continue;
        const actionPath = `${uses.slice(2)}/action.yml`;
        if (!users.has(actionPath)) users.set(actionPath, []);
        users.get(actionPath).push(`${workflowPath(file)}@${jobName}`);
      }
    }
  }
  return users;
};

test('the scripts root is exactly the declared entries, the manifest and the declared data files', () => {
  const { entries, data } = manifest();
  const declaredEntries = [...new Set(entries.map(row => row.entry))].sort();
  const declaredRoot = [...declaredEntries, ...data].sort();
  const rootFiles = filesIn(scriptsDirectory);
  const undeclared = rootFiles.filter(file => !declaredRoot.includes(file));
  assert.deepEqual(undeclared, [],
    `scripts/ root file(s) without a manifest or data-table declaration: ${undeclared.join(', ')}`);
  const missing = declaredRoot.filter(file => !rootFiles.includes(file));
  assert.deepEqual(missing, [],
    `scripts/README.md declares root file(s) that do not exist: ${missing.join(', ')}`);
  for (const row of entries) {
    assert.ok(isFile(`scripts/${row.entry}`),
      `scripts/README.md:${row.line} declares ${row.entry}, which is not a root scripts/ file`);
  }

  const command = packageScripts()['test:contracts'];
  assert.equal(typeof command, 'string', 'package.json must define test:contracts');
  assert.match(command, /^node --test\s+\S+/, 'test:contracts must be a node --test command');
  const patterns = command.replace(/^node --test\s+/, '').trim().split(/\s+/).map((pattern) => new RegExp(
    `^${escapeRegExp(pattern).replace(/\\\*/g, '[^/]*')}$`));
  const trackedTests = trackedFiles('test').filter(file => file.endsWith('.test.mjs'));
  assert.ok(trackedTests.length > 0, 'the test:contracts census found no tracked test/**/*.test.mjs');
  for (const file of trackedTests) {
    assert.ok(patterns.some(pattern => pattern.test(file)),
      `test:contracts does not match tracked test ${file}; a moved test cannot silently stop running`);
  }
});

test('no Node test lives under scripts/ and lib/ is its only directory', () => {
  assert.deepEqual(directoriesIn(scriptsDirectory), ['lib'],
    'scripts/ must contain only the lib/ module directory');
  const rootTests = filesIn(scriptsDirectory).filter(file => file.endsWith('.test.mjs'));
  assert.deepEqual(rootTests, [], `Node test(s) must live in test/scripts/, not scripts/: ${rootTests.join(', ')}`);
  assert.deepEqual(directoriesIn(moduleDirectory), [],
    'scripts/lib/ must hold modules only; nested directories are not part of the module surface');
  const moduleTests = filesIn(moduleDirectory).filter(file => file.endsWith('.test.mjs'));
  assert.deepEqual(moduleTests, [], `Node test(s) must live in test/scripts/, not scripts/lib/: ${moduleTests.join(', ')}`);
});

test('every manifest row resolves to a live caller that invokes its entry', () => {
  const { entries } = manifest();
  const workflows = new Map(loadWorkflows().map(({ file, workflow }) => [workflowPath(file), workflow]));
  const actions = new Map(loadActions().map(({ file, action }) => [file, action]));
  const scripts = packageScripts();
  for (const row of entries) {
    if (row.kind === 'workflow') {
      const separator = row.site.lastIndexOf('@');
      assert.ok(separator > 0, `scripts/README.md:${row.line} workflow site must be <file>.yml@<job>, got ${row.site}`);
      const file = row.site.slice(0, separator);
      const jobName = row.site.slice(separator + 1);
      const workflow = workflows.get(file);
      assert.notEqual(workflow, undefined, `scripts/README.md:${row.line} names workflow ${file}, which does not exist`);
      const job = workflow.jobs?.[jobName];
      assert.notEqual(job, undefined, `scripts/README.md:${row.line} names job ${jobName}, which ${file} does not define`);
      assert.ok(invokes(jobRunText(job), row.entry),
        `${row.site} must invoke scripts/${row.entry} (declared at scripts/README.md:${row.line})`);
    } else if (row.kind === 'action') {
      const action = actions.get(row.site);
      assert.notEqual(action, undefined, `scripts/README.md:${row.line} names action ${row.site}, which does not exist`);
      const runText = (action.runs?.steps ?? []).map(step => String(step.run ?? '')).join('\n');
      assert.ok(invokes(runText, row.entry),
        `${row.site} must invoke scripts/${row.entry} (declared at scripts/README.md:${row.line})`);
    } else if (row.kind === 'shell') {
      assert.ok(isFile(row.site), `scripts/README.md:${row.line} names shell hook ${row.site}, which does not exist`);
      assert.ok(invokes(shellCode(readText(row.site)), row.entry),
        `${row.site} must invoke scripts/${row.entry} on a non-comment line (declared at scripts/README.md:${row.line})`);
    } else if (row.kind === 'package') {
      assert.equal(typeof scripts[row.site], 'string',
        `scripts/README.md:${row.line} names package script ${row.site}, which package.json does not define`);
      assert.ok(invokes(scripts[row.site], row.entry),
        `package.json script ${row.site} must invoke scripts/${row.entry} (declared at scripts/README.md:${row.line})`);
    } else if (row.kind === 'runbook') {
      assert.ok(isFile(row.site), `scripts/README.md:${row.line} names runbook ${row.site}, which does not exist`);
      assert.ok(new RegExp(`node\\s+scripts/${escapeRegExp(row.entry)}(?![\\w.-])`).test(readText(row.site)),
        `${row.site} must document \`node scripts/${row.entry}\` (declared at scripts/README.md:${row.line})`);
    } else if (row.kind === 'cdk') {
      assert.ok(isFile(row.site), `scripts/README.md:${row.line} names CDK source ${row.site}, which does not exist`);
      assert.ok(new RegExp(`\\.\\./scripts/${escapeRegExp(row.entry)}(?![\\w.-])`).test(readText(row.site)),
        `${row.site} must spawn ../scripts/${row.entry} (declared at scripts/README.md:${row.line})`);
    }
  }
});

test('every workflow, action, shell hook and package script invocation is declared', () => {
  const { entries } = manifest();
  const declared = new Set(entries.map(row => `${row.kind}:${row.site}:${row.entry}`));
  const assertDeclared = (kind, site, entry) => {
    assert.ok(declared.has(`${kind}:${site}:${entry}`),
      `${kind} site ${site} invokes scripts/${entry}, which has no manifest row`);
  };
  for (const { file, workflow } of loadWorkflows()) {
    for (const { jobName, text } of workflowRunText(workflow)) {
      for (const entry of programNamesIn(text)) assertDeclared('workflow', `${workflowPath(file)}@${jobName}`, entry);
    }
  }
  for (const { file, action } of loadActions()) {
    const runText = (action.runs?.steps ?? []).map(step => String(step.run ?? '')).join('\n');
    for (const entry of programNamesIn(runText)) assertDeclared('action', file, entry);
  }
  for (const file of nonCommentShellFiles()) {
    for (const entry of programNamesIn(shellCode(readText(file)))) assertDeclared('shell', file, entry);
  }
  for (const [name, value] of Object.entries(packageScripts())) {
    for (const entry of programNamesIn(String(value))) assertDeclared('package', name, entry);
  }
});

test('every documented or TypeScript-spawned scripts program is a declared entry', () => {
  const { entries } = manifest();
  const declaredEntries = new Set(entries.map(row => row.entry));
  const assertEntry = (site, entry) => {
    assert.ok(declaredEntries.has(entry), `${site} names scripts/${entry}, which is not a declared entry`);
  };
  const documents = ['README.md', 'AGENTS.md', ...trackedFiles('docs').filter(file => file.endsWith('.md'))];
  for (const document of documents) {
    for (const match of readText(document).matchAll(/node\s+scripts\/([a-z0-9-]+\.mjs)(?![\w.-])/g)) {
      assertEntry(document, match[1]);
    }
  }
  const typescript = [...trackedFiles('lib'), ...trackedFiles('bin')].filter(file => file.endsWith('.ts'));
  for (const source of typescript) {
    for (const entry of programNamesIn(readText(source))) assertEntry(source, entry);
  }
});

test('every row credential class matches the job that runs it', () => {
  const { entries } = manifest();
  const classes = jobClasses();
  const users = actionUsers();
  const runs = new Map();
  for (const { file, workflow } of loadWorkflows()) {
    for (const { jobName, text } of workflowRunText(workflow)) runs.set(`${workflowPath(file)}@${jobName}`, text);
  }
  for (const row of entries) {
    const where = `scripts/README.md:${row.line}`;
    if (row.kind === 'workflow') {
      assert.ok(classes.has(row.site), `${where} names unknown workflow job ${row.site}`);
      assert.equal(classes.get(row.site), row.credential,
        `${where}: ${row.site} runs under ${classes.get(row.site)}, not the declared ${row.credential}`);
    } else if (row.kind === 'action') {
      const jobs = users.get(row.site) ?? [];
      assert.ok(jobs.length > 0, `${where}: no job uses ${row.site}, so its credential class cannot hold`);
      for (const job of jobs) {
        assert.equal(classes.get(job), row.credential,
          `${where}: ${row.site} runs in ${job} under ${classes.get(job)}, not the declared ${row.credential}`);
      }
      assert.equal(/configure-aws-credentials|aws-actions\//.test(readText(row.site)), false,
        `${where}: ${row.site} must configure no AWS credential; the workflow job owns the session`);
    } else if (row.kind === 'shell') {
      assert.equal(row.credential, 'inherited', `${where}: a shell hook runs under the inherited operation credential`);
    } else if (row.kind === 'package') {
      assert.equal(row.credential, 'none', `${where}: a package script is a credential-free repository command`);
      for (const [job, text] of runs) {
        if (!new RegExp(`npm\\s+run\\s+${escapeRegExp(row.site)}(?![\\w:.-])`).test(text)) continue;
        assert.equal(classes.get(job), 'none', `${where}: ${job} runs \`npm run ${row.site}\` with a credential surface`);
      }
    } else if (row.kind === 'runbook') {
      assert.equal(row.credential, 'operator', `${where}: a runbook CLI runs under the operator session`);
    } else if (row.kind === 'cdk') {
      assert.equal(row.credential, 'synth', `${where}: the CDK application spawns the program while synthesizing`);
    }
  }
});

test('every scripts/lib module has a non-test importer', () => {
  const importers = new Map();
  const add = (target, importer) => {
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(importer);
  };
  const sourceFiles = [
    ...filesIn(scriptsDirectory).filter(file => file.endsWith('.mjs')).map(file => `scripts/${file}`),
    ...filesIn(moduleDirectory).filter(file => file.endsWith('.mjs')).map(file => `scripts/lib/${file}`),
    ...[...trackedFiles('lib'), ...trackedFiles('bin')].filter(file => file.endsWith('.ts')),
  ];
  for (const source of sourceFiles) {
    for (const match of readText(source).matchAll(/(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\1/g)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
      if (target === source) continue;
      add(target, source);
    }
  }
  const modules = filesIn(moduleDirectory).filter(file => file.endsWith('.mjs'));
  assert.ok(modules.length > 0, 'scripts/lib/ holds no module to check');
  for (const module of modules) {
    const target = `scripts/lib/${module}`;
    const importersOfModule = [...(importers.get(target) ?? [])].filter(importer => importer !== target);
    assert.ok(importersOfModule.length > 0,
      `${target} has no non-test importer; a module without a production importer cannot survive`);
  }
});

test('scripts/lib holds modules only: no main guard and two-level root anchors', () => {
  for (const file of filesIn(moduleDirectory)) {
    const location = `scripts/lib/${file}`;
    assert.match(file, /^[a-z0-9-]+\.mjs$/, `${location} must be a lowercase module file name`);
    const text = readText(location);
    assert.equal(/process\.argv\[1\]/.test(text), false,
      `${location} must not carry a process.argv[1] main guard; an executable cannot hide in scripts/lib/`);
    text.split(/\r?\n/).forEach((line, index) => {
      if (!/import\.meta\.dirname|fileURLToPath\(import\.meta\.url\)/.test(line)) return;
      assert.match(line, /'\.\.\/\.\.'|"\.\.\/\.\."/,
        `${location}:${index + 1} computes a repository-root anchor and must step up two levels`);
    });
  }
});

test('the declared operator entries load without a credential', async () => {
  const ecr = await import(pathToFileURL(path.join(scriptsDirectory, 'ecr-retention.mjs')).href);
  assert.equal(typeof ecr.checkRetention, 'function',
    'scripts/ecr-retention.mjs must expose checkRetention without a credential');
  const migrate = await import(pathToFileURL(path.join(scriptsDirectory, 'migrate-beta-split.mjs')).href);
  assert.equal(typeof migrate.runStage, 'function',
    'scripts/migrate-beta-split.mjs must expose runStage without a credential');
  const release = await import(pathToFileURL(path.join(moduleDirectory, 'release-inputs.mjs')).href);
  assert.equal(path.dirname(path.dirname(release.SELECTED_RELEASE_DIRECTORY)), repositoryRoot,
    'SELECTED_RELEASE_DIRECTORY must resolve to the repository root before its .service-artifacts step');
});

test('each shared constant has exactly one definition and the contract values agree', async () => {
  const definitions = new Map();
  const sources = ['lib/contracts.mjs', ...trackedFiles('scripts').filter(file => file.endsWith('.mjs'))];
  for (const source of sources) {
    for (const match of readText(source).matchAll(
      /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (!definitions.has(name)) definitions.set(name, []);
      definitions.get(name).push(source);
    }
  }
  const duplicates = [...definitions].filter(([, files]) => files.length > 1);
  assert.deepEqual(duplicates.map(([name, files]) => `${name} in ${files.join(', ')}`), [],
    'no exported binding may be defined twice across lib/contracts.mjs and scripts/**/*.mjs');
  for (const name of ['BASE_STACK', 'SSM_GET_PARAMETERS_LIMIT', 'SERVICE_REPOSITORY', 'INFRA_REPOSITORY']) {
    assert.equal(definitions.get(name)?.length, 1, `${name} must have exactly one definition`);
  }
  const contracts = await import(pathToFileURL(path.join(repositoryRoot, 'lib', 'contracts.mjs')).href);
  const deployment = await import(pathToFileURL(path.join(moduleDirectory, 'deployment-contract.mjs')).href);
  const parameters = await import(pathToFileURL(path.join(moduleDirectory, 'stage-contract-parameters.mjs')).href);
  assert.equal(deployment.BASE_STACK, contracts.platformStackName(contracts.STAGE_CONTRACT_STAGE),
    'BASE_STACK must be the stage contract\'s name for the persistent stage base');
  assert.equal(deployment.SERVICE_REPOSITORY, contracts.SERVICE_REPOSITORY,
    'the deployment contract must re-export the contract\'s Service repository identity');
  assert.equal(deployment.INFRA_REPOSITORY, contracts.INFRA_REPOSITORY,
    'the deployment contract must re-export the contract\'s Infra repository identity');
  assert.equal(typeof parameters.SSM_GET_PARAMETERS_LIMIT, 'number',
    'SSM_GET_PARAMETERS_LIMIT must come from the stage-contract parameter module');
});
