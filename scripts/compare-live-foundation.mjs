import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonicalJson, sha256, parseJson } from './lib/json-contract.mjs';

const pseudo = { 'AWS::AccountId': '650880818323', 'AWS::Region': 'ap-east-1', 'AWS::Partition': 'aws' };
// Resolve only fixed-account pseudo parameters and diagnostic conditions. A
// resource Ref/GetAtt stays structural; no asset/code or IAM difference is hidden.
function resolve(value) {
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1) {
    if (Object.hasOwn(pseudo, value.Ref)) return pseudo[value.Ref];
    if (typeof value['Fn::Sub'] === 'string') {
      const result = value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (whole, key) => pseudo[key] ?? whole);
      if (!result.includes('${')) return result;
    }
    const values = value['Fn::Or']?.map(resolve);
    if (values?.every(item => typeof item === 'boolean')) return values.some(Boolean);
    if (value['Fn::Equals']) {
      const values = value['Fn::Equals'].map(resolve);
      if (values.every(item => typeof item !== 'object')) return values[0] === values[1];
    }
    if (value['Fn::Join']) {
      const [separator, items] = value['Fn::Join']; const resolved = items.map(resolve);
      if (resolved.every(item => typeof item === 'string')) return resolved.join(separator);
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
}

function normalized(template) {
  const result = structuredClone(template);
  for (const [id, resource] of Object.entries(result.Resources)) {
    for (const key of Object.keys(resource.Metadata ?? {})) {
      assert.ok(['aws:cdk:path', 'aws:asset:path', 'aws:asset:property'].includes(key), `Unreviewed resource metadata ${id}/${key}`);
    }
    delete resource.Metadata;
    if (id === 'CDKMetadata') {
      assert.equal(resource.Type, 'AWS::CDK::Metadata');
      assert.deepEqual(Object.keys(resource.Properties), ['Analytics']);
      resource.Properties.Analytics = '@cdk-diagnostics';
      if (resource.Condition !== undefined) {
        assert.equal(resource.Condition, 'CDKMetadataAvailable');
        assert.equal(resolve(result.Conditions?.CDKMetadataAvailable), true);
        delete resource.Condition;
      }
    }
  }
  if (result.Conditions?.CDKMetadataAvailable !== undefined) {
    assert.equal(resolve(result.Conditions.CDKMetadataAvailable), true);
    delete result.Conditions.CDKMetadataAvailable;
    if (!Object.keys(result.Conditions).length) delete result.Conditions;
  }
  return resolve(result);
}

export function compareLiveFoundation(original, candidate, additions) {
  const expected = normalized({ ...original, Resources: { ...original.Resources, ...additions } });
  const actual = normalized(candidate);
  assert.deepEqual(Object.keys(candidate.Resources).sort(), Object.keys(expected.Resources).sort(),
    `Only the reviewed ${Object.keys(additions).length} additive resources are allowed`);
  assert.deepEqual(actual, expected, 'Live provider/helper/output or dedicated role/policy drift');
  return { accepted: true, comparison_kind: 'live-foundation-original-source-check', legacy_role_source: 'external',
    added: Object.keys(additions).sort(), original_resource_count: Object.keys(original.Resources).length,
    candidate_resource_count: Object.keys(candidate.Resources).length, original_canonical_sha256: sha256(canonicalJson(original)),
    candidate_canonical_sha256: sha256(canonicalJson(candidate)), normalized_canonical_sha256: sha256(canonicalJson(actual)),
    diagnostic_exceptions: ['aws:cdk:path', 'aws:asset:path', 'aws:asset:property', 'CDKMetadata.Properties.Analytics', 'CDKMetadataAvailable evaluated true'],
    pseudo_parameters: pseudo, publication_verified: false, deployment_qualified: false };
}

export async function loadLiveFoundationFixture() {
  const fixture = name => new URL(`../test/fixtures/${name}`, import.meta.url);
  const provenance = parseJson(await readFile(fixture('foundation-live-provenance.json')));
  const originalBytes = await readFile(fixture('foundation-live-original.template.json'));
  const additionBytes = await readFile(fixture('foundation-dedicated-additions.json'));
  assert.equal(sha256(originalBytes), provenance.fixture_sha256);
  assert.equal(sha256(additionBytes), provenance.dedicated_additions_sha256);
  const original = parseJson(originalBytes); const additions = parseJson(additionBytes);
  assert.equal(sha256(canonicalJson(original)), provenance.original_canonical_sha256);
  assert.deepEqual(Object.keys(additions).sort(), provenance.addition_allowlist.toSorted());
  return { original, additions, provenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => { const index = process.argv.indexOf(name); assert.ok(index >= 2 && process.argv[index + 1], `Required ${name}`); return process.argv[index + 1]; };
  const { original, additions, provenance } = await loadLiveFoundationFixture();
  const candidateBytes = await readFile(option('--candidate')); const candidate = parseJson(candidateBytes);
  const sourceSha = execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  const report = { ...compareLiveFoundation(original, candidate, additions), fixture_provenance: provenance,
    candidate_raw_sha256: sha256(candidateBytes), source_sha: sourceSha, source_dirty: dirty.length > 0,
    context: { deployScope: 'foundation', identityPhase: 'roles-added', legacyRoleSource: 'external', account: '650880818323', region: 'ap-east-1' } };
  await writeFile(option('--output'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, added: report.added.length, candidate_sha256: report.candidate_canonical_sha256 })}\n`);
}
