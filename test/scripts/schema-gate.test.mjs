import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APPLIED_SCHEMA_MAX_ROWS,
  APPLIED_SCHEMA_RECORD_TYPE,
  APPLIED_SCHEMA_RECORD_VERSION,
  ONE_SHOT_LOG_GROUP,
  SCHEMA_BOUNDARY_EVENT,
  SCHEMA_BOUNDARY_REASONS,
  SCHEMA_JOURNAL_ACTION,
  SCHEMA_LOG_MAX_ATTEMPTS,
  SCHEMA_LOG_MAX_MESSAGES,
  SCHEMA_LOG_MAX_PAGES,
  SCHEMA_LOG_PAGE_LIMIT,
  SCHEMA_LOG_RETRY_MS,
  SCHEMA_READER_APPLIED_JOURNAL_INVALID_EXIT,
  SCHEMA_READER_CONFIGURATION_INVALID_EXIT,
  SCHEMA_READER_CONNECTION_FAILED_EXIT,
  SCHEMA_READER_CREDENTIAL_REFUSED_EXIT,
  SCHEMA_READER_EXITS,
  SCHEMA_READER_IMAGE_JOURNAL_INVALID_EXIT,
  SCHEMA_READER_PRIVILEGE_INSUFFICIENT_EXIT,
  SCHEMA_READER_REFUSAL_ACTIONS,
  SCHEMA_READER_SECRET_UNAVAILABLE_EXIT,
  SCHEMA_READER_SOURCES,
  SCHEMA_VERIFY_COMMAND,
  SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT,
  SCHEMA_VERIFY_FAMILY,
  SchemaBoundaryError,
  compareSchemaBoundary,
  probeAppliedSchema,
  readAppliedSchemaLog,
  readSchemaBoundaryEvidence,
  runSchemaBoundaryGate,
  validateAppliedSchemaRecord,
  schemaBoundaryPrefixHash,
} from '../../scripts/lib/schema-gate.mjs';
import { SCHEMA_ASSET_NAME, validateSchemaAsset } from '../../scripts/lib/schema-asset.mjs';
import { canonicalJson, sha256 } from '../../scripts/lib/json-contract.mjs';

// ---------------------------------------------------------------------------
// Fixture provenance (#194)
//
// `test/fixtures/schema-boundary/schema-asset.json` was generated ONCE from the
// committed AnyWear-Service source at the base of the parallel Service reader
// change: `drizzle/meta/_journal.json` plus `sha256(<drizzle/<tag>.sql bytes>)`
// for every one of its 26 entries, with `current_version: 22`,
// `minimum_version: 20`, `minimum_migration_count: 24` (the Service
// `MINIMUM_SCHEMA_MIGRATION = '0023_sudden_the_order'` boundary) and the last
// migration `0025_new_human_fly`. It is written as the publisher writes it
// (`canonicalJson(asset) + "\n"`), so it is the sealed asset's content, not a
// hand-shaped example. `live-read-compatible.json` is the compatible live record
// the `schema-journal` reader returns for that same journal
// (`applied_schema_version: 22`, `journal_table_present: true`, 26 applied rows,
// `local_journal_length: 26`). Every other comparison case below is derived in
// this file from those two fixtures; the fresh-database, ahead, same-index,
// equal-length-different-content, duplicate-row and out-of-order variants are
// synthetic and are named as such.
// ---------------------------------------------------------------------------
const assetBytes = readFileSync(new URL('../../test/fixtures/schema-boundary/schema-asset.json', import.meta.url));
const asset = validateSchemaAsset(JSON.parse(assetBytes.toString('utf8')));
const assetSha256 = sha256(assetBytes);
const live = JSON.parse(readFileSync(new URL('../../test/fixtures/schema-boundary/live-read-compatible.json', import.meta.url), 'utf8'));
const migrations = asset.migrations;
const SERVICE_SHA = 'b'.repeat(40);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const release = { releaseTag: `service-artifacts-${SERVICE_SHA}`, serviceCommit: SERVICE_SHA, imageDigest: IMAGE_DIGEST };
const deployedRevision = { serviceCommit: 'd'.repeat(40), imageDigest: `sha256:${'e'.repeat(64)}` };
const reader = { source: 'selected-image', service_sha: SERVICE_SHA, image_digest: IMAGE_DIGEST };
const taskId = 'a'.repeat(32);
const definitionArn = 'arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-verify:7';
const task = {
  taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${taskId}`,
  clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/beta-anywear',
  lastStatus: 'STOPPED', taskDefinitionArn: definitionArn,
  containers: [{ name: 'OneShot', exitCode: 0, imageDigest: IMAGE_DIGEST }],
};
const definition = {
  family: SCHEMA_VERIFY_FAMILY, taskDefinitionArn: definitionArn,
  containerDefinitions: [{
    name: 'OneShot', command: [...SCHEMA_VERIFY_COMMAND],
    logConfiguration: { logDriver: 'awslogs', options: {
      'awslogs-group': ONE_SHOT_LOG_GROUP, 'awslogs-region': 'ap-east-1',
      'awslogs-stream-prefix': SCHEMA_VERIFY_FAMILY } },
  }],
};

const directories = [];
test.after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});
async function assetDirectory(bytes = assetBytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'schema-gate-'));
  directories.push(directory);
  await writeFile(path.join(directory, SCHEMA_ASSET_NAME), bytes);
  return directory;
}

// A derived comparison case. Only the two committed fixtures are authoritative;
// the rest are the issue's synthetic variants.
function appliedVariant(change) {
  const value = structuredClone(live);
  change(value);
  return value;
}
const appliedRow = (id, tag, created_at, hash) => ({ id, hash, created_at, tag });
const liveRow = (index) => live.applied[index];

// A six-page-bounded fake CloudWatch transport. `pages` is consumed in call
// order; `sleep` is recorded so the bounded retry is provable, not wall-clock.
function logIo(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    io: {
      async aws(args) {
        calls.push(args);
        const next = pages[Math.min(index, pages.length - 1)];
        index += 1;
        return typeof next === 'function' ? next(args) : next;
      },
      async sleep(milliseconds) { calls.push(['sleep', milliseconds]); },
    },
  };
}
const page = (messages, nextForwardToken) => ({ events: messages.map((message) => ({ message })), nextForwardToken });
// One realistic two-page scan: the first page carries the messages and the
// terminal token, the token page is empty (as CloudWatch returns after the head).
const recordScan = (records = [live]) => [page(['noise before the record',
  ...records.map((record) => JSON.stringify(record)), 'noise after the record'], 'end'), page([], 'end')];
const emptyScan = () => [page(['ordinary verify output'], 'end'), page([], 'end')];
// Two complete matching scans of one record.
const twoMatchingScans = () => [...recordScan(), ...recordScan()];
const flat = (scans) => scans.flat();

const taskOf = (exitCode, imageDigest = IMAGE_DIGEST) => ({ task: { ...structuredClone(task),
  containers: [{ name: 'OneShot', exitCode, imageDigest }] }, definition });

// ---------------------------------------------------------------------------
// Asset validator publication rules
// ---------------------------------------------------------------------------
const assetRuleCases = [
  ['an extra member', (value) => { value.note = 'unexpected'; }, /Invalid service schema asset fields/],
  ['a missing member', (value) => { delete value.minimum_version; }, /Invalid service schema asset fields/],
  ['an unknown schema_version', (value) => { value.schema_version = 2; }, /Unknown service-schema\.json schema/],
  ['an unknown record_type', (value) => { value.record_type = 'anywear_service_schema_v2'; }, /Unknown service-schema\.json schema/],
  ['a non-integer current_version', (value) => { value.current_version = 22.5; }, /Invalid service schema current version/],
  ['a zero minimum_version', (value) => { value.minimum_version = 0; }, /Invalid service schema minimum version/],
  ['minimum above current', (value) => { value.minimum_version = 23; }, /Invalid service schema version range/],
  ['an unknown journal version', (value) => { value.journal.version = '6'; }, /Invalid service schema journal identity/],
  ['an unknown journal dialect', (value) => { value.journal.dialect = 'mysql'; }, /Invalid service schema journal identity/],
  ['a journal/migration length mismatch', (value) => { value.migrations.pop(); }, /differ in length/],
  ['an empty journal', (value) => { value.journal.entries = []; value.migrations = []; }, /differ in length/],
  ['a zero minimum_migration_count', (value) => { value.minimum_migration_count = 0; }, /Invalid service schema minimum migration count/],
  ['a minimum_migration_count above the journal', (value) => { value.minimum_migration_count = 27; }, /minimum migration count exceeds the journal/],
  ['equal versions without the whole journal', (value) => { value.minimum_version = 22; }, /Equal service schema versions must require the whole journal/],
  ['a non-contiguous idx', (value) => { value.journal.entries[3].idx = 4; }, /journal idx is not contiguous/],
  ['an entry version mismatch', (value) => { value.journal.entries[2].version = '6'; }, /journal entry version/],
  ['non-boolean breakpoints', (value) => { value.journal.entries[1].breakpoints = 'yes'; }, /journal breakpoints/],
  ['a zero migration time', (value) => { value.journal.entries[1].when = 0; }, /Invalid service schema migration time/],
  ['a malformed migration tag', (value) => { value.journal.entries[1].tag = 'first_taskmaster'; }, /migration tag/],
  ['a duplicate migration tag', (value) => { value.journal.entries[1].tag = value.journal.entries[0].tag; }, /Duplicate service schema migration tag/],
  ['non-increasing migration times', (value) => { value.journal.entries[2].when = value.journal.entries[1].when; }, /not strictly increasing/],
  ['a migration id misaligned with its tag', (value) => { value.migrations[4].id = '0003_wardrobe_auto_tagging'; }, /does not align with its journal entry/],
  ['a migration idx misaligned', (value) => { value.migrations[4].idx = 5; }, /does not align with its journal entry/],
  ['a migration created_at misaligned', (value) => { value.migrations[4].created_at += 1; }, /does not align with its journal entry/],
  ['a malformed migration hash', (value) => { value.migrations[4].sha256 = 'not-a-hash'; }, /Invalid service schema migration SQL hash/],
];
test('the asset validator refuses every publication rule, an unknown version and more than 256 migrations', () => {
  for (const [label, change, pattern] of assetRuleCases) {
    const value = structuredClone(asset);
    change(value);
    assert.throws(() => validateSchemaAsset(value), pattern, label);
  }
  // The 257-migration bound is the deployment-path read's own limit.
  const wide = {
    schema_version: 1, record_type: 'anywear_service_schema', current_version: 1, minimum_version: 1,
    minimum_migration_count: 257,
    journal: { version: '7', dialect: 'postgresql', entries: Array.from({ length: 257 }, (_, index) => ({
      idx: index, version: '7', when: 1773041075909 + index, tag: `${String(index).padStart(4, '0')}_case`, breakpoints: true })) },
    migrations: Array.from({ length: 257 }, (_, index) => ({
      id: `${String(index).padStart(4, '0')}_case`, idx: index, created_at: 1773041075909 + index,
      sha256: 'a'.repeat(64) })),
  };
  assert.throws(() => validateSchemaAsset(wide), /exceeds 256 migrations/);
  assert.equal(validateSchemaAsset(asset), asset);
});

// ---------------------------------------------------------------------------
// Applied-record validation and the log-evidence read
// ---------------------------------------------------------------------------
test('the applied record validator refuses shape, row-order and journal-presence drift', () => {
  assert.equal(APPLIED_SCHEMA_RECORD_TYPE, 'anywear_applied_schema');
  assert.equal(APPLIED_SCHEMA_RECORD_VERSION, 1);
  assert.equal(APPLIED_SCHEMA_MAX_ROWS, 256);
  assert.deepEqual(validateAppliedSchemaRecord(live), live);
  const cases = [
    ['an extra member', (value) => { value.note = 'x'; }, /Invalid applied schema record fields/],
    ['an unknown schema version', (value) => { value.schema_version = 2; }, /Unknown anywear_applied_schema schema/],
    ['an unknown record type', (value) => { value.record_type = 'other'; }, /Unknown anywear_applied_schema schema/],
    ['a fractional applied version', (value) => { value.applied_schema_version = 1.5; }, /Invalid applied schema version/],
    ['a negative applied version', (value) => { value.applied_schema_version = -1; }, /Invalid applied schema version/],
    ['a non-boolean table presence', (value) => { value.journal_table_present = 'yes'; }, /journal presence/],
    ['a zero local journal length', (value) => { value.local_journal_length = 0; }, /local journal length/],
    ['more than 256 rows', (value) => {
      value.applied = Array.from({ length: 257 }, (_, index) => appliedRow(index + 1,
        `${String(index).padStart(4, '0')}_case`, 1773041075909 + index, 'a'.repeat(64)));
    }, /at most 256 are read/],
    ['an extra row member', (value) => { value.applied[0].note = 'x'; }, /Invalid applied schema row 0 fields/],
    ['a zero row id', (value) => { value.applied[0].id = 0; }, /Invalid applied schema row id/],
    ['a malformed row hash', (value) => { value.applied[0].hash = 'abc'; }, /Invalid applied schema row hash/],
    ['a negative row creation time', (value) => { value.applied[0].created_at = -1; }, /Invalid applied schema row creation time/],
    ['a malformed row tag', (value) => { value.applied[0].tag = 'not a tag'; }, /Invalid applied schema row tag/],
    ['a duplicate row id', (value) => { value.applied[1].id = value.applied[0].id; }, /strictly increasing id order/],
    ['an out-of-order row id', (value) => {
      const [first, second] = value.applied; value.applied[0] = second; value.applied[1] = first;
    }, /strictly increasing id order/],
    ['rows under an absent journal table', (value) => { value.journal_table_present = false; }, /absent applied journal table/],
  ];
  for (const [label, change, pattern] of cases) assert.throws(() => validateAppliedSchemaRecord(appliedVariant(change)), pattern, label);
  // A fresh database is a valid record: null version, no table, no rows.
  const fresh = appliedVariant((value) => {
    value.applied_schema_version = null; value.journal_table_present = false;
    value.applied = []; value.local_journal_length = asset.migrations.length;
  });
  assert.deepEqual(validateAppliedSchemaRecord(fresh), fresh);
});

test('the log read proves the stopped verify task and requires two matching complete scans', async () => {
  assert.deepEqual(await readAppliedSchemaLog(logIo(flat(twoMatchingScans())).io, task, definition), live);
  // Exactly one record: a second one is ambiguous, never merged or preferred.
  const duplicate = logIo(flat([recordScan([live, live]), recordScan([live])]));
  await assert.rejects(readAppliedSchemaLog(duplicate.io, task, definition), /ambiguous/);
  // A record that cannot be parsed is malformed even though the stream is otherwise quiet.
  const malformed = logIo([
    page([`${APPLIED_SCHEMA_RECORD_TYPE} {not json`], 'end'), page([], 'end'), page([], 'end'), page([], 'end')]);
  await assert.rejects(readAppliedSchemaLog(malformed.io, task, definition), /malformed/);
  // Changing evidence fails closed: delayed ingestion is not a licence to accept either view.
  const changed = appliedVariant((value) => { value.applied[0].hash = 'f'.repeat(64); });
  const changing = logIo(flat([recordScan([live]), recordScan([changed])]));
  await assert.rejects(readAppliedSchemaLog(changing.io, task, definition), /changed during readback/);
  // A stream with no marker at all is the pre-reader image case: the whole bounded
  // window is quiet, so the read returns null and the reader rule may fall back once.
  const quiet = logIo(flat([emptyScan(), emptyScan(), emptyScan(), emptyScan(), emptyScan()]));
  assert.equal(await readAppliedSchemaLog(quiet.io, task, definition), null);
});

test('the log read is bounded to 16 pages, 4096 messages, five two-second attempts and a proven pagination', async () => {
  assert.equal(SCHEMA_LOG_MAX_PAGES, 16);
  assert.equal(SCHEMA_LOG_PAGE_LIMIT, 1000);
  assert.equal(SCHEMA_LOG_MAX_MESSAGES, 4096);
  assert.equal(SCHEMA_LOG_MAX_ATTEMPTS, 5);
  assert.equal(SCHEMA_LOG_RETRY_MS, 2000);
  // A pagination that never reaches its terminal token stops at 16 pages.
  let token = 0;
  const endless = logIo([() => ({ events: [], nextForwardToken: `token-${token++}` })]);
  await assert.rejects(readAppliedSchemaLog(endless.io, task, definition), /pagination did not complete/);
  assert.equal(endless.calls.filter((call) => call[0] === 'logs').length, 16);
  // A cycle in the forward tokens is unproven pagination, not a completed scan.
  const cycle = logIo([page([], 'a'), page([], 'b'), page([], 'a')]);
  await assert.rejects(readAppliedSchemaLog(cycle.io, task, definition), /pagination did not complete/);
  // The message inventory is bounded even when every page is well formed.
  token = 0;
  const flood = logIo([() => ({ events: Array.from({ length: 1000 }, () => ({ message: 'noise' })),
    nextForwardToken: `flood-${token++}` })]);
  await assert.rejects(readAppliedSchemaLog(flood.io, task, definition), /inventory exceeds its bound/);
  // A page larger than the reviewed limit is malformed.
  const oversized = logIo([{ events: Array.from({ length: 1001 }, () => ({ message: 'noise' })), nextForwardToken: 'x' }]);
  await assert.rejects(readAppliedSchemaLog(oversized.io, task, definition), /page is malformed/);
  // Delayed ingestion retries on the bounded cadence before a record appears and
  // is then confirmed by a second complete scan; the empty scans are not treated
  // as conflicting evidence.
  const delayed = logIo(flat([emptyScan(), recordScan([live]), recordScan([live])]));
  assert.deepEqual(await readAppliedSchemaLog(delayed.io, task, definition), live);
  assert.deepEqual(delayed.calls.filter((call) => call[0] === 'sleep'),
    [['sleep', 2000], ['sleep', 2000]]);
});

test('the log read refuses a wrong task, definition, command or log destination', async () => {
  const cases = [
    ['a foreign task ARN', () => ({ task: { ...task, taskArn: `arn:aws:ecs:ap-east-1:650880818323:task/other/${taskId}` } })],
    ['a foreign cluster', () => ({ task: { ...task, clusterArn: 'arn:aws:ecs:ap-east-1:650880818323:cluster/other' } })],
    ['a running task', () => ({ task: { ...task, lastStatus: 'RUNNING' } })],
    ['another task definition', () => ({ task: { ...task, taskDefinitionArn: `${definitionArn}:8` } })],
    ['another family', () => ({ definition: { ...definition, family: 'beta-anywear-lifecycle' } })],
    ['another command', () => ({ definition: { ...definition, containerDefinitions: [{
      ...definition.containerDefinitions[0], command: ['node', 'dist/verify.js'] }] } })],
    ['another log driver', () => ({ definition: { ...definition, containerDefinitions: [{
      ...definition.containerDefinitions[0],
      logConfiguration: { ...definition.containerDefinitions[0].logConfiguration, logDriver: 'json-file' } }] } })],
    ['another log group', () => ({ definition: { ...definition, containerDefinitions: [{
      ...definition.containerDefinitions[0],
      logConfiguration: { logDriver: 'awslogs', options: { ...definition.containerDefinitions[0].logConfiguration.options,
        'awslogs-group': '/anywear/beta/worker' } } }] } })],
    ['another region', () => ({ definition: { ...definition, containerDefinitions: [{
      ...definition.containerDefinitions[0],
      logConfiguration: { logDriver: 'awslogs', options: { ...definition.containerDefinitions[0].logConfiguration.options,
        'awslogs-region': 'us-east-1' } } }] } })],
    ['another stream prefix', () => ({ definition: { ...definition, containerDefinitions: [{
      ...definition.containerDefinitions[0],
      logConfiguration: { logDriver: 'awslogs', options: { ...definition.containerDefinitions[0].logConfiguration.options,
        'awslogs-stream-prefix': 'other' } } }] } })],
  ];
  for (const [label, change] of cases) {
    const { task: wrongTask, definition: wrongDefinition } = { task, definition, ...change() };
    const io = logIo(flat(recordScan()));
    await assert.rejects(readAppliedSchemaLog(io.io, wrongTask, wrongDefinition),
      /Exact stopped schema-journal task\/log destination is unproven/, label);
  }
});

// ---------------------------------------------------------------------------
// Reader rule
// ---------------------------------------------------------------------------
test('the reader rule reads the selected image first, falls back exactly once and never after a non-zero exit', async () => {
  const launches = [];
  const probeFor = (results) => async (io, revision) => {
    launches.push(revision);
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  // 1. The selected image reports the journal: no fallback.
  let calls = 0;
  let evidence = await readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor([taskOf(0)]),
    readLog: async () => { calls += 1; return live; } });
  assert.equal(evidence.reader.source, 'selected-image');
  assert.deepEqual(evidence.reader, { source: 'selected-image', service_sha: SERVICE_SHA, image_digest: IMAGE_DIGEST });
  assert.equal(calls, 1);
  assert.equal(launches.length, 1);
  // 2. The selected image exits 0 without a marker: one deployed-image probe.
  launches.length = 0;
  const results = [taskOf(0), taskOf(0, deployedRevision.imageDigest)];
  const logs = [null, live];
  evidence = await readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor(results), readLog: async () => logs.shift() });
  assert.equal(evidence.reader.source, 'deployed-image');
  assert.deepEqual(evidence.reader, { source: 'deployed-image',
    service_sha: deployedRevision.serviceCommit, image_digest: deployedRevision.imageDigest });
  assert.equal(evidence.readers.length, 2);
  assert.deepEqual(evidence.readers.map((entry) => [entry.source, entry.service_sha]),
    [['selected-image', SERVICE_SHA], ['deployed-image', deployedRevision.serviceCommit]]);
  assert.equal(launches.length, 2);
  // 3. A non-zero selected exit is a hard refusal: no second launch, no fallback.
  launches.length = 0;
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor([taskOf(3)]), readLog: async () => { throw new Error('no log read after a refusal'); } }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'reader-failed'
    && error.violations[0].observed === 'exit code 3');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].digest, IMAGE_DIGEST);
  // 4. Exit 0 with no marker and no deployed revision is unavailable.
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release,
    probe: probeFor([taskOf(0)]), readLog: async () => null }),
  (error) => error.reason === 'reader-unavailable');
  // 5. The fallback exits 0 without a marker: unavailable, not a third launch.
  launches.length = 0;
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor([taskOf(0), taskOf(0, deployedRevision.imageDigest)]), readLog: async () => null }),
  (error) => error.reason === 'reader-unavailable' && error.evidence.readers.length === 2);
  assert.equal(launches.length, 2);
  // 6. The fallback exits on an unassigned code: the residual reader-failed with
  // the fallback identity and the code. (Exit 9 now names
  // reader-credential-refused, so the reader rule's residual case uses a code
  // outside the assigned 3-11 contract.)
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor([taskOf(0), taskOf(13, deployedRevision.imageDigest)]), readLog: async () => null }),
  (error) => error.reason === 'reader-failed' && error.evidence.reader.source === 'deployed-image'
    && error.violations[0].observed === 'exit code 13'
    && /the deployed-image verify task exited 13/.test(error.message)
    && /no class/.test(error.message));
  // 7. A task that reports another image is not the revision the gate asked for.
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async () => taskOf(0, `sha256:${'9'.repeat(64)}`), readLog: async () => live }),
  (error) => error.reason === 'reader-failed' && /image digest differs/.test(error.message));
  // 8. Log evidence that is unusable after exit 0 does not trigger a fallback.
  launches.length = 0;
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: probeFor([taskOf(0)]), readLog: async () => { throw new Error('ambiguous'); } }),
  (error) => error.reason === 'reader-evidence-unavailable');
  assert.equal(launches.length, 1);
  // 9. A launch failure that is not a named refusal becomes reader-failed.
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async () => { throw new Error('one-shot execution failed'); }, readLog: async () => live }),
  (error) => error.reason === 'reader-failed' && /could not be launched/.test(error.message));
  // 10. The probe primitive is the verify action and needs the operation's probe.
  assert.ok(Object.isFrozen(SCHEMA_READER_SOURCES));
  assert.deepEqual([...SCHEMA_READER_SOURCES], ['selected-image', 'deployed-image']);
  const probed = [];
  await probeAppliedSchema({ async oneShotProbe(role, revision, argument) {
    probed.push([role, revision, argument]);
    return taskOf(0);
  } }, { commit: SERVICE_SHA, digest: IMAGE_DIGEST });
  assert.deepEqual(probed, [['verify', { commit: SERVICE_SHA, digest: IMAGE_DIGEST }, SCHEMA_JOURNAL_ACTION]]);
  await assert.rejects(probeAppliedSchema({}, { commit: SERVICE_SHA, digest: IMAGE_DIGEST }),
    (error) => error instanceof SchemaBoundaryError && error.reason === 'reader-unavailable');
});

// Issue #252: the verify one-shot's exit 4 is a `schema-journal` connect timeout
// (`CONNECT_TIMEOUT`), not a schema-boundary disagreement. The selected image is
// judged first, so the refusal happens before any journal read or fallback.
test('the selected image exiting 4 refuses as reader-connect-timeout before any journal read', async () => {
  assert.equal(SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT, 4);
  const launches = [];
  let logReads = 0;
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async (io, revision) => { launches.push(revision); return taskOf(SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT); },
    readLog: async () => { logReads += 1; return live; } }),
  (error) => error instanceof SchemaBoundaryError
    && error.reason === 'reader-connect-timeout'
    && error.evidence.reader.source === 'selected-image'
    && error.evidence.reader.service_sha === SERVICE_SHA
    && error.evidence.reader.image_digest === IMAGE_DIGEST
    && error.evidence.reader.exit_code === SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT
    && error.evidence.applied_rows.length === 0
    && error.violations.length === 1
    && error.violations[0].reason === 'reader-connect-timeout'
    && error.violations[0].observed === `exit code ${SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT} / CONNECT_TIMEOUT`
    && /connect timeout/i.test(error.message)
    && /did not answer in time/i.test(error.message)
    && /dispatch the run again/i.test(error.message)
    && /not a schema-boundary disagreement/i.test(error.message));
  assert.equal(launches.length, 1);
  assert.deepEqual(launches.map((revision) => revision.digest), [IMAGE_DIGEST]);
  assert.equal(logReads, 0);
});

// Issue #252: the one deployed-image fallback can time out too. Its refusal names
// the deployed reader, keeps the existing reader shape and still reads no log.
test('the deployed-image fallback exiting 4 refuses as reader-connect-timeout with the fallback identity', async () => {
  const launches = [];
  const logReads = [];
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async (io, revision) => {
      launches.push(revision);
      return launches.length === 1 ? taskOf(0)
        : taskOf(SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT, deployedRevision.imageDigest);
    },
    readLog: async (io, taskArg) => { logReads.push(taskArg); return null; } }),
  (error) => error instanceof SchemaBoundaryError
    && error.reason === 'reader-connect-timeout'
    && error.evidence.reader.source === 'deployed-image'
    && error.evidence.reader.service_sha === deployedRevision.serviceCommit
    && error.evidence.reader.image_digest === deployedRevision.imageDigest
    && error.evidence.reader.exit_code === SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT
    && error.evidence.applied_rows.length === 0
    && error.evidence.readers.length === 2
    && /connect timeout/i.test(error.message)
    && /did not answer in time/i.test(error.message)
    && /dispatch the run again/i.test(error.message)
    && /not a schema-boundary disagreement/i.test(error.message));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map((revision) => revision.digest),
    [IMAGE_DIGEST, deployedRevision.imageDigest]);
  assert.equal(logReads.length, 1, 'the fallback task log is never read');
  assert.equal(logReads[0].taskArn, task.taskArn, 'the one read is the selected task');
});

// Issue #257: one process exit code per named reader reason, 5-11 beside #252's
// exit 4 and the residual exit 3. The gate, these tests and the runbook contract
// test iterate the one table, so no list is restated.
async function selectedImageRefusal(exitCode, onLogRead = () => {}) {
  const launches = [];
  let raised;
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async (io, revision) => { launches.push(revision); return taskOf(exitCode); },
    readLog: async () => { onLogRead(); return live; } }),
  (error) => { raised = error; return error instanceof SchemaBoundaryError; });
  return { raised, launches };
}

test('the reader exit contract assigns exactly the seven new codes 5-11 beside 3 and 4', () => {
  assert.deepEqual([
    SCHEMA_READER_CONFIGURATION_INVALID_EXIT,
    SCHEMA_READER_SECRET_UNAVAILABLE_EXIT,
    SCHEMA_READER_IMAGE_JOURNAL_INVALID_EXIT,
    SCHEMA_READER_CONNECTION_FAILED_EXIT,
    SCHEMA_READER_CREDENTIAL_REFUSED_EXIT,
    SCHEMA_READER_PRIVILEGE_INSUFFICIENT_EXIT,
    SCHEMA_READER_APPLIED_JOURNAL_INVALID_EXIT,
  ], [5, 6, 7, 8, 9, 10, 11]);
  assert.equal(SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT, 4);
  assert.deepEqual(SCHEMA_READER_EXITS.map((entry) => entry.exit), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(Object.isFrozen(SCHEMA_READER_EXITS));
  assert.ok(SCHEMA_READER_EXITS.every((entry) => Object.isFrozen(entry)));
  assert.deepEqual(SCHEMA_READER_EXITS.map((entry) => entry.reason), [
    'reader-failed', 'reader-connect-timeout', 'reader-configuration-invalid',
    'reader-secret-unavailable', 'reader-image-journal-invalid', 'reader-connection-failed',
    'reader-credential-refused', 'reader-privilege-insufficient', 'reader-applied-journal-invalid']);
  for (const entry of SCHEMA_READER_EXITS) assert.ok(SCHEMA_BOUNDARY_REASONS.includes(entry.reason));
});

for (const refusal of SCHEMA_READER_EXITS.filter((entry) => entry.exit >= 5)) {
  test(`the selected image exiting ${refusal.exit} refuses as ${refusal.reason} with one operator action`, async () => {
    let logReads = 0;
    const { raised, launches } = await selectedImageRefusal(refusal.exit, () => { logReads += 1; });
    assert.equal(raised.reason, refusal.reason);
    assert.equal(raised.evidence.reader.source, 'selected-image');
    assert.equal(raised.evidence.reader.service_sha, SERVICE_SHA);
    assert.equal(raised.evidence.reader.image_digest, IMAGE_DIGEST);
    assert.equal(raised.evidence.reader.exit_code, refusal.exit);
    assert.deepEqual(raised.evidence.applied_rows, []);
    assert.equal(raised.evidence.readers.length, 1);
    assert.equal(raised.violations.length, 1);
    assert.equal(raised.violations[0].reason, refusal.reason);
    assert.equal(raised.violations[0].expected, 'exit code 0 with one anywear_applied_schema record');
    assert.equal(raised.violations[0].observed, `exit code ${refusal.exit}`);
    assert.match(raised.message,
      new RegExp(`^${refusal.reason}: the selected-image verify task exited ${refusal.exit}`));
    assert.ok(raised.message.includes(refusal.part), `the failed part: ${refusal.part}`);
    assert.ok(raised.message.includes('nothing was synthesised or changed'));
    assert.ok(raised.message.includes('a non-zero exit is a hard refusal, never a fallback'));
    // Exactly one action phrase from the closed list, counted across the list.
    const occurrences = SCHEMA_READER_REFUSAL_ACTIONS
      .map((phrase) => raised.message.split(phrase).length - 1)
      .reduce((total, count) => total + count, 0);
    assert.equal(occurrences, 1, 'exactly one action phrase from the closed list');
    assert.equal(raised.message.split(refusal.action).length - 1, 1, refusal.action);
    assert.equal(/timeout/i.test(raised.message), false, 'no named class claims a timeout');
    assert.equal(launches.length, 1);
    assert.equal(logReads, 0);
  });
}

// Issue #257: the one deployed-image fallback carries a named class too, still
// without reading the fallback's log.
test('the deployed-image fallback exiting 6 refuses as reader-secret-unavailable with the fallback identity', async () => {
  const launches = [];
  const logReads = [];
  await assert.rejects(readSchemaBoundaryEvidence({ io: {}, release, deployedRevision,
    probe: async (io, revision) => {
      launches.push(revision);
      return launches.length === 1 ? taskOf(0)
        : taskOf(SCHEMA_READER_SECRET_UNAVAILABLE_EXIT, deployedRevision.imageDigest);
    },
    readLog: async (io, taskArg) => { logReads.push(taskArg); return null; } }),
  (error) => error instanceof SchemaBoundaryError
    && error.reason === 'reader-secret-unavailable'
    && error.evidence.reader.source === 'deployed-image'
    && error.evidence.reader.service_sha === deployedRevision.serviceCommit
    && error.evidence.reader.image_digest === deployedRevision.imageDigest
    && error.evidence.reader.exit_code === SCHEMA_READER_SECRET_UNAVAILABLE_EXIT
    && error.evidence.applied_rows.length === 0
    && error.evidence.readers.length === 2
    && error.violations[0].observed === `exit code ${SCHEMA_READER_SECRET_UNAVAILABLE_EXIT}`
    && /the deployed-image verify task exited 6/.test(error.message)
    && /the database secret could not be read/.test(error.message)
    && /check the secret and the reader permission/.test(error.message)
    && /nothing was synthesised or changed/.test(error.message));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map((revision) => revision.digest),
    [IMAGE_DIGEST, deployedRevision.imageDigest]);
  assert.equal(logReads.length, 1, 'the fallback task log is never read');
  assert.equal(logReads[0].taskArn, task.taskArn, 'the one read is the selected task');
});

// Issue #257: exit 3 is the residual (the image named no class) and an
// unassigned code is the residual with the code printed. Neither admits, falls
// back or retries.
test('the residual reader-failed names no class for exit 3 and prints an unassigned code', async () => {
  for (const [exitCode, expected] of [
    [3, /the image named no class for exit 3/],
    [13, /exit 13 is unassigned and the gate recognises no class for it/],
  ]) {
    let logReads = 0;
    const { raised, launches } = await selectedImageRefusal(exitCode, () => { logReads += 1; });
    assert.equal(raised.reason, 'reader-failed', `exit ${exitCode}`);
    assert.equal(raised.evidence.reader.exit_code, exitCode);
    assert.deepEqual(raised.evidence.applied_rows, []);
    assert.equal(raised.violations.length, 1);
    assert.equal(raised.violations[0].observed, `exit code ${exitCode}`);
    assert.match(raised.message, expected);
    assert.ok(raised.message.includes('a non-zero exit is a hard refusal, never a fallback'));
    assert.ok(raised.message.includes('nothing was synthesised or changed'));
    assert.equal(SCHEMA_READER_REFUSAL_ACTIONS.some((phrase) => raised.message.includes(phrase)), false,
      'the residual carries no bound action phrase');
    assert.equal(launches.length, 1);
    assert.equal(logReads, 0);
  }
});

// Issue #257: the class is carried by the exit code alone, so no refusal path
// reads a CloudWatch stream.
test('no refusal reads a task log: exits 3-11 and an unassigned code all decide before the read', async () => {
  for (const exitCode of [3, 4, 5, 6, 7, 8, 9, 10, 11, 13]) {
    let logReads = 0;
    const { launches } = await selectedImageRefusal(exitCode, () => { logReads += 1; });
    assert.equal(logReads, 0, `exit ${exitCode}`);
    assert.equal(launches.length, 1, `exit ${exitCode}`);
  }
});

test('the closed action list holds exactly seven phrases and no named class claims a timeout', async () => {
  assert.ok(Object.isFrozen(SCHEMA_READER_REFUSAL_ACTIONS));
  assert.equal(SCHEMA_READER_REFUSAL_ACTIONS.length, 7);
  assert.equal(new Set(SCHEMA_READER_REFUSAL_ACTIONS).size, 7);
  // Verbatim and sentence-lowercase: the message never capitalises the phrase.
  for (const phrase of SCHEMA_READER_REFUSAL_ACTIONS) {
    assert.equal(phrase, phrase.trim(), phrase);
    assert.equal(phrase[0], phrase[0].toLowerCase(), phrase);
  }
  const named = SCHEMA_READER_EXITS.filter((entry) => entry.exit >= 5);
  assert.equal(named.length, 7);
  assert.deepEqual(named.map((entry) => entry.action), [...SCHEMA_READER_REFUSAL_ACTIONS]);
  for (const refusal of named) {
    const { raised } = await selectedImageRefusal(refusal.exit);
    assert.equal(/timeout/i.test(raised.message), false, refusal.reason);
  }
  assert.deepEqual(SCHEMA_BOUNDARY_REASONS.filter((reason) => /timeout/i.test(reason)),
    ['reader-connect-timeout']);
});

// ---------------------------------------------------------------------------
// Comparison predicate
// ---------------------------------------------------------------------------
test('the compatible fixture compares to 26 checked entries, no pending tail and the canonical prefix hash', () => {
  const compared = compareSchemaBoundary({ asset, applied: live, reader, assetSha256 });
  assert.deepEqual(compared.violations, []);
  assert.equal(compared.versionAhead, false);
  assert.equal(compared.boundary.result, 'compatible');
  assert.deepEqual(compared.boundary.asset, { sha256: assetSha256, current_version: 22,
    minimum_version: 20, minimum_migration_count: 24, journal_length: 26 });
  assert.deepEqual(compared.boundary.applied, { schema_version: 22, journal_length: 26 });
  assert.deepEqual(compared.boundary.comparison, { checked_entries: 26,
    prefix_sha256: schemaBoundaryPrefixHash(live.applied.map((row) => ({ created_at: row.created_at,
      sha256: row.hash }))), pending_migrations: 0 });
  assert.deepEqual(compared.boundary.reader, { source: 'selected-image', service_sha: SERVICE_SHA,
    image_digest: IMAGE_DIGEST });
});

test('the predicate refuses a below-minimum version, a below-boundary journal and an unproven fresh database', () => {
  const belowVersion = compareSchemaBoundary({ asset, applied: appliedVariant((value) => {
    value.applied_schema_version = 19;
  }), reader, assetSha256 });
  assert.deepEqual(belowVersion.violations.map((entry) => entry.reason), ['below-minimum-version']);
  assert.match(belowVersion.violations[0].expected, /release minimum schema version 20 \(current 22\)/);
  assert.equal(belowVersion.violations[0].observed, 'database schema version 19');
  assert.equal(belowVersion.boundary, null);

  // Applied at the release's minimum version but three migrations short of the
  // migration boundary: versions are labels, the boundary is a count.
  const short = appliedVariant((value) => { value.applied = value.applied.slice(0, 23); });
  const belowCount = compareSchemaBoundary({ asset, applied: short, reader, assetSha256 });
  assert.deepEqual(belowCount.violations.map((entry) => entry.reason), ['below-minimum-migration-count']);
  assert.match(belowCount.violations[0].expected, /at least 24 applied migrations \(release boundary 0023_sudden_the_order\)/);
  assert.match(belowCount.violations[0].observed, /^23 applied migrations \(last 0022_next_marvel_zombies\)$/);

  // The fresh database: no version, no table, no rows. (2)/(3)/(6) all refuse it.
  const fresh = appliedVariant((value) => {
    value.applied_schema_version = null; value.journal_table_present = false;
    value.applied = []; value.local_journal_length = 26;
  });
  const freshCompared = compareSchemaBoundary({ asset, applied: validateAppliedSchemaRecord(fresh), reader, assetSha256 });
  assert.deepEqual(freshCompared.violations.map((entry) => entry.reason),
    ['live-version-unproven', 'below-minimum-migration-count']);
  assert.equal(freshCompared.violations[0].observed, 'no recorded schema version');
  assert.match(freshCompared.violations[0].expected, /release minimum schema version 20/);
  assert.equal(freshCompared.boundary, null);
});

test('the predicate refuses a same-index difference and an equal-length different content journal', () => {
  // Synthetic same-index variant: the database hash at index 5 differs.
  const sameIndex = structuredClone(live);
  sameIndex.applied[5].hash = 'f'.repeat(64);
  const compared = compareSchemaBoundary({ asset, applied: sameIndex, reader, assetSha256 });
  assert.deepEqual(compared.violations.map((entry) => entry.reason), ['journal-entry-differs']);
  const migration = migrations[5];
  assert.match(compared.violations[0].expected,
    new RegExp(`release ${migration.id} created_at ${migration.created_at} sha256 ${migration.sha256}`));
  assert.match(compared.violations[0].observed, /^database 0005_rename_image_urls_to_image_keys created_at 1777714728365 hash f{64}$/);
  // Synthetic equal-length different content: the creation time differs at index 10,
  // so every entry count matches but the journals are not the same journal.
  const different = structuredClone(live);
  different.applied[10].created_at += 1;
  const timeCompared = compareSchemaBoundary({ asset, applied: different, reader, assetSha256 });
  assert.deepEqual(timeCompared.violations.map((entry) => entry.reason), ['journal-entry-differs']);
  assert.match(timeCompared.violations[0].expected, new RegExp(`release ${migrations[10].id}`));
});

test('the predicate refuses an applied journal beyond the release: the #156 defect is explicit', () => {
  // Synthetic ahead variant: the database carries a migration the release never
  // heard of. The old min(selected, applied) predicate reported this compatible.
  const ahead = structuredClone(live);
  ahead.applied.push(appliedRow(27, '0026_newer_fly', ahead.applied.at(-1).created_at + 1000, 'f'.repeat(64)));
  const compared = compareSchemaBoundary({ asset, applied: ahead, reader, assetSha256 });
  assert.deepEqual(compared.violations.map((entry) => entry.reason), ['applied-beyond-release']);
  assert.match(compared.violations[0].expected,
    /release journal ends at 0025_new_human_fly created_at 1792665759751 sha256 c65789fc/);
  assert.match(compared.violations[0].observed, /^database row 27 at index 26 0026_newer_fly created_at 1792665760751 hash f{64}$/);
  assert.equal(compared.boundary, null);

  // Synthetic duplicate variant: an appended duplicate row is also beyond the
  // release, so it cannot be absorbed by a positional comparison.
  const duplicate = structuredClone(live);
  duplicate.applied.push({ ...duplicate.applied.at(-1) });
  const duplicated = compareSchemaBoundary({ asset, applied: duplicate, reader, assetSha256 });
  assert.deepEqual(duplicated.violations.map((entry) => entry.reason), ['applied-beyond-release']);

  // Synthetic out-of-order variant: swapping two rows changes both same-index
  // contents even though the multiset is unchanged, so nothing is absorbed.
  const reordered = structuredClone(live);
  [reordered.applied[24], reordered.applied[25]] = [reordered.applied[25], reordered.applied[24]];
  const outOfOrder = compareSchemaBoundary({ asset, applied: reordered, reader, assetSha256 });
  assert.deepEqual(outOfOrder.violations.map((entry) => entry.reason),
    ['journal-entry-differs', 'journal-entry-differs']);
  assert.ok(outOfOrder.violations.every((entry) => /0024_fine_justice|0025_new_human_fly/.test(entry.expected)));
});

test('the predicate collects every violation in one refusal and records an ahead version as an observation', () => {
  // Synthetic multi-violation variant: below the minimum version, a differing
  // entry and one applied row the release does not contain, all at once.
  const multi = structuredClone(live);
  multi.applied_schema_version = 19;
  multi.applied[0].hash = 'f'.repeat(64);
  multi.applied.push(appliedRow(27, '0026_newer_fly', multi.applied.at(-1).created_at + 1000, 'e'.repeat(64)));
  const compared = compareSchemaBoundary({ asset, applied: multi, reader, assetSha256 });
  assert.deepEqual(compared.violations.map((entry) => entry.reason),
    ['below-minimum-version', 'journal-entry-differs', 'applied-beyond-release']);
  for (const entry of compared.violations) {
    assert.equal(typeof entry.expected, 'string');
    assert.equal(typeof entry.observed, 'string');
    assert.ok(entry.expected.length > 0 && entry.observed.length > 0, entry.reason);
  }
  // Issue #257: the inventory is closed at seventeen — the ten on main at the
  // branch point plus the seven named reader classes, none added, removed or
  // renamed.
  assert.equal(new Set(SCHEMA_BOUNDARY_REASONS).size, 17);
  assert.deepEqual([...SCHEMA_BOUNDARY_REASONS], [
    'asset-invalid',
    'reader-unavailable',
    'reader-failed',
    'reader-connect-timeout',
    'reader-configuration-invalid',
    'reader-secret-unavailable',
    'reader-image-journal-invalid',
    'reader-connection-failed',
    'reader-credential-refused',
    'reader-privilege-insufficient',
    'reader-applied-journal-invalid',
    'reader-evidence-unavailable',
    'live-version-unproven',
    'below-minimum-version',
    'journal-entry-differs',
    'applied-beyond-release',
    'below-minimum-migration-count',
  ]);
  assert.ok(SCHEMA_BOUNDARY_REASONS.includes('reader-connect-timeout'));

  // A version ahead of the release with a contained journal is an observation:
  // compatible, recorded as `version_ahead`, never a separate refusal.
  const ahead = appliedVariant((value) => { value.applied_schema_version = 23; });
  const aheadCompared = compareSchemaBoundary({ asset, applied: ahead, reader, assetSha256 });
  assert.deepEqual(aheadCompared.violations, []);
  assert.equal(aheadCompared.versionAhead, true);
  assert.equal(aheadCompared.boundary.applied.schema_version, 23);

  // The allowed shortfall records its pending tail.
  const pending = appliedVariant((value) => { value.applied = value.applied.slice(0, 24); });
  const pendingCompared = compareSchemaBoundary({ asset, applied: pending, reader, assetSha256 });
  assert.deepEqual(pendingCompared.violations, []);
  assert.equal(pendingCompared.boundary.comparison.checked_entries, 24);
  assert.equal(pendingCompared.boundary.comparison.pending_migrations, 2);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Gate runner
// ---------------------------------------------------------------------------
function gateProbe(results) {
  return async () => results.shift();
}

test('the gate refuses an invalid travelled asset before any AWS call', async () => {
  // The loader itself already refuses an invalid asset; the injected validator
  // proves the runner refuses before any AWS read or task launch.
  const directory = await assetDirectory();
  let awsCalls = 0;
  let launched = 0;
  await assert.rejects(runSchemaBoundaryGate({ io: { async aws() { awsCalls += 1; } }, env: {}, release,
    deployedRevision, directory,
    assetValidator: () => { throw new Error('asset content refused by the consumer'); },
    probe: async () => { launched += 1; } }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'asset-invalid'
    && /refused before any AWS call/.test(error.message)
    && (error.evidence.reader === null && error.evidence.applied_rows.length === 0));
  assert.equal(awsCalls, 0);
  assert.equal(launched, 0);
  // An actually invalid travelled asset (its minimum cannot exceed its current
  // version) refuses through the loader.
  const invalid = await assetDirectory(Buffer.from(
    `${JSON.stringify({ ...asset, minimum_version: 23 })}\n`));
  await assert.rejects(runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision,
    directory: invalid }), (error) => error.reason === 'asset-invalid');
  // A missing travelled file is the same refusal.
  const empty = await mkdtemp(path.join(os.tmpdir(), 'schema-gate-empty-'));
  directories.push(empty);
  await assert.rejects(runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision,
    directory: empty }), (error) => error.reason === 'asset-invalid');
});

test('a compatible gate returns the boundary body it proved', async () => {
  const directory = await assetDirectory();
  const boundary = await runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision, directory,
    probe: gateProbe([taskOf(0)]), readLog: async () => live });
  assert.equal(boundary.result, 'compatible');
  assert.equal(boundary.comparison.checked_entries, 26);
  assert.equal(boundary.comparison.pending_migrations, 0);
  assert.equal(boundary.asset.sha256, assetSha256);
  assert.equal(boundary.reader.service_sha, SERVICE_SHA);
  assert.deepEqual(boundary.applied, { schema_version: 22, journal_length: 26 });
});

test('a comparison refusal names the rows, both sides and the violation list and throws the named error', async () => {
  const directory = await assetDirectory();
  const ahead = structuredClone(live);
  ahead.applied.push(appliedRow(27, '0026_newer_fly', ahead.applied.at(-1).created_at + 1000, 'f'.repeat(64)));
  await assert.rejects(runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision, directory,
    probe: gateProbe([taskOf(0)]), readLog: async () => ahead }),
  (error) => error instanceof SchemaBoundaryError && error.reason === 'applied-beyond-release'
    && error.violations.length === 1 && /0025_new_human_fly/.test(error.message)
    && /expected .*0025_new_human_fly/.test(error.message) && /observed .*0026_newer_fly/.test(error.message)
    && error.evidence.applied_rows.length === 27
    && error.evidence.reader.source === 'selected-image'
    && error.evidence.readers[0].task_arn === task.taskArn);
});

test('a reader failure names the exit code and reader identity and never falls back', async () => {
  const directory = await assetDirectory();
  const launches = [];
  await assert.rejects(runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision, directory,
    probe: async (io, revision) => { launches.push(revision); return taskOf(3); },
    readLog: async () => { throw new Error('no log read after a refusal'); } }),
  (error) => error.reason === 'reader-failed'
    && error.evidence.readers[0].exit_code === 3
    && error.evidence.reader.source === 'selected-image'
    && error.evidence.applied_rows.length === 0);
  assert.equal(launches.length, 1);
});

test('the fallback read admits the deployed-image reader and returns its boundary', async () => {
  const directory = await assetDirectory();
  const logs = [null, live];
  const deployedTask = { ...task, containers: [{ name: 'OneShot', exitCode: 0,
    imageDigest: deployedRevision.imageDigest }] };
  const boundary = await runSchemaBoundaryGate({ io: {}, env: {}, release, deployedRevision, directory,
    probe: gateProbe([taskOf(0), { task: deployedTask, definition }]), readLog: async () => logs.shift() });
  assert.equal(boundary.result, 'compatible');
  assert.equal(boundary.reader.source, 'deployed-image');
  assert.equal(boundary.reader.service_sha, deployedRevision.serviceCommit);
  assert.equal(boundary.reader.image_digest, deployedRevision.imageDigest);
});

// ---------------------------------------------------------------------------
// The one-shot task script's verify action
// ---------------------------------------------------------------------------
test('run-one-shot-task.sh validates the verify action and appends it to the container command', async () => {
  const script = await readFile(new URL('../../.github/scripts/run-one-shot-task.sh', import.meta.url), 'utf8');
  // The fifth argument for role=verify is either the existing https VERIFY_API_URL
  // or the exact schema-journal action; anything else refuses before registration.
  assert.match(script, /elif \[\[ "\$role" == "verify" \]\]/);
  assert.match(script, /"\$verify_api_url" == "schema-journal"/);
  assert.match(script, /"\$verify_api_url" =~ \^https:\/\/\[\^\[:space:\]\]\+\$/);
  // The action becomes the third command argument and does not become VERIFY_API_URL.
  assert.match(script, /if \$role == "verify" and \$action == "schema-journal" then \["schema-journal"\]/);
  assert.match(script, /if \$role == "verify" and \$api != "" and \$api != "schema-journal"/);
  assert.equal(canonicalJson([...SCHEMA_VERIFY_COMMAND]), canonicalJson(['node', 'dist/verify.js', 'schema-journal']));
});

// ---------------------------------------------------------------------------
// The Beta runbook contract (#257)
// ---------------------------------------------------------------------------
test('the Beta runbook lists every boundary reason and the reader rule names all nine exit-coded reasons', () => {
  const markdown = readFileSync(new URL('../../docs/runbooks/beta-infrastructure.md', import.meta.url), 'utf8');
  const lines = markdown.split('\n');
  // The operation row is found by its lead-in, never by a line number.
  const operationRow = lines.find((line) => line.startsWith('| `deploy-runtime` / `stop-runtime` |'));
  assert.ok(operationRow, 'the deploy-runtime / stop-runtime operation row');
  for (const reason of SCHEMA_BOUNDARY_REASONS) {
    assert.ok(operationRow.includes(`\`${reason}\``), `the reason list names ${reason}`);
  }
  // The reader rule is found by its lead-in and runs to the next bullet. Its
  // range shifts as the section grows, so no line range appears here.
  const start = lines.findIndex((line) => line.includes('**The reader rule.**'));
  assert.ok(start >= 0, 'the reader rule bullet');
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('- **')) end += 1;
  const paragraph = lines.slice(start, end).join('\n');
  for (const refusal of SCHEMA_READER_EXITS) {
    assert.ok(paragraph.includes(`| ${refusal.exit} | \`${refusal.reason}\` |`),
      `the reader rule names exit ${refusal.exit} as ${refusal.reason}`);
  }
  // The rule keeps its invariants: a non-zero exit is never retried on another
  // image, exit 4 is the connect timeout, it is one bounded read under the
  // existing verification-task role with no task-definition change, at most two
  // launches happen, and the waiter's 600-second envelope stays.
  assert.match(paragraph, /never retried on another image/);
  assert.match(paragraph, /connect timeout/i);
  assert.match(paragraph, /existing verification-task role/);
  assert.match(paragraph, /no\s+task-definition change/);
  assert.match(paragraph, /At most two one-shot launches/);
  assert.match(paragraph, /600 seconds/);
});
