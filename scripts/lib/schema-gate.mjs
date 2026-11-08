import { canonicalJson, parseJson, sha256, exact, matches, integer, HASH, SHA, DIGEST } from './json-contract.mjs';
import {
  SCHEMA_ASSET_NAME,
  SCHEMA_MIGRATION_TAG,
  loadSchemaAsset,
  schemaAssetSummary,
  validateSchemaAsset,
} from './schema-asset.mjs';
import { SELECTED_RELEASE_DIRECTORY } from './release-inputs.mjs';

// The pre-mutation schema-boundary gate (#194).
//
// `deploy-runtime` reads the sealed artifact's `service-schema.json` and the live
// applied Drizzle journal before it synthesises or changes anything. The live
// read is one bounded, read-only `schema-journal` one-shot from the existing
// `verify` task family; its single canonical-JSON record is read back from the
// authenticated stopped task's CloudWatch stream. The comparison refuses a
// database below the release minimum, a journal that differs at a shared index,
// and a database carrying a migration the release does not contain (the #156
// defect). Every refusal names both sides and leaves the stack untouched.
//
// The gate is dependency-injected (`loadAsset`/`probe`/`readLog`/`compare`) so
// every branch is credential-free testable. Its verdict is one `schema-boundary`
// line in the run log and the step's own conclusion; no record carries it (#207).

export const APPLIED_SCHEMA_RECORD_TYPE = 'anywear_applied_schema';
export const APPLIED_SCHEMA_RECORD_VERSION = 1;
export const APPLIED_SCHEMA_MAX_ROWS = 256;
export const SCHEMA_JOURNAL_ACTION = 'schema-journal';
export const SCHEMA_BOUNDARY_EVENT = 'schema-boundary';
// The two reader identities. `selected-image` is the release under test;
// `deployed-image` is the one bounded fallback when the release image predates
// the `schema-journal` reader. They are the gate's own vocabulary since #207: the
// comparison is no longer a cross-repository record member.
export const SCHEMA_READER_SOURCES = Object.freeze(['selected-image', 'deployed-image']);

// The admitted comparison body the gate builds and validates before it lets the
// deployment proceed. It is logged (and refused by name) rather than written to a
// record, so the shape is owned here instead of in the versioned package.
export const SCHEMA_BOUNDARY_FIELDS = Object.freeze(
  ['result', 'asset', 'applied', 'comparison', 'reader']);
export const SCHEMA_BOUNDARY_ASSET_FIELDS = Object.freeze(
  ['sha256', 'current_version', 'minimum_version', 'minimum_migration_count', 'journal_length']);
export const SCHEMA_BOUNDARY_APPLIED_FIELDS = Object.freeze(['schema_version', 'journal_length']);
export const SCHEMA_BOUNDARY_COMPARISON_FIELDS = Object.freeze(
  ['checked_entries', 'prefix_sha256', 'pending_migrations']);
export const SCHEMA_BOUNDARY_READER_FIELDS = Object.freeze(['source', 'service_sha', 'image_digest']);
// A gate admits one comparison only.
export const SCHEMA_BOUNDARY_RESULTS = Object.freeze(['compatible']);

/**
 * The canonical hash of the compared `{ created_at, sha256 }` prefix.
 *
 * `entries` are the compared release/live pairs in journal order, each with the
 * migration creation time (the Drizzle journal `when`) and the 64-hex
 * `sha256(<drizzle/<tag>.sql bytes>)`. A caller passes the first `checked_entries`
 * pairs, so the hash identifies exactly what was compared and not the pending
 * tail.
 */
export function schemaBoundaryPrefixHash(entries) {
  if (!Array.isArray(entries) || entries.length > 256) throw new Error('Invalid schema boundary prefix');
  const prefix = entries.map((entry) => {
    exact(entry, ['created_at', 'sha256'], 'schema boundary prefix entry');
    return {
      created_at: integer(entry.created_at, 'schema boundary prefix migration time', 0),
      sha256: matches(entry.sha256, HASH, 'schema boundary prefix migration hash'),
    };
  });
  return sha256(canonicalJson(prefix));
}

function validateSchemaBoundaryAsset(asset) {
  exact(asset, SCHEMA_BOUNDARY_ASSET_FIELDS, 'schema boundary asset');
  matches(asset.sha256, HASH, 'schema boundary asset digest');
  integer(asset.current_version, 'schema boundary current version');
  integer(asset.minimum_version, 'schema boundary minimum version');
  integer(asset.minimum_migration_count, 'schema boundary minimum migration count');
  integer(asset.journal_length, 'schema boundary journal length');
  if (asset.minimum_version > asset.current_version) throw new Error('Invalid schema boundary version range');
  if (asset.minimum_migration_count > asset.journal_length) {
    throw new Error('Schema boundary minimum migration count exceeds the release journal');
  }
  // Equal versions mean the release supports its whole journal: a minimum equal
  // to the current version cannot exclude a migration the release itself applies.
  if (asset.current_version === asset.minimum_version
    && asset.minimum_migration_count !== asset.journal_length) {
    throw new Error('Equal schema boundary versions must require the whole release journal');
  }
  return asset;
}

function validateSchemaBoundaryApplied(applied, asset) {
  exact(applied, SCHEMA_BOUNDARY_APPLIED_FIELDS, 'schema boundary applied');
  integer(applied.schema_version, 'schema boundary applied version', 0);
  integer(applied.journal_length, 'schema boundary applied journal length', 0);
  if (applied.schema_version < asset.minimum_version) {
    throw new Error('Schema boundary applied version is below the release minimum');
  }
  if (applied.journal_length > asset.journal_length) {
    throw new Error('Schema boundary applied journal is longer than the release journal');
  }
  return applied;
}

function validateSchemaBoundaryComparison(comparison, asset, applied) {
  exact(comparison, SCHEMA_BOUNDARY_COMPARISON_FIELDS, 'schema boundary comparison');
  integer(comparison.checked_entries, 'schema boundary checked entries', 0);
  integer(comparison.pending_migrations, 'schema boundary pending migrations', 0);
  matches(comparison.prefix_sha256, HASH, 'schema boundary prefix hash');
  if (comparison.checked_entries !== applied.journal_length) {
    throw new Error('Schema boundary checked entries differ from the applied journal length');
  }
  if (comparison.checked_entries > asset.journal_length) {
    throw new Error('Schema boundary checked entries exceed the release journal');
  }
  if (comparison.pending_migrations !== asset.journal_length - comparison.checked_entries) {
    throw new Error('Schema boundary pending migrations differ from the release journal tail');
  }
  if (comparison.checked_entries < asset.minimum_migration_count) {
    throw new Error('Schema boundary checked entries are below the minimum migration count');
  }
  return comparison;
}

function validateSchemaBoundaryReader(reader) {
  exact(reader, SCHEMA_BOUNDARY_READER_FIELDS, 'schema boundary reader');
  if (!SCHEMA_READER_SOURCES.includes(reader.source)) throw new Error('Invalid schema boundary reader source');
  matches(reader.service_sha, SHA, 'schema boundary reader Service');
  matches(reader.image_digest, DIGEST, 'schema boundary reader image');
  return reader;
}

/**
 * Validate one admitted comparison before the gate trusts it.
 *
 * Every relation the gate can prove is checked: the exact member sets, the
 * admitted result, the version/count range, the journal/prefix arithmetic and the
 * reader identity.
 */
export function validateSchemaBoundary(boundary) {
  exact(boundary, SCHEMA_BOUNDARY_FIELDS, 'schema boundary');
  if (!SCHEMA_BOUNDARY_RESULTS.includes(boundary.result)) throw new Error('Invalid schema boundary result');
  const asset = validateSchemaBoundaryAsset(boundary.asset);
  const applied = validateSchemaBoundaryApplied(boundary.applied, asset);
  validateSchemaBoundaryComparison(boundary.comparison, asset, applied);
  validateSchemaBoundaryReader(boundary.reader);
  return boundary;
}

// The existing verification one-shot family and the exact command the verify
// action registers. The stopped task identity, its log destination and its
// command are all proven before a log read. The class of a failed
// `schema-journal` read travels on the process exit code alone: the gate reads
// no CloudWatch stream on a non-zero exit, so one code names one reason and one
// operator action. `3` is the residual (`reader-failed`, no class named), `4` is
// #252's connect timeout (`CONNECT_TIMEOUT`), and `5`-`11` are the classes the
// Service action proves (#257). Nothing outside `3`-`11` is assigned.
export const SCHEMA_VERIFY_FAMILY = 'beta-anywear-verify';
export const SCHEMA_VERIFY_COMMAND = Object.freeze(['node', 'dist/verify.js', SCHEMA_JOURNAL_ACTION]);
export const SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT = 4;
export const SCHEMA_READER_CONFIGURATION_INVALID_EXIT = 5;
export const SCHEMA_READER_SECRET_UNAVAILABLE_EXIT = 6;
export const SCHEMA_READER_IMAGE_JOURNAL_INVALID_EXIT = 7;
export const SCHEMA_READER_CONNECTION_FAILED_EXIT = 8;
export const SCHEMA_READER_CREDENTIAL_REFUSED_EXIT = 9;
export const SCHEMA_READER_PRIVILEGE_INSUFFICIENT_EXIT = 10;
export const SCHEMA_READER_APPLIED_JOURNAL_INVALID_EXIT = 11;
export const ONE_SHOT_CLUSTER = 'beta-anywear';
export const ONE_SHOT_LOG_GROUP = '/anywear/beta/one-shot';
export const ONE_SHOT_REGION = 'ap-east-1';

// The bounded log read: 16 pages x 1000 events, 4096 messages, five attempts
// two seconds apart, and two complete matching scans before evidence is trusted.
export const SCHEMA_LOG_MAX_PAGES = 16;
export const SCHEMA_LOG_PAGE_LIMIT = 1000;
export const SCHEMA_LOG_MAX_MESSAGES = 4096;
export const SCHEMA_LOG_MAX_ATTEMPTS = 5;
export const SCHEMA_LOG_RETRY_MS = 2000;
export const SCHEMA_LOG_TOKEN_LIMIT = 4096;

export const SCHEMA_BOUNDARY_REASONS = Object.freeze([
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

// The closed operator-action list for exits 5-11 (#257): every named reader
// message carries exactly one of these phrases verbatim, never sentence-
// capitalised.
export const SCHEMA_READER_REFUSAL_ACTIONS = Object.freeze([
  "correct the task's database inputs",
  'check the secret and the reader permission',
  'fix the release',
  'dispatch the run again',
  'correct the username or password',
  'restore the SELECT grants',
  'inspect the Beta database',
]);

// One row per exit-coded reader refusal, in exit order. It is the single source
// the gate, its tests and the Beta runbook contract test read: `part` is the
// failed part a message names and `action` is the one operator action it gives.
// Exit 4 keeps its own byte-identical message in `refuseProbeExit`; the 5-11
// rows build theirs, and the residual row documents the branch exit 3 shares
// with every unrecognised code. No row claims a timeout outside exit 4.
export const SCHEMA_READER_EXITS = Object.freeze([
  Object.freeze({ exit: 3, reason: 'reader-failed',
    part: 'the image named no class for exit 3', action: 'open the task stream' }),
  Object.freeze({ exit: SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT, reason: 'reader-connect-timeout',
    part: 'the database did not answer in time', action: 'dispatch the run again' }),
  Object.freeze({ exit: SCHEMA_READER_CONFIGURATION_INVALID_EXIT, reason: 'reader-configuration-invalid',
    part: "the task's database inputs are missing or malformed",
    action: "correct the task's database inputs" }),
  Object.freeze({ exit: SCHEMA_READER_SECRET_UNAVAILABLE_EXIT, reason: 'reader-secret-unavailable',
    part: 'the database secret could not be read',
    action: 'check the secret and the reader permission' }),
  Object.freeze({ exit: SCHEMA_READER_IMAGE_JOURNAL_INVALID_EXIT, reason: 'reader-image-journal-invalid',
    part: "the image's own drizzle/ migration journal is missing or malformed",
    action: 'fix the release' }),
  Object.freeze({ exit: SCHEMA_READER_CONNECTION_FAILED_EXIT, reason: 'reader-connection-failed',
    part: 'the database session did not open or the read did not complete',
    action: 'dispatch the run again' }),
  Object.freeze({ exit: SCHEMA_READER_CREDENTIAL_REFUSED_EXIT, reason: 'reader-credential-refused',
    part: 'the database server refused the login',
    action: 'correct the username or password' }),
  Object.freeze({ exit: SCHEMA_READER_PRIVILEGE_INSUFFICIENT_EXIT, reason: 'reader-privilege-insufficient',
    part: 'the login succeeded and the read was denied',
    action: 'restore the SELECT grants' }),
  Object.freeze({ exit: SCHEMA_READER_APPLIED_JOURNAL_INVALID_EXIT, reason: 'reader-applied-journal-invalid',
    part: 'the database answered with an invalid applied journal',
    action: 'inspect the Beta database' }),
]);

const APPLIED_SCHEMA_FIELDS = Object.freeze(['schema_version', 'record_type', 'applied_schema_version',
  'journal_table_present', 'applied', 'local_journal_length']);
const APPLIED_SCHEMA_ROW_FIELDS = Object.freeze(['id', 'hash', 'created_at', 'tag']);

const violation = (reason, expected, observed) => ({ reason, expected, observed });
const describeViolations = (violations) => violations
  .map((entry) => `${entry.reason}: expected ${entry.expected}; observed ${entry.observed}`).join('; ');

/** The named, fail-closed refusal of the schema-boundary gate. */
export class SchemaBoundaryError extends Error {
  /**
   * @param {string} reason one of {@link SCHEMA_BOUNDARY_REASONS}
   * @param {string} detail a message that names the reason and both sides
   * @param {readonly {reason: string, expected: unknown, observed: unknown}[]} violations
   * @param {{reader?: object|null, readers?: object[], applied_rows?: object[]}} evidence
   *   what the gate observed before refusing, so the refusal can name the reader
   *   and task identity even when no boundary body exists
   */
  constructor(reason, detail, violations = [], evidence = {}) {
    super(`${reason}: ${detail}`);
    if (!SCHEMA_BOUNDARY_REASONS.includes(reason)) throw new Error(`Unknown schema boundary reason ${reason}`);
    this.name = 'SchemaBoundaryError';
    this.reason = reason;
    this.violations = violations.map((entry) => ({
      reason: entry.reason, expected: entry.expected, observed: entry.observed }));
    this.evidence = evidence;
  }
}

/**
 * Validate one live `anywear_applied_schema` record.
 *
 * Strict: exact members, one known record version, an integer-or-null applied
 * version, a boolean journal presence, at most 256 ordered applied rows with
 * positive increasing ids, 64-hex SQL hashes, safe-integer creation times and
 * `NNNN_[a-z0-9_]+` tags (or null), and a positive local journal length. An
 * absent journal table cannot carry applied rows.
 */
export function validateAppliedSchemaRecord(record) {
  exact(record, APPLIED_SCHEMA_FIELDS, 'applied schema record');
  if (record.schema_version !== APPLIED_SCHEMA_RECORD_VERSION
    || record.record_type !== APPLIED_SCHEMA_RECORD_TYPE) {
    throw new Error(`Unknown ${APPLIED_SCHEMA_RECORD_TYPE} schema`);
  }
  if (record.applied_schema_version !== null) {
    integer(record.applied_schema_version, 'applied schema version', 0);
  }
  if (typeof record.journal_table_present !== 'boolean') throw new Error('Invalid applied schema journal presence');
  integer(record.local_journal_length, 'applied schema local journal length');
  if (!Array.isArray(record.applied) || record.applied.length > APPLIED_SCHEMA_MAX_ROWS) {
    throw new Error(`Invalid applied schema rows; at most ${APPLIED_SCHEMA_MAX_ROWS} are read`);
  }
  if (!record.journal_table_present && record.applied.length) {
    throw new Error('An absent applied journal table cannot carry applied rows');
  }
  let prior;
  for (const [index, row] of record.applied.entries()) {
    exact(row, APPLIED_SCHEMA_ROW_FIELDS, `applied schema row ${index}`);
    integer(row.id, 'applied schema row id');
    matches(row.hash, HASH, 'applied schema row hash');
    integer(row.created_at, 'applied schema row creation time', 0);
    if (row.tag !== null) matches(row.tag, SCHEMA_MIGRATION_TAG, 'applied schema row tag');
    if (prior !== undefined && !(prior < row.id)) {
      throw new Error('Applied schema rows are not in strictly increasing id order');
    }
    prior = row.id;
  }
  return record;
}

const readerIdentity = (source, revision) => ({
  source, service_sha: revision.commit, image_digest: revision.digest });

/**
 * Read the one `anywear_applied_schema` record from the authenticated stopped
 * verification task's CloudWatch stream.
 *
 * Returns the record, or `null` when two complete matching scans carry no
 * marker (the pre-reader image case). Malformed, ambiguous or changing evidence
 * throws: the caller fails closed as `reader-evidence-unavailable`.
 */
export async function readAppliedSchemaLog(io, task, definition) {
  const taskId = task?.taskArn?.match(/^arn:aws:ecs:ap-east-1:650880818323:task\/beta-anywear\/([a-f0-9]{32})$/)?.[1];
  const container = definition?.containerDefinitions?.find((item) => item.name === 'OneShot');
  const options = container?.logConfiguration?.options;
  if (!taskId || task.clusterArn !== `arn:aws:ecs:${ONE_SHOT_REGION}:650880818323:cluster/${ONE_SHOT_CLUSTER}`
    || task.lastStatus !== 'STOPPED' || task.taskDefinitionArn !== definition?.taskDefinitionArn
    || definition.family !== SCHEMA_VERIFY_FAMILY
    || canonicalJson(container?.command) !== canonicalJson([...SCHEMA_VERIFY_COMMAND])
    || container.logConfiguration.logDriver !== 'awslogs'
    || options?.['awslogs-group'] !== ONE_SHOT_LOG_GROUP
    || options['awslogs-region'] !== ONE_SHOT_REGION
    || options['awslogs-stream-prefix'] !== definition.family) {
    throw new Error('Exact stopped schema-journal task/log destination is unproven');
  }
  const args = ['logs', 'get-log-events', '--log-group-name', options['awslogs-group'],
    '--log-stream-name', `${definition.family}/OneShot/${taskId}`, '--start-from-head',
    '--limit', String(SCHEMA_LOG_PAGE_LIMIT)];
  // Two separate proofs share this loop: a found record must be identical on a
  // second complete scan, and a stream with no marker at all must be quiet for
  // the whole bounded attempt budget before the reader rule may fall back.
  let previous;
  let found = false;
  for (let attempt = 0; attempt < SCHEMA_LOG_MAX_ATTEMPTS; attempt++) {
    let token;
    const seen = new Set();
    const messages = [];
    for (let page = 0; page < SCHEMA_LOG_MAX_PAGES; page++) {
      const response = await io.aws([...args, ...(token ? ['--next-token', token] : [])]);
      if (!Array.isArray(response.events) || response.events.length > SCHEMA_LOG_PAGE_LIMIT
        || response.events.some((event) => typeof event?.message !== 'string')) {
        throw new Error('Schema-journal log page is malformed');
      }
      messages.push(...response.events.map((event) => event.message));
      if (messages.length > SCHEMA_LOG_MAX_MESSAGES) throw new Error('Schema-journal log inventory exceeds its bound');
      const next = response.nextForwardToken;
      if (typeof next !== 'string' || !next || next.length > SCHEMA_LOG_TOKEN_LIMIT) {
        throw new Error('Schema-journal log pagination is unproven');
      }
      if (next === token) break;
      if (seen.has(next) || page === SCHEMA_LOG_MAX_PAGES - 1) {
        throw new Error('Schema-journal log pagination did not complete');
      }
      seen.add(next);
      token = next;
    }
    const records = [];
    for (const message of messages) {
      // The pinned Service prints one JSON object. A line that mentions the
      // record type but cannot be parsed is malformed evidence, never skipped.
      if (!message.includes(APPLIED_SCHEMA_RECORD_TYPE)) continue;
      let value;
      try { value = parseJson(message); } catch { throw new Error('Schema-journal log evidence is malformed'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Schema-journal log evidence is malformed');
      }
      if (value.record_type !== APPLIED_SCHEMA_RECORD_TYPE) continue;
      validateAppliedSchemaRecord(value);
      records.push(value);
    }
    if (records.length > 1) throw new Error('Schema-journal log evidence is ambiguous');
    const current = records.length ? canonicalJson(records[0]) : undefined;
    if (current === undefined) {
      // A complete scan with no marker is a delayed or pre-reader stream, not a
      // conflicting observation: keep reading within the bound.
      previous = undefined;
    } else {
      found = true;
      // Two complete matching scans prove the stream settled after the task
      // stopped; a first partial view is not evidence.
      if (previous === current) return records[0];
      if (previous !== undefined) throw new Error('Schema-journal log evidence changed during readback');
      previous = current;
    }
    if (attempt < SCHEMA_LOG_MAX_ATTEMPTS - 1) await io.sleep(SCHEMA_LOG_RETRY_MS);
  }
  // No marker in the whole bounded window is the pre-reader image case; a
  // marker that never repeated is unconfirmed evidence and fails closed.
  if (found) throw new Error('Unique authenticated schema-journal evidence is unavailable');
  return null;
}

/** Run the one bounded `schema-journal` verify one-shot; the exit code is not judged here. */
export async function probeAppliedSchema(io, revision) {
  if (typeof io?.oneShotProbe !== 'function') {
    throw new SchemaBoundaryError('reader-unavailable', 'the operation has no one-shot probe',
      [violation('reader-unavailable', 'one bounded schema-journal probe', 'io.oneShotProbe is unavailable')],
      { reader: null, readers: [] });
  }
  return io.oneShotProbe('verify', revision, SCHEMA_JOURNAL_ACTION);
}

async function launchProbe({ io, probe, identity, readers }) {
  const source = identity.source;
  let result;
  try {
    result = await probe(io, { commit: identity.service_sha, digest: identity.image_digest });
  } catch (error) {
    if (error instanceof SchemaBoundaryError) throw error;
    throw new SchemaBoundaryError('reader-failed', `the ${source} verify task could not be launched: ${error?.message ?? error}`,
      [violation('reader-failed', 'one stopped verify task with an exit code', String(error?.message ?? error).slice(0, 300))],
      { reader: identity, readers, applied_rows: [] });
  }
  const container = result?.task?.containers?.find((item) => item.name === 'OneShot');
  const exitCode = container?.exitCode;
  const taskArn = result?.task?.taskArn;
  const definitionArn = result?.definition?.taskDefinitionArn;
  const reader = {
    ...identity,
    task_arn: typeof taskArn === 'string' ? taskArn : 'unavailable',
    task_definition_arn: typeof definitionArn === 'string' ? definitionArn : 'unavailable',
    exit_code: Number.isSafeInteger(exitCode) ? exitCode : 'unavailable',
  };
  readers.push(reader);
  if (!Number.isSafeInteger(exitCode) || typeof taskArn !== 'string' || typeof definitionArn !== 'string') {
    throw new SchemaBoundaryError('reader-failed', `the ${source} verify task returned no readable task identity`,
      [violation('reader-failed', 'one stopped verify task with an exit code and identity', 'no readable task result')],
      { reader, readers, applied_rows: [] });
  }
  // The launch is only as good as the image it actually ran: a rollout in flight
  // could otherwise read the journal with an image nobody asked for.
  if (container.imageDigest !== reader.image_digest) {
    throw new SchemaBoundaryError('reader-failed', `the ${source} verify task image digest differs from the requested revision`,
      [violation('reader-failed', `image digest ${reader.image_digest}`, `image digest ${container.imageDigest ?? 'absent'}`)],
      { reader, readers, applied_rows: [] });
  }
  return { reader, result };
}

// The reader rule's one named refusal per exit code (#252, #257). Exit 4 is the
// `schema-journal` action's connect timeout and keeps its message byte-identical.
// Exit 3 and every unrecognised code stay the residual `reader-failed`. Codes
// 5-11 each name one class from the one exit table; every non-zero exit is a
// hard refusal, never a fallback, and the code alone carries the class: no log is
// read on this path.
function refuseProbeExit(source, launched, readers) {
  const { reader } = launched;
  if (reader.exit_code === SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT) {
    throw new SchemaBoundaryError('reader-connect-timeout',
      `the ${source} verify task exited ${SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT} on the schema-journal connect timeout: `
      + 'the database did not answer in time. Dispatch the run again; this is not a schema-boundary disagreement, '
      + 'and nothing was synthesised or changed',
      [violation('reader-connect-timeout', 'exit code 0 with one anywear_applied_schema record',
        `exit code ${SCHEMA_VERIFY_CONNECT_TIMEOUT_EXIT} / CONNECT_TIMEOUT`)],
      { reader, readers, applied_rows: [] });
  }
  const mapped = SCHEMA_READER_EXITS.find((entry) => entry.exit === reader.exit_code);
  if (mapped && mapped.exit >= SCHEMA_READER_CONFIGURATION_INVALID_EXIT) {
    const detail = `the ${source} verify task exited ${mapped.exit}: ${mapped.part}. `
      + `Operator action: ${mapped.action}; nothing was synthesised or changed`
      + (source === 'selected-image' ? '; a non-zero exit is a hard refusal, never a fallback' : '');
    throw new SchemaBoundaryError(mapped.reason, detail,
      [violation(mapped.reason, 'exit code 0 with one anywear_applied_schema record', `exit code ${mapped.exit}`)],
      { reader, readers, applied_rows: [] });
  }
  const residual = mapped
    ? mapped.part
    : `exit ${reader.exit_code} is unassigned and the gate recognises no class for it`;
  const detail = `the ${source} verify task exited ${reader.exit_code}: ${residual}; open the task stream`
    + (source === 'selected-image' ? '; a non-zero exit is a hard refusal, never a fallback' : '')
    + '; nothing was synthesised or changed';
  throw new SchemaBoundaryError('reader-failed', detail,
    [violation('reader-failed', 'exit code 0 with one anywear_applied_schema record',
      `exit code ${reader.exit_code}`)],
    { reader, readers, applied_rows: [] });
}

async function readProbeJournal({ io, readLog, launched, readers, source }) {
  try {
    const applied = await readLog(io, launched.result.task, launched.result.definition);
    return applied;
  } catch (error) {
    if (error instanceof SchemaBoundaryError) throw error;
    throw new SchemaBoundaryError('reader-evidence-unavailable',
      `the ${source} log evidence is unusable: ${error?.message ?? error}`,
      [violation('reader-evidence-unavailable',
        'one complete anywear_applied_schema scan repeated by a second complete scan',
        String(error?.message ?? error).slice(0, 300))],
      { reader: launched.reader, readers, applied_rows: [] });
  }
}

/**
 * Resolve the reader rule: the selected image first, one deployed-image fallback
 * only when the selected image exits 0 without a marker, and never a fallback
 * after a non-zero exit. At most two launches.
 */
export async function readSchemaBoundaryEvidence({ io, release, deployedRevision,
  probe = probeAppliedSchema, readLog = readAppliedSchemaLog } = {}) {
  const releaseRevision = {
    serviceCommit: release?.serviceCommit, imageDigest: release?.imageDigest };
  if (!SHA.test(releaseRevision.serviceCommit ?? '') || !DIGEST.test(releaseRevision.imageDigest ?? '')) {
    throw new SchemaBoundaryError('reader-unavailable', 'the release identity is unreadable',
      [violation('reader-unavailable', 'a sealed artifact Service commit and image digest',
        `commit ${releaseRevision.serviceCommit ?? 'absent'} digest ${releaseRevision.imageDigest ?? 'absent'}`)],
      { reader: null, readers: [], applied_rows: [] });
  }
  const deployed = deployedRevision && SHA.test(deployedRevision.serviceCommit ?? '')
    && DIGEST.test(deployedRevision.imageDigest ?? '') ? deployedRevision : undefined;
  const readers = [];
  const selectedIdentity = { ...readerIdentity('selected-image', {
    commit: releaseRevision.serviceCommit, digest: releaseRevision.imageDigest }) };
  const selected = await launchProbe({ io, probe, identity: selectedIdentity, readers });
  if (selected.reader.exit_code !== 0) refuseProbeExit('selected-image', selected, readers);
  const selectedApplied = await readProbeJournal({ io, readLog, launched: selected, readers, source: 'selected-image' });
  if (selectedApplied !== null) {
    return { reader: readerIdentity('selected-image', {
      commit: releaseRevision.serviceCommit, digest: releaseRevision.imageDigest }),
    applied: selectedApplied, readers };
  }
  if (!deployed) {
    throw new SchemaBoundaryError('reader-unavailable',
      'the selected image exited 0 without an anywear_applied_schema marker and no deployed revision is recorded',
      [violation('reader-unavailable', 'a selected or deployed image that reports the applied journal',
        'the selected image printed no anywear_applied_schema record and no deployed revision was recorded')],
      { reader: selected.reader, readers, applied_rows: [] });
  }
  const deployedIdentity = readerIdentity('deployed-image', {
    commit: deployed.serviceCommit, digest: deployed.imageDigest });
  const fallback = await launchProbe({ io, probe, identity: deployedIdentity, readers });
  if (fallback.reader.exit_code !== 0) refuseProbeExit('deployed-image', fallback, readers);
  const fallbackApplied = await readProbeJournal({ io, readLog, launched: fallback, readers, source: 'deployed-image' });
  if (fallbackApplied === null) {
    throw new SchemaBoundaryError('reader-unavailable',
      'neither the selected nor the deployed image reported the applied journal',
      [violation('reader-unavailable', 'one image that reports the applied journal',
        'both the selected and the deployed image printed no anywear_applied_schema record')],
      { reader: fallback.reader, readers, applied_rows: [] });
  }
  return { reader: deployedIdentity, applied: fallbackApplied, readers };
}

/**
 * The one comparison predicate.
 *
 * Returns `{ boundary, violations, versionAhead }`: every violation in the
 * issue's order with both sides present, and the v6 body only when there are
 * none. `versionAhead` is an observation (the journal comparison is the
 * authoritative one) and is never a separate refusal.
 */
export function compareSchemaBoundary({ asset, applied, reader, assetSha256 }) {
  const migrations = asset.migrations;
  const rows = applied.applied;
  const appliedCount = rows.length;
  const releaseCount = migrations.length;
  const appliedVersion = applied.applied_schema_version;
  const violations = [];
  const releaseRange = `release minimum schema version ${asset.minimum_version} (current ${asset.current_version})`;
  if (appliedVersion === null) {
    violations.push(violation('live-version-unproven', releaseRange, 'no recorded schema version'));
  } else if (appliedVersion < asset.minimum_version) {
    violations.push(violation('below-minimum-version', releaseRange, `database schema version ${appliedVersion}`));
  }
  for (let index = 0; index < Math.min(appliedCount, releaseCount); index++) {
    const migration = migrations[index];
    const row = rows[index];
    if (row?.hash !== migration.sha256 || row?.created_at !== migration.created_at) {
      violations.push(violation('journal-entry-differs',
        `release ${migration.id} created_at ${migration.created_at} sha256 ${migration.sha256}`,
        `database ${row?.tag ?? row?.id ?? 'missing'} created_at ${row?.created_at ?? 'absent'} hash ${row?.hash ?? 'absent'}`));
    }
  }
  if (appliedCount > releaseCount) {
    // The #156 defect: the old predicate compared only min(selected, applied)
    // entries, so a database carrying an unknown migration reported compatible.
    const last = migrations[releaseCount - 1];
    const extra = rows[releaseCount];
    violations.push(violation('applied-beyond-release',
      `release journal ends at ${last.id} created_at ${last.created_at} sha256 ${last.sha256}`,
      `database row ${extra?.id ?? 'absent'} at index ${releaseCount} ${extra?.tag ?? 'untagged'} created_at ${extra?.created_at ?? 'absent'} hash ${extra?.hash ?? 'absent'}`));
  }
  if (appliedCount < releaseCount && appliedCount < asset.minimum_migration_count) {
    const boundary = migrations[asset.minimum_migration_count - 1];
    const lastApplied = appliedCount > 0 ? rows[appliedCount - 1] : undefined;
    violations.push(violation('below-minimum-migration-count',
      `at least ${asset.minimum_migration_count} applied migrations (release boundary ${boundary.id})`,
      `${appliedCount} applied migrations (last ${lastApplied ? lastApplied.tag ?? lastApplied.id : 'none'})`));
  }
  const versionAhead = appliedVersion !== null && appliedVersion > asset.current_version;
  if (violations.length) return { boundary: null, violations, versionAhead };
  const boundary = {
    result: 'compatible',
    asset: schemaAssetSummary(asset, assetSha256),
    applied: { schema_version: appliedVersion, journal_length: appliedCount },
    comparison: {
      checked_entries: appliedCount,
      prefix_sha256: schemaBoundaryPrefixHash(rows.slice(0, appliedCount)
        .map((row) => ({ created_at: row.created_at, sha256: row.hash }))),
      pending_migrations: releaseCount - appliedCount,
    },
    reader: { source: reader.source, service_sha: reader.service_sha, image_digest: reader.image_digest },
  };
  return { boundary: validateSchemaBoundary(boundary), violations: [], versionAhead };
}

/**
 * The gate runner.
 *
 * 1. Load and strictly validate the travelled asset before any AWS call.
 * 2. Resolve the live evidence with the reader rule.
 * 3. Compare, push exactly one `schema-boundary` event, and return the v6 body
 *    or throw the named refusal carrying every violation.
 */
export async function runSchemaBoundaryGate({ io, env, release, deployedRevision,
  directory = SELECTED_RELEASE_DIRECTORY,
  loadAsset = loadSchemaAsset, probe = probeAppliedSchema, readLog = readAppliedSchemaLog,
  compare = compareSchemaBoundary, assetValidator = validateSchemaAsset }) {
  const releaseIdentity = { tag: release?.releaseTag ?? 'unavailable',
    service_commit: release?.serviceCommit ?? 'unavailable' };
  let loaded;
  let assetSha256 = 'unavailable';
  try {
    loaded = await loadAsset(directory);
    assetSha256 = matches(loaded?.sha256, HASH, 'travelled service schema asset digest');
    assetValidator(loaded.asset);
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 500);
    const violations = [violation('asset-invalid',
      `a strictly valid travelled ${SCHEMA_ASSET_NAME} (schema_version 1, record_type anywear_service_schema)`,
      detail)];
    throw new SchemaBoundaryError('asset-invalid',
      `${SCHEMA_ASSET_NAME} was refused before any AWS call: ${detail}`, violations,
      { reader: null, readers: [], applied_rows: [] });
  }
  const evidence = await readSchemaBoundaryEvidence({ io, release, deployedRevision, probe, readLog });
  const compared = compare({ asset: loaded.asset, applied: evidence.applied,
    reader: evidence.reader, assetSha256 });
  const appliedSummary = {
    schema_version: evidence.applied.applied_schema_version,
    journal_length: evidence.applied.applied.length,
  };
  if (compared.violations.length) {
    const reason = compared.violations[0].reason;
    const detail = describeViolations(compared.violations);
    throw new SchemaBoundaryError(reason, detail, compared.violations,
      { reader: evidence.reader, readers: evidence.readers, applied_rows: evidence.applied.applied });
  }
  // The verdict is a run fact: the step log names the boundary the deployment is
  // admitted against. No record carries it (#207).
  process.stdout.write(`${JSON.stringify({ gate: SCHEMA_BOUNDARY_EVENT, result: 'compatible',
    release: releaseIdentity, asset: { sha256: assetSha256 }, applied: appliedSummary,
    comparison: compared.boundary.comparison, reader: evidence.reader })}\n`);
  return compared.boundary;
}
