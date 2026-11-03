import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, sha256, exact, matches, integer, HASH } from './json-contract.mjs';

// The consumer side of the Service `service-schema.json` release asset (#194).
//
// AnyWear-Service publishes one sealed artifact whose schema asset states the database
// schema the image can run against: the ordered Drizzle journal, the image's
// current and minimum application schema version and the migration boundary that
// applies to the minimum. Infra's `deploy-runtime` reads it here, before any AWS
// call, with the same strictness as the publisher: exact members, one known
// version, a journalled and internally aligned migration list. Anything else
// refuses; the loader never guesses a shape.
export const SCHEMA_ASSET_NAME = 'service-schema.json';
export const SCHEMA_ASSET_RECORD_TYPE = 'anywear_service_schema';
export const SCHEMA_ASSET_SCHEMA_VERSION = 1;
export const SCHEMA_JOURNAL_VERSION = '7';
export const SCHEMA_JOURNAL_DIALECT = 'postgresql';
// The deployment-path read is bounded to the same 256 rows the live read uses.
export const SCHEMA_MAX_MIGRATIONS = 256;
export const SCHEMA_MIGRATION_TAG = /^\d{4}_[a-z0-9_]+$/;

const SCHEMA_ASSET_FIELDS = Object.freeze(['schema_version', 'record_type', 'current_version',
  'minimum_version', 'minimum_migration_count', 'journal', 'migrations']);
const SCHEMA_JOURNAL_FIELDS = Object.freeze(['version', 'dialect', 'entries']);
const SCHEMA_JOURNAL_ENTRY_FIELDS = Object.freeze(['idx', 'version', 'when', 'tag', 'breakpoints']);
const SCHEMA_MIGRATION_FIELDS = Object.freeze(['id', 'idx', 'created_at', 'sha256']);

/**
 * Strictly validate one `service-schema.json` asset and return it unchanged.
 *
 * The rules are the publication rules: an unknown `schema_version` or
 * `record_type` refuses rather than being guessed, every version/count is a
 * positive safe integer, `minimum_version <= current_version`, the minimum
 * migration count is inside the journal and equal versions require the whole
 * journal, the journal is Drizzle v7/PostgreSQL, each migration aligns with its
 * journal entry (`id`/`tag`, `idx`, `created_at`/`when`, SQL `sha256`),
 * `idx` is contiguous, `created_at` strictly increases, tags are unique and
 * match `NNNN_[a-z0-9_]+`, and the journal holds at most 256 migrations.
 */
export function validateSchemaAsset(asset) {
  exact(asset, SCHEMA_ASSET_FIELDS, 'service schema asset');
  if (asset.schema_version !== SCHEMA_ASSET_SCHEMA_VERSION
    || asset.record_type !== SCHEMA_ASSET_RECORD_TYPE) {
    throw new Error(`Unknown ${SCHEMA_ASSET_NAME} schema; an unknown asset version is never guessed`);
  }
  const currentVersion = integer(asset.current_version, 'service schema current version');
  const minimumVersion = integer(asset.minimum_version, 'service schema minimum version');
  if (minimumVersion > currentVersion) throw new Error('Invalid service schema version range');
  exact(asset.journal, SCHEMA_JOURNAL_FIELDS, 'service schema journal');
  if (asset.journal.version !== SCHEMA_JOURNAL_VERSION
    || asset.journal.dialect !== SCHEMA_JOURNAL_DIALECT) throw new Error('Invalid service schema journal identity');
  if (!Array.isArray(asset.journal.entries) || !Array.isArray(asset.migrations)) {
    throw new Error('Invalid service schema journal entries');
  }
  if (asset.migrations.length === 0 || asset.journal.entries.length !== asset.migrations.length) {
    throw new Error('Service schema journal and migrations differ in length');
  }
  if (asset.migrations.length > SCHEMA_MAX_MIGRATIONS) {
    throw new Error(`Service schema journal exceeds ${SCHEMA_MAX_MIGRATIONS} migrations`);
  }
  const minimumMigrationCount = integer(asset.minimum_migration_count, 'service schema minimum migration count');
  if (minimumMigrationCount > asset.migrations.length) {
    throw new Error('Service schema minimum migration count exceeds the journal');
  }
  // Equal versions mean the minimum is the current image: every migration the
  // release applies is inside its own minimum, so the whole journal is required.
  if (currentVersion === minimumVersion && minimumMigrationCount !== asset.migrations.length) {
    throw new Error('Equal service schema versions must require the whole journal');
  }
  const tags = new Set();
  let prior;
  for (const [index, entry] of asset.journal.entries.entries()) {
    exact(entry, SCHEMA_JOURNAL_ENTRY_FIELDS, `service schema journal entry ${index}`);
    if (entry.idx !== index) throw new Error('Service schema journal idx is not contiguous');
    if (entry.version !== SCHEMA_JOURNAL_VERSION) throw new Error('Invalid service schema journal entry version');
    if (typeof entry.breakpoints !== 'boolean') throw new Error('Invalid service schema journal breakpoints');
    integer(entry.when, 'service schema migration time');
    matches(entry.tag, SCHEMA_MIGRATION_TAG, 'service schema migration tag');
    if (tags.has(entry.tag)) throw new Error(`Duplicate service schema migration tag ${entry.tag}`);
    if (prior !== undefined && !(prior < entry.when)) {
      throw new Error('Service schema migration times are not strictly increasing');
    }
    tags.add(entry.tag);
    prior = entry.when;
    const migration = exact(asset.migrations[index], SCHEMA_MIGRATION_FIELDS, `service schema migration ${index}`);
    if (migration.id !== entry.tag || migration.idx !== index || migration.created_at !== entry.when) {
      throw new Error('Service schema migration does not align with its journal entry');
    }
    matches(migration.sha256, HASH, 'service schema migration SQL hash');
  }
  return asset;
}

/**
 * The v6 record's `asset` member: the travelled digest and the four numbers the
 * comparison uses. `journalLength` is the release's own migration count.
 */
export function schemaAssetSummary(asset, sha256Hex) {
  validateSchemaAsset(asset);
  return {
    sha256: matches(sha256Hex, HASH, 'service schema asset digest'),
    current_version: asset.current_version,
    minimum_version: asset.minimum_version,
    minimum_migration_count: asset.minimum_migration_count,
    journal_length: asset.migrations.length,
  };
}

/** The published `sha256:<hex>` digest form the release digest set carries. */
export function assetDigest(bytes) {
  return `sha256:${sha256(bytes)}`;
}

/**
 * Read and strictly validate `<directory>/service-schema.json`.
 *
 * Returns the validated asset, the travelled bytes and their bare 64-hex digest.
 * A missing or empty file refuses before any AWS call.
 */
export async function loadSchemaAsset(directory) {
  const file = path.join(directory, SCHEMA_ASSET_NAME);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`The travelled ${SCHEMA_ASSET_NAME} is missing from ${directory}`);
    throw error;
  }
  if (!bytes.length) throw new Error(`The travelled ${SCHEMA_ASSET_NAME} is empty`);
  // `parseJson` rejects duplicate JSON keys, and the strict validator above
  // refuses any member, number or relation the publication contract does not state.
  const asset = validateSchemaAsset(parseJson(bytes));
  return { asset, bytes, sha256: sha256(bytes) };
}
