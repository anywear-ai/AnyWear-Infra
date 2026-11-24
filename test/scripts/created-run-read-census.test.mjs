import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #354: the census over every workflow script that could read an Actions run by id.
// The class "a by-id read of a freshly created run must tolerate eventual
// consistency" has one implementation, `scripts/lib/created-run-read.mjs`; this
// test fails when any tracked workflow script spells `actions/runs/` outside it,
// when the vendored bytes drift from the pinned SHA-256, when the retry policy is
// defined twice, when the module gains a dependency, or when the restricted
// `requireSuccess: false` flag appears anywhere but the observation.
//
// The scan set is the one the Analysis records: `git ls-files .github scripts`,
// extensions mjs/cjs/js/ts/yml/yaml, without tests and fixtures. Comments are
// stripped before the scan, so prose about a URL does not count as a read.
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const MODULE = 'scripts/lib/created-run-read.mjs';
const MODULE_PATH_LITERAL = 'repos/${repository}/actions/runs/${runId}';
const MODULE_TEMPLATE = `\`${MODULE_PATH_LITERAL}\``;
const SCAN_EXTENSIONS = /\.(?:mjs|cjs|js|ts|ya?ml)$/;
const SUB_RESOURCES = /\/(?:jobs|artifacts|attempts|logs|timing|cancel|rerun|force-cancel|approve|review)\b|\?per_page=/;
const BROWSABLE_HOST = /(?:https?:\/\/github\.com\/|github\\\.com\/|GITHUB_SERVER_URL|SERVER_URL|server_url|serverUrl)/;
const REPOSITORY_SEGMENT = /(?:\$\{[^}]*\}|[\w.-]+\/[\w.-]+)\/$/;

// The exact, reason-bearing, non-stale exemption table. Each row asserts that the
// file's spans not already cleared by a browsable URL or a sub-resource are exactly
// the listed ones; a new by-id read in either file is not listed and fails.
const EXEMPTIONS = Object.freeze({
  // Reads the Client publisher run named by the `client_run_id` dispatch input;
  // another workflow created it minutes earlier, so a `404` there is a real
  // refusal. `:49` is a URL and `:312`/`:316` are sub-resources, so they are
  // cleared by the rules above, not by this row.
  'scripts/client-publication.mjs': Object.freeze([311]),
  // By-id re-read of holder runs first discovered from the unfiltered active-run
  // list; the gate is fail-closed and its 30-minute budget must not be spent on
  // retries. `:70` is a cleared URL, so only `:64` is exempt.
  'scripts/qualification-admission.mjs': Object.freeze([64]),
});

// The SHA-256 over the LF-normalised bytes of the canonical module
// `scripts/lib/created-run-read.mjs`, taken from AnyWear-Infra commit
// 6e8c2d94ad59623a118b748f2fc80a4157421c7a. AnyWear-Service and AnyWear-Client
// vendor these exact bytes and carry the same value; the reviewer and the
// independent verifier compare the three constants, because no repository's CI can
// read another private repository.
const PINNED_DIGEST = '78d6883547dc45df1bd57b0f698428b4592aca0b20cdc453dd2a2edc9419ba10';

const readText = file => readFileSync(path.join(repositoryRoot, file), 'utf8');
const trackedScanFiles = () => execFileSync('git', ['-C', repositoryRoot, 'ls-files', '.github', 'scripts'],
  { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean)
  .map(file => file.split(path.sep).join('/'))
  .filter(file => SCAN_EXTENSIONS.test(file))
  .filter(file => !file.startsWith('test/') && !file.includes('/fixtures/') && !file.endsWith('.test.mjs'));

// Strip block comments (keeping newlines so line numbers survive) and line
// comments, without touching the `//` of a URL or a YAML value.
function stripComments(file, text) {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
  return cleaned.split('\n').map(line => (/\.ya?ml$/.test(file)
    ? line.replace(/(^|\s)#.*$/, '$1')
    : line.replace(/(^|[^:])\/\/.*$/, '$1'))).join('\n');
}

function occurrencesOf(file, text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    let from = 0;
    for (;;) {
      const at = line.indexOf('actions/runs/', from);
      if (at < 0) break;
      found.push({ file, line: index + 1, column: at + 1, text: line, index: at });
      from = at + 'actions/runs/'.length;
    }
  });
  return found;
}

// A span is `module` inside the shared module, `url` for a browsable GitHub URL,
// `sub-resource` for a `/jobs`, `/artifacts`, `/attempts` (etc.) read or a
// `?per_page=` query, `exempt` for an exact listed row, and `unclassified`
// otherwise. The module's own occurrences are judged by `moduleVerdict`.
function classifySpan(span) {
  if (span.file === MODULE) return 'module';
  const before = span.text.slice(0, span.index);
  const after = span.text.slice(span.index + 'actions/runs/'.length);
  if (BROWSABLE_HOST.test(before) && REPOSITORY_SEGMENT.test(before)) return 'url';
  if (SUB_RESOURCES.test(after)) return 'sub-resource';
  if ((EXEMPTIONS[span.file] ?? []).includes(span.line)) return 'exempt';
  return 'unclassified';
}

// A second `actions/runs/` occurrence inside the module already fails the span
// count; the template must also be the by-id path literal, not a URL or a
// hand-rolled variant.
function moduleVerdict(moduleText, moduleSpans) {
  if (moduleSpans.length !== 1) {
    return `it holds ${moduleSpans.length} actions/runs/ occurrences and must hold exactly one, the by-id path template`;
  }
  return moduleText.includes(MODULE_TEMPLATE) ? undefined : `its one occurrence is not the template ${MODULE_TEMPLATE}`;
}

const spanOf = (file, text, line = 7) => {
  const index = text.indexOf('actions/runs/');
  return { file, line, column: index + 1, text, index };
};

test('every workflow-script by-id read of an Actions run goes through the shared module', () => {
  const files = trackedScanFiles();
  assert.ok(files.includes(MODULE), `${MODULE} must be tracked: the census scans git ls-files`);
  const spans = files.flatMap(file => occurrencesOf(file, stripComments(file, readText(file))));
  const moduleSpans = spans.filter(span => span.file === MODULE);
  const problems = [];
  const moduleProblem = moduleVerdict(readText(MODULE), moduleSpans);
  if (moduleProblem !== undefined) {
    problems.push(`${MODULE}: ${moduleProblem}; keep the one readCreatedRunById path there`);
  }
  for (const span of spans) {
    if (span.file === MODULE) continue;
    if (classifySpan(span) !== 'unclassified') continue;
    problems.push(`${span.file}:${span.line}:${span.column}: a by-id read of an Actions run outside the shared module;`
      + ` call readCreatedRunById from ${MODULE}`);
  }
  // `gh run view`/`gh run watch` read a run's state without spelling the API path;
  // a workflow-run path without a query is a by-id read the same way.
  for (const file of files) {
    stripComments(file, readText(file)).split('\n').forEach((line, index) => {
      if (/\bgh\s+run\s+(?:view|watch)\b/.test(line)) {
        problems.push(`${file}:${index + 1}:1: ` + '`gh run view`/`gh run watch` reads a run outside the shared module;'
          + ` call readCreatedRunById from ${MODULE}`);
      }
      if (/actions\/workflows\/[^\s`'"$]+\/runs\/\d+/.test(line)) {
        problems.push(`${file}:${index + 1}:1: a workflow-run id read outside the shared module;`
          + ` call readCreatedRunById from ${MODULE}`);
      }
    });
  }
  assert.deepEqual(problems, [], 'every by-id read of an Actions run must go through the shared module');

  // The exemption table is exact in both directions: every listed span exists and is
  // not already cleared by the URL/sub-resource rules, and no other span in the file
  // escapes those rules. A stale or widened row fails by name.
  for (const [file, lines] of Object.entries(EXEMPTIONS)) {
    const fileSpans = spans.filter(span => span.file === file);
    assert.ok(fileSpans.length > 0, `${file}: the exemption row must name a scanned file that spells actions/runs/`);
    const unclassified = fileSpans.filter(span => !['url', 'sub-resource'].includes(classifySpan(span)))
      .map(span => span.line);
    assert.deepEqual(unclassified, [...lines],
      `${file}: the exemption row must list exactly the spans no rule clears`);
  }
});

test('the retry policy is defined once, in the module, and only imported or re-exported elsewhere', () => {
  const files = trackedScanFiles();
  for (const name of ['RUN_READ_ATTEMPTS', 'RUN_READ_WAIT_MS', 'runReadWaits']) {
    const definitions = files.filter(file => new RegExp(
      `^export\\s+(?:async\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`, 'm').test(readText(file)));
    assert.deepEqual(definitions, [MODULE], `${name} must be defined only in ${MODULE}`);
  }
  const dispatch = readText('scripts/qualification-dispatch.mjs');
  assert.match(dispatch,
    /export\s*\{\s*RUN_READ_ATTEMPTS,\s*RUN_READ_WAIT_MS,\s*runReadWaits\s*\}\s*from\s*'\.\/lib\/created-run-read\.mjs'/,
    'the dispatch entry re-exports the three symbols; a re-export is not a definition');
  // The doubling construction belongs to the module alone, so no caller can grow a
  // second schedule.
  const doubling = files.filter(file => readText(file).includes('baseMs * 2 ** index'));
  assert.deepEqual(doubling, [MODULE], 'the doubling schedule may only be written in the module');
});

test('the module bytes equal the pinned digest and the module has no dependencies', () => {
  const moduleText = readText(MODULE);
  const normalised = moduleText.replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
  assert.equal(digest, PINNED_DIGEST,
    `the vendored module changed: observed ${digest}. Re-pin this constant in all three repositories and vendor`
    + ' the same bytes; the canonical path is scripts/lib/created-run-read.mjs');
  assert.equal(/\bimport\b/.test(moduleText), false, 'the module must import nothing');
  assert.equal(/process\.env/.test(moduleText), false, 'the module must read no environment');
  assert.equal(/readFile/.test(moduleText), false, 'the module must touch no filesystem');
  assert.equal(/process\.argv\[1\]/.test(moduleText), false, 'the module must carry no main guard');
});

test('the restricted requireSuccess flag appears only at the observation call site', () => {
  const hits = [];
  for (const file of trackedScanFiles()) {
    readText(file).split('\n').forEach((line, index) => {
      if (line.includes('requireSuccess: false')) hits.push({ file, line: index + 1 });
    });
  }
  assert.deepEqual(hits.map(hit => hit.file), ['scripts/qualification-dispatch.mjs'],
    'only the observation may accept a terminal non-success run');
  const dispatch = readText('scripts/qualification-dispatch.mjs');
  const observationStart = dispatch.split('\n')
    .findIndex(line => line.startsWith('export async function observeQualification')) + 1;
  assert.ok(observationStart > 0, 'the observation function must exist');
  assert.ok(hits[0].line > observationStart,
    `requireSuccess: false must be inside observeQualification, found at line ${hits[0].line}`);
  assert.ok(dispatch.slice(dispatch.indexOf('export async function observeQualification'))
    .includes('requireSuccess: false'), 'the observation calls the module with the flag');
});

// The classifier is self-tested so a broken pattern cannot make the census pass
// vacuously: one plain API path that fails, one browsable URL that passes, one
// `api.github.com` path that fails, one sub-resource that passes, one exemption
// span that passes, and a module holding two occurrences that fails.
test('the classifier itself distinguishes a module path, a URL, a sub-resource and an exemption', () => {
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const probe = `gh api repos/anywear-ai/AnyWear-E2E/actions/runs/${runId}`;')), 'unclassified');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const url = `https://github.com/${repository}/actions/runs/${runId}`;')), 'url');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const url = `https://api.github.com/repos/anywear-ai/AnyWear-E2E/actions/runs/${runId}`;')), 'unclassified');
  assert.equal(classifySpan(spanOf('scripts/probe.mjs',
    'const jobs = `${base}/actions/runs/${runId}/jobs`;')), 'sub-resource');
  assert.equal(classifySpan(spanOf('scripts/client-publication.mjs',
    '  const publisherRun = await readApi({ run, token }, restPath(`actions/runs/${runId}`));', 311)), 'exempt');
  const moduleSpan = spanOf(MODULE, `const readPath = ${MODULE_TEMPLATE};`, 92);
  assert.equal(moduleVerdict(readText(MODULE), [moduleSpan]), undefined, 'one template occurrence passes');
  assert.notEqual(moduleVerdict(readText(MODULE), [moduleSpan, moduleSpan]), undefined,
    'a module holding two occurrences fails, so the implementation cannot grow a site of its own');
});
