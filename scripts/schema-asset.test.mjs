import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_ASSET_NAME,
  SCHEMA_ASSET_RECORD_TYPE,
  SCHEMA_ASSET_SCHEMA_VERSION,
  SCHEMA_JOURNAL_DIALECT,
  SCHEMA_JOURNAL_VERSION,
  SCHEMA_MAX_MIGRATIONS,
  assetDigest,
  loadSchemaAsset,
  schemaAssetSummary,
  validateSchemaAsset,
} from './schema-asset.mjs';
import { contentHash, sha256 } from './json-contract.mjs';

// The consumer side of the Service release's `service-schema.json` (#194). The
// fixture is generated once from the committed AnyWear-Service journal and SQL
// bytes (see `test/fixtures/schema-boundary/schema-asset.json` and the
// provenance note in `schema-gate.test.mjs`): 26 migrations, current version 22,
// minimum version 20, minimum migration count 24.
const assetBytes = await readFile(new URL('../test/fixtures/schema-boundary/schema-asset.json', import.meta.url));
const fixtureAsset = JSON.parse(assetBytes.toString('utf8'));
const directories = [];
test.after(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

async function travelled(bytes = assetBytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'schema-asset-'));
  directories.push(directory);
  await writeFile(path.join(directory, SCHEMA_ASSET_NAME), bytes);
  return directory;
}

function mutated(change) {
  const asset = structuredClone(fixtureAsset);
  change(asset);
  return asset;
}

test('the frozen asset identity is the published name, version and 256-migration bound', () => {
  assert.equal(SCHEMA_ASSET_NAME, 'service-schema.json');
  assert.equal(SCHEMA_ASSET_SCHEMA_VERSION, 1);
  assert.equal(SCHEMA_ASSET_RECORD_TYPE, 'anywear_service_schema');
  assert.equal(SCHEMA_JOURNAL_VERSION, '7');
  assert.equal(SCHEMA_JOURNAL_DIALECT, 'postgresql');
  assert.equal(SCHEMA_MAX_MIGRATIONS, 256);
});

test('the released fixture is the compatible asset: 26 migrations, versions 22/20, boundary 24, last 0025_new_human_fly', () => {
  assert.deepEqual(validateSchemaAsset(fixtureAsset), fixtureAsset);
  assert.deepEqual(Object.keys(fixtureAsset).sort(), ['current_version', 'journal', 'migrations',
    'minimum_migration_count', 'minimum_version', 'record_type', 'schema_version']);
  assert.equal(fixtureAsset.schema_version, 1);
  assert.equal(fixtureAsset.record_type, 'anywear_service_schema');
  assert.equal(fixtureAsset.current_version, 22);
  assert.equal(fixtureAsset.minimum_version, 20);
  assert.equal(fixtureAsset.minimum_migration_count, 24);
  assert.equal(fixtureAsset.migrations.length, 26);
  assert.equal(fixtureAsset.journal.entries.length, 26);
  assert.equal(fixtureAsset.migrations[0].id, '0000_elite_otto_octavius');
  assert.equal(fixtureAsset.migrations.at(-1).id, '0025_new_human_fly');
  assert.equal(fixtureAsset.migrations.at(-1).idx, 25);
  for (const [index, migration] of fixtureAsset.migrations.entries()) {
    assert.equal(migration.idx, index);
    assert.equal(migration.created_at, fixtureAsset.journal.entries[index].when);
    assert.match(migration.sha256, /^[a-f0-9]{64}$/);
  }
});

test('the loader returns the asset, its travelled bytes and the bare 64-hex digest', async () => {
  const directory = await travelled();
  const loaded = await loadSchemaAsset(directory);
  assert.deepEqual(loaded.asset, fixtureAsset);
  assert.deepEqual(Buffer.from(loaded.bytes), Buffer.from(assetBytes));
  assert.equal(loaded.sha256, sha256(assetBytes));
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
  // The published release-digest form is the same digest with its algorithm.
  assert.equal(assetDigest(assetBytes), `sha256:${sha256(assetBytes)}`);
});

test('the asset summary is the record member the comparison compares against', async () => {
  const directory = await travelled();
  const loaded = await loadSchemaAsset(directory);
  assert.deepEqual(schemaAssetSummary(loaded.asset, loaded.sha256), {
    sha256: loaded.sha256,
    current_version: 22,
    minimum_version: 20,
    minimum_migration_count: 24,
    journal_length: 26,
  });
  // The summary refuses a malformed digest and re-validates the asset, so a
  // caller cannot record numbers from an unvalidated object.
  assert.throws(() => schemaAssetSummary(loaded.asset, 'sha256:not-bare'), /Invalid service schema asset digest/);
  assert.throws(() => schemaAssetSummary(mutated((asset) => { asset.current_version = 0; }), loaded.sha256),
    /Invalid service schema current version/);
});

test('the loader refuses a missing, empty or duplicate-key asset before any AWS call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'schema-asset-missing-'));
  directories.push(directory);
  await assert.rejects(loadSchemaAsset(directory), /is missing from/);

  const empty = await travelled(Buffer.alloc(0));
  await assert.rejects(loadSchemaAsset(empty), /is empty/);

  // JSON.parse silently accepts duplicate keys; the shared strict parser does not.
  const duplicate = Buffer.from(assetBytes.toString('utf8').replace(
    '"current_version":22', '"current_version":22,"current_version":22'));
  const duplicates = await travelled(duplicate);
  await assert.rejects(loadSchemaAsset(duplicates), /Duplicate JSON key: current_version/);

  const unknown = await travelled(Buffer.from(`${JSON.stringify({ ...fixtureAsset, schema_version: 2 })}\n`));
  await assert.rejects(loadSchemaAsset(unknown), /Unknown service-schema\.json schema/);
});

test('the fixture content hash is stable canonical JSON plus the publisher newline', () => {
  // The Service publisher writes `canonicalJson(asset) + "\n"`; the fixture keeps
  // those exact bytes so its digest is the one a sealed artifact would publish.
  const text = assetBytes.toString('utf8');
  assert.equal(text.endsWith('}\n'), true);
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  assert.equal(text, `${canonical(JSON.parse(text))}\n`);
  assert.equal(contentHash(fixtureAsset), sha256(text.slice(0, -1)));
});
