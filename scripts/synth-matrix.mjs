import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareTemplates } from './lib/compare-templates.mjs';
import { canonicalDeployedTemplateHash } from '../lib/contracts.mjs';
import { platformStackName, recoveryFailureMessage, recoveryViolations, synthStage } from './lib/recovery-contract.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) { assert.ok(value.startsWith('--') && args[index + 1], 'Options require --name value pairs');
    pairs.push([value.slice(2), args[index + 1]]); }
  return pairs;
}, []));
const repository = path.resolve(options.repository || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const baselineSnapshot = options['baseline-snapshot'] && path.resolve(options['baseline-snapshot']);
assert.ok(!(baselineSnapshot && options['baseline-repository']), 'Use one baseline source input');
const baselineRepository = baselineSnapshot ? path.join(baselineSnapshot, 'infra')
  : options['baseline-repository'] && path.resolve(options['baseline-repository']);
const baselineTemplates = options['baseline-templates'] && path.resolve(options['baseline-templates']);
assert.ok(!(baselineRepository && baselineTemplates), 'Use one baseline input');
const output = path.resolve(options.output || path.join(repository, 'cdk.matrix'));
assert.ok(options['artifact-directory'], '--artifact-directory is required');
const phases = options.phase ? [options.phase] : ['legacy', 'roles-added', 'retired'];
assert.ok(options['retention-protection'] === undefined || ['true', 'false'].includes(options['retention-protection']),
  '--retention-protection must be true or false');
const ecrImageRetention = options['retention-protection'] === 'true';
assert.ok(phases.every((phase) => ['legacy', 'roles-added', 'retired'].includes(phase)), 'Unknown identity phase');
const variants = [{ stage: 'dev' }, { stage: 'beta' }, { stage: 'prod' }];
const revision = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const source = { repository_sha: revision(repository), baseline_sha: baselineRepository && !baselineSnapshot && revision(baselineRepository) };
if (baselineSnapshot) {
  const snapshot = JSON.parse(readFileSync(path.join(baselineSnapshot, '.source-snapshot.json'), 'utf8'));
  assert.equal(snapshot.repository, 'git-malu/AnyWear-Service');
  assert.match(snapshot.source_sha, /^[a-f0-9]{40}$/);
  assert.match(snapshot.tree_sha, /^[a-f0-9]{40}$/);
  assert.match(snapshot.archive_sha256, /^[a-f0-9]{64}$/);
  for (const [file, hash] of Object.entries(snapshot.files)) {
    assert.ok(!path.isAbsolute(file) && file.split('/').every((part) => part && !['.', '..'].includes(part)), 'Safe source file');
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineSnapshot, file))).digest('hex'), hash,
      `Original source snapshot integrity: ${file}`);
  }
  source.baseline_sha = snapshot.source_sha;
  source.baseline_tree_sha = snapshot.tree_sha;
  source.baseline_archive_sha256 = snapshot.archive_sha256;
}
const baselineProvenance = baselineTemplates
  ? JSON.parse(readFileSync(path.join(baselineTemplates, 'provenance.json'), 'utf8')) : undefined;
if (baselineTemplates) {
  const provenance = baselineProvenance;
  assert.equal(provenance.repository, 'git-malu/AnyWear-Service', 'Baseline must retain Service provenance');
  assert.match(provenance.source_sha, /^[a-f0-9]{40}$/, 'Baseline source SHA');
  const cdkVersion = JSON.parse(readFileSync(path.join(repository, 'node_modules/aws-cdk-lib/package.json'), 'utf8')).version;
  assert.equal(provenance.cdk_version, cdkVersion, 'CDK version differs from the resource baseline');
  for (const [file, hash] of Object.entries(provenance.templates)) {
    // The release slice is Service's baseline; this repository's baseline set is
    // exactly the stack set this app still synthesizes, plus the two #195 Runtime
    // Stack baselines moved here from AnyWear-Service.
    assert.match(file, /^(dev-active|beta-active|prod-active)\/AnyWear(?:Foundation|Platform|Billing)Stack(?:-(?:dev|beta|prod))?\.template\.json$|^(beta-active|prod-active)\/AnyWearRuntimeStack-(?:beta|prod)\.template\.json$/);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineTemplates, file))).digest('hex'), hash,
      `Baseline template integrity: ${file}`);
  }
  source.baseline_sha = provenance.source_sha;
  source.baseline_provenance = provenance;
}
if (baselineRepository && !baselineSnapshot) {
  // Never silently synthesize modified original CDK source as the baseline.
  execFileSync('git', ['diff', '--exit-code', '--', 'bin', 'lib', 'test', 'cdk.json', 'package-lock.json', 'package.json'],
    { cwd: baselineRepository, stdio: 'pipe' });
}
mkdirSync(output, { recursive: true });
function synth(cwd, directory, variant, phase, immutableInputs, deployScope = 'application') {
  // A repeated local run must not compare a stale assembly: the pre-credential
  // check also synthesizes into a fresh directory.
  rmSync(directory, { recursive: true, force: true });
  // The shared synthesis is what the pre-credential deployment check runs, so
  // the matrix and the deployment gate cannot drift into different shapes.
  return synthStage({ repository: cwd, directory, stage: variant.stage, deployScope,
    inputs: immutableInputs ? { identityPhase: phase, ecrImageRetention, legacyRoleSource: 'cdk',
      artifactDirectory: path.resolve(options['artifact-directory']) } : undefined });
}
// The stacks one deploy scope synthesizes. The application scope produces the
// configured Base set; `runtime` produces the release slice and is a separate
// scope because it consumes no Service-built asset.
const applicationStacks = (stage) => [
  'AnyWearFoundationStack.template.json', `${platformStackName(stage)}.template.json`,
  ...(stage === 'beta' ? ['AnyWearBillingStack-beta.template.json'] : []),
].sort();
const runtimeStacks = (stage) => [`AnyWearRuntimeStack-${stage}.template.json`];
const reports = [];
for (const variant of variants) {
  const name = `${variant.stage}-active`;
  const baseline = baselineTemplates ? path.join(baselineTemplates, name) : path.join(output, 'baseline', name);
  if (baselineRepository) synth(baselineRepository, baseline, variant, 'legacy', false);
  const baselineFiles = baselineTemplates
    ? readdirSync(baseline).filter((file) => file.endsWith('.template.json'))
      .filter((file) => applicationStacks(variant.stage).includes(file))
    : undefined;
  for (const phase of phases) {
    const target = path.join(output, phase, name);
    const files = synth(repository, target, variant, phase, true);
    const platformTemplate = `${platformStackName(variant.stage)}.template.json`;
    assert.ok(files.includes(platformTemplate), `Missing ${platformTemplate} for ${name}/${phase}`);
    const violations = recoveryViolations(JSON.parse(readFileSync(path.join(target, platformTemplate), 'utf8')),
      { stage: variant.stage });
    if (violations.length) throw new Error(recoveryFailureMessage(violations,
      { stage: variant.stage, stackName: platformStackName(variant.stage) }));
    if (baselineRepository || baselineTemplates) {
      assert.deepEqual(files.sort(), [...applicationStacks(variant.stage)].sort(), 'Stack set drift');
      for (const file of files) {
        reports.push(compareTemplates(JSON.parse(readFileSync(path.join(baseline, file), 'utf8')),
          JSON.parse(readFileSync(path.join(target, file), 'utf8')), {
            phase, stage: variant.stage, stackName: file.slice(0, -'.template.json'.length), ecrImageRetention,
          }));
      }
    }
  }
  assert.deepEqual(baselineFiles?.sort(), [...applicationStacks(variant.stage)].sort(),
    `Baseline stack set drift for ${name}`);
}

// The Runtime release slice (#195). `deployScope=runtime` synthesizes the one
// stack AnyWearRuntimeStack-<stage>; it is compared against the moved Service
// baselines at every identity phase with the reviewed #86 cleanup allowance, and
// its declared normalisation hash must equal the recorded phase hash. The phase
// hashes are computed from this source, which is byte-identical to the pre-change
// AnyWear-Service/infra at 4f2ba555ec293771551c0d23266af7038d95383e.
const runtimeVariants = [{ stage: 'beta', name: 'beta-active' }, { stage: 'prod', name: 'prod-active' }];
const runtimeProvenance = baselineTemplates
  ? baselineProvenance.runtime_identity
  : undefined;
if (baselineTemplates) assert.ok(runtimeProvenance, 'The baseline provenance must record the Runtime identity');
if (runtimeProvenance) {
  assert.equal(runtimeProvenance.repository, 'git-malu/AnyWear-Service', 'Runtime baseline source repository');
  assert.equal(runtimeProvenance.source_sha, '4f2ba555ec293771551c0d23266af7038d95383e',
    'Runtime baseline source commit is the pre-change Service source');
  assert.equal(runtimeProvenance.normalisation.length, 4, 'The declared normalisation is four rules');
  for (const [file, hash] of Object.entries(runtimeProvenance.templates)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(baselineTemplates, file))).digest('hex'), hash,
      `Runtime baseline template integrity: ${file}`);
  }
  assert.equal(runtimeProvenance.stage_parameters.beta.length, 35, 'The Beta Runtime read set is 35 stage parameters');
  assert.equal(runtimeProvenance.stage_parameters.prod.length, 34, 'The Prod Runtime read set is 34 stage parameters');
  assert.equal(runtimeProvenance.stage_parameters.beta.includes('isolated_subnet_ids'), false,
    'The Runtime stack reads no isolated-subnet list');
}
const phaseHashes = {};
let runtimeComparisons = 0;
for (const variant of runtimeVariants) {
  const baseline = path.join(baselineTemplates, variant.name);
  const baselineFile = runtimeStacks(variant.stage)[0];
  assert.ok(readdirSync(baseline).includes(baselineFile), `Missing Runtime baseline ${variant.name}/${baselineFile}`);
  for (const phase of phases) {
    const target = path.join(output, 'runtime', phase, variant.name);
    const files = synth(repository, target, variant, phase, true, 'runtime');
    assert.deepEqual(files.sort(), [...runtimeStacks(variant.stage)].sort(),
      `Runtime stack set drift for ${variant.name}/${phase}`);
    const candidate = JSON.parse(readFileSync(path.join(target, baselineFile), 'utf8'));
    const recorded = JSON.parse(readFileSync(path.join(baseline, baselineFile), 'utf8'));
    const report = compareTemplates(recorded, candidate, {
      phase, stage: variant.stage, stackName: `AnyWearRuntimeStack-${variant.stage}`, ecrImageRetention,
    });
    reports.push(report);
    runtimeComparisons += 1;
    const hash = canonicalDeployedTemplateHash(candidate);
    phaseHashes[`${variant.stage}/${phase}`] = hash;
    assert.equal(hash, runtimeProvenance.phase_hashes[variant.stage][phase],
      `Runtime ${variant.stage}/${phase} normalised hash differs from the recorded phase identity`);
    // The recorded beta identity phases are the design's AC 4 values; they must
    // equal the per-stage table, so a re-record cannot silently move them.
    if (variant.stage === 'beta') {
      assert.equal(hash, runtimeProvenance.identity_phases[phase],
        `Runtime beta/${phase} differs from the recorded identity phase`);
    }
  }
}
assert.equal(runtimeComparisons, 6, 'The matrix must compare six Runtime syntheses (2 stages x 3 phases)');
const runtimeStackPattern = /^AnyWearRuntimeStack-(?:beta|prod)$/;
const runtimeRejected = reports.filter((entry) => runtimeStackPattern.test(entry.stackName ?? ''))
  .flatMap((entry) => entry.rejected);
assert.deepEqual(runtimeRejected, [], 'No Runtime comparison may be rejected');
const report = { ...source, generated_at: new Date().toISOString(), variants, phases,
  comparison_kind: 'service-source-simulation', legacy_role_source: 'cdk',
  retention_protection: ecrImageRetention,
  runtime: { baseline_source: baselineTemplates ? 'AnyWear-Service/infra at 4f2ba555ec293771551c0d23266af7038d95383e' : undefined,
    comparisons: runtimeComparisons, phase_hashes: phaseHashes, normalisation: runtimeProvenance?.normalisation },
  accepted: reports.length ? reports.every((entry) => entry.accepted) : null, comparisons: reports };
writeFileSync(path.join(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ repository_sha: source.repository_sha, baseline_sha: source.baseline_sha,
  baseline_tree_sha: source.baseline_tree_sha, baseline_archive_sha256: source.baseline_archive_sha256,
  retention_protection: ecrImageRetention, accepted: report.accepted, comparisons: reports.length,
  runtime_comparisons: report.runtime?.comparisons, runtime_phase_hashes: report.runtime?.phase_hashes,
  allowed: reports.reduce((count, entry) => count + entry.allowed.length, 0),
  rejected: reports.flatMap((entry) => entry.rejected.map((difference) => ({ ...difference,
    phase: entry.phase, stage: entry.stage, stackName: entry.stackName }))), report: path.join(output, 'comparison.json') }, null, 2)}\n`);
if (report.accepted === false) process.exitCode = 1;
